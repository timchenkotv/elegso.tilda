"""Cross-component regressions for published legal metadata and consent."""
import copy
import importlib.util
import io
import json
import re
import shutil
import sys
import tempfile
import unittest
import uuid
import xml.etree.ElementTree as ET
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops/seo-admin"))
import privacy_consent as privacy
import legal_publish as legal
from legal_documents import Store

SPEC = importlib.util.spec_from_file_location("legal_integration_case_publisher", ROOT / "ops/case-publisher/publish.py")
cases = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cases
SPEC.loader.exec_module(cases)


def request_consent(database, public_root, version, *, analytics=True, fallback="2026-09-13.1"):
    raw = json.dumps({"choice_id": str(uuid.uuid4()), "version": version, "analytics": analytics}).encode()
    headers = Message()
    headers["Origin"] = "https://elegso.ru"
    headers["Content-Type"] = "application/json"
    headers["Content-Length"] = str(len(raw))
    handler = SimpleNamespace(path="/api/privacy/consent", headers=headers, rfile=io.BytesIO(raw),
                              app=SimpleNamespace(allowed_origin="https://elegso.ru", privacy_version=fallback,
                                                  privacy_db_path=database, legal_public_root=public_root))
    handler.send_json = lambda data, status=200: setattr(handler, "result", (status, data))
    privacy.handle(handler)
    return handler.result


class PublishedConsentVersionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.db = self.home / "consents.sqlite3"
        self.public = self.home / "public"
        self.public.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_api_uses_atomically_published_version_not_environment(self):
        (self.public / "privacy-config.json").write_text(json.dumps({"consentVersion": "2026-09-14.7"}))
        status, body = request_consent(self.db, self.public, "2026-09-14.7")
        self.assertEqual(status, 200)
        self.assertEqual(body["receipt"]["version"], "2026-09-14.7")
        self.assertEqual(request_consent(self.db, self.public, "2026-09-13.1")[0], 400)
        self.assertEqual(request_consent(self.db, self.public, "2026-09-13.1", analytics=False)[0], 200)

    def test_api_reloads_version_on_each_request_after_symlink_switch(self):
        old, new = self.home / "old", self.home / "new"
        for folder, version in ((old, "2026-09-14.1"), (new, "2026-09-14.2")):
            folder.mkdir()
            (folder / "privacy-config.json").write_text(json.dumps({"consentVersion": version}))
        link = self.home / "current"
        link.symlink_to(old)
        self.assertEqual(request_consent(self.db, link, "2026-09-14.1")[0], 200)
        replacement = self.home / "next"
        replacement.symlink_to(new)
        replacement.replace(link)
        self.assertEqual(request_consent(self.db, link, "2026-09-14.1")[0], 400)
        self.assertEqual(request_consent(self.db, link, "2026-09-14.2")[0], 200)

    def test_missing_published_projection_uses_initial_configuration(self):
        self.assertEqual(request_consent(self.db, self.public, "2026-09-13.1")[0], 200)

    def test_invalid_published_config_fails_closed_with_service_error(self):
        (self.public / "privacy-config.json").write_text('{"unrelated":"value"}')
        self.assertEqual(request_consent(self.db, self.public, "2026-09-13.1")[0], 503)


class LegalSitemapIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.source = self.home / "www"
        (self.source / "mission").mkdir(parents=True)
        (self.source / "mission/index.html").write_text("<html><title>Site</title></html>")
        (self.source / "sitemap.base.xml").write_text('<urlset><url><loc>https://elegso.ru/mission/</loc></url><url><loc>https://elegso.ru/oferta/</loc><lastmod>2000-01-01</lastmod></url><url><loc>https://elegso.ru/oferta-fiz/</loc></url><url><loc>https://elegso.ru/cases/old-case/</loc></url></urlset>')
        self.manifest = self.home / "sitemap-legal.json"
        self.rows = ['<url><loc>https://elegso.ru/oferta/</loc><lastmod>2026-09-14</lastmod></url>', '<url><loc>https://elegso.ru/soglashenie/</loc><lastmod>2026-09-14</lastmod></url>']
        self.value = {"roots": sorted(legal.ROUTES), "rows": self.rows}
        self.manifest.write_text(json.dumps(self.value))
        self.patch = mock.patch.dict("os.environ", {"LEGAL_SITEMAP_MANIFEST": str(self.manifest)})
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_cases_sitemap_preserves_unmanaged_urls_and_replaces_legal_rows_once(self):
        result = cases.render_sitemap(self.source, [{"public_slug": "new-case", "updated_at": "2026-09-14T10:00:00Z"}])
        nodes = ET.fromstring(result).findall("{*}url")
        urls = [node.findtext("{*}loc") for node in nodes]
        self.assertIn("https://elegso.ru/mission/", urls)
        self.assertIn("https://elegso.ru/cases/new-case/", urls)
        self.assertNotIn("https://elegso.ru/cases/old-case/", urls)
        self.assertNotIn("https://elegso.ru/oferta-fiz/", urls)
        self.assertEqual(urls.count("https://elegso.ru/oferta/"), 1)
        self.assertEqual(urls.count("https://elegso.ru/soglashenie/"), 1)
        self.assertNotIn("2000-01-01", result)

    def test_legal_change_invalidates_case_publisher_digest(self):
        before = cases.content_digest(self.source, [])
        self.value["rows"][0] = self.value["rows"][0].replace("2026-09-14", "2026-09-15")
        self.manifest.write_text(json.dumps(self.value))
        self.assertNotEqual(before, cases.content_digest(self.source, []))

    def test_manifest_rejects_unmanaged_root_and_external_row(self):
        for value in ({"roots": ["articles"], "rows": []}, {"roots": sorted(legal.ROUTES), "rows": ['<url><loc>https://evil.example/oferta/</loc></url>']}):
            with self.subTest(value=value):
                self.manifest.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    cases.published_legal_sitemap(self.source)

    def test_absent_manifest_preserves_static_base(self):
        self.manifest.unlink()
        self.assertIsNone(cases.published_legal_sitemap(self.source))
        result = cases.render_sitemap(self.source, [])
        self.assertIn("https://elegso.ru/mission/", result)
        self.assertIn("2000-01-01", result)


@unittest.skipUnless(shutil.which("node"), "Node.js is unavailable")
class GeneratedLegalIntegrationTests(unittest.TestCase):
    def test_offer_seo_title_and_description_survive_subsequent_rebuild(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            store = Store(root / "legal.sqlite3")
            store.import_bundle(legal.seed_bundle(ROOT))
            row = store.get_document("offer-business")
            changed = copy.deepcopy(row["draft_content"])
            changed["version"] = "2026-09-14-integration-title"
            changed["title"] = "Юридические услуги — новая редакция договора"
            changed["description"] = "Проверка устойчивого описания договора после повторной сборки."
            draft = store.save_draft(row["id"], changed, row["revision"], "admin")
            job = store.request_publish(row["id"], draft["revision"], "admin")
            first = root / "first"
            first.mkdir()
            legal.build_projection(ROOT, first, store.export_published()["documents"], job=job, node=shutil.which("node"))
            store.claim_job(legal.WORKER)
            store.complete_job(job["id"], legal.WORKER, changed["version"])
            second = root / "second"
            second.mkdir()
            legal.build_projection(ROOT, second, store.export_published()["documents"], previous=first, node=shutil.which("node"))
            for stage in (first, second):
                html = (stage / "www/oferta/index.html").read_text()
                self.assertIn(changed["title"], re.search(r"<title>(.*?)</title>", html).group(1))
                self.assertIn(changed["description"], html)
            self.assertEqual(json.loads((first / "privacy-config.json").read_text())["consentVersion"], json.loads((second / "privacy-config.json").read_text())["consentVersion"])

    def test_generated_browser_and_api_consent_versions_match_and_sitemap_merges(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            store = Store(root / "legal.sqlite3")
            store.import_bundle(legal.seed_bundle(ROOT))
            row = store.get_document("legal-privacy")
            changed = copy.deepcopy(row["draft_content"])
            changed["title"] += " — тест публикации"
            draft = store.save_draft(row["id"], changed, row["revision"], "admin")
            job = store.request_publish(row["id"], draft["revision"], "admin")
            stage = root / "stage"
            stage.mkdir()
            legal.build_projection(ROOT, stage, store.export_published()["documents"], job=job, node=shutil.which("node"))
            config = json.loads((stage / "privacy-config.json").read_text())
            js = (stage / "privacy-config.js").read_text()
            self.assertTrue(js.startswith("window.__elegsoPublishedPrivacyConfig="))
            self.assertEqual(json.loads(js.split("=", 1)[1].rstrip(";\n")), config)
            status, response = request_consent(root / "consents.sqlite3", stage, config["consentVersion"])
            self.assertEqual(status, 200)
            self.assertEqual(response["receipt"]["version"], config["consentVersion"])
            html = (stage / "www/soglashenie/index.html").read_text()
            self.assertIn("/assets/legal-privacy-config.js", html)
            self.assertLess(html.index("/assets/legal-privacy-config.js"), html.index("/assets/site-privacy.js"))
            for script in re.findall(r"<script[^>]+src=\"/assets/(?:legal-privacy-config|site-privacy)\.js[^>]*>", html):
                self.assertIn("defer", script)
            with mock.patch.dict("os.environ", {"LEGAL_SITEMAP_MANIFEST": str(stage / "sitemap-legal.json")}):
                manifest = cases.published_legal_sitemap(ROOT / "www")
                sitemap = cases.render_sitemap(ROOT / "www", [])
                self.assertEqual(set(manifest["roots"]), legal.ROUTES)
                for expected in ("/oferta/", "/soglashenie/", "/cookies/", "/consent/", "/documents/"):
                    self.assertEqual(sitemap.count("<loc>https://elegso.ru" + expected + "</loc>"), 1)


if __name__ == "__main__":
    unittest.main()
