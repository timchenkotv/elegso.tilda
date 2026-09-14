"""Publisher tests operate exclusively on temporary databases and releases."""
import copy
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops/seo-admin"))
sys.path.insert(0, str(ROOT / "ops/seo-monitor"))
import legal_publish as publisher
from legal_documents import Store, ValidationError, ConflictError, canonical, digest

SPEC = importlib.util.spec_from_file_location("legal_publish_test_admin", ROOT / "ops/seo-admin/app.py")
admin = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(admin)


class LegalPublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.db = self.home / "documents.sqlite3"
        self.output = self.home / "releases-root"
        self.store = Store(self.db)
        self.bundle = publisher.seed_bundle(ROOT)
        self.store.import_bundle(self.bundle)

    def tearDown(self):
        self.temp.cleanup()

    def fake_build(self, source, stage, documents, job=None, previous=None, node=None):
        self.assertIsInstance(documents, list)
        self.assertTrue(all("published_content" in row and "history" in row for row in documents))
        web = stage / "www/soglashenie"
        web.mkdir(parents=True)
        payload = job["snapshot"] if job else next(row["published_content"] for row in documents if row["id"] == "legal-privacy")
        (web / "index.html").write_text("<html><title>Legal</title><body>" + payload["title"] + "</body></html>")
        return {"job_id": job["id"] if job else None}

    def initial_release(self):
        with mock.patch.object(publisher, "build_projection", side_effect=self.fake_build):
            return publisher.run(ROOT, self.db, self.output, "node", force=True)

    def enqueue_privacy(self):
        row = self.store.get_document("legal-privacy")
        content = copy.deepcopy(row["content"])
        content["title"] += " — новая редакция"
        saved = self.store.save_draft(row["id"], content, row["revision"], "admin")
        return self.store.request_publish(row["id"], saved["revision"], "admin")

    def test_seed_import_is_lossless_and_legacy_roundtrip_exact(self):
        for source in self.bundle["documents"]:
            with self.subTest(document=source["id"]):
                imported = self.store.get_document(source["id"])
                self.assertEqual(imported["imported_content"], source["content"])
                self.assertEqual(imported["baseline_sha256"], digest(canonical(source["content"])))
                for version in source.get("history", []):
                    self.assertEqual(self.store.get_history(source["id"], version["version_id"])["content"], version["content"])
        source = ROOT / "www/offer_for_lawyer_20231103/index.html"
        legacy = self.store.get_document("legacy-contractors")["content"]
        self.assertEqual(publisher.render_legacy(source, legacy), source.read_text())

    def test_initialize_does_not_replace_editor_draft(self):
        self.enqueue_privacy()
        before = self.store.get_document("legal-privacy")
        self.assertEqual(publisher.initialize(self.store, ROOT), {"status": "already_imported"})
        self.assertEqual(self.store.get_document("legal-privacy"), before)

    def test_worker_publishes_job_snapshot_not_current_draft(self):
        self.initial_release()
        job = self.enqueue_privacy()
        row = self.store.get_document("legal-privacy")
        # A user keeps editing (or reverts) while the queued snapshot is fixed.
        self.store.save_draft("legal-privacy", row["published_content"], row["revision"], "admin")
        with mock.patch.object(publisher, "build_projection", side_effect=self.fake_build):
            result = publisher.run(ROOT, self.db, self.output, "node")
        self.assertEqual(result["status"], "published")
        current = self.store.get_document("legal-privacy")
        self.assertEqual(current["published_content"], job["snapshot"])
        self.assertEqual(current["published_version"], job["id"])
        self.assertNotEqual(current["draft_content"], current["published_content"])
        self.assertIn(job["snapshot"]["title"], (self.output / "current/www/soglashenie/index.html").read_text())
        self.assertTrue(list((self.db.parent / "backups").glob("*.sqlite3")))

    def test_deployment_rebuild_preserves_queued_publication(self):
        self.initial_release()
        job = self.enqueue_privacy()
        before = self.store.get_document("legal-privacy")["published_sha256"]
        self.initial_release()
        self.assertEqual(self.store.get_job(job["id"])["status"], "queued")
        self.assertEqual(self.store.get_document("legal-privacy")["published_sha256"], before)

    def test_deployment_rebuild_requires_interrupted_job_recovery(self):
        self.initial_release()
        self.enqueue_privacy()
        job = self.store.claim_job(publisher.WORKER)
        with self.assertRaisesRegex(RuntimeError, "Recover the interrupted"):
            self.initial_release()
        self.assertEqual(self.store.get_job(job["id"])["status"], "running")

    def test_build_failure_never_switches_current(self):
        self.initial_release()
        previous = (self.output / "current").resolve()
        original = (previous / "www/soglashenie/index.html").read_bytes()
        job = self.enqueue_privacy()
        with mock.patch.object(publisher, "build_projection", side_effect=ValueError("invalid candidate")):
            with self.assertRaisesRegex(ValueError, "invalid candidate"):
                publisher.run(ROOT, self.db, self.output, "node")
        self.assertEqual((self.output / "current").resolve(), previous)
        self.assertEqual((previous / "www/soglashenie/index.html").read_bytes(), original)
        self.assertEqual(self.store.get_job(job["id"])["status"], "failed")
        self.assertFalse(list(self.output.glob(".build-*")))

    def test_database_completion_failure_rolls_back_files(self):
        self.initial_release()
        previous = (self.output / "current").resolve()
        job = self.enqueue_privacy()
        with mock.patch.object(publisher, "build_projection", side_effect=self.fake_build), mock.patch.object(Store, "complete_job", side_effect=ConflictError("forced collision")):
            with self.assertRaisesRegex(ConflictError, "forced collision"):
                publisher.run(ROOT, self.db, self.output, "node")
        self.assertEqual((self.output / "current").resolve(), previous)
        self.assertEqual(self.store.get_job(job["id"])["status"], "failed")
        self.assertEqual(self.store.get_document("legal-privacy")["published_content"], next(item["content"] for item in self.bundle["documents"] if item["id"] == "legal-privacy"))

    def test_noop_job_retains_imported_history_version(self):
        self.initial_release()
        row = self.store.get_document("legal-privacy")
        old_history = self.store.get_history("legal-privacy")
        job = self.store.request_publish("legal-privacy", row["revision"], "admin")
        # A later unscheduled draft must not turn this no-op snapshot into a new edition.
        newer = copy.deepcopy(row["content"])
        newer["title"] += " — черновик"
        self.store.save_draft("legal-privacy", newer, row["revision"], "admin")
        with mock.patch.object(publisher, "build_projection", side_effect=self.fake_build):
            publisher.run(ROOT, self.db, self.output, "node")
        self.assertEqual(self.store.get_job(job["id"])["status"], "completed")
        self.assertEqual(self.store.get_history("legal-privacy"), old_history)

    def interrupted_release(self, job, previous, tamper=False):
        self.store.claim_job(publisher.WORKER)
        release = self.output / "releases/crash-after-switch"
        release.mkdir(parents=True)
        content = copy.deepcopy(job["snapshot"])
        if tamper:
            content["title"] += " CORRUPTED"
        publisher.write_json(release / "manifest.json", {
            "job_id": job["id"], "documents": {job["document_id"]: job["snapshot_sha256"]},
            "previous": str(previous) if previous else None})
        publisher.write_json(release / "published.json", {"documents": {job["document_id"]: content}, "job_id": job["id"]})
        publisher.write_json(release / "privacy-config.json", {"consentVersion": "2026-09-14.123"})
        (self.output / "current").unlink(missing_ok=True)
        (self.output / "current").symlink_to(release)
        return release

    def test_crash_reconciliation_commits_snapshot_without_rebuild_or_consent_bump(self):
        self.initial_release()
        previous = (self.output / "current").resolve()
        job = self.enqueue_privacy()
        release = self.interrupted_release(job, previous)
        config_bytes = (release / "privacy-config.json").read_bytes()
        with mock.patch.object(publisher, "build_projection", side_effect=AssertionError("must not rebuild committed files")):
            result = publisher.run(ROOT, self.db, self.output, "node")
        self.assertEqual(result["status"], "reconciled")
        self.assertEqual((self.output / "current").resolve(), release.resolve())
        self.assertEqual(self.store.get_job(job["id"])["status"], "completed")
        self.assertEqual(self.store.get_document("legal-privacy")["published_content"], job["snapshot"])
        self.assertEqual((release / "privacy-config.json").read_bytes(), config_bytes)
        with mock.patch.object(publisher, "build_projection", side_effect=AssertionError("must remain idle")):
            self.assertEqual(publisher.run(ROOT, self.db, self.output, "node"), {"status": "idle"})

    def test_crash_reconciliation_completion_failure_restores_previous_release(self):
        self.initial_release()
        previous = (self.output / "current").resolve()
        job = self.enqueue_privacy()
        self.interrupted_release(job, previous)
        with mock.patch.object(Store, "complete_job", side_effect=ConflictError("reconcile failed")):
            with self.assertRaisesRegex(ConflictError, "reconcile failed"):
                publisher.run(ROOT, self.db, self.output, "node")
        self.assertEqual((self.output / "current").resolve(), previous)
        self.assertEqual(self.store.get_job(job["id"])["status"], "failed")

    def test_crash_reconciliation_rejects_tampered_snapshot(self):
        self.initial_release()
        previous = (self.output / "current").resolve()
        job = self.enqueue_privacy()
        self.interrupted_release(job, previous, tamper=True)
        with mock.patch.object(publisher, "build_projection", side_effect=AssertionError("must not publish corrupt snapshot")):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                publisher.run(ROOT, self.db, self.output, "node")
        self.assertNotEqual(self.store.get_job(job["id"])["status"], "completed")
        self.assertEqual((self.output / "current").resolve(), previous)
        self.assertEqual(self.store.get_job(job["id"])["status"], "failed")

    def test_failed_reconciliation_of_first_release_removes_bad_pointer(self):
        job = self.enqueue_privacy()
        self.interrupted_release(job, None)
        with mock.patch.object(Store, "complete_job", side_effect=ConflictError("first commit failed")):
            with self.assertRaisesRegex(ConflictError, "first commit failed"):
                publisher.run(ROOT, self.db, self.output, "node")
        self.assertFalse((self.output / "current").exists())
        self.assertEqual(self.store.get_job(job["id"])["status"], "failed")

    def test_offer_collision_rejected_before_worker(self):
        row = self.store.get_document("offer-business")
        changed = copy.deepcopy(row["content"])
        changed["title"] += " — правка"
        saved = self.store.save_draft(row["id"], changed, row["revision"], "admin")
        with self.assertRaises(ValidationError):
            self.store.request_publish(row["id"], saved["revision"], "admin")
        self.assertEqual(self.store.jobs(), [])

    def test_legacy_slot_count_change_is_rejected(self):
        source = ROOT / "www/offer_for_lawyer_20231103/index.html"
        legacy = self.store.get_document("legacy-contractors")["content"]
        legacy["sections"][0]["clauses"].pop()
        with self.assertRaises(ValueError):
            publisher.render_legacy(source, legacy)

    @unittest.skipUnless(shutil.which("node"), "Node.js is unavailable")
    def test_real_build_stage_does_not_touch_live_or_source(self):
        stage = self.home / "candidate"
        stage.mkdir()
        source_page = ROOT / "www/soglashenie/index.html"
        before = source_page.read_bytes()
        manifest = publisher.build_projection(ROOT, stage, self.store.export_published()["documents"], node=shutil.which("node"))
        self.assertIsNone(manifest["job_id"])
        for route in ("oferta", "oferta-fiz", "soglashenie", "cookies", "consent", "documents", "offer_for_lawyer_20231103"):
            self.assertTrue((stage / "www" / route / "index.html").exists(), route)
        self.assertFalse((stage / "www/mission").exists())
        self.assertFalse((stage / "www/assets").exists())
        self.assertTrue((stage / "www/soglashenie/history/index.html").exists())
        self.assertEqual(source_page.read_bytes(), before)
        self.assertFalse((self.output / "current").exists())


class LegalHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "legal.sqlite3"
        self.store = Store(self.db)
        self.store.import_bundle({"schema_version": 1, "bundle_id": "http", "documents": [{"id": "settings", "type": "settings", "title": "Settings", "content": {"label": "One"}}]})

    def tearDown(self):
        self.temp.cleanup()

    def handler(self, role="admin", payload=None, origin="https://elegso.ru"):
        def authenticated(actor):
            if role not in ("admin", "viewer"):
                raise PermissionError("inactive")
        def require_admin(actor):
            if role != "admin":
                raise PermissionError("administrator required")
        raw = json.dumps(payload or {}).encode()
        headers = Message()
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(raw))
        if origin is not None:
            headers["Origin"] = origin
        app = SimpleNamespace(legal_db_path=self.db, require_authenticated=authenticated, require_admin=require_admin, actor_role=lambda actor: role, allowed_origin="https://elegso.ru")
        handler = SimpleNamespace(app=app, headers=headers, rfile=io.BytesIO(raw), actor=lambda: "reviewer")
        handler.send_json = lambda data, status=200: setattr(handler, "result", (status, data))
        handler.require_valid_origin = lambda: admin.Handler.require_valid_origin(handler)
        return handler

    def test_read_access_requires_authenticated_active_user(self):
        handler = self.handler(role=None)
        self.assertTrue(admin.Handler.legal_request(handler, "GET", "/api/legal-documents"))
        self.assertEqual(handler.result[0], 403)
        viewer = self.handler(role="viewer")
        admin.Handler.legal_request(viewer, "GET", "/api/legal-documents")
        self.assertEqual(viewer.result[0], 200)
        self.assertFalse(viewer.result[1]["can_edit"])

    def test_viewer_cannot_mutate_and_invalid_origin_is_rejected(self):
        for role, origin in (("viewer", "https://elegso.ru"), ("admin", "https://evil.example"), ("admin", None)):
            with self.subTest(role=role, origin=origin):
                handler = self.handler(role=role, origin=origin, payload={"content": {"label": "Two"}, "expected_revision": 1})
                admin.Handler.legal_request(handler, "PUT", "/api/legal-documents/settings")
                self.assertEqual(handler.result[0], 403)
        self.assertEqual(self.store.get_document("settings")["revision"], 1)

    def test_http_revision_conflict_and_enqueue_without_publish(self):
        payload = {"content": {"label": "Two"}, "expected_revision": 1}
        handler = self.handler(payload=payload)
        admin.Handler.legal_request(handler, "PUT", "/api/legal-documents/settings")
        self.assertEqual(handler.result[0], 200)
        stale = self.handler(payload=payload)
        admin.Handler.legal_request(stale, "PUT", "/api/legal-documents/settings")
        self.assertEqual(stale.result[0], 409)
        publish = self.handler(payload={"expected_revision": 2})
        admin.Handler.legal_request(publish, "POST", "/api/legal-documents/settings/publish")
        self.assertEqual(publish.result[0], 202)
        self.assertEqual(publish.result[1]["job"]["status"], "queued")
        self.assertEqual(self.store.get_document("settings")["published_content"], {"label": "One"})

    def test_unrelated_routes_not_consumed(self):
        handler = self.handler()
        self.assertFalse(admin.Handler.legal_request(handler, "GET", "/api/users"))
        self.assertFalse(hasattr(handler, "result"))


if __name__ == "__main__":
    unittest.main()
