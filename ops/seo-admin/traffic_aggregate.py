#!/usr/bin/env python3
"""Aggregate ELEGSO nginx logs without retaining IP addresses or user agents."""

from __future__ import annotations

import argparse
import gzip
import re
import sqlite3
import sys
import urllib.parse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, TextIO

from app import iso_utc, open_admin_database


LOG_PATTERN = re.compile(
    r'^\S+\s+\S+\s+\S+\s+\[([^]]+)]\s+"([A-Z]+)\s+([^ ]+)\s+[^\"]+"\s+'
    r'(\d{3})\s+\S+\s+"([^\"]*)"\s+"([^\"]*)"'
)
ASSET_PATTERN = re.compile(
    r"\.(?:css|js|mjs|map|jpe?g|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|pdf|xml|txt)$",
    re.IGNORECASE,
)
BOT_PATTERN = re.compile(
    r"(?:bot|crawler|spider|slurp|yandex|googlebot|bing|mail\.ru|ahrefs|semrush|mj12|uptime|monitoring)",
    re.IGNORECASE,
)
EXCLUDED_PREFIXES = (
    "/admin",
    "/api/",
    "/calculator-data/",
    "/calc_nst/service/",
    "/_external/",
    "/header/",
    "/footer/",
)


def text_stream(path: Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return path.open("r", encoding="utf-8", errors="replace")


def log_files(pattern: str) -> list[Path]:
    source = Path(pattern)
    parent = source.parent
    return sorted(
        (item for item in parent.glob(source.name) if item.is_file()),
        key=lambda item: (item.stat().st_mtime, item.name),
    )


def canonical_path(raw_target: str) -> str:
    try:
        path = urllib.parse.urlsplit(raw_target).path or "/"
    except ValueError:
        path = raw_target.split("?", 1)[0] or "/"
    path = re.sub(r"/{2,}", "/", path)
    if path.endswith("/index.html"):
        path = path[: -len("index.html")]
    if path != "/" and not path.endswith("/") and "." not in path.rsplit("/", 1)[-1]:
        path += "/"
    return path[:1000]


def referrer_host(raw_referrer: str) -> str:
    if not raw_referrer or raw_referrer == "-":
        return "Прямой переход / источник не передан"
    try:
        hostname = (urllib.parse.urlsplit(raw_referrer).hostname or "").lower()
    except ValueError:
        return "Некорректный реферер"
    if hostname in {"elegso.ru", "www.elegso.ru"}:
        return "Внутренний переход"
    return hostname[:253] or "Источник не определён"


def device_group(user_agent: str) -> str:
    lowered = user_agent.casefold()
    if any(marker in lowered for marker in ("mobile", "android", "iphone")):
        return "Телефон"
    if any(marker in lowered for marker in ("ipad", "tablet")):
        return "Планшет"
    return "Компьютер"


def ensure_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
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
        """
    )


def aggregate(paths: Iterable[Path], retention_days: int) -> dict[str, Counter]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    daily: Counter = Counter()
    pages: Counter = Counter()
    referrers: Counter = Counter()
    devices: Counter = Counter()
    errors: Counter = Counter()
    parsed_lines = 0
    ignored_lines = 0
    for path in paths:
        with text_stream(path) as handle:
            for line in handle:
                match = LOG_PATTERN.match(line)
                if not match:
                    ignored_lines += 1
                    continue
                raw_time, method, target, raw_status, referrer, user_agent = match.groups()
                try:
                    moment = datetime.strptime(raw_time, "%d/%b/%Y:%H:%M:%S %z")
                except ValueError:
                    ignored_lines += 1
                    continue
                if moment.astimezone(timezone.utc) < cutoff:
                    continue
                parsed_lines += 1
                observed_date = moment.date().isoformat()
                status = int(raw_status)
                path_value = canonical_path(target)
                is_asset = bool(ASSET_PATTERN.search(path_value))
                is_bot = bool(BOT_PATTERN.search(user_agent))
                if is_asset:
                    daily[(observed_date, "asset_requests")] += 1
                if is_bot:
                    daily[(observed_date, "bot_requests")] += 1
                if status >= 400:
                    daily[(observed_date, "error_requests")] += 1
                    errors[(observed_date, status, path_value)] += 1
                is_page = (
                    method == "GET"
                    and status == 200
                    and not is_asset
                    and not is_bot
                    and not any(path_value.startswith(prefix) for prefix in EXCLUDED_PREFIXES)
                )
                if not is_page:
                    continue
                daily[(observed_date, "pageviews")] += 1
                pages[(observed_date, path_value)] += 1
                referrers[(observed_date, referrer_host(referrer))] += 1
                devices[(observed_date, device_group(user_agent))] += 1
    return {
        "daily": daily,
        "pages": pages,
        "referrers": referrers,
        "devices": devices,
        "errors": errors,
        "meta": Counter({"parsed_lines": parsed_lines, "ignored_lines": ignored_lines}),
    }


def persist(
    database_path: Path, result: dict[str, Counter], retention_days: int
) -> dict[str, int]:
    dates = sorted({key[0] for key in result["daily"]})
    now = iso_utc()
    cutoff_date = (
        datetime.now(timezone.utc) - timedelta(days=retention_days)
    ).date().isoformat()
    with open_admin_database(database_path) as connection:
        ensure_tables(connection)
        for table in (
            "traffic_daily",
            "traffic_pages",
            "traffic_referrers",
            "traffic_devices",
            "traffic_errors",
        ):
            connection.execute(
                f"DELETE FROM {table} WHERE observed_date<?", (cutoff_date,)
            )
        for observed_date in dates:
            connection.execute(
                """INSERT INTO traffic_daily(
                       observed_date, pageviews, asset_requests, error_requests,
                       bot_requests, updated_at
                   ) VALUES(?, ?, ?, ?, ?, ?)
                   ON CONFLICT(observed_date) DO UPDATE SET
                       pageviews=excluded.pageviews,
                       asset_requests=excluded.asset_requests,
                       error_requests=excluded.error_requests,
                       bot_requests=excluded.bot_requests,
                       updated_at=excluded.updated_at""",
                (
                    observed_date,
                    result["daily"][(observed_date, "pageviews")],
                    result["daily"][(observed_date, "asset_requests")],
                    result["daily"][(observed_date, "error_requests")],
                    result["daily"][(observed_date, "bot_requests")],
                    now,
                ),
            )
            for table in ("traffic_pages", "traffic_referrers", "traffic_devices", "traffic_errors"):
                connection.execute(f"DELETE FROM {table} WHERE observed_date=?", (observed_date,))
        connection.executemany(
            "INSERT INTO traffic_pages(observed_date, path, pageviews) VALUES(?, ?, ?)",
            ((day, path, count) for (day, path), count in result["pages"].items()),
        )
        connection.executemany(
            "INSERT INTO traffic_referrers(observed_date, referrer, pageviews) VALUES(?, ?, ?)",
            ((day, value, count) for (day, value), count in result["referrers"].items()),
        )
        connection.executemany(
            "INSERT INTO traffic_devices(observed_date, device, pageviews) VALUES(?, ?, ?)",
            ((day, value, count) for (day, value), count in result["devices"].items()),
        )
        connection.executemany(
            "INSERT INTO traffic_errors(observed_date, status, path, requests) VALUES(?, ?, ?, ?)",
            ((day, status, path, count) for (day, status, path), count in result["errors"].items()),
        )
        connection.execute(
            """INSERT INTO integration_runs(
                   provider, last_attempt_at, last_success_at, status, message
               ) VALUES('nginx', ?, ?, 'completed', ?)
               ON CONFLICT(provider) DO UPDATE SET
                   last_attempt_at=excluded.last_attempt_at,
                   last_success_at=excluded.last_success_at,
                   status=excluded.status,
                   message=excluded.message""",
            (
                now,
                now,
                (
                    f"Обработано строк: {result['meta']['parsed_lines']}; "
                    f"дней: {len(dates)}; открытые IP не сохраняются"
                ),
            ),
        )
        connection.commit()
    return {
        "days": len(dates),
        "pages": len(result["pages"]),
        "parsed_lines": result["meta"]["parsed_lines"],
        "ignored_lines": result["meta"]["ignored_lines"],
    }


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--logs", default="/var/log/nginx/elegso.access.log*")
    parser.add_argument(
        "--db", default="/var/lib/elegso-seo-admin/data/analytics.sqlite3"
    )
    parser.add_argument("--retention-days", type=int, default=400)
    return parser


def main() -> int:
    args = create_parser().parse_args()
    if not 1 <= args.retention_days <= 3650:
        print("retention-days must be between 1 and 3650", file=sys.stderr)
        return 78
    paths = log_files(args.logs)
    if not paths:
        print("no nginx access logs found", file=sys.stderr)
        return 1
    result = aggregate(paths, args.retention_days)
    print(persist(Path(args.db), result, args.retention_days))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
