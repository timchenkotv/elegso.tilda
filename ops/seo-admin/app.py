#!/usr/bin/env python3
"""Private ELEGSO SEO dashboard served behind nginx authentication."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn, UnixStreamServer
from typing import Any, Iterator, Mapping, Sequence


HERE = Path(__file__).resolve().parent
MONITOR_DIR = Path(os.environ.get("SEO_MONITOR_PROGRAM_DIR", str(HERE)))
if str(MONITOR_DIR) not in sys.path:
    sys.path.insert(0, str(MONITOR_DIR))

import seo_monitor as monitor  # noqa: E402


REGION_NAMES = monitor.REGION_NAMES
MAX_BODY = 512 * 1024
MAX_KEYWORDS = 500


def iso_utc() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )


def open_monitor_database(path: Path) -> sqlite3.Connection | None:
    if not path.is_file():
        return None
    quoted = urllib.parse.quote(str(path), safe="/")
    connection = sqlite3.connect(
        f"file:{quoted}?mode=ro", uri=True, timeout=10.0, check_same_thread=False
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


@contextmanager
def open_admin_database(path: Path) -> Iterator[sqlite3.Connection]:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10.0, check_same_thread=False)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.executescript(
            """
        CREATE TABLE IF NOT EXISTS traffic_daily (
            observed_date TEXT PRIMARY KEY,
            pageviews INTEGER NOT NULL DEFAULT 0,
            asset_requests INTEGER NOT NULL DEFAULT 0,
            error_requests INTEGER NOT NULL DEFAULT 0,
            bot_requests INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS traffic_pages (
            observed_date TEXT NOT NULL,
            path TEXT NOT NULL,
            pageviews INTEGER NOT NULL,
            PRIMARY KEY(observed_date, path)
        );
        CREATE TABLE IF NOT EXISTS traffic_referrers (
            observed_date TEXT NOT NULL,
            referrer TEXT NOT NULL,
            pageviews INTEGER NOT NULL,
            PRIMARY KEY(observed_date, referrer)
        );
        CREATE TABLE IF NOT EXISTS traffic_devices (
            observed_date TEXT NOT NULL,
            device TEXT NOT NULL,
            pageviews INTEGER NOT NULL,
            PRIMARY KEY(observed_date, device)
        );
        CREATE TABLE IF NOT EXISTS traffic_errors (
            observed_date TEXT NOT NULL,
            status INTEGER NOT NULL,
            path TEXT NOT NULL,
            requests INTEGER NOT NULL,
            PRIMARY KEY(observed_date, status, path)
        );
        CREATE TABLE IF NOT EXISTS metrika_daily (
            observed_date TEXT PRIMARY KEY,
            visits INTEGER NOT NULL DEFAULT 0,
            users INTEGER NOT NULL DEFAULT 0,
            pageviews INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS metrika_queries (
            period_from TEXT NOT NULL,
            period_to TEXT NOT NULL,
            query TEXT NOT NULL,
            visits INTEGER NOT NULL DEFAULT 0,
            users INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(period_from, period_to, query)
        );
        CREATE TABLE IF NOT EXISTS metrika_pages (
            period_from TEXT NOT NULL,
            period_to TEXT NOT NULL,
            page TEXT NOT NULL,
            visits INTEGER NOT NULL DEFAULT 0,
            users INTEGER NOT NULL DEFAULT 0,
            pageviews INTEGER NOT NULL DEFAULT 0,
            bounce_rate REAL,
            avg_duration_seconds REAL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(period_from, period_to, page)
        );
        CREATE TABLE IF NOT EXISTS metrika_goals (
            period_from TEXT NOT NULL,
            period_to TEXT NOT NULL,
            goal TEXT NOT NULL,
            reaches INTEGER NOT NULL DEFAULT 0,
            conversion_rate REAL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(period_from, period_to, goal)
        );
        CREATE TABLE IF NOT EXISTS metrika_breakdowns (
            period_from TEXT NOT NULL,
            period_to TEXT NOT NULL,
            kind TEXT NOT NULL,
            dimension_1 TEXT NOT NULL,
            dimension_2 TEXT NOT NULL DEFAULT '',
            dimension_3 TEXT NOT NULL DEFAULT '',
            visits INTEGER NOT NULL DEFAULT 0,
            users INTEGER NOT NULL DEFAULT 0,
            pageviews INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(period_from, period_to, kind, dimension_1, dimension_2, dimension_3)
        );
        CREATE TABLE IF NOT EXISTS webmaster_queries (
            period_from TEXT NOT NULL,
            period_to TEXT NOT NULL,
            query TEXT NOT NULL,
            device TEXT NOT NULL DEFAULT 'ALL',
            shows REAL,
            clicks REAL,
            avg_show_position REAL,
            avg_click_position REAL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(period_from, period_to, query, device)
        );
        CREATE TABLE IF NOT EXISTS integration_runs (
            provider TEXT PRIMARY KEY,
            last_attempt_at TEXT,
            last_success_at TEXT,
            status TEXT NOT NULL,
            message TEXT
        );
            """
        )
        yield connection
    finally:
        connection.close()


@contextmanager
def open_access_database(path: Path) -> Iterator[sqlite3.Connection]:
    """Open the private role/audit database, isolated from analytics ingest."""
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10.0, check_same_thread=False)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.executescript(
            """
        CREATE TABLE IF NOT EXISTS audit_log (
            audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
            changed_at TEXT NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            before_digest TEXT,
            after_digest TEXT,
            details TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            role TEXT NOT NULL CHECK(role IN ('admin', 'viewer')),
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
            """
        )
        yield connection
    finally:
        connection.close()


def load_raw_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("configuration root must be an object")
    return payload


def current_keyword_keys(config: monitor.MonitorConfig) -> set[str]:
    return {
        keyword.query_key
        for site in config.sites
        for keyword in site.keywords
    }


def latest_rank_rows(
    connection: sqlite3.Connection,
    config: monitor.MonitorConfig,
) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    latest_row = connection.execute(
        "SELECT MAX(observed_date) AS value FROM rank_snapshots"
    ).fetchone()
    latest = str(latest_row["value"]) if latest_row and latest_row["value"] else None
    if not latest:
        return None, None, []
    previous_row = connection.execute(
        "SELECT MAX(observed_date) AS value FROM rank_snapshots WHERE observed_date<?",
        (latest,),
    ).fetchone()
    previous = (
        str(previous_row["value"])
        if previous_row and previous_row["value"]
        else None
    )
    active_queries = current_keyword_keys(config)
    active_regions = set(config.region_ids)
    current = [
        dict(row)
        for row in connection.execute(
            """SELECT * FROM rank_snapshots WHERE observed_date=?
               ORDER BY region_id, cluster_name, query, device""",
            (latest,),
        )
        if row["query_key"] in active_queries and row["region_id"] in active_regions
    ]
    baseline: dict[tuple[str, str, str, str], sqlite3.Row] = {}
    if previous:
        baseline = {
            (row["site_id"], row["query_key"], row["region_id"], row["device"]): row
            for row in connection.execute(
                "SELECT * FROM rank_snapshots WHERE observed_date=?", (previous,)
            )
        }
    output: list[dict[str, Any]] = []
    for row in current:
        key = (row["site_id"], row["query_key"], row["region_id"], row["device"])
        before = baseline.get(key)
        current_value = (
            int(row["position"])
            if row["status"] == "ok" and row["position"] is not None
            else 101 if row["status"] == "not_found" else None
        )
        before_value = (
            int(before["position"])
            if before and before["status"] == "ok" and before["position"] is not None
            else 101 if before and before["status"] == "not_found" else None
        )
        change = (
            before_value - current_value
            if current_value is not None and before_value is not None
            else None
        )
        output.append(
            {
                "site_id": row["site_id"],
                "query": row["query"],
                "query_key": row["query_key"],
                "cluster": row["cluster_name"],
                "target_url": row["target_url"],
                "region_id": row["region_id"],
                "region_name": REGION_NAMES.get(
                    row["region_id"], f"Регион {row['region_id']}"
                ),
                "device": row["device"],
                "status": row["status"],
                "position": row["position"],
                "previous_position": before["position"] if before else None,
                "change": change,
                "found_url": row["found_url"],
                "target_match": (
                    None
                    if row["target_match"] is None
                    else bool(row["target_match"])
                ),
                "error": row["error"],
                "checked_at": row["checked_at"],
            }
        )
    return latest, previous, output


def summarize_ranks(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    positions = [
        int(row["position"])
        for row in rows
        if row.get("status") == "ok" and row.get("position") is not None
    ]
    return {
        "checks": len(rows),
        "found": len(positions),
        "top10": sum(value <= 10 for value in positions),
        "top20": sum(value <= 20 for value in positions),
        "top50": sum(value <= 50 for value in positions),
        "not_found": sum(row.get("status") == "not_found" for row in rows),
        "errors": sum(row.get("status") == "error" for row in rows),
        "improved": sum((row.get("change") or 0) > 0 for row in rows),
        "declined": sum((row.get("change") or 0) < 0 for row in rows),
        "average_position": (
            round(sum(positions) / len(positions), 1) if positions else None
        ),
    }


def queue_summary(connection: sqlite3.Connection) -> dict[str, Any]:
    tables = {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    if "wordstat_jobs" not in tables:
        return {"pending": 0, "completed": 0, "error": 0, "supported": False}
    counts = {
        "queued": 0,
        "deferred": 0,
        "running": 0,
        "completed": 0,
        "error": 0,
    }
    for row in connection.execute(
        "SELECT state, COUNT(*) AS amount FROM wordstat_jobs GROUP BY state"
    ):
        counts[str(row["state"])] = int(row["amount"])
    next_row = connection.execute(
        "SELECT MIN(not_before) AS value FROM wordstat_jobs WHERE state='deferred'"
    ).fetchone()
    calls_row = connection.execute(
        """SELECT COUNT(*) AS amount FROM api_call_log
           WHERE endpoint='wordstat' AND attempted_at>=?""",
        ((datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),),
    ).fetchone()
    return {
        **counts,
        "pending": counts["queued"] + counts["deferred"] + counts["running"],
        "next_not_before": next_row["value"] if next_row else None,
        "calls_last_hour": int(calls_row["amount"] if calls_row else 0),
        "hourly_limit": int(os.environ.get("SEO_MONITOR_WORDSTAT_HOURLY_LIMIT", "90")),
        "supported": True,
    }


def dashboard_payload(app: "Application", actor: str = "") -> dict[str, Any]:
    config = monitor.load_config(app.config_path)
    connection = open_monitor_database(app.monitor_db_path)
    if connection is None:
        return {
            "generated_at": iso_utc(),
            "latest_date": None,
            "previous_date": None,
            "summary": summarize_ranks([]),
            "regions": [
                {"id": item, "name": REGION_NAMES.get(item, f"Регион {item}")}
                for item in config.region_ids
            ],
            "region_summaries": [],
            "queue": {"pending": 0, "supported": False},
            "keywords": sum(len(site.keywords) for site in config.sites),
            "integrations": app.integration_status(),
            "current_user": app.current_user(actor),
        }
    try:
        latest, previous, rows = latest_rank_rows(connection, config)
        region_summaries = []
        for region_id in config.region_ids:
            regional = [row for row in rows if row["region_id"] == region_id]
            region_summaries.append(
                {
                    "id": region_id,
                    "name": REGION_NAMES.get(region_id, f"Регион {region_id}"),
                    **summarize_ranks(regional),
                }
            )
        last_run = connection.execute(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        return {
            "generated_at": iso_utc(),
            "latest_date": latest,
            "previous_date": previous,
            "summary": summarize_ranks(rows),
            "regions": [
                {"id": item, "name": REGION_NAMES.get(item, f"Регион {item}")}
                for item in config.region_ids
            ],
            "region_summaries": region_summaries,
            "queue": queue_summary(connection),
            "keywords": sum(len(site.keywords) for site in config.sites),
            "last_run": dict(last_run) if last_run else None,
            "integrations": app.integration_status(),
            "current_user": app.current_user(actor),
        }
    finally:
        connection.close()


class Application:
    def __init__(self) -> None:
        self.bind = os.environ.get("SEO_ADMIN_BIND", "127.0.0.1")
        self.port = int(os.environ.get("SEO_ADMIN_PORT", "8790"))
        self.socket_path = os.environ.get("SEO_ADMIN_SOCKET", "").strip()
        self.monitor_db_path = Path(
            os.environ.get(
                "SEO_MONITOR_DB", "/var/lib/elegso-seo-monitor/history.sqlite3"
            )
        )
        self.config_path = Path(
            os.environ.get(
                "SEO_MONITOR_CONFIG",
                "/var/lib/elegso-seo-admin/config/keywords.json",
            )
        )
        self.admin_db_path = Path(
            os.environ.get(
                "SEO_ADMIN_DB", "/var/lib/elegso-seo-admin/data/analytics.sqlite3"
            )
        )
        self.access_db_path = Path(
            os.environ.get(
                "SEO_ADMIN_ACCESS_DB",
                "/var/lib/elegso-seo-admin/access/access.sqlite3",
            )
        )
        self.static_dir = Path(
            os.environ.get("SEO_ADMIN_STATIC_DIR", str(HERE / "static"))
        )
        self.allowed_origin = os.environ.get(
            "SEO_ADMIN_ALLOWED_ORIGIN", "https://elegso.ru"
        ).rstrip("/")
        self.owner = os.environ.get("SEO_ADMIN_OWNER", "").strip().casefold()
        if not self.owner:
            raise RuntimeError("SEO_ADMIN_OWNER must be configured")
        self.htpasswd_path = Path(
            os.environ.get(
                "SEO_ADMIN_HTPASSWD",
                "/var/lib/elegso-seo-admin/auth/users.htpasswd",
            )
        )
        self.metrika_counter = os.environ.get("YANDEX_METRIKA_COUNTER", "87831358")
        # The HTTP server is threaded. Serialize changes to the shared
        # htpasswd file so two simultaneous user-management requests cannot
        # overwrite one another.
        self.user_lock = threading.Lock()
        with open_access_database(self.access_db_path) as connection:
            if self.owner:
                now = iso_utc()
                connection.execute(
                    """INSERT INTO users(username, role, active, created_at, updated_at)
                       VALUES(?, 'admin', 1, ?, ?)
                       ON CONFLICT(username) DO UPDATE SET role='admin', active=1,
                           updated_at=excluded.updated_at""",
                    (self.owner, now, now),
                )
            connection.commit()

    def actor_role(self, actor: str) -> str | None:
        username = actor.strip().casefold()
        if not username:
            return None
        with open_access_database(self.access_db_path) as connection:
            row = connection.execute(
                "SELECT role FROM users WHERE username=? AND active=1", (username,)
            ).fetchone()
        return str(row["role"]) if row else None

    def current_user(self, actor: str) -> dict[str, Any]:
        username = actor.strip().casefold()
        return {
            "username": username,
            "role": self.actor_role(username),
            "is_owner": bool(username and username == self.owner),
        }

    def require_authenticated(self, actor: str) -> str:
        role = self.actor_role(actor)
        if role not in {"admin", "viewer"}:
            raise PermissionError("dashboard access is not active")
        return role

    def require_admin(self, actor: str) -> None:
        if self.actor_role(actor) != "admin":
            raise PermissionError("administrator access is required")

    def require_owner(self, actor: str) -> None:
        username = actor.strip().casefold()
        if not self.owner or username != self.owner or self.actor_role(username) != "admin":
            raise PermissionError("owner access is required")

    def users(self, actor: str) -> dict[str, Any]:
        self.require_owner(actor)
        with open_access_database(self.access_db_path) as connection:
            rows = [
                dict(row)
                for row in connection.execute(
                    """SELECT username, role, active, created_at, updated_at
                       FROM users ORDER BY role, username"""
                )
            ]
        return {"rows": rows, "owner": self.owner}

    def save_user(self, payload: Mapping[str, Any], actor: str) -> dict[str, Any]:
        self.require_owner(actor)
        username = str(payload.get("username", "")).strip().casefold()
        password = str(payload.get("password", ""))
        role = str(payload.get("role", "viewer")).strip().lower()
        if not re.fullmatch(r"[^\s:@]+(?:\.[^\s:@]+)*@[^\s:@]+(?:\.[^\s:@]+)+", username):
            raise ValueError("enter a valid email address")
        if len(username) > 200 or ":" in username:
            raise ValueError("unsupported username")
        if role not in {"viewer", "admin"}:
            raise ValueError("unsupported role")
        if username == self.owner and role != "admin":
            raise ValueError("the owner account must remain an administrator")
        if len(password) < 12 or len(password) > 256:
            raise ValueError("password must contain 12-256 characters")
        with self.user_lock:
            self.htpasswd_path.parent.mkdir(parents=True, exist_ok=True)
            if not self.htpasswd_path.exists():
                self.htpasswd_path.touch(mode=0o640)
            result = subprocess.run(
                [
                    "/usr/bin/htpasswd",
                    "-B",
                    "-C",
                    "12",
                    "-i",
                    str(self.htpasswd_path),
                    username,
                ],
                input=password + "\n",
                text=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=15,
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError("password hash could not be created")
            os.chmod(self.htpasswd_path, 0o640)
            now = iso_utc()
            with open_access_database(self.access_db_path) as connection:
                connection.execute(
                    """INSERT INTO users(username, role, active, created_at, updated_at)
                       VALUES(?, ?, 1, ?, ?)
                       ON CONFLICT(username) DO UPDATE SET role=excluded.role,
                           active=1, updated_at=excluded.updated_at""",
                    (username, role, now, now),
                )
                connection.execute(
                    """INSERT INTO audit_log(
                           changed_at, actor, action, details
                       ) VALUES(?, ?, 'save_user', ?)""",
                    (now, actor[:200], json.dumps({"username": username, "role": role})),
                )
                connection.commit()
        return {"status": "saved", "username": username, "role": role}

    def delete_user(self, username: str, actor: str) -> dict[str, Any]:
        self.require_owner(actor)
        username = username.strip().casefold()
        if not username:
            raise ValueError("username is required")
        if username == self.owner:
            raise ValueError("the owner account cannot be deleted")
        with self.user_lock:
            result = subprocess.run(
                ["/usr/bin/htpasswd", "-D", str(self.htpasswd_path), username],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=15,
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError("account could not be removed")
            now = iso_utc()
            with open_access_database(self.access_db_path) as connection:
                connection.execute("DELETE FROM users WHERE username=?", (username,))
                connection.execute(
                    """INSERT INTO audit_log(changed_at, actor, action, details)
                       VALUES(?, ?, 'delete_user', ?)""",
                    (now, actor[:200], json.dumps({"username": username})),
                )
                connection.commit()
        return {"status": "deleted", "username": username}

    def integration_status(self) -> dict[str, Any]:
        connection = open_monitor_database(self.admin_db_path)
        if connection is None:
            rows: dict[str, dict[str, Any]] = {}
        else:
            try:
                rows = {
                    row["provider"]: dict(row)
                    for row in connection.execute("SELECT * FROM integration_runs")
                }
            except sqlite3.OperationalError:
                rows = {}
            finally:
                connection.close()
        return {
            "metrika": {
                # OAuth secrets are intentionally not exposed to this
                # long-running web process. Presence of a synchronization
                # record proves that the isolated oneshot has attempted the
                # integration.
                "configured": bool(rows.get("metrika")),
                "counter": self.metrika_counter,
                "last_run": rows.get("metrika"),
            },
            "webmaster": {
                "configured": bool(rows.get("webmaster")),
                "last_run": rows.get("webmaster"),
            },
            "server_traffic": {"configured": True, "last_run": rows.get("nginx")},
        }

    def rankings(self, parameters: Mapping[str, Sequence[str]]) -> dict[str, Any]:
        config = monitor.load_config(self.config_path)
        connection = open_monitor_database(self.monitor_db_path)
        if connection is None:
            return {"latest_date": None, "previous_date": None, "rows": []}
        try:
            latest, previous, rows = latest_rank_rows(connection, config)
        finally:
            connection.close()
        region = (parameters.get("region") or [""])[0]
        device = (parameters.get("device") or [""])[0]
        phrase = (parameters.get("q") or [""])[0].casefold().strip()
        cluster = (parameters.get("cluster") or [""])[0].casefold().strip()
        if region:
            rows = [row for row in rows if row["region_id"] == region]
        if device:
            rows = [row for row in rows if row["device"] == device]
        if phrase:
            rows = [row for row in rows if phrase in row["query"].casefold()]
        if cluster:
            rows = [row for row in rows if cluster == row["cluster"].casefold()]
        return {
            "latest_date": latest,
            "previous_date": previous,
            "summary": summarize_ranks(rows),
            "rows": rows[:1000],
        }

    def history(self, parameters: Mapping[str, Sequence[str]]) -> dict[str, Any]:
        query = (parameters.get("query") or [""])[0].strip()
        region = (parameters.get("region") or [""])[0].strip()
        device = (parameters.get("device") or ["desktop"])[0].strip()
        if not query or not re.fullmatch(r"[0-9]{1,10}", region):
            raise ValueError("query and numeric region are required")
        if device not in {"desktop", "mobile"}:
            raise ValueError("unsupported device")
        connection = open_monitor_database(self.monitor_db_path)
        if connection is None:
            return {"query": query, "region": region, "device": device, "rows": []}
        try:
            rows = [
                {
                    "date": row["observed_date"],
                    "position": row["position"] if row["position"] is not None else 101,
                    "status": row["status"],
                    "found_url": row["found_url"],
                }
                for row in connection.execute(
                    """SELECT observed_date, position, status, found_url
                       FROM rank_snapshots
                       WHERE query_key=? AND region_id=? AND device=?
                       ORDER BY observed_date""",
                    (monitor.query_key(query), region, device),
                )
                if row["status"] in {"ok", "not_found"}
            ]
        finally:
            connection.close()
        forecast = None
        values = [float(row["position"]) for row in rows[-30:]]
        if len(values) >= 7:
            n = len(values)
            x_mean = (n - 1) / 2
            y_mean = sum(values) / n
            denominator = sum((index - x_mean) ** 2 for index in range(n))
            slope = (
                sum(
                    (index - x_mean) * (value - y_mean)
                    for index, value in enumerate(values)
                )
                / denominator
                if denominator
                else 0.0
            )
            forecast = max(1, min(101, round(values[-1] + slope * 14, 1)))
        return {
            "query": query,
            "region": region,
            "device": device,
            "rows": rows,
            "forecast_14_days": forecast,
            "forecast_note": "Линейный ориентир по истории, не гарантия позиции.",
        }

    def keywords(self) -> dict[str, Any]:
        raw = load_raw_config(self.config_path)
        parsed = monitor.load_config(self.config_path)
        connection = open_monitor_database(self.monitor_db_path)
        frequencies: dict[tuple[str, str], int] = {}
        if connection is not None:
            try:
                latest_row = connection.execute(
                    "SELECT MAX(observed_date) AS value FROM wordstat_snapshots"
                ).fetchone()
                latest = latest_row["value"] if latest_row else None
                if latest:
                    frequencies = {
                        (row["phrase_key"], row["region_id"]): int(row["amount"])
                        for row in connection.execute(
                            """SELECT phrase_key, region_id, MAX(count) AS amount
                               FROM wordstat_snapshots WHERE observed_date=?
                               GROUP BY phrase_key, region_id""",
                            (latest,),
                        )
                    }
            finally:
                connection.close()
        site = raw["sites"][0]
        keywords = []
        for item in site.get("keywords", []):
            normalized = (
                {"query": item, "cluster": "", "target_url": "", "enabled": True}
                if isinstance(item, str)
                else {
                    "query": str(item.get("query", "")),
                    "cluster": str(item.get("cluster", "")),
                    "target_url": str(item.get("target_url", "")),
                    "enabled": item.get("enabled", True) is not False,
                }
            )
            key = monitor.query_key(normalized["query"])
            normalized["frequency"] = {
                region: frequencies.get((key, region)) for region in parsed.region_ids
            }
            keywords.append(normalized)
        return {
            "regions": list(parsed.region_ids),
            "region_names": {
                item: REGION_NAMES.get(item, f"Регион {item}")
                for item in parsed.region_ids
            },
            "keywords": keywords,
            "discovery_seeds": list(site.get("discovery_seeds", [])),
            "count": len(keywords),
        }

    def save_keywords(self, payload: Mapping[str, Any], actor: str) -> dict[str, Any]:
        self.require_admin(actor)
        regions = payload.get("regions")
        keywords = payload.get("keywords")
        if not isinstance(regions, list) or not regions:
            raise ValueError("regions must be a non-empty list")
        if not isinstance(keywords, list) or not keywords:
            raise ValueError("keywords must be a non-empty list")
        if len(keywords) > MAX_KEYWORDS:
            raise ValueError(f"at most {MAX_KEYWORDS} keywords are allowed")

        current = load_raw_config(self.config_path)
        updated = json.loads(json.dumps(current, ensure_ascii=False))
        updated["regions"] = [str(item).strip() for item in regions]
        clean_keywords = []
        for index, item in enumerate(keywords):
            if not isinstance(item, dict):
                raise ValueError(f"keyword {index + 1} must be an object")
            clean_keywords.append(
                {
                    "query": str(item.get("query", "")).strip(),
                    "cluster": str(item.get("cluster", "")).strip(),
                    "target_url": str(item.get("target_url", "")).strip(),
                    "enabled": item.get("enabled", True) is not False,
                }
            )
        updated["sites"][0]["keywords"] = clean_keywords
        content = json.dumps(updated, ensure_ascii=False, indent=2) + "\n"
        before = hashlib.sha256(
            json.dumps(current, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        after = hashlib.sha256(
            json.dumps(updated, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()

        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".keywords.", suffix=".json", dir=self.config_path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_name, 0o640)
            monitor.load_config(Path(temporary_name))
            os.replace(temporary_name, self.config_path)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass

        with open_access_database(self.access_db_path) as connection:
            connection.execute(
                """INSERT INTO audit_log(
                       changed_at, actor, action, before_digest, after_digest, details
                   ) VALUES(?, ?, 'save_keywords', ?, ?, ?)""",
                (
                    iso_utc(),
                    actor[:200] or "authenticated-user",
                    before,
                    after,
                    json.dumps(
                        {"regions": updated["regions"], "keywords": len(clean_keywords)},
                        ensure_ascii=False,
                    ),
                ),
            )
            connection.commit()
        return {"status": "saved", "digest": after, "count": len(clean_keywords)}

    def wordstat(self, parameters: Mapping[str, Sequence[str]]) -> dict[str, Any]:
        q = (parameters.get("q") or [""])[0].casefold().strip()
        region = (parameters.get("region") or [""])[0].strip()
        connection = open_monitor_database(self.monitor_db_path)
        if connection is None:
            return {"latest_date": None, "rows": []}
        try:
            latest_row = connection.execute(
                "SELECT MAX(observed_date) AS value FROM wordstat_snapshots"
            ).fetchone()
            latest = latest_row["value"] if latest_row else None
            rows = []
            if latest:
                rows = [
                    {
                        "phrase": row["phrase"],
                        "region_id": row["region_id"],
                        "region_name": REGION_NAMES.get(
                            row["region_id"], f"Регион {row['region_id']}"
                        ),
                        "count": int(row["amount"]),
                        "source": row["source"],
                    }
                    for row in connection.execute(
                        """SELECT phrase, phrase_key, region_id, source,
                                  MAX(count) AS amount
                           FROM wordstat_snapshots WHERE observed_date=?
                           GROUP BY phrase_key, region_id, source
                           ORDER BY amount DESC LIMIT 5000""",
                        (latest,),
                    )
                ]
        finally:
            connection.close()
        if region:
            rows = [row for row in rows if row["region_id"] == region]
        if q:
            rows = [row for row in rows if q in row["phrase"].casefold()]
        return {"latest_date": latest, "rows": rows[:1000]}

    def runs(self) -> dict[str, Any]:
        connection = open_monitor_database(self.monitor_db_path)
        if connection is None:
            return {"rows": []}
        try:
            rows = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM runs ORDER BY started_at DESC LIMIT 100"
                )
            ]
            queue = queue_summary(connection)
        finally:
            connection.close()
        return {"rows": rows, "queue": queue}

    def traffic(self) -> dict[str, Any]:
        connection = open_monitor_database(self.admin_db_path)
        if connection is None:
            return {
                "server": [],
                "metrika": [],
                "metrika_queries": [],
                "webmaster_queries": [],
                "pages": [],
                "goals": [],
                "breakdowns": [],
                "server_referrers": [],
                "server_devices": [],
                "server_errors": [],
                "integrations": self.integration_status(),
            }
        try:
            server = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM traffic_daily ORDER BY observed_date DESC LIMIT 90"
                )
            ]
            metrika = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM metrika_daily ORDER BY observed_date DESC LIMIT 90"
                )
            ]
            metrika_queries = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM metrika_queries
                       WHERE period_to=(SELECT MAX(period_to) FROM metrika_queries)
                       ORDER BY period_to DESC, visits DESC LIMIT 500"""
                )
            ]
            webmaster_queries = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM webmaster_queries
                       WHERE period_to=(SELECT MAX(period_to) FROM webmaster_queries)
                       ORDER BY period_to DESC, shows DESC LIMIT 500"""
                )
            ]
            metrika_pages = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM metrika_pages
                       WHERE period_to=(SELECT MAX(period_to) FROM metrika_pages)
                       ORDER BY period_to DESC, pageviews DESC LIMIT 1000"""
                )
            ]
            server_pages = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM traffic_pages
                       ORDER BY observed_date DESC, pageviews DESC LIMIT 2000"""
                )
            ]
            goals = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM metrika_goals
                       WHERE period_to=(SELECT MAX(period_to) FROM metrika_goals)
                       ORDER BY period_to DESC, reaches DESC LIMIT 500"""
                )
            ]
            breakdowns = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM metrika_breakdowns
                       WHERE period_to=(SELECT MAX(period_to) FROM metrika_breakdowns)
                       ORDER BY period_to DESC, visits DESC LIMIT 2000"""
                )
            ]
            server_referrers = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM traffic_referrers
                       ORDER BY observed_date DESC, pageviews DESC LIMIT 1000"""
                )
            ]
            server_devices = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM traffic_devices
                       ORDER BY observed_date DESC, pageviews DESC LIMIT 500"""
                )
            ]
            server_errors = [
                dict(row)
                for row in connection.execute(
                    """SELECT * FROM traffic_errors
                       ORDER BY observed_date DESC, requests DESC LIMIT 1000"""
                )
            ]
        except sqlite3.OperationalError:
            server = []
            metrika = []
            metrika_queries = []
            webmaster_queries = []
            metrika_pages = []
            server_pages = []
            goals = []
            breakdowns = []
            server_referrers = []
            server_devices = []
            server_errors = []
        finally:
            connection.close()
        return {
            "server": server,
            "metrika": metrika,
            "metrika_queries": metrika_queries,
            "webmaster_queries": webmaster_queries,
            "metrika_pages": metrika_pages,
            "pages": metrika_pages if metrika_pages else server_pages,
            "goals": goals,
            "breakdowns": breakdowns,
            "server_referrers": server_referrers,
            "server_devices": server_devices,
            "server_errors": server_errors,
            "integrations": self.integration_status(),
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "ElegsoSeoAdmin/1.0"

    @property
    def app(self) -> Application:
        return self.server.app  # type: ignore[attr-defined]

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        super().end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(
            "%s %s\n" % (self.log_date_time_string(), fmt % args)
        )

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path, media_type: str) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def actor(self) -> str:
        return self.headers.get("X-Admin-User", "").strip().casefold()

    def require_valid_origin(self) -> bool:
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin != self.app.allowed_origin:
            self.send_json({"error": "invalid_origin"}, HTTPStatus.FORBIDDEN)
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        parameters = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
        try:
            if parsed.path.startswith("/api/"):
                # nginx authenticates the Basic Auth credentials and replaces
                # X-Admin-User with $remote_user. The application separately
                # verifies that this account is still active in its role DB.
                self.app.require_authenticated(self.actor())
            if parsed.path in {"/", "/index.html"}:
                self.send_file(self.app.static_dir / "index.html", "text/html; charset=utf-8")
            elif parsed.path == "/app.css":
                self.send_file(self.app.static_dir / "app.css", "text/css; charset=utf-8")
            elif parsed.path == "/app.js":
                self.send_file(
                    self.app.static_dir / "app.js", "application/javascript; charset=utf-8"
                )
            elif parsed.path == "/health":
                self.send_json({"status": "ok", "time": iso_utc()})
            elif parsed.path == "/api/overview":
                self.send_json(dashboard_payload(self.app, self.actor()))
            elif parsed.path == "/api/rankings":
                self.send_json(self.app.rankings(parameters))
            elif parsed.path == "/api/history":
                self.send_json(self.app.history(parameters))
            elif parsed.path == "/api/keywords":
                self.send_json(self.app.keywords())
            elif parsed.path == "/api/wordstat":
                self.send_json(self.app.wordstat(parameters))
            elif parsed.path == "/api/runs":
                self.send_json(self.app.runs())
            elif parsed.path == "/api/traffic":
                self.send_json(self.app.traffic())
            elif parsed.path == "/api/users":
                self.send_json(self.app.users(self.actor()))
            else:
                self.send_json({"error": "not_found"}, HTTPStatus.NOT_FOUND)
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.FORBIDDEN)
        except (ValueError, monitor.ConfigError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except (OSError, sqlite3.Error, json.JSONDecodeError) as exc:
            self.send_json({"error": "data_unavailable", "detail": str(exc)}, 503)

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/api/keywords":
            self.send_json({"error": "not_found"}, HTTPStatus.NOT_FOUND)
            return
        if not self.require_valid_origin():
            return
        if not self.headers.get("Content-Type", "").lower().startswith(
            "application/json"
        ):
            self.send_json({"error": "json_required"}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 1 <= length <= MAX_BODY:
            self.send_json({"error": "invalid_body_size"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object")
            actor = self.actor()
            self.app.require_admin(actor)
            self.send_json(self.app.save_keywords(payload, actor))
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.FORBIDDEN)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, monitor.ConfigError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except (OSError, sqlite3.Error) as exc:
            self.send_json({"error": "save_failed", "detail": str(exc)}, 503)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/api/users":
            self.send_json({"error": "not_found"}, HTTPStatus.NOT_FOUND)
            return
        if not self.require_valid_origin():
            return
        if not self.headers.get("Content-Type", "").lower().startswith(
            "application/json"
        ):
            self.send_json({"error": "json_required"}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= MAX_BODY:
                raise ValueError("invalid body size")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object")
            self.send_json(self.app.save_user(payload, self.actor()))
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.FORBIDDEN)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except (OSError, sqlite3.Error, RuntimeError, subprocess.SubprocessError) as exc:
            self.send_json({"error": "save_failed", "detail": str(exc)}, 503)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/api/users":
            self.send_json({"error": "not_found"}, HTTPStatus.NOT_FOUND)
            return
        if not self.require_valid_origin():
            return
        if not self.headers.get("Content-Type", "").lower().startswith(
            "application/json"
        ):
            self.send_json({"error": "json_required"}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= MAX_BODY:
                raise ValueError("invalid body size")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object")
            username = str(payload.get("username", ""))
            self.send_json(self.app.delete_user(username, self.actor()))
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.FORBIDDEN)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except (OSError, sqlite3.Error, RuntimeError, subprocess.SubprocessError) as exc:
            self.send_json({"error": "delete_failed", "detail": str(exc)}, 503)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], app: Application):
        self.app = app
        super().__init__(address, Handler)


class UnixServer(ThreadingMixIn, UnixStreamServer):
    daemon_threads = True

    def __init__(self, path: str, app: Application):
        self.app = app
        super().__init__(path, Handler)


def main() -> int:
    app = Application()
    socket_path: Path | None = None
    if app.socket_path:
        socket_path = Path(app.socket_path)
        socket_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass
        server = UnixServer(str(socket_path), app)
        os.chmod(socket_path, 0o660)
        print(f"ELEGSO SEO admin listening on {socket_path}", flush=True)
    else:
        server = Server((app.bind, app.port), app)
        print(f"ELEGSO SEO admin listening on {app.bind}:{app.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if socket_path is not None:
            try:
                socket_path.unlink()
            except FileNotFoundError:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
