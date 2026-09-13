#!/usr/bin/env python3
"""Minimal consent events, not proof of identity; isolated from admin/SEO data."""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

CURRENT_VERSION = "2026-09-13.1"
MAX_BODY = 1024
CHOICE_DAYS = 180
RETENTION_DAYS = 365
DEFAULT_DB = "/var/lib/elegso-seo-admin/access/privacy-consent.sqlite3"


class WithdrawnChoice(ValueError):
    pass


def utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate(payload: object, current_version: str = CURRENT_VERSION) -> dict:
    if not isinstance(payload, dict) or set(payload) != {"choice_id", "version", "analytics"}:
        raise ValueError("invalid_fields")
    choice_id, version, analytics = payload["choice_id"], payload["version"], payload["analytics"]
    try:
        parsed = uuid.UUID(choice_id) if isinstance(choice_id, str) else None
    except (ValueError, AttributeError):
        parsed = None
    if not parsed or parsed.version != 4 or str(parsed) != choice_id:
        raise ValueError("invalid_choice_id")
    if type(analytics) is not bool:
        raise ValueError("invalid_analytics")
    # Old-version withdrawal is permitted; a new grant requires the current text.
    if not isinstance(version, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d{1,4}", version):
        raise ValueError("invalid_version")
    if analytics and version != current_version:
        raise ValueError("outdated_version")
    return payload


def decode(raw: bytes) -> dict:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate_field")
            result[key] = value
        return result
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique)


@contextmanager
def database(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    # O_EXCL protects permissions for the first create without a global umask
    # change in the threaded server. Existing DB permissions are tightened too.
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    except FileExistsError:
        pass
    os.chmod(path, 0o600)
    connection = sqlite3.connect(path, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA secure_delete=ON")
        connection.execute("""CREATE TABLE IF NOT EXISTS privacy_consent_events (
            choice_id TEXT NOT NULL, consent_version TEXT NOT NULL,
            analytics INTEGER NOT NULL CHECK(analytics IN (0,1)),
            recorded_at TEXT NOT NULL, expires_at TEXT NOT NULL, retain_until TEXT NOT NULL,
            PRIMARY KEY(choice_id, consent_version, analytics))""")
        connection.execute("CREATE INDEX IF NOT EXISTS privacy_consent_retention ON privacy_consent_events(retain_until)")
        connection.commit()
        yield connection
    finally:
        connection.close()


def record(path: Path, payload: object, current_version: str = CURRENT_VERSION, now: datetime | None = None) -> dict:
    item = validate(payload, current_version)
    now = now or datetime.now(timezone.utc)
    values = (item["choice_id"], item["version"], int(item["analytics"]))
    with database(path) as connection:
        # Serialize duplicate grants/withdrawals. A withdrawn choice can never
        # be revived; a later opt-in must receive a fresh random choice UUID.
        connection.execute("BEGIN IMMEDIATE")
        try:
            if item["analytics"] and connection.execute(
                "SELECT 1 FROM privacy_consent_events WHERE choice_id=? AND consent_version=? AND analytics=0", values[:2]
            ).fetchone():
                raise WithdrawnChoice("choice_withdrawn")
            connection.execute(
                "INSERT OR IGNORE INTO privacy_consent_events VALUES (?,?,?,?,?,?)",
                (*values, utc(now), utc(now + timedelta(days=CHOICE_DAYS)), utc(now + timedelta(days=RETENTION_DAYS))),
            )
            row = connection.execute(
                "SELECT * FROM privacy_consent_events WHERE choice_id=? AND consent_version=? AND analytics=?", values
            ).fetchone()
            connection.commit()  # Acknowledgement is only issued after commit.
        except Exception:
            connection.rollback()
            raise
    return {"choice_id": row["choice_id"], "version": row["consent_version"], "analytics": bool(row["analytics"]),
            "recorded_at": row["recorded_at"], "expires_at": row["expires_at"], "retain_until": row["retain_until"]}


def prune(path: Path, now: datetime | None = None) -> int:
    if not path.exists():
        return 0
    with database(path) as connection:
        deleted = connection.execute("DELETE FROM privacy_consent_events WHERE retain_until<=?", (utc(now or datetime.now(timezone.utc)),)).rowcount
        connection.commit()
    return deleted


def handle(handler) -> None:
    """Only the exact public POST route invokes this; no admin auth bypass."""
    if handler.path != "/api/privacy/consent":
        handler.send_json({"error": "invalid_path"}, 400)
        return
    if handler.headers.get("Origin", "") != handler.app.allowed_origin:
        handler.send_json({"error": "invalid_origin"}, 403)
        return
    if handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
        handler.send_json({"error": "json_required"}, 415)
        return
    if handler.headers.get("Transfer-Encoding") or len(handler.headers.get_all("Content-Length", [])) != 1:
        handler.send_json({"error": "invalid_body_size"}, 400)
        return
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if not 1 <= length <= MAX_BODY:
            raise ValueError("invalid_body_size")
        payload = decode(handler.rfile.read(length))
        receipt = record(handler.app.privacy_db_path, payload, handler.app.privacy_version)
        handler.send_json({"receipt": receipt})
    except WithdrawnChoice:
        handler.send_json({"error": "choice_withdrawn"}, 409)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
        handler.send_json({"error": "invalid_consent"}, 400)
    except (OSError, sqlite3.Error):
        # Never expose DB paths, SQL or submitted content through errors/logs.
        handler.send_json({"error": "consent_unavailable"}, 503)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prune", action="store_true", required=True)
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("PRIVACY_CONSENT_DB", DEFAULT_DB)))
    args = parser.parse_args()
    print(json.dumps({"expired_consent_events_deleted": prune(args.db)}))
