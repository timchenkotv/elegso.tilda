import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops/seo-admin"))
sys.path.insert(0, str(ROOT / "ops/seo-monitor"))
import privacy_consent as privacy

SPEC = importlib.util.spec_from_file_location("privacy_test_admin", ROOT / "ops/seo-admin/app.py")
admin = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(admin)


class PrivacyConsentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "privacy.sqlite3"
        self.now = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)
        self.payload = {"choice_id": str(uuid.uuid4()), "version": privacy.CURRENT_VERSION, "analytics": True}

    def tearDown(self):
        self.temp.cleanup()

    def handler(self, payload=None, raw=None, origin="https://elegso.ru", media="application/json", path="/api/privacy/consent", **headers):
        raw = raw if raw is not None else json.dumps(payload if payload is not None else self.payload).encode()
        message = Message()
        if origin is not None:
            message["Origin"] = origin
        message["Content-Type"] = media
        message["Content-Length"] = str(len(raw))
        for key, value in headers.items():
            message[key.replace("_", "-")] = value
        handler = SimpleNamespace(path=path, headers=message, rfile=io.BytesIO(raw),
            app=SimpleNamespace(privacy_db_path=self.db, privacy_version=privacy.CURRENT_VERSION, allowed_origin="https://elegso.ru"))
        handler.send_json = lambda data, status=200: setattr(handler, "result", (status, data))
        return handler

    def test_receipt_exact_fields_no_metadata_and_0600(self):
        handler = self.handler(User_Agent="private-agent", X_Forwarded_For="192.0.2.20", Referer="https://example.test/private")
        admin.Handler.do_POST(handler)
        self.assertEqual(handler.result[0], 200)
        receipt = handler.result[1]["receipt"]
        self.assertEqual(set(receipt), {"choice_id", "version", "analytics", "recorded_at", "expires_at", "retain_until"})
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(self.db) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(privacy_consent_events)")}
            self.assertEqual(columns, {"choice_id", "consent_version", "analytics", "recorded_at", "expires_at", "retain_until"})
            self.assertNotIn("private", str(connection.execute("SELECT * FROM privacy_consent_events").fetchall()))

    def test_idempotent_retries_never_extend_retention_or_choice(self):
        first = privacy.record(self.db, self.payload, now=self.now)
        repeated = privacy.record(self.db, self.payload, now=self.now + timedelta(days=20))
        self.assertEqual(first, repeated)
        self.assertEqual(first["expires_at"], privacy.utc(self.now + timedelta(days=180)))
        self.assertEqual(first["retain_until"], privacy.utc(self.now + timedelta(days=365)))

    def test_withdrawn_choice_cannot_be_revived_and_retry_is_idempotent(self):
        privacy.record(self.db, self.payload, now=self.now)
        refusal = {**self.payload, "analytics": False}
        first = privacy.record(self.db, refusal, now=self.now + timedelta(days=1))
        self.assertEqual(first, privacy.record(self.db, refusal, now=self.now + timedelta(days=2)))
        handler = self.handler()
        privacy.handle(handler)
        self.assertEqual(handler.result, (409, {"error": "choice_withdrawn"}))
        fresh = {**self.payload, "choice_id": str(uuid.uuid4())}
        self.assertTrue(privacy.record(self.db, fresh)["analytics"])

    def test_refusal_arriving_before_grant_also_prevents_late_activation(self):
        privacy.record(self.db, {**self.payload, "analytics": False})
        with self.assertRaises(privacy.WithdrawnChoice):
            privacy.record(self.db, self.payload)

    def test_invalid_missing_origin_and_crossorigin_rejected_without_db(self):
        for origin in [None, "", "null", "https://evil.test", "https://elegso.ru.evil.test", "https://elegso.ru/"]:
            handler = self.handler(origin=origin)
            privacy.handle(handler)
            self.assertEqual(handler.result[0], 403)
        self.assertFalse(self.db.exists())

    def test_schema_and_sql_like_garbage_are_rejected(self):
        for payload in [[], None, {}, {**self.payload, "ip": "x"}, {**self.payload, "analytics": 1},
                        {**self.payload, "choice_id": "';DROP TABLE users;--"}, {**self.payload, "choice_id": str(uuid.uuid1())},
                        {**self.payload, "version": "old"}, {**self.payload, "version": "2025-01-01.1"}]:
            handler = self.handler(raw=json.dumps(payload).encode())
            privacy.handle(handler)
            self.assertEqual(handler.result[0], 400, payload)
        for raw in [b"garbage", b"\xff", b'{"analytics":true,"analytics":false}', b"x" * 1025]:
            handler = self.handler(raw=raw)
            privacy.handle(handler)
            self.assertEqual(handler.result[0], 400)
        self.assertFalse(self.db.exists())

    def test_media_query_and_transfer_encoding_validation(self):
        for kwargs, status in [({"media": "text/plain"}, 415), ({"path": "/api/privacy/consent?secret=1"}, 400),
                               ({"Transfer_Encoding": "chunked"}, 400), ({"Content_Length": "5"}, 400)]:
            handler = self.handler(**kwargs)
            privacy.handle(handler)
            self.assertEqual(handler.result[0], status)

    def test_old_version_withdrawal_is_allowed(self):
        receipt = privacy.record(self.db, {**self.payload, "version": "2025-01-01.1", "analytics": False})
        self.assertFalse(receipt["analytics"])

    def test_prune_removes_only_expired_events_without_changing_other_tables(self):
        privacy.record(self.db, self.payload, now=self.now)
        privacy.record(self.db, {**self.payload, "choice_id": str(uuid.uuid4())}, now=self.now + timedelta(days=1))
        with sqlite3.connect(self.db) as connection:
            connection.execute("CREATE TABLE unrelated (value TEXT)")
            connection.execute("INSERT INTO unrelated VALUES ('keep')")
        self.assertEqual(privacy.prune(self.db, self.now + timedelta(days=365)), 1)
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM privacy_consent_events").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT value FROM unrelated").fetchone()[0], "keep")

    def test_errors_hide_database_details_and_sql(self):
        handler = self.handler()
        with mock.patch.object(privacy, "record", side_effect=sqlite3.OperationalError("/secret/db SQL passwords")):
            privacy.handle(handler)
        self.assertEqual(handler.result, (503, {"error": "consent_unavailable"}))

    def test_existing_admin_routes_do_not_inherit_public_auth(self):
        handler = self.handler(path="/api/users")
        handler.require_valid_origin = lambda: True
        handler.actor = lambda: ""
        handler.app.save_user = mock.Mock(side_effect=PermissionError("forbidden"))
        admin.Handler.do_POST(handler)
        self.assertEqual(handler.result[0], 403)
        handler.app.save_user.assert_called_once()
        wrong = self.handler(path="/api/privacy/consent/extra")
        admin.Handler.do_POST(wrong)
        self.assertEqual(wrong.result[0], 404)

    def test_receipt_request_is_not_logged(self):
        handler = self.handler(path="/api/privacy/consent?secret=1")
        with mock.patch.object(admin.sys.stderr, "write") as write:
            admin.Handler.log_message(handler, "private %s", "data")
        write.assert_not_called()

    def test_config_and_installation_agree(self):
        config = json.loads((ROOT / "config/site-privacy.json").read_text())
        self.assertEqual(config["consentVersion"], privacy.CURRENT_VERSION)
        self.assertEqual(config["maxAgeDays"], privacy.CHOICE_DAYS)
        self.assertEqual(config["receiptRetentionDays"], privacy.RETENTION_DAYS)
        hook = (ROOT / "ops/hooks/post-receive").read_text()
        for item in ["privacy_consent.py", "elegso-privacy-prune.service", "elegso-privacy-prune.timer"]:
            self.assertIn(item, hook)
        nginx = (ROOT / "ops/nginx/elegso.conf").read_text()
        block = nginx.split("location = /api/privacy/consent {", 1)[1].split("# Private marketing", 1)[0]
        for item in ['client_max_body_size 1k', 'access_log off', 'proxy_set_header User-Agent ""', 'proxy_set_header Referer ""', 'limit_req zone=elegso_privacy_global']:
            self.assertIn(item, block)
        self.assertIn('auth_basic_user_file /var/lib/elegso-seo-admin/auth/users.htpasswd', nginx)


if __name__ == "__main__":
    unittest.main()
