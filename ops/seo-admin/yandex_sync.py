#!/usr/bin/env python3
"""Synchronize aggregate Yandex Metrica and Webmaster marketing reports."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Mapping, Sequence

from app import iso_utc, open_admin_database


METRIKA_URL = "https://api-metrika.yandex.net/stat/v1/data"
WEBMASTER_URL = "https://api.webmaster.yandex.net/v4"


class SyncError(Exception):
    pass


def api_get(url: str, token: str, parameters: Mapping[str, Any] | None = None) -> dict[str, Any]:
    if parameters:
        url += "?" + urllib.parse.urlencode(parameters, doseq=True)
    request = urllib.request.Request(url)
    request.add_header("Authorization", f"OAuth {token}")
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", "ElegsoMarketingSync/1.0 (+https://elegso.ru/)")
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read(8 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        body = exc.read(16 * 1024).decode("utf-8", errors="replace")
        try:
            payload = json.loads(body)
            message = payload.get("message") or payload.get("error_message") or payload.get("error_code")
        except json.JSONDecodeError:
            message = "request rejected"
        raise SyncError(f"HTTP {exc.code}: {str(message)[:300]}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SyncError(f"network request failed: {exc}") from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SyncError("Yandex returned malformed JSON") from exc
    if not isinstance(payload, dict):
        raise SyncError("Yandex returned a non-object response")
    return payload


def dimension(row: Mapping[str, Any], index: int) -> str:
    values = row.get("dimensions", [])
    if not isinstance(values, list) or index >= len(values):
        return ""
    value = values[index]
    if isinstance(value, dict):
        return str(value.get("name") or value.get("id") or "")
    return str(value or "")


def metrics(row: Mapping[str, Any], amount: int) -> list[float]:
    values = row.get("metrics", [])
    if not isinstance(values, list):
        values = []
    output = []
    for index in range(amount):
        try:
            output.append(float(values[index]))
        except (IndexError, TypeError, ValueError):
            output.append(0.0)
    return output


def metrika_report(
    token: str,
    counter: str,
    date_from: str,
    date_to: str,
    dimensions: str,
    report_metrics: str = "ym:s:visits,ym:s:users,ym:s:pageviews",
    *,
    filters: str | None = None,
    limit: int = 10000,
) -> dict[str, Any]:
    parameters: dict[str, Any] = {
        "ids": counter,
        "date1": date_from,
        "date2": date_to,
        "dimensions": dimensions,
        "metrics": report_metrics,
        "accuracy": "full",
        "include_undefined": "true",
        "limit": str(limit),
        "lang": "ru",
    }
    if filters:
        parameters["filters"] = filters
    return api_get(METRIKA_URL, token, parameters)


def sync_metrika(
    database_path: Path,
    token: str,
    counter: str,
    period_days: int = 90,
) -> dict[str, int]:
    today = date.today()
    date_from = (today - timedelta(days=period_days - 1)).isoformat()
    date_to = today.isoformat()
    daily = metrika_report(
        token,
        counter,
        date_from,
        date_to,
        "ym:s:datePeriodday",
    )
    pages = metrika_report(
        token,
        counter,
        date_from,
        date_to,
        "ym:s:startURL",
        "ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:avgVisitDurationSeconds",
    )
    queries = metrika_report(
        token,
        counter,
        date_from,
        date_to,
        "ym:s:lastSearchPhrase",
        "ym:s:visits,ym:s:users",
        filters="ym:s:lastTrafficSource=='organic' AND ym:s:isRobot=='No'",
    )
    sources = metrika_report(
        token,
        counter,
        date_from,
        date_to,
        "ym:s:lastTrafficSourceName,ym:s:lastSourceEngineName",
    )
    geography = metrika_report(
        token,
        counter,
        date_from,
        date_to,
        "ym:s:regionCountryName,ym:s:regionAreaName,ym:s:regionCityName",
    )
    devices = metrika_report(
        token,
        counter,
        date_from,
        date_to,
        "ym:s:deviceCategoryName",
    )
    now = iso_utc()
    with open_admin_database(database_path) as connection:
        connection.execute("DELETE FROM metrika_daily WHERE observed_date BETWEEN ? AND ?", (date_from, date_to))
        for row in daily.get("data", []):
            if not isinstance(row, dict):
                continue
            day = dimension(row, 0)
            visits, users, pageviews = metrics(row, 3)
            if day:
                connection.execute(
                    """INSERT OR REPLACE INTO metrika_daily(
                           observed_date, visits, users, pageviews, updated_at
                       ) VALUES(?, ?, ?, ?, ?)""",
                    (day, round(visits), round(users), round(pageviews), now),
                )

        connection.execute("DELETE FROM metrika_pages WHERE period_from=? AND period_to=?", (date_from, date_to))
        for row in pages.get("data", []):
            if not isinstance(row, dict):
                continue
            page = dimension(row, 0)
            values = metrics(row, 5)
            if page:
                connection.execute(
                    """INSERT OR REPLACE INTO metrika_pages(
                           period_from, period_to, page, visits, users, pageviews,
                           bounce_rate, avg_duration_seconds, updated_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        date_from,
                        date_to,
                        page[:2000],
                        round(values[0]),
                        round(values[1]),
                        round(values[2]),
                        values[3],
                        values[4],
                        now,
                    ),
                )

        connection.execute("DELETE FROM metrika_queries WHERE period_from=? AND period_to=?", (date_from, date_to))
        for row in queries.get("data", []):
            if not isinstance(row, dict):
                continue
            query = dimension(row, 0).strip()
            visits, users = metrics(row, 2)
            if query and query not in {"Не определено", "not set"}:
                connection.execute(
                    """INSERT OR REPLACE INTO metrika_queries(
                           period_from, period_to, query, visits, users, updated_at
                       ) VALUES(?, ?, ?, ?, ?, ?)""",
                    (date_from, date_to, query[:1000], round(visits), round(users), now),
                )

        connection.execute("DELETE FROM metrika_breakdowns WHERE period_from=? AND period_to=?", (date_from, date_to))
        for kind, payload, dimensions_amount in (
            ("source", sources, 2),
            ("geo", geography, 3),
            ("device", devices, 1),
        ):
            for row in payload.get("data", []):
                if not isinstance(row, dict):
                    continue
                labels = [dimension(row, index)[:500] for index in range(dimensions_amount)]
                labels += [""] * (3 - len(labels))
                visits, users, pageviews = metrics(row, 3)
                if labels[0]:
                    connection.execute(
                        """INSERT OR REPLACE INTO metrika_breakdowns(
                               period_from, period_to, kind, dimension_1,
                               dimension_2, dimension_3, visits, users,
                               pageviews, updated_at
                           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            date_from,
                            date_to,
                            kind,
                            labels[0],
                            labels[1],
                            labels[2],
                            round(visits),
                            round(users),
                            round(pageviews),
                            now,
                        ),
                    )
        connection.execute(
            """INSERT INTO integration_runs(
                   provider, last_attempt_at, last_success_at, status, message
               ) VALUES('metrika', ?, ?, 'completed', ?)
               ON CONFLICT(provider) DO UPDATE SET
                   last_attempt_at=excluded.last_attempt_at,
                   last_success_at=excluded.last_success_at,
                   status=excluded.status,
                   message=excluded.message""",
            (
                now,
                now,
                f"Синхронизировано: {date_from} — {date_to}; счётчик {counter}",
            ),
        )
        connection.commit()
    return {
        "days": len(daily.get("data", [])),
        "pages": len(pages.get("data", [])),
        "queries": len(queries.get("data", [])),
    }


def discover_webmaster_host(token: str, domain: str) -> tuple[str, str]:
    user = api_get(f"{WEBMASTER_URL}/user", token)
    user_id = str(user.get("user_id") or "")
    if not user_id:
        raise SyncError("Webmaster response has no user_id")
    hosts = api_get(f"{WEBMASTER_URL}/user/{urllib.parse.quote(user_id, safe='')}/hosts", token)
    for host in hosts.get("hosts", []):
        if not isinstance(host, dict):
            continue
        visible = " ".join(
            str(host.get(field) or "")
            for field in ("host_id", "ascii_host_url", "unicode_host_url")
        ).casefold()
        if domain.casefold() in visible:
            host_id = str(host.get("host_id") or "")
            if host_id:
                return user_id, host_id
    raise SyncError(f"verified Webmaster host for {domain} was not found")


def webmaster_queries(
    token: str,
    user_id: str,
    host_id: str,
    date_from: str,
    date_to: str,
    device: str,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    offset = 0
    while offset < 3000:
        path = (
            f"{WEBMASTER_URL}/user/{urllib.parse.quote(user_id, safe='')}"
            f"/hosts/{urllib.parse.quote(host_id, safe='')}/search-queries/popular"
        )
        payload = api_get(
            path,
            token,
            {
                "order_by": "TOTAL_SHOWS",
                "query_indicator": [
                    "TOTAL_SHOWS",
                    "TOTAL_CLICKS",
                    "AVG_SHOW_POSITION",
                    "AVG_CLICK_POSITION",
                ],
                "device_type_indicator": device,
                "date_from": date_from,
                "date_to": date_to,
                "offset": offset,
                "limit": 500,
            },
        )
        batch = payload.get("queries", [])
        if not isinstance(batch, list) or not batch:
            break
        output.extend(item for item in batch if isinstance(item, dict))
        offset += len(batch)
        if offset >= int(payload.get("count") or 0):
            break
    return output


def sync_webmaster(database_path: Path, token: str, domain: str = "elegso.ru") -> dict[str, int]:
    today = date.today()
    date_from = (today - timedelta(days=13)).isoformat()
    date_to = today.isoformat()
    user_id, host_id = discover_webmaster_host(token, domain)
    gathered = {
        device: webmaster_queries(
            token, user_id, host_id, date_from, date_to, device
        )
        for device in ("ALL", "DESKTOP", "MOBILE_AND_TABLET")
    }
    now = iso_utc()
    with open_admin_database(database_path) as connection:
        connection.execute(
            "DELETE FROM webmaster_queries WHERE period_from=? AND period_to=?",
            (date_from, date_to),
        )
        for device, rows in gathered.items():
            for row in rows:
                query = str(row.get("query_text") or "").strip()
                indicators = row.get("indicators", {})
                if not query or not isinstance(indicators, dict):
                    continue
                connection.execute(
                    """INSERT OR REPLACE INTO webmaster_queries(
                           period_from, period_to, query, device, shows, clicks,
                           avg_show_position, avg_click_position, updated_at
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        date_from,
                        date_to,
                        query[:1000],
                        device,
                        indicators.get("TOTAL_SHOWS"),
                        indicators.get("TOTAL_CLICKS"),
                        indicators.get("AVG_SHOW_POSITION"),
                        indicators.get("AVG_CLICK_POSITION"),
                        now,
                    ),
                )
        connection.execute(
            """INSERT INTO integration_runs(
                   provider, last_attempt_at, last_success_at, status, message
               ) VALUES('webmaster', ?, ?, 'completed', ?)
               ON CONFLICT(provider) DO UPDATE SET
                   last_attempt_at=excluded.last_attempt_at,
                   last_success_at=excluded.last_success_at,
                   status=excluded.status,
                   message=excluded.message""",
            (
                now,
                now,
                f"Синхронизировано запросов: {sum(len(rows) for rows in gathered.values())}",
            ),
        )
        connection.commit()
    return {device: len(rows) for device, rows in gathered.items()}


def record_failure(database_path: Path, provider: str, error: BaseException) -> None:
    message = " ".join(str(error).split())[:500]
    now = iso_utc()
    with open_admin_database(database_path) as connection:
        connection.execute(
            """INSERT INTO integration_runs(provider, last_attempt_at, status, message)
               VALUES(?, ?, 'error', ?)
               ON CONFLICT(provider) DO UPDATE SET
                   last_attempt_at=excluded.last_attempt_at,
                   status=excluded.status,
                   message=excluded.message""",
            (provider, now, message),
        )
        connection.commit()


def main() -> int:
    database_path = Path(
        os.environ.get(
            "SEO_ADMIN_DB", "/var/lib/elegso-seo-admin/data/analytics.sqlite3"
        )
    )
    shared = os.environ.get("YANDEX_ANALYTICS_OAUTH_TOKEN", "").strip()
    metrika_token = os.environ.get("YANDEX_METRIKA_OAUTH_TOKEN", "").strip() or shared
    webmaster_token = os.environ.get("YANDEX_WEBMASTER_OAUTH_TOKEN", "").strip() or shared
    configured = 0
    failures = 0
    if metrika_token:
        configured += 1
        try:
            result = sync_metrika(
                database_path,
                metrika_token,
                os.environ.get("YANDEX_METRIKA_COUNTER", "87831358"),
            )
            print(f"Metrika synchronized: {result}")
        except (SyncError, OSError, sqlite3.Error) as exc:
            failures += 1
            record_failure(database_path, "metrika", exc)
            print(f"Metrika synchronization failed: {exc}", file=sys.stderr)
    if webmaster_token:
        configured += 1
        try:
            result = sync_webmaster(database_path, webmaster_token)
            print(f"Webmaster synchronized: {result}")
        except (SyncError, OSError, sqlite3.Error) as exc:
            failures += 1
            record_failure(database_path, "webmaster", exc)
            print(f"Webmaster synchronization failed: {exc}", file=sys.stderr)
    if configured == 0:
        print("Yandex analytics OAuth is not configured; nothing to synchronize")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
