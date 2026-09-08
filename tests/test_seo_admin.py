import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MONITOR_DIR = ROOT / "ops" / "seo-monitor"
ADMIN_FILE = ROOT / "ops" / "seo-admin" / "app.py"
sys.path.insert(0, str(MONITOR_DIR))
SPEC = importlib.util.spec_from_file_location("elegso_seo_admin", ADMIN_FILE)
assert SPEC and SPEC.loader
admin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = admin
SPEC.loader.exec_module(admin)


class SeoAdminUserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = self.root / "keywords.json"
        self.config.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "regions": ["225", "213", "2"],
                    "sites": [
                        {
                            "id": "elegso.ru",
                            "name": "ELEGSO",
                            "domains": ["elegso.ru"],
                            "keywords": [
                                {
                                    "query": "юрист по лизингу",
                                    "cluster": "лизинг",
                                    "target_url": "/leasing_lawyer/",
                                }
                            ],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.environment = mock.patch.dict(
            os.environ,
            {
                "SEO_ADMIN_OWNER": "owner@example.ru",
                "SEO_ADMIN_DB": str(self.root / "admin.sqlite3"),
                "SEO_ADMIN_ACCESS_DB": str(self.root / "access.sqlite3"),
                "SEO_ADMIN_HTPASSWD": str(self.root / "users.htpasswd"),
                "SEO_MONITOR_CONFIG": str(self.config),
                "SEO_MONITOR_DB": str(self.root / "monitor.sqlite3"),
                "SEO_ADMIN_STATIC_DIR": str(ROOT / "ops" / "seo-admin" / "static"),
            },
        )
        self.environment.start()
        self.app = admin.Application()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def test_owner_is_bootstrapped_and_cannot_be_downgraded_or_deleted(self) -> None:
        self.assertEqual(self.app.actor_role("OWNER@example.ru"), "admin")
        self.assertTrue(self.app.current_user("owner@example.ru")["is_owner"])
        with self.assertRaisesRegex(ValueError, "must remain"):
            self.app.save_user(
                {
                    "username": "owner@example.ru",
                    "password": "a-secure-password",
                    "role": "viewer",
                },
                "owner@example.ru",
            )
        with self.assertRaisesRegex(ValueError, "cannot be deleted"):
            self.app.delete_user("owner@example.ru", "owner@example.ru")

    @mock.patch.object(admin.subprocess, "run")
    def test_owner_can_add_viewer_without_putting_password_in_arguments(self, run) -> None:
        run.return_value = SimpleNamespace(returncode=0, stderr="")
        password = "marketer-password-123"
        result = self.app.save_user(
            {
                "username": "Marketing@Example.ru",
                "password": password,
                "role": "viewer",
            },
            "owner@example.ru",
        )
        self.assertEqual(result["username"], "marketing@example.ru")
        self.assertEqual(self.app.actor_role("marketing@example.ru"), "viewer")
        arguments = run.call_args.args[0]
        self.assertNotIn(password, arguments)
        self.assertEqual(run.call_args.kwargs["input"], password + "\n")

        with closing(sqlite3.connect(self.app.access_db_path)) as connection:
            serialized_audit = " ".join(
                row[0] for row in connection.execute("SELECT details FROM audit_log")
            )
        self.assertNotIn(password, serialized_audit)

    @mock.patch.object(admin.subprocess, "run")
    def test_viewer_can_read_but_cannot_manage_users(self, run) -> None:
        run.return_value = SimpleNamespace(returncode=0, stderr="")
        self.app.save_user(
            {
                "username": "marketing@example.ru",
                "password": "marketer-password-123",
                "role": "viewer",
            },
            "owner@example.ru",
        )
        self.assertEqual(
            self.app.require_authenticated("marketing@example.ru"), "viewer"
        )
        with self.assertRaises(PermissionError):
            self.app.users("marketing@example.ru")
        with self.assertRaises(PermissionError):
            self.app.save_user(
                {
                    "username": "another@example.ru",
                    "password": "another-password-123",
                    "role": "viewer",
                },
                "marketing@example.ru",
            )
        with self.assertRaises(PermissionError):
            self.app.require_admin("marketing@example.ru")

    def test_unknown_or_orphaned_basic_auth_user_is_rejected(self) -> None:
        with self.assertRaises(PermissionError):
            self.app.require_authenticated("orphan@example.ru")


if __name__ == "__main__":
    unittest.main()
