#!/usr/bin/env python3
"""Multi-site rank history using only the official Yandex Search API.

The program deliberately does not fetch yandex.ru search-result pages and does
not use Yandex Webmaster API.  It has no third-party Python dependencies.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import ipaddress
import json
import os
import random
import re
import sqlite3
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo


SEARCH_ASYNC_URL = "https://searchapi.api.cloud.yandex.net/v2/web/searchAsync"
OPERATIONS_URL = "https://operation.api.cloud.yandex.net/operations/"
WORDSTAT_TOP_URL = "https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests"
MOSCOW_REGION_ID = "213"
DEFAULT_GEO_IP = "155.212.215.203"
MOSCOW_TZ = ZoneInfo("Europe/Moscow")
SCHEMA_VERSION = 1

DEVICE_USER_AGENTS = {
    "desktop": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    ),
    "mobile": (
        "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
    ),
}


class MonitorError(Exception):
    """Base class for expected, safely printable failures."""


class ConfigError(MonitorError):
    """Invalid local configuration or missing credentials."""


class APIError(MonitorError):
    """Yandex API or network failure."""


class HTTPStatusError(APIError):
    def __init__(self, status: int, message: str, retry_after: float | None = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.retry_after = retry_after


class NetworkError(APIError):
    pass


@dataclass(frozen=True)
class Keyword:
    query: str
    query_key: str
    cluster: str
    target_url: str


@dataclass(frozen=True)
class Site:
    site_id: str
    name: str
    domains: frozenset[str]
    include_subdomains: bool
    keywords: tuple[Keyword, ...]
    discovery_seeds: tuple[str, ...]


@dataclass(frozen=True)
class MonitorConfig:
    sites: tuple[Site, ...]
    digest: str


@dataclass(frozen=True)
class ObservationPlan:
    site: Site
    keyword: Keyword


@dataclass(frozen=True)
class SearchTask:
    query: str
    query_key: str
    device: str
    plans: tuple[ObservationPlan, ...]


@dataclass(frozen=True)
class SerpDocument:
    position: int
    url: str
    hostname: str


@dataclass(frozen=True)
class Credentials:
    folder_id: str
    authorization: str


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None = None) -> str:
    value = value or utc_now()
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def moscow_today() -> date:
    return datetime.now(MOSCOW_TZ).date()


def normalize_query(value: Any) -> str:
    text = unicodedata.normalize("NFC", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()


def query_key(value: Any) -> str:
    return normalize_query(value).casefold()


def normalize_hostname(value: Any) -> str:
    text = str(value or "").strip().lower().rstrip(".")
    if not text:
        return ""
    if "://" in text:
        text = urllib.parse.urlsplit(text).hostname or ""
    else:
        text = text.split("/", 1)[0].split(":", 1)[0]
    try:
        return text.encode("idna").decode("ascii")
    except UnicodeError:
        return ""


def hostname_from_url(url: str) -> str:
    try:
        return normalize_hostname(urllib.parse.urlsplit(url).hostname or "")
    except ValueError:
        return ""


def _as_nonempty_string(value: Any, label: str) -> str:
    text = normalize_query(value)
    if not text:
        raise ConfigError(f"{label} must be a non-empty string")
    return text


def load_config(path: Path) -> MonitorConfig:
    """Load JSON configuration.

    JSON is also valid YAML 1.2.  A JSON-shaped file may therefore use .yaml or
    .yml when desired without adding an unsafe, implicit YAML parser.
    """

    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read keyword configuration {path}: {exc}") from exc
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"keyword configuration must be JSON (JSON is valid YAML 1.2): {exc}"
        ) from exc
    if not isinstance(payload, dict):
        raise ConfigError("keyword configuration root must be an object")
    if payload.get("schema_version", SCHEMA_VERSION) != SCHEMA_VERSION:
        raise ConfigError(f"unsupported keyword schema_version; expected {SCHEMA_VERSION}")
    raw_sites = payload.get("sites")
    if not isinstance(raw_sites, list) or not raw_sites:
        raise ConfigError("keyword configuration must contain a non-empty sites list")

    sites: list[Site] = []
    seen_site_ids: set[str] = set()
    for site_index, raw_site in enumerate(raw_sites):
        label = f"sites[{site_index}]"
        if not isinstance(raw_site, dict):
            raise ConfigError(f"{label} must be an object")
        if raw_site.get("enabled", True) is False:
            continue
        site_id = _as_nonempty_string(raw_site.get("id"), f"{label}.id")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", site_id):
            raise ConfigError(f"{label}.id contains unsupported characters")
        if site_id in seen_site_ids:
            raise ConfigError(f"duplicate site id: {site_id}")
        seen_site_ids.add(site_id)
        name = normalize_query(raw_site.get("name")) or site_id

        raw_domains = raw_site.get("domains")
        if not isinstance(raw_domains, list) or not raw_domains:
            raise ConfigError(f"{label}.domains must be a non-empty list")
        domains = frozenset(normalize_hostname(item) for item in raw_domains)
        if "" in domains:
            raise ConfigError(f"{label}.domains contains an invalid hostname")

        raw_keywords = raw_site.get("keywords")
        if not isinstance(raw_keywords, list) or not raw_keywords:
            raise ConfigError(f"{label}.keywords must be a non-empty list")
        keywords: list[Keyword] = []
        seen_queries: set[str] = set()
        for keyword_index, raw_keyword in enumerate(raw_keywords):
            keyword_label = f"{label}.keywords[{keyword_index}]"
            if isinstance(raw_keyword, str):
                query = normalize_query(raw_keyword)
                cluster = ""
                target_url = ""
                enabled = True
            elif isinstance(raw_keyword, dict):
                query = normalize_query(raw_keyword.get("query"))
                cluster = normalize_query(raw_keyword.get("cluster"))
                target_url = str(raw_keyword.get("target_url") or "").strip()
                enabled = raw_keyword.get("enabled", True) is not False
            else:
                raise ConfigError(f"{keyword_label} must be a string or object")
            if not enabled:
                continue
            if not query or len(query) > 400:
                raise ConfigError(f"{keyword_label}.query must contain 1-400 characters")
            key = query_key(query)
            if key in seen_queries:
                raise ConfigError(f"duplicate query for {site_id}: {query}")
            seen_queries.add(key)
            if target_url and not (
                target_url.startswith("/")
                or target_url.startswith("https://")
                or target_url.startswith("http://")
            ):
                raise ConfigError(
                    f"{keyword_label}.target_url must be relative or an HTTP(S) URL"
                )
            keywords.append(Keyword(query, key, cluster, target_url))
        if not keywords:
            raise ConfigError(f"{label} has no enabled keywords")

        raw_seeds = raw_site.get("discovery_seeds", [])
        if not isinstance(raw_seeds, list):
            raise ConfigError(f"{label}.discovery_seeds must be a list")
        seeds = tuple(
            dict.fromkeys(
                seed
                for seed in (normalize_query(item) for item in raw_seeds)
                if seed
            )
        )
        sites.append(
            Site(
                site_id=site_id,
                name=name,
                domains=domains,
                include_subdomains=bool(raw_site.get("include_subdomains", False)),
                keywords=tuple(keywords),
                discovery_seeds=seeds,
            )
        )
    if not sites:
        raise ConfigError("keyword configuration has no enabled sites")
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return MonitorConfig(tuple(sites), digest)


def load_credentials(environment: Mapping[str, str] | None = None) -> Credentials:
    environment = os.environ if environment is None else environment
    folder_id = environment.get("YANDEX_FOLDER_ID", "").strip()
    api_key = environment.get("YANDEX_SEARCH_API_KEY", "").strip()
    iam_token = environment.get("YANDEX_IAM_TOKEN", "").strip()
    if not folder_id or folder_id.startswith("replace-"):
        raise ConfigError("YANDEX_FOLDER_ID is not configured")
    if bool(api_key) == bool(iam_token):
        raise ConfigError(
            "configure exactly one of YANDEX_SEARCH_API_KEY or YANDEX_IAM_TOKEN"
        )
    if api_key:
        if api_key.startswith("replace-"):
            raise ConfigError("YANDEX_SEARCH_API_KEY still contains the placeholder")
        authorization = f"Api-Key {api_key}"
    else:
        authorization = f"Bearer {iam_token}"
    return Credentials(folder_id=folder_id, authorization=authorization)


def validate_public_ip(value: str) -> str:
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError as exc:
        raise ConfigError("YANDEX_SEARCH_GEO_IP must be a valid IP address") from exc
    if not address.is_global:
        raise ConfigError("YANDEX_SEARCH_GEO_IP must be a public routable IP address")
    return str(address)


def build_tasks(config: MonitorConfig) -> list[SearchTask]:
    grouped: dict[tuple[str, str], tuple[str, list[ObservationPlan]]] = {}
    for site in config.sites:
        for keyword in site.keywords:
            for device in ("desktop", "mobile"):
                key = (keyword.query_key, device)
                if key not in grouped:
                    grouped[key] = (keyword.query, [])
                grouped[key][1].append(ObservationPlan(site, keyword))
    return [
        SearchTask(query, key[0], key[1], tuple(plans))
        for key, (query, plans) in sorted(grouped.items())
    ]


class HTTPTransport:
    """Small JSON transport with bounded error bodies and no credential logging."""

    def request_json(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any] | None,
        timeout: float,
    ) -> dict[str, Any]:
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url=url, data=body, method=method)
        for name, value in headers.items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(8 * 1024 * 1024)
        except urllib.error.HTTPError as exc:
            raw_error = exc.read(32 * 1024)
            message = _api_error_message(raw_error) or exc.reason or "request rejected"
            retry_after = _retry_after_seconds(exc.headers.get("Retry-After"))
            raise HTTPStatusError(exc.code, str(message), retry_after) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise NetworkError(f"network request failed: {exc}") from exc
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise APIError("Yandex API returned malformed JSON") from exc
        if not isinstance(decoded, dict):
            raise APIError("Yandex API returned a non-object JSON response")
        return decoded


def _api_error_message(raw: bytes) -> str:
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return re.sub(r"\s+", " ", raw.decode("utf-8", errors="replace")).strip()[:300]
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("code") or "request rejected")[:300]
        return str(payload.get("message") or payload.get("code") or "request rejected")[:300]
    return "request rejected"


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


class YandexSearchClient:
    def __init__(
        self,
        credentials: Credentials,
        geo_ip: str = DEFAULT_GEO_IP,
        *,
        transport: Any | None = None,
        http_timeout: float = 30.0,
        max_retries: int = 5,
        min_request_interval: float = 0.15,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.credentials = credentials
        self.geo_ip = validate_public_ip(geo_ip)
        self.transport = transport or HTTPTransport()
        self.http_timeout = max(1.0, http_timeout)
        self.max_retries = max(1, max_retries)
        self.min_request_interval = max(0.1, min_request_interval)
        self.sleep = sleep
        self.monotonic = monotonic
        self._last_request_at = 0.0

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": self.credentials.authorization,
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": "ElegsoSeoMonitor/1.0 (+https://elegso.ru/)",
        }

    def _request(
        self,
        method: str,
        url: str,
        payload: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        last_error: APIError | None = None
        for attempt in range(self.max_retries):
            wait_for_slot = self._last_request_at + self.min_request_interval - self.monotonic()
            if wait_for_slot > 0:
                self.sleep(wait_for_slot)
            try:
                response = self.transport.request_json(
                    method, url, self.headers, payload, self.http_timeout
                )
                self._last_request_at = self.monotonic()
                return response
            except (HTTPStatusError, NetworkError) as exc:
                self._last_request_at = self.monotonic()
                last_error = exc
                retryable = isinstance(exc, NetworkError) or (
                    isinstance(exc, HTTPStatusError)
                    and exc.status in {408, 429, 500, 502, 503, 504}
                )
                if not retryable or attempt + 1 >= self.max_retries:
                    raise
                server_delay = exc.retry_after if isinstance(exc, HTTPStatusError) else None
                delay = server_delay if server_delay is not None else min(30.0, 2**attempt)
                self.sleep(delay + random.uniform(0.0, 0.25))
        raise last_error or APIError("request failed")

    def submit_search(self, query: str, device: str) -> dict[str, Any]:
        if device not in DEVICE_USER_AGENTS:
            raise ConfigError(f"unsupported search device: {device}")
        payload: dict[str, Any] = {
            "query": {
                "searchType": "SEARCH_TYPE_RU",
                "queryText": query,
                "familyMode": "FAMILY_MODE_STRICT",
                "page": "0",
                "fixTypoMode": "FIX_TYPO_MODE_OFF",
            },
            "sortSpec": {
                "sortMode": "SORT_MODE_BY_RELEVANCE",
                "sortOrder": "SORT_ORDER_DESC",
            },
            "groupSpec": {
                "groupMode": "GROUP_MODE_FLAT",
                "groupsOnPage": "100",
                "docsInGroup": "1",
            },
            "maxPassages": "1",
            "region": MOSCOW_REGION_ID,
            "l10n": "LOCALIZATION_RU",
            "folderId": self.credentials.folder_id,
            "responseFormat": "FORMAT_XML",
            "userAgent": DEVICE_USER_AGENTS[device],
            "metadata": {"fields": {"X-Forwarded-For-Y": self.geo_ip}},
            "period": "PERIOD_ALL_TIME",
        }
        operation = self._request("POST", SEARCH_ASYNC_URL, payload)
        if not normalize_query(operation.get("id")):
            raise APIError("async search response has no operation id")
        return operation

    def get_operation(self, operation_id: str) -> dict[str, Any]:
        safe_id = urllib.parse.quote(operation_id, safe="")
        return self._request("GET", OPERATIONS_URL + safe_id)

    def wordstat_top(
        self, phrase: str, *, num_phrases: int = 100, region_id: str = MOSCOW_REGION_ID
    ) -> dict[str, Any]:
        if not 1 <= num_phrases <= 2000:
            raise ConfigError("Wordstat num_phrases must be between 1 and 2000")
        payload = {
            "phrase": phrase,
            "numPhrases": num_phrases,
            "regions": [region_id],
            "devices": ["DEVICE_ALL"],
            "folderId": self.credentials.folder_id,
        }
        return self._request("POST", WORDSTAT_TOP_URL, payload)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def parse_serp_xml(raw: bytes | str, limit: int = 100) -> list[SerpDocument]:
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise APIError(f"malformed XML search response: {exc}") from exc
    for element in root.iter():
        if _local_name(element.tag) == "error":
            message = normalize_query("".join(element.itertext())) or "unknown XML error"
            code = element.attrib.get("code")
            raise APIError(f"search XML error{f' {code}' if code else ''}: {message}")

    documents: list[SerpDocument] = []
    for element in root.iter():
        if _local_name(element.tag) != "doc":
            continue
        url = ""
        for child in element.iter():
            if _local_name(child.tag) == "url":
                url = normalize_query("".join(child.itertext()))
                break
        if not url:
            continue
        documents.append(
            SerpDocument(
                position=len(documents) + 1,
                url=url,
                hostname=hostname_from_url(url),
            )
        )
        if len(documents) >= limit:
            break
    return documents


def operation_documents(operation: Mapping[str, Any]) -> list[SerpDocument] | None:
    if not operation.get("done", False):
        return None
    error = operation.get("error")
    if isinstance(error, dict):
        code = normalize_query(error.get("code"))
        message = normalize_query(error.get("message")) or "asynchronous operation failed"
        raise APIError(f"operation error{f' {code}' if code else ''}: {message}")
    response = operation.get("response")
    if not isinstance(response, dict):
        raise APIError("completed operation has neither response nor structured error")
    encoded = response.get("rawData")
    if not isinstance(encoded, str) or not encoded:
        raise APIError("completed operation response has no rawData")
    try:
        raw_xml = base64.b64decode(encoded, validate=False)
    except (ValueError, TypeError) as exc:
        raise APIError("operation rawData is not valid Base64") from exc
    return parse_serp_xml(raw_xml)


def site_matches_host(site: Site, hostname: str) -> bool:
    hostname = normalize_hostname(hostname)
    if hostname in site.domains:
        return True
    return site.include_subdomains and any(
        hostname.endswith("." + domain) for domain in site.domains
    )


def _normal_path(url: str) -> str:
    try:
        path = urllib.parse.urlsplit(url).path
    except ValueError:
        path = url
    path = re.sub(r"/{2,}", "/", path or "/")
    return path if path == "/" else path.rstrip("/")


def target_url_matches(found_url: str, target_url: str) -> bool | None:
    if not target_url:
        return None
    return _normal_path(found_url) == _normal_path(target_url)


def find_site_rank(
    documents: Sequence[SerpDocument], site: Site
) -> SerpDocument | None:
    return next((doc for doc in documents if site_matches_host(site, doc.hostname)), None)


def safe_error_text(error: BaseException | str) -> str:
    return re.sub(r"\s+", " ", str(error)).strip()[:500]


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, timeout=30.0)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA busy_timeout=30000")
        if self.path != ":memory:":
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=NORMAL")
        self.initialize()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()

    def initialize(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                observed_date TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL,
                config_digest TEXT,
                planned_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0,
                message TEXT
            );
            CREATE TABLE IF NOT EXISTS search_jobs (
                job_id INTEGER PRIMARY KEY AUTOINCREMENT,
                observed_date TEXT NOT NULL,
                query TEXT NOT NULL,
                query_key TEXT NOT NULL,
                region_id TEXT NOT NULL,
                device TEXT NOT NULL,
                state TEXT NOT NULL,
                operation_id TEXT,
                submitted_at TEXT,
                completed_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(observed_date, query_key, region_id, device)
            );
            CREATE TABLE IF NOT EXISTS serp_documents (
                job_id INTEGER NOT NULL REFERENCES search_jobs(job_id) ON DELETE CASCADE,
                position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 100),
                url TEXT NOT NULL,
                hostname TEXT NOT NULL,
                PRIMARY KEY(job_id, position)
            );
            CREATE TABLE IF NOT EXISTS rank_snapshots (
                observed_date TEXT NOT NULL,
                site_id TEXT NOT NULL,
                site_name TEXT NOT NULL,
                query TEXT NOT NULL,
                query_key TEXT NOT NULL,
                cluster_name TEXT NOT NULL,
                target_url TEXT NOT NULL,
                region_id TEXT NOT NULL,
                device TEXT NOT NULL,
                position INTEGER CHECK(position BETWEEN 1 AND 100),
                found_url TEXT,
                found_hostname TEXT,
                target_match INTEGER,
                result_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                error TEXT,
                checked_at TEXT NOT NULL,
                run_id TEXT REFERENCES runs(run_id),
                UNIQUE(observed_date, site_id, query_key, region_id, device)
            );
            CREATE INDEX IF NOT EXISTS rank_snapshots_lookup
                ON rank_snapshots(site_id, query_key, region_id, device, observed_date);
            CREATE INDEX IF NOT EXISTS rank_snapshots_date
                ON rank_snapshots(observed_date, site_id);
            CREATE TABLE IF NOT EXISTS wordstat_snapshots (
                observed_date TEXT NOT NULL,
                site_id TEXT NOT NULL,
                seed TEXT NOT NULL,
                phrase TEXT NOT NULL,
                phrase_key TEXT NOT NULL,
                source TEXT NOT NULL,
                count INTEGER NOT NULL CHECK(count > 0),
                region_id TEXT NOT NULL,
                checked_at TEXT NOT NULL,
                run_id TEXT REFERENCES runs(run_id),
                UNIQUE(observed_date, site_id, seed, phrase_key, source, region_id)
            );
            CREATE INDEX IF NOT EXISTS wordstat_phrase_history
                ON wordstat_snapshots(site_id, phrase_key, observed_date);
            """
        )
        with self.connection:
            self.connection.execute(
                "INSERT INTO metadata(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )

    def start_run(
        self, kind: str, observed_date: date, config_digest: str, planned_count: int
    ) -> str:
        run_id = str(uuid.uuid4())
        with self.connection:
            self.connection.execute(
                """INSERT INTO runs(
                       run_id, kind, observed_date, started_at, status,
                       config_digest, planned_count
                   ) VALUES(?, ?, ?, ?, 'running', ?, ?)""",
                (
                    run_id,
                    kind,
                    observed_date.isoformat(),
                    iso_utc(),
                    config_digest,
                    planned_count,
                ),
            )
        return run_id

    def finish_run(
        self,
        run_id: str,
        status: str,
        success_count: int,
        error_count: int,
        message: str = "",
    ) -> None:
        with self.connection:
            self.connection.execute(
                """UPDATE runs
                   SET finished_at=?, status=?, success_count=?, error_count=?, message=?
                   WHERE run_id=?""",
                (iso_utc(), status, success_count, error_count, message, run_id),
            )

    def ensure_job(self, observed_date: date, task: SearchTask) -> sqlite3.Row:
        now = iso_utc()
        with self.connection:
            self.connection.execute(
                """INSERT INTO search_jobs(
                       observed_date, query, query_key, region_id, device,
                       state, created_at, updated_at
                   ) VALUES(?, ?, ?, ?, ?, 'created', ?, ?)
                   ON CONFLICT(observed_date, query_key, region_id, device)
                   DO UPDATE SET query=excluded.query, updated_at=excluded.updated_at""",
                (
                    observed_date.isoformat(),
                    task.query,
                    task.query_key,
                    MOSCOW_REGION_ID,
                    task.device,
                    now,
                    now,
                ),
            )
        row = self.connection.execute(
            """SELECT * FROM search_jobs
               WHERE observed_date=? AND query_key=? AND region_id=? AND device=?""",
            (observed_date.isoformat(), task.query_key, MOSCOW_REGION_ID, task.device),
        ).fetchone()
        assert row is not None
        return row

    def set_job_submitted(self, job_id: int, operation_id: str) -> None:
        now = iso_utc()
        with self.connection:
            self.connection.execute(
                """UPDATE search_jobs
                   SET state='submitted', operation_id=?, submitted_at=COALESCE(submitted_at, ?),
                       last_error=NULL, updated_at=? WHERE job_id=?""",
                (operation_id, now, now, job_id),
            )

    def reset_job(self, job_id: int) -> None:
        with self.connection:
            self.connection.execute(
                """UPDATE search_jobs
                   SET state='created', operation_id=NULL, submitted_at=NULL,
                       completed_at=NULL, last_error=NULL, updated_at=?
                   WHERE job_id=?""",
                (iso_utc(), job_id),
            )

    def load_documents(self, job_id: int) -> list[SerpDocument]:
        return [
            SerpDocument(row["position"], row["url"], row["hostname"])
            for row in self.connection.execute(
                "SELECT position, url, hostname FROM serp_documents "
                "WHERE job_id=? ORDER BY position",
                (job_id,),
            )
        ]

    def store_completed_job(
        self,
        job_id: int,
        documents: Sequence[SerpDocument],
        task: SearchTask,
        observed_date: date,
        run_id: str,
    ) -> None:
        now = iso_utc()
        with self.connection:
            self.connection.execute("DELETE FROM serp_documents WHERE job_id=?", (job_id,))
            self.connection.executemany(
                "INSERT INTO serp_documents(job_id, position, url, hostname) VALUES(?, ?, ?, ?)",
                ((job_id, doc.position, doc.url, doc.hostname) for doc in documents),
            )
            self.connection.execute(
                """UPDATE search_jobs
                   SET state='completed', completed_at=?, last_error=NULL, updated_at=?
                   WHERE job_id=?""",
                (now, now, job_id),
            )
            for plan in task.plans:
                self._upsert_rank_snapshot(
                    observed_date, plan, task.device, documents, run_id, now, None
                )

    def refresh_snapshots_from_documents(
        self,
        observed_date: date,
        task: SearchTask,
        documents: Sequence[SerpDocument],
        run_id: str,
    ) -> None:
        now = iso_utc()
        with self.connection:
            for plan in task.plans:
                self._upsert_rank_snapshot(
                    observed_date, plan, task.device, documents, run_id, now, None
                )

    def mark_job_failure(
        self,
        job_id: int,
        state: str,
        error: BaseException | str,
        task: SearchTask,
        observed_date: date,
        run_id: str,
        *,
        preserve_operation: bool = False,
    ) -> None:
        message = safe_error_text(error)
        now = iso_utc()
        with self.connection:
            self.connection.execute(
                f"""UPDATE search_jobs
                    SET state=?, last_error=?, updated_at=?
                    {'' if preserve_operation else ', operation_id=NULL'}
                    WHERE job_id=?""",
                (state, message, now, job_id),
            )
            for plan in task.plans:
                self._upsert_rank_snapshot(
                    observed_date, plan, task.device, (), run_id, now, message
                )

    def mark_task_failure_only(
        self,
        observed_date: date,
        task: SearchTask,
        run_id: str,
        error: BaseException | str,
    ) -> None:
        message = safe_error_text(error)
        now = iso_utc()
        with self.connection:
            for plan in task.plans:
                self._upsert_rank_snapshot(
                    observed_date, plan, task.device, (), run_id, now, message
                )

    def _upsert_rank_snapshot(
        self,
        observed_date: date,
        plan: ObservationPlan,
        device: str,
        documents: Sequence[SerpDocument],
        run_id: str,
        checked_at: str,
        error: str | None,
    ) -> None:
        found = None if error else find_site_rank(documents, plan.site)
        status = "error" if error else ("ok" if found else "not_found")
        target_match = (
            None
            if not found
            else target_url_matches(found.url, plan.keyword.target_url)
        )
        self.connection.execute(
            """INSERT INTO rank_snapshots(
                   observed_date, site_id, site_name, query, query_key,
                   cluster_name, target_url, region_id, device, position,
                   found_url, found_hostname, target_match, result_count,
                   status, error, checked_at, run_id
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(observed_date, site_id, query_key, region_id, device)
               DO UPDATE SET
                   site_name=excluded.site_name,
                   query=excluded.query,
                   cluster_name=excluded.cluster_name,
                   target_url=excluded.target_url,
                   position=excluded.position,
                   found_url=excluded.found_url,
                   found_hostname=excluded.found_hostname,
                   target_match=excluded.target_match,
                   result_count=excluded.result_count,
                   status=excluded.status,
                   error=excluded.error,
                   checked_at=excluded.checked_at,
                   run_id=excluded.run_id""",
            (
                observed_date.isoformat(),
                plan.site.site_id,
                plan.site.name,
                plan.keyword.query,
                plan.keyword.query_key,
                plan.keyword.cluster,
                plan.keyword.target_url,
                MOSCOW_REGION_ID,
                device,
                found.position if found else None,
                found.url if found else None,
                found.hostname if found else None,
                None if target_match is None else int(target_match),
                len(documents),
                status,
                error,
                checked_at,
                run_id,
            ),
        )

    def snapshot_counts(self, observed_date: date) -> dict[str, int]:
        rows = self.connection.execute(
            """SELECT status, COUNT(*) AS amount FROM rank_snapshots
               WHERE observed_date=? GROUP BY status""",
            (observed_date.isoformat(),),
        )
        result = {"ok": 0, "not_found": 0, "error": 0}
        for row in rows:
            result[row["status"]] = row["amount"]
        return result

    def store_wordstat_rows(
        self,
        observed_date: date,
        site_id: str,
        seed: str,
        rows: Sequence[Mapping[str, Any]],
        run_id: str,
    ) -> None:
        now = iso_utc()
        with self.connection:
            for row in rows:
                self.connection.execute(
                    """INSERT INTO wordstat_snapshots(
                           observed_date, site_id, seed, phrase, phrase_key,
                           source, count, region_id, checked_at, run_id
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(observed_date, site_id, seed, phrase_key, source, region_id)
                       DO UPDATE SET phrase=excluded.phrase, count=excluded.count,
                           checked_at=excluded.checked_at, run_id=excluded.run_id""",
                    (
                        observed_date.isoformat(),
                        site_id,
                        seed,
                        row["phrase"],
                        query_key(row["phrase"]),
                        row["source"],
                        row["count"],
                        MOSCOW_REGION_ID,
                        now,
                        run_id,
                    ),
                )

    def latest_run(self) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def latest_snapshot_date(self) -> str | None:
        row = self.connection.execute(
            "SELECT MAX(observed_date) AS latest FROM rank_snapshots"
        ).fetchone()
        return row["latest"] if row else None


def _is_authentication_failure(error: BaseException) -> bool:
    return isinstance(error, HTTPStatusError) and error.status in {401, 403}


def _is_transient_failure(error: BaseException) -> bool:
    return isinstance(error, NetworkError) or (
        isinstance(error, HTTPStatusError)
        and error.status in {408, 429, 500, 502, 503, 504}
    )


def collect_rankings(
    config: MonitorConfig,
    database: Database,
    client: YandexSearchClient,
    observed_date: date,
    *,
    poll_interval: float = 60.0,
    poll_timeout: float = 10800.0,
    retry_errors: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Submit de-duplicated searches, poll operations and persist snapshots."""

    tasks = build_tasks(config)
    planned_observations = sum(len(task.plans) for task in tasks)
    run_id = database.start_run(
        "rank", observed_date, config.digest, planned_observations
    )
    pending: dict[int, tuple[SearchTask, str]] = {}
    reused_jobs = 0
    submitted_jobs = 0
    try:
        for task in tasks:
            row = database.ensure_job(observed_date, task)
            job_id = int(row["job_id"])
            state = str(row["state"])
            operation_id = str(row["operation_id"] or "")

            if state == "completed":
                documents = database.load_documents(job_id)
                database.refresh_snapshots_from_documents(
                    observed_date, task, documents, run_id
                )
                reused_jobs += 1
                continue
            if state == "error" and not retry_errors:
                database.mark_task_failure_only(
                    observed_date,
                    task,
                    run_id,
                    row["last_error"] or "previous attempt failed; use --retry-errors",
                )
                continue
            if state == "error" and retry_errors:
                database.reset_job(job_id)
                operation_id = ""
            if operation_id and state in {"submitted", "timeout"}:
                pending[job_id] = (task, operation_id)
                continue

            try:
                operation = client.submit_search(task.query, task.device)
            except APIError as exc:
                if _is_authentication_failure(exc):
                    raise ConfigError(
                        "Yandex rejected the configured credential; verify its role and scope"
                    ) from exc
                database.mark_job_failure(
                    job_id, "error", exc, task, observed_date, run_id
                )
                continue
            operation_id = normalize_query(operation.get("id"))
            database.set_job_submitted(job_id, operation_id)
            submitted_jobs += 1
            try:
                documents = operation_documents(operation)
            except APIError as exc:
                database.mark_job_failure(
                    job_id, "error", exc, task, observed_date, run_id
                )
                continue
            if documents is not None:
                database.store_completed_job(
                    job_id, documents, task, observed_date, run_id
                )
            else:
                pending[job_id] = (task, operation_id)

        deadline = monotonic() + max(1.0, poll_timeout)
        while pending:
            for job_id, (task, operation_id) in list(pending.items()):
                try:
                    operation = client.get_operation(operation_id)
                    documents = operation_documents(operation)
                except APIError as exc:
                    if _is_authentication_failure(exc):
                        raise ConfigError(
                            "Yandex rejected the configured credential while polling"
                        ) from exc
                    database.mark_job_failure(
                        job_id,
                        "timeout" if _is_transient_failure(exc) else "error",
                        exc,
                        task,
                        observed_date,
                        run_id,
                        preserve_operation=_is_transient_failure(exc),
                    )
                    del pending[job_id]
                    continue
                if documents is None:
                    continue
                database.store_completed_job(
                    job_id, documents, task, observed_date, run_id
                )
                del pending[job_id]

            if not pending:
                break
            remaining = deadline - monotonic()
            if remaining <= 0:
                for job_id, (task, _operation_id) in list(pending.items()):
                    database.mark_job_failure(
                        job_id,
                        "timeout",
                        "asynchronous operation did not finish before the local poll timeout",
                        task,
                        observed_date,
                        run_id,
                        preserve_operation=True,
                    )
                    del pending[job_id]
                break
            sleep(min(max(1.0, poll_interval), remaining))

        counts = database.snapshot_counts(observed_date)
        successful = counts.get("ok", 0) + counts.get("not_found", 0)
        errors = counts.get("error", 0)
        status = "completed" if errors == 0 and successful == planned_observations else "partial"
        message = (
            f"tasks={len(tasks)}, submitted={submitted_jobs}, reused={reused_jobs}, "
            f"observations={planned_observations}"
        )
        database.finish_run(run_id, status, successful, errors, message)
        return {
            "run_id": run_id,
            "status": status,
            "observed_date": observed_date.isoformat(),
            "tasks": len(tasks),
            "submitted_tasks": submitted_jobs,
            "reused_tasks": reused_jobs,
            "planned_observations": planned_observations,
            "found": counts.get("ok", 0),
            "not_found": counts.get("not_found", 0),
            "errors": errors,
        }
    except Exception as exc:
        counts = database.snapshot_counts(observed_date)
        successful = counts.get("ok", 0) + counts.get("not_found", 0)
        database.finish_run(
            run_id,
            "failed",
            successful,
            counts.get("error", 0),
            safe_error_text(exc),
        )
        raise


def _wordstat_rows(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for source, field in (("result", "results"), ("association", "associations")):
        values = payload.get(field, [])
        if not isinstance(values, list):
            continue
        for value in values:
            if not isinstance(value, dict):
                continue
            phrase = normalize_query(value.get("phrase"))
            try:
                count = int(value.get("count", 0))
            except (TypeError, ValueError):
                continue
            if phrase and count > 0:
                rows.append({"phrase": phrase, "count": count, "source": source})
    rows.sort(key=lambda item: (-item["count"], item["phrase"].casefold(), item["source"]))
    return rows


def discover_wordstat(
    config: MonitorConfig,
    database: Database,
    client: YandexSearchClient,
    observed_date: date,
    site_id: str,
    seeds: Sequence[str],
    num_phrases: int,
) -> dict[str, Any]:
    site = next((item for item in config.sites if item.site_id == site_id), None)
    if site is None:
        raise ConfigError(f"unknown site id: {site_id}")
    effective_seeds = tuple(
        dict.fromkeys(seed for seed in (normalize_query(item) for item in seeds) if seed)
    ) or site.discovery_seeds
    if not effective_seeds:
        raise ConfigError("provide --seed or configure discovery_seeds for this site")

    run_id = database.start_run(
        "wordstat", observed_date, config.digest, len(effective_seeds)
    )
    combined: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        for seed in effective_seeds:
            try:
                payload = client.wordstat_top(seed, num_phrases=num_phrases)
                rows = _wordstat_rows(payload)
                database.store_wordstat_rows(
                    observed_date, site.site_id, seed, rows, run_id
                )
                combined.extend(
                    {"site_id": site.site_id, "seed": seed, **row} for row in rows
                )
            except APIError as exc:
                if _is_authentication_failure(exc):
                    raise ConfigError(
                        "Yandex rejected the configured credential for Wordstat"
                    ) from exc
                errors.append(f"{seed}: {safe_error_text(exc)}")
        status = "completed" if not errors else "partial"
        database.finish_run(
            run_id,
            status,
            len(effective_seeds) - len(errors),
            len(errors),
            "; ".join(errors),
        )
        return {
            "run_id": run_id,
            "status": status,
            "observed_date": observed_date.isoformat(),
            "region_id": MOSCOW_REGION_ID,
            "site_id": site.site_id,
            "seeds": list(effective_seeds),
            "rows": combined,
            "errors": errors,
        }
    except Exception as exc:
        database.finish_run(run_id, "failed", 0, 1, safe_error_text(exc))
        raise


def _position_value(row: Mapping[str, Any] | None) -> int | None:
    if not row:
        return None
    if row.get("status") == "ok" and row.get("position") is not None:
        return int(row["position"])
    if row.get("status") == "not_found":
        return 101
    return None


def build_report(database: Database, as_of: date, days: int) -> dict[str, Any]:
    if days not in {1, 7, 30}:
        raise ConfigError("report window must be today, 7 or 30 days")
    current_rows = [
        dict(row)
        for row in database.connection.execute(
            """SELECT * FROM rank_snapshots WHERE observed_date=?
               ORDER BY site_id, cluster_name, query, device""",
            (as_of.isoformat(),),
        )
    ]
    baseline_target = as_of - timedelta(days=days if days > 1 else 0)
    output_rows: list[dict[str, Any]] = []
    for current in current_rows:
        baseline: dict[str, Any] | None = None
        if days > 1:
            row = database.connection.execute(
                """SELECT observed_date, position, status, found_url
                   FROM rank_snapshots
                   WHERE site_id=? AND query_key=? AND region_id=? AND device=?
                     AND observed_date<=? AND status IN ('ok', 'not_found')
                   ORDER BY observed_date DESC LIMIT 1""",
                (
                    current["site_id"],
                    current["query_key"],
                    current["region_id"],
                    current["device"],
                    baseline_target.isoformat(),
                ),
            ).fetchone()
            baseline = dict(row) if row else None
        current_value = _position_value(current)
        baseline_value = _position_value(baseline)
        change = (
            baseline_value - current_value
            if baseline_value is not None and current_value is not None
            else None
        )
        output_rows.append(
            {
                "site_id": current["site_id"],
                "site_name": current["site_name"],
                "cluster": current["cluster_name"],
                "query": current["query"],
                "region_id": current["region_id"],
                "device": current["device"],
                "status": current["status"],
                "position": current["position"],
                "found_url": current["found_url"],
                "target_url": current["target_url"],
                "target_match": (
                    None
                    if current["target_match"] is None
                    else bool(current["target_match"])
                ),
                "baseline_date": baseline["observed_date"] if baseline else None,
                "baseline_position": (
                    baseline["position"]
                    if baseline and baseline["status"] == "ok"
                    else None
                ),
                "baseline_status": baseline["status"] if baseline else None,
                "change": change,
                "error": current["error"],
                "checked_at": current["checked_at"],
            }
        )
    valid = [row for row in output_rows if row["status"] != "error"]
    positions = [row["position"] for row in valid if row["position"] is not None]
    summary = {
        "tracked": len(output_rows),
        "found": len(positions),
        "not_found_top_100": sum(row["status"] == "not_found" for row in output_rows),
        "errors": sum(row["status"] == "error" for row in output_rows),
        "top_10": sum(position <= 10 for position in positions),
        "top_20": sum(position <= 20 for position in positions),
        "top_50": sum(position <= 50 for position in positions),
        "improved": sum((row["change"] or 0) > 0 for row in output_rows),
        "declined": sum((row["change"] or 0) < 0 for row in output_rows),
        "unchanged": sum(row["change"] == 0 for row in output_rows),
    }
    return {
        "generated_at": iso_utc(),
        "as_of": as_of.isoformat(),
        "window_days": days,
        "baseline_target_date": baseline_target.isoformat() if days > 1 else None,
        "region_id": MOSCOW_REGION_ID,
        "method": "Official Yandex Search API async XML; top 100",
        "summary": summary,
        "rows": output_rows,
    }


REPORT_COLUMNS = (
    "site_id",
    "cluster",
    "query",
    "device",
    "status",
    "position",
    "baseline_date",
    "baseline_position",
    "change",
    "found_url",
    "target_url",
    "target_match",
    "error",
    "checked_at",
)


def _atomic_write(path: Path, content: str, *, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding=encoding, newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o640)
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def report_to_csv(report: Mapping[str, Any]) -> str:
    from io import StringIO

    output = StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=REPORT_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(_csv_safe_row(row) for row in report["rows"])
    return "\ufeff" + output.getvalue()


def _csv_safe_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Prevent spreadsheet formula execution without changing numeric metrics."""

    safe: dict[str, Any] = {}
    for key, value in row.items():
        if isinstance(value, str) and value[:1] in {"=", "+", "-", "@", "\t", "\r"}:
            safe[key] = "'" + value
        else:
            safe[key] = value
    return safe


def _position_label(row: Mapping[str, Any], key: str = "position") -> str:
    value = row.get(key)
    if value is not None:
        return str(value)
    status_key = "status" if key == "position" else "baseline_status"
    if row.get(status_key) == "not_found":
        return ">100"
    return "—"


def _is_http_url(value: str) -> bool:
    try:
        return urllib.parse.urlsplit(value).scheme in {"http", "https"}
    except ValueError:
        return False


def report_to_html(report: Mapping[str, Any]) -> str:
    summary = report["summary"]
    window = report["window_days"]
    title_window = "сегодня" if window == 1 else f"{window} дней"
    cards = "".join(
        f"<div><strong>{html.escape(str(value))}</strong><span>{html.escape(label)}</span></div>"
        for label, value in (
            ("Проверок", summary["tracked"]),
            ("Найдено", summary["found"]),
            ("В топ-10", summary["top_10"]),
            ("Рост", summary["improved"]),
            ("Снижение", summary["declined"]),
            ("Ошибки", summary["errors"]),
        )
    )
    body_rows: list[str] = []
    for row in report["rows"]:
        change = row["change"]
        change_text = "—" if change is None else f"{change:+d}"
        change_class = "up" if change and change > 0 else "down" if change and change < 0 else ""
        url = row.get("found_url") or ""
        safe_url = html.escape(url, quote=True)
        linkable = _is_http_url(url)
        url_html = (
            f'<a href="{safe_url}" rel="noreferrer">{html.escape(url)}</a>'
            if linkable
            else html.escape(url) if url else "—"
        )
        body_rows.append(
            "<tr>"
            f"<td>{html.escape(str(row['site_id']))}</td>"
            f"<td><b>{html.escape(str(row['query']))}</b><small>{html.escape(str(row['cluster'] or '—'))}</small></td>"
            f"<td>{'Телефон' if row['device'] == 'mobile' else 'Компьютер'}</td>"
            f"<td class=rank>{_position_label(row)}</td>"
            f"<td>{_position_label(row, 'baseline_position')}</td>"
            f"<td class=\"{change_class}\">{change_text}</td>"
            f"<td class=url>{url_html}</td>"
            f"<td>{html.escape(str(row.get('error') or ''))}</td>"
            "</tr>"
        )
    empty = (
        "<tr><td colspan=8 class=empty>За выбранную дату снимков пока нет.</td></tr>"
        if not body_rows
        else ""
    )
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO-монитор ЭЛЕГСО — {html.escape(title_window)}</title>
<style>
:root{{--ink:#17251f;--muted:#64736c;--paper:#f5f3ed;--card:#fff;--line:#d9ded9;--green:#0b7654;--red:#a63737}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{max-width:1500px;margin:auto;padding:36px 24px}}header{{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:24px}}
h1{{font:700 clamp(28px,4vw,48px)/1.05 Georgia,serif;margin:5px 0}}p{{margin:0;color:var(--muted)}}.eyebrow{{color:var(--green);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}}
.cards{{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:18px}}.cards div{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px}}
.cards strong{{display:block;font:700 25px Georgia,serif}}.cards span,small{{display:block;color:var(--muted);font-size:12px}}
.table{{overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:14px}}table{{width:100%;border-collapse:collapse;min-width:1050px}}
th,td{{padding:12px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}}th{{position:sticky;top:0;background:#ecf0ec;font-size:11px;letter-spacing:.06em;text-transform:uppercase}}
.rank{{font-size:20px;font-weight:800}}.up{{color:var(--green);font-weight:800}}.down{{color:var(--red);font-weight:800}}.url{{max-width:360px;overflow-wrap:anywhere}}a{{color:var(--green)}}.empty{{padding:40px;text-align:center;color:var(--muted)}}footer{{margin-top:14px;font-size:12px;color:var(--muted)}}
@media(max-width:900px){{.cards{{grid-template-columns:repeat(3,1fr)}}header{{display:block}}}}@media(max-width:520px){{main{{padding:22px 12px}}.cards{{grid-template-columns:repeat(2,1fr)}}}}
</style></head><body><main><header><div><div class=eyebrow>Официальный Yandex Search API · Москва 213</div><h1>Позиции сайта</h1><p>Дата снимка: {report['as_of']} · сравнение: {html.escape(title_window)}</p></div><p>Сформировано {html.escape(str(report['generated_at']))}</p></header>
<section class=cards>{cards}</section><section class=table><table><thead><tr><th>Сайт</th><th>Запрос</th><th>Устройство</th><th>Позиция</th><th>Было</th><th>Изменение</th><th>Найденная страница</th><th>Ошибка</th></tr></thead><tbody>{''.join(body_rows)}{empty}</tbody></table></section>
<footer>Позиция является воспроизводимым снимком Search API, а не персонализированной ручной выдачей. Значение &gt;100 означает отсутствие домена в первых 100 органических результатах.</footer></main></body></html>"""


def write_reports(
    database: Database,
    output_dir: Path,
    as_of: date,
    windows: Sequence[int] = (1, 7, 30),
) -> list[Path]:
    written: list[Path] = []
    for days in windows:
        report = build_report(database, as_of, days)
        stem = "rank-today" if days == 1 else f"rank-{days}d"
        json_path = output_dir / f"{stem}.json"
        csv_path = output_dir / f"{stem}.csv"
        html_path = output_dir / f"{stem}.html"
        _atomic_write(json_path, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        _atomic_write(csv_path, report_to_csv(report))
        _atomic_write(html_path, report_to_html(report))
        written.extend((json_path, csv_path, html_path))
    if 1 in windows:
        _atomic_write(output_dir / "index.html", report_to_html(build_report(database, as_of, 1)))
        written.append(output_dir / "index.html")
    return written


def parse_date(value: str | None) -> date:
    if not value:
        return moscow_today()
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ConfigError("date must use YYYY-MM-DD format") from exc


def _number_from_env(name: str, default: float, cast: Callable[[str], Any]) -> Any:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return cast(str(default))
    try:
        return cast(value)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number") from exc


def client_from_environment() -> YandexSearchClient:
    credentials = load_credentials()
    return YandexSearchClient(
        credentials,
        os.environ.get("YANDEX_SEARCH_GEO_IP", DEFAULT_GEO_IP),
        http_timeout=_number_from_env("SEO_MONITOR_HTTP_TIMEOUT", 30, float),
        max_retries=_number_from_env("SEO_MONITOR_HTTP_RETRIES", 5, int),
        min_request_interval=_number_from_env(
            "SEO_MONITOR_MIN_REQUEST_INTERVAL", 0.15, float
        ),
    )


def _default_path(environment_name: str, fallback: str) -> str:
    return os.environ.get(environment_name, fallback)


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Multi-site rank monitor using the official Yandex Search API"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="submit and collect today's rank checks")
    run.add_argument(
        "--config",
        default=_default_path(
            "SEO_MONITOR_CONFIG", "/etc/elegso-seo-monitor/keywords.json"
        ),
    )
    run.add_argument(
        "--db",
        default=_default_path(
            "SEO_MONITOR_DB", "/var/lib/elegso-seo-monitor/history.sqlite3"
        ),
    )
    run.add_argument(
        "--report-dir",
        default=_default_path(
            "SEO_MONITOR_REPORT_DIR", "/var/lib/elegso-seo-monitor/reports"
        ),
    )
    run.add_argument("--date", help="Moscow observation date, YYYY-MM-DD")
    run.add_argument(
        "--poll-interval",
        type=float,
        default=_number_from_env("SEO_MONITOR_POLL_INTERVAL", 60, float),
    )
    run.add_argument(
        "--poll-timeout",
        type=float,
        default=_number_from_env("SEO_MONITOR_POLL_TIMEOUT", 10800, float),
    )
    run.add_argument(
        "--retry-errors",
        action="store_true",
        help="resubmit same-day jobs already marked as failed",
    )

    report = subparsers.add_parser("report", help="render reports from local history")
    report.add_argument(
        "--db",
        default=_default_path(
            "SEO_MONITOR_DB", "/var/lib/elegso-seo-monitor/history.sqlite3"
        ),
    )
    report.add_argument(
        "--output-dir",
        default=_default_path(
            "SEO_MONITOR_REPORT_DIR", "/var/lib/elegso-seo-monitor/reports"
        ),
    )
    report.add_argument("--date", help="snapshot date, YYYY-MM-DD")
    report.add_argument(
        "--window", choices=("all", "today", "7", "30"), default="all"
    )

    discover = subparsers.add_parser(
        "discover", help="find non-zero query candidates with official Wordstat GetTop"
    )
    discover.add_argument(
        "--config",
        default=_default_path(
            "SEO_MONITOR_CONFIG", "/etc/elegso-seo-monitor/keywords.json"
        ),
    )
    discover.add_argument(
        "--db",
        default=_default_path(
            "SEO_MONITOR_DB", "/var/lib/elegso-seo-monitor/history.sqlite3"
        ),
    )
    discover.add_argument("--site", required=True, help="site id from keyword config")
    discover.add_argument("--seed", action="append", default=[])
    discover.add_argument("--num-phrases", type=int, default=100)
    discover.add_argument("--date", help="Moscow observation date, YYYY-MM-DD")
    discover.add_argument("--format", choices=("json", "csv"), default="json")
    discover.add_argument("--output", default="-", help="file path or - for stdout")

    status = subparsers.add_parser(
        "status", help="show local state; this command never requires an API key"
    )
    status.add_argument(
        "--config",
        default=_default_path(
            "SEO_MONITOR_CONFIG", "/etc/elegso-seo-monitor/keywords.json"
        ),
    )
    status.add_argument(
        "--db",
        default=_default_path(
            "SEO_MONITOR_DB", "/var/lib/elegso-seo-monitor/history.sqlite3"
        ),
    )
    status.add_argument("--json", action="store_true")

    initialize = subparsers.add_parser("init-db", help="initialize an empty database")
    initialize.add_argument(
        "--db",
        default=_default_path(
            "SEO_MONITOR_DB", "/var/lib/elegso-seo-monitor/history.sqlite3"
        ),
    )
    return parser


def _print_json(payload: Mapping[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _write_discovery_output(result: Mapping[str, Any], output_format: str, path: str) -> None:
    if output_format == "json":
        content = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    else:
        from io import StringIO

        stream = StringIO(newline="")
        writer = csv.DictWriter(
            stream, fieldnames=("site_id", "seed", "source", "phrase", "count")
        )
        writer.writeheader()
        writer.writerows(_csv_safe_row(row) for row in result["rows"])
        content = "\ufeff" + stream.getvalue()
    if path == "-":
        sys.stdout.write(content)
    else:
        _atomic_write(Path(path), content)


def status_payload(config_path: Path, db_path: Path) -> dict[str, Any]:
    config = load_config(config_path)
    raw_folder_id = os.environ.get("YANDEX_FOLDER_ID", "").strip()
    raw_api_key = os.environ.get("YANDEX_SEARCH_API_KEY", "").strip()
    raw_iam_token = os.environ.get("YANDEX_IAM_TOKEN", "").strip()
    folder_id = bool(raw_folder_id and not raw_folder_id.startswith("replace-"))
    api_key = bool(raw_api_key and not raw_api_key.startswith("replace-"))
    iam_token = bool(raw_iam_token and not raw_iam_token.startswith("replace-"))
    payload: dict[str, Any] = {
        "status": "configured",
        "config": str(config_path),
        "config_digest": config.digest,
        "sites": [
            {
                "id": site.site_id,
                "name": site.name,
                "keywords": len(site.keywords),
                "domains": sorted(site.domains),
            }
            for site in config.sites
        ],
        "search_tasks_per_day": len(build_tasks(config)),
        "credentials": {
            "folder_id_set": folder_id,
            "api_key_set": api_key,
            "iam_token_set": iam_token,
            "valid_shape": folder_id and api_key != iam_token,
        },
        "database": str(db_path),
        "database_exists": db_path.exists(),
        "latest_run": None,
        "latest_snapshot_date": None,
    }
    if db_path.exists():
        with Database(db_path) as database:
            payload["latest_run"] = database.latest_run()
            payload["latest_snapshot_date"] = database.latest_snapshot_date()
    return payload


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = create_parser().parse_args(argv)
        if args.command == "init-db":
            with Database(Path(args.db)):
                pass
            print(f"initialized {args.db}")
            return 0

        if args.command == "status":
            payload = status_payload(Path(args.config), Path(args.db))
            if args.json:
                _print_json(payload)
            else:
                print(f"Configuration: {payload['config']}")
                print(
                    f"Sites: {len(payload['sites'])}; "
                    f"daily API searches: {payload['search_tasks_per_day']}"
                )
                print(
                    "Credentials configured: "
                    + ("yes" if payload["credentials"]["valid_shape"] else "no")
                )
                print(f"Database exists: {'yes' if payload['database_exists'] else 'no'}")
                print(f"Latest snapshot: {payload['latest_snapshot_date'] or 'none'}")
                if payload["latest_run"]:
                    latest = payload["latest_run"]
                    print(
                        f"Latest run: {latest['started_at']} · {latest['kind']} · {latest['status']}"
                    )
            return 0

        if args.command == "report":
            observed_date = parse_date(args.date)
            windows = {
                "all": (1, 7, 30),
                "today": (1,),
                "7": (7,),
                "30": (30,),
            }[args.window]
            with Database(Path(args.db)) as database:
                paths = write_reports(
                    database, Path(args.output_dir), observed_date, windows
                )
            print("\n".join(str(path) for path in paths))
            return 0

        if args.command == "run":
            config = load_config(Path(args.config))
            client = client_from_environment()
            observed_date = parse_date(args.date)
            with Database(Path(args.db)) as database:
                result = collect_rankings(
                    config,
                    database,
                    client,
                    observed_date,
                    poll_interval=args.poll_interval,
                    poll_timeout=args.poll_timeout,
                    retry_errors=args.retry_errors,
                )
                paths = write_reports(database, Path(args.report_dir), observed_date)
            result["reports"] = [str(path) for path in paths]
            _print_json(result)
            return 0 if result["status"] == "completed" else 1

        if args.command == "discover":
            config = load_config(Path(args.config))
            client = client_from_environment()
            observed_date = parse_date(args.date)
            with Database(Path(args.db)) as database:
                result = discover_wordstat(
                    config,
                    database,
                    client,
                    observed_date,
                    args.site,
                    args.seed,
                    args.num_phrases,
                )
            _write_discovery_output(result, args.format, args.output)
            return 0 if result["status"] == "completed" else 1
        raise ConfigError(f"unsupported command: {args.command}")
    except ConfigError as exc:
        print(f"configuration error: {safe_error_text(exc)}", file=sys.stderr)
        return 78
    except MonitorError as exc:
        print(f"monitor error: {safe_error_text(exc)}", file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error) as exc:
        print(f"local storage error: {safe_error_text(exc)}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
