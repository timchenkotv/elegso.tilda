import copy
import json
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops/seo-admin"))
from legal_documents import Store, ValidationError, ConflictError, NotFoundError, canonical, digest, validate_content, validate_html, validate_url


def document(version="2026-09-14-1"):
    return {"id": "business", "version": version, "title": "Договор", "description": "Описание",
            "revisionDate": "2026-09-14", "sections": [{"id": "terms", "title": "1. Условия",
            "clauses": [{"number": "1.1", "html": 'Текст  <strong>без изменений</strong>. <a href="/soglashenie/">Политика</a>'}]}]}


class LegalDocumentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "legal.sqlite3"
        self.store = Store(self.path)
        self.content = document()
        self.bundle = {"schema_version": 1, "bundle_id": "initial", "documents": [{
            "id": "offer-business", "type": "offer", "title": "Договор", "url": "/oferta/",
            "source_path": "content/offers/business/2026-09-14-1.json", "content": self.content,
            "published_version": "2026-09-14-1", "history": [{"version_id": "2026-09-13", "content": document("2026-09-13")}]}]}
        self.store.import_bundle(self.bundle)

    def tearDown(self):
        self.temp.cleanup()

    def edited(self, version="2026-09-14-2"):
        result = document(version)
        result["sections"][0]["clauses"][0]["html"] += " Дополнение."
        return result

    def test_import_exact_and_idempotent_never_overwrites_draft(self):
        self.assertEqual(self.store.get_document("offer-business")["imported_content"], self.content)
        saved = self.store.save_draft("offer-business", self.edited(), 1, "admin")
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(self.store.import_bundle(self.bundle)["imported"], 0)
        fresh = self.store.get_document("offer-business")
        self.assertEqual(fresh["draft_content"], self.edited())
        self.assertEqual(fresh["published_content"], self.content)
        self.assertEqual(fresh["baseline_sha256"], digest(canonical(self.content)))
        self.assertEqual(len(fresh["history"]), 2)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_history_declared_date_uses_content_without_changing_snapshot(self):
        baseline = self.store.get_history("offer-business", "2026-09-14-1")
        self.assertEqual(baseline["declared_published_at"], self.content["revisionDate"])
        self.assertEqual(baseline["content"], self.content)
        self.assertEqual(baseline["sha256"], digest(canonical(self.content)))
        updated = self.edited()
        updated["publishedAt"] = "2026-09-14T12:30:00+03:00"
        draft = self.store.save_draft("offer-business", updated, 1, "admin")
        job = self.store.request_publish("offer-business", draft["revision"], "admin")
        self.store.claim_job("worker")
        self.store.complete_job(job["id"], "worker", updated["version"])
        published = self.store.get_history("offer-business", updated["version"])
        self.assertEqual(published["declared_published_at"], updated["publishedAt"])
        self.assertEqual(published["content"], updated)
        self.assertEqual(published["sha256"], digest(canonical(updated)))
        self.assertTrue(published["recorded_at"].endswith("Z"))
        self.assertNotEqual(published["recorded_at"], published["declared_published_at"])

    def test_changed_bundle_baseline_rejected_atomically(self):
        changed = copy.deepcopy(self.bundle)
        changed["bundle_id"] = "later"
        changed["documents"].insert(0, {"id": "first", "type": "settings", "title": "Settings", "content": {}})
        changed["documents"][1]["content"]["title"] = "Другой"
        with self.assertRaises(ConflictError):
            self.store.import_bundle(changed)
        with self.assertRaises(NotFoundError):
            self.store.get_document("first")
        with self.assertRaises(ConflictError):
            self.store.import_bundle(self.bundle, idempotent=False)

    def test_optimistic_concurrent_saves_one_wins(self):
        def save(i):
            payload = self.edited()
            payload["title"] = str(i)
            try:
                return self.store.save_draft("offer-business", payload, 1, "writer")["revision"]
            except ConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, (1, 2)))
        self.assertEqual(sorted(map(str, results)), ["2", "conflict"])
        self.assertEqual(len([a for a in self.store.get_audit() if a["action"] == "save_draft"]), 1)

    def test_rejects_unsafe_html_without_rewriting_or_partial_save(self):
        payload = self.edited()
        payload["sections"][0]["clauses"][0]["html"] = '<img src="/image.webp" onerror="alert(1)">'
        with self.assertRaises(ValidationError):
            self.store.save_draft("offer-business", payload, 1, "admin")
        self.assertEqual(self.store.get_document("offer-business")["revision"], 1)
        for html in ('<script>alert(1)</script>', '<a href="java&#x73;cript:alert(1)">x</a>',
                     '<svg><a href="/">x</a></svg>', '<span style="color:red">x</span>',
                     '<a href="/" href="javascript:1">x</a>', '<strong>unclosed', '<!-- test -->',
                     '<a href="https://example.org" target="_blank">x</a>', '<iframe src="/"/>'):
            with self.subTest(html=html), self.assertRaises(ValidationError):
                validate_html(html)
        validate_html('<p>Текст <a href="https://example.org" target="_blank" rel="noopener noreferrer">ссылка</a><br>конец</p>')

    def test_url_guards(self):
        for url in ("javascript:1", "data:text/html,a", "//evil.example/x", "/%2fexample.com", "/../secret", "/%2e%2e/secret", "https://good.example@evil.example/", "https://a.example/\\evil", "mailto:x@example.org?body=secret"):
            with self.subTest(url=url), self.assertRaises(ValidationError):
                validate_url(url)
        for url in ("/oferta/", "#section", "https://vsrf.ru/files/1/", "mailto:mail@elegso.ru", "tel:+74956460002"):
            self.assertEqual(validate_url(url), url)

    def test_unsafe_legacy_import_lossless_but_publication_blocked(self):
        legacy = {"schema_version": 1, "bundle_id": "legacy", "documents": [{"id": "legacy", "type": "legacy", "title": "Legacy", "content": {"html": '<p onclick="bad()">Original</p>'}}]}
        self.store.import_bundle(legacy)
        self.assertEqual(self.store.get_document("legacy")["content"], legacy["documents"][0]["content"])
        self.assertTrue(self.store.get_document("legacy")["validation_errors"])
        with self.assertRaises(ValidationError):
            self.store.request_publish("legacy", 1, "admin")

    def test_publish_snapshot_does_not_follow_future_draft_and_is_idempotent(self):
        self.store.save_draft("offer-business", self.edited(), 1, "admin")
        first = self.store.request_publish("offer-business", 2, "admin")
        repeated = self.store.request_publish("offer-business", 2, "other-admin")
        self.assertEqual(first, repeated)
        self.store.save_draft("offer-business", self.edited("2026-09-14-3"), 2, "admin")
        self.assertEqual(self.store.get_job(first["id"])["snapshot"], self.edited())
        self.assertEqual(self.store.claim_job("worker")["id"], first["id"])
        with self.assertRaises(ConflictError):
            self.store.complete_job(first["id"], "other-worker", "2026-09-14-2")
        done = self.store.complete_job(first["id"], "worker", "2026-09-14-2", published_at="2020-01-01")
        self.assertEqual(done["status"], "completed")
        self.assertEqual(self.store.complete_job(first["id"], "worker", "2026-09-14-2"), done)
        doc = self.store.get_document("offer-business")
        self.assertEqual(doc["published_content"], self.edited())
        self.assertEqual(doc["draft_content"], self.edited("2026-09-14-3"))
        self.assertTrue(doc["has_changes"])
        history = self.store.get_history("offer-business", "2026-09-14-2")
        self.assertNotEqual(history["recorded_at"], history["declared_published_at"])

    def test_offer_requires_new_identifier_and_url(self):
        unchanged_version = self.edited("2026-09-14-1")
        self.store.save_draft("offer-business", unchanged_version, 1, "admin")
        with self.assertRaises(ValidationError):
            self.store.request_publish("offer-business", 2, "admin")
        changed = self.edited()
        changed["publication"] = {"permanentUrl": "/oferta/versions/2026-09-14-1/"}
        self.store.save_draft("offer-business", changed, 2, "admin")
        with self.assertRaises(ValidationError):
            self.store.request_publish("offer-business", 3, "admin")
        changed["publication"]["permanentUrl"] = "/oferta/versions/custom-2/"
        self.store.save_draft("offer-business", changed, 3, "admin")
        self.assertEqual(self.store.request_publish("offer-business", 4, "admin")["status"], "queued")

    def test_publication_metadata_display_identifier_and_legacy_url_guard(self):
        payload = self.edited()
        payload["publication"] = {"identifier": "ЭЛЕГСО / единая оферта № 2", "checksumNote": "Контрольная сумма текста"}
        validate_content("offer", payload)
        payload["permanentUrl"] = "/other-route/versions/new/"
        with self.assertRaises(ValidationError):
            validate_content("offer", payload)
        payload["permanentUrl"] = "/oferta/versions/2026-09-14-1/"
        saved = self.store.save_draft("offer-business", payload, 1, "admin")
        with self.assertRaises(ValidationError):
            self.store.request_publish("offer-business", saved["revision"], "admin")

    def test_pending_version_is_reserved_and_claims_serialized(self):
        self.store.save_draft("offer-business", self.edited(), 1, "admin")
        first = self.store.request_publish("offer-business", 2, "admin")
        same_version = self.edited()
        same_version["title"] = "Иной текст"
        self.store.save_draft("offer-business", same_version, 2, "admin")
        with self.assertRaises(ConflictError):
            self.store.request_publish("offer-business", 3, "admin")
        self.store.save_draft("offer-business", self.edited("2026-09-14-3"), 3, "admin")
        second = self.store.request_publish("offer-business", 4, "admin")
        self.assertEqual(self.store.claim_job("one")["id"], first["id"])
        self.assertIsNone(self.store.claim_job("two"))
        self.store.fail_job(first["id"], "one", "build_failed")
        self.assertEqual(self.store.claim_job("two")["id"], second["id"])

    def test_history_restores_into_new_draft_only(self):
        restored = self.store.create_from_history("offer-business", "2026-09-13", 1, "admin")
        self.assertEqual(restored["revision"], 2)
        self.assertEqual(restored["content"], document("2026-09-13"))
        self.assertEqual(restored["published_content"], self.content)
        with self.assertRaises(ValidationError):
            self.store.request_publish("offer-business", 2, "admin")
        with self.assertRaises(ConflictError):
            self.store.create_from_history("offer-business", "2026-09-13", 1, "admin")

    def test_failed_job_retry_keeps_snapshot_and_rejects_rollback_after_new_publish(self):
        self.store.save_draft("offer-business", self.edited(), 1, "admin")
        first = self.store.request_publish("offer-business", 2, "admin")
        self.store.claim_job("worker")
        self.store.fail_job(first["id"], "worker", "temporary")
        retry = self.store.retry_job(first["id"], "admin")
        self.assertEqual(retry["snapshot_sha256"], first["snapshot_sha256"])
        self.store.claim_job("worker")
        self.store.fail_job(first["id"], "worker", "again")
        self.store.save_draft("offer-business", self.edited("2026-09-14-3"), 2, "admin")
        second = self.store.request_publish("offer-business", 3, "admin")
        self.store.claim_job("worker")
        self.store.complete_job(second["id"], "worker", "2026-09-14-3")
        with self.assertRaises(ConflictError):
            self.store.retry_job(first["id"], "admin")

    def test_noop_publication_reuses_imported_history(self):
        job = self.store.request_publish("offer-business", 1, "admin")
        self.store.claim_job("worker")
        self.store.complete_job(job["id"], "worker", "2026-09-14-1")
        self.assertEqual(len(self.store.get_history("offer-business")), 2)

    def test_job_snapshot_is_immutable_in_database(self):
        job = self.store.request_publish("offer-business", 1, "admin")
        with closing(sqlite3.connect(self.path)) as db, db:
            for sql in ("UPDATE legal_jobs SET snapshot_json='{}'", "UPDATE legal_jobs SET revision=99", "DELETE FROM legal_jobs"):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                    db.execute(sql)
        self.assertEqual(self.store.get_job(job["id"])["snapshot"], self.content)

    def test_database_immutability_and_separate_unrelated_table(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TABLE unrelated(v TEXT)")
            db.execute("INSERT INTO unrelated VALUES('keep')")
            for sql in ("UPDATE legal_publications SET content_json='{}'", "DELETE FROM legal_publications", "DELETE FROM legal_audit", "UPDATE legal_audit SET action='bad'", "UPDATE legal_documents SET imported_json='{}'", "DELETE FROM legal_imports"):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                    db.execute(sql)
        Store(self.path)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT v FROM unrelated").fetchone()[0], "keep")

    def test_export_is_committed_history_not_draft(self):
        self.store.save_draft("offer-business", self.edited(), 1, "admin")
        exported = self.store.export_published()["documents"][0]
        self.assertEqual(exported["published_content"], self.content)
        self.assertEqual(exported["imported_content"], self.content)
        self.assertEqual(len(exported["history"]), 2)
        self.assertNotIn("draft_content", exported)
        self.assertEqual(exported["history"][0]["sha256"], digest(canonical(exported["history"][0]["content"])))

    def test_read_only_and_immutable_document_identity(self):
        bundle = {"schema_version": 1, "bundle_id": "readonly", "documents": [{"id": "archive", "type": "settings", "title": "Архив", "content": {}, "editable": False}]}
        self.store.import_bundle(bundle)
        for action in (lambda: self.store.save_draft("archive", {"x": 1}, 1, "admin"), lambda: self.store.request_publish("archive", 1, "admin"), lambda: self.store.create_from_history("archive", "baseline", 1, "admin")):
            with self.assertRaises(ValidationError):
                action()
        wrong_id = self.edited()
        wrong_id["id"] = "other"
        with self.assertRaises(ValidationError):
            self.store.save_draft("offer-business", wrong_id, 1, "admin")

    def test_actual_editable_sources_pass_safety_without_changes(self):
        sources = [("offer", ROOT / "content/offers/business/2026-09-13-4.json"), ("practice", ROOT / "content/offers/practice.json")]
        sources += [("legal", path) for path in (ROOT / "content/legal").glob("*.json")]
        for kind, path in sources:
            with self.subTest(path=path):
                value = json.loads(path.read_text())
                original = copy.deepcopy(value)
                validate_content(kind, value)
                self.assertEqual(value, original)


if __name__ == "__main__":
    unittest.main()
