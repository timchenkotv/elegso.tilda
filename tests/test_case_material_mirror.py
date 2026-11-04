"""Static public-document projection, reuse, allowlist and failure atomicity."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("case_material_publisher", ROOT / "ops/case-publisher/publish.py")
assert SPEC and SPEC.loader
publisher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publisher
SPEC.loader.exec_module(publisher)


def record(slug: str = "example-case") -> dict:
    return {
        "code": "CASE-TEST",
        "public_slug": slug,
        "public_title": "Публичная история дела",
        "public_excerpt": "Полный исходный анонс остаётся на странице.",
        "updated_at": "2026-11-03T15:00:00Z",
        "document_date": "2026-11-01",
        "outcome_kind": "won",
        "published_materials": [
            {"id": 1, "kind": "folder", "name": "Судебные акты", "parent_id": None},
            {
                "id": 11,
                "parent_id": 1,
                "kind": "file",
                "media_kind": "pdf",
                "name": "Решение суда.pdf",
                "file_date": "2026-11-01",
                "file_content_type": "application/pdf",
                "file_size": len(PDF_BYTES),
                "content_url": f"/api/v1/public/legal-case-announcements/{slug}/materials/11/decision.pdf",
            },
        ],
    }


PDF_BYTES = b"%PDF-1.7\nexact public ERP document\n%%EOF\n"
JPEG_BYTES = b"\xff\xd8\xffexact public ERP photograph\xff\xd9"


def source_tree(base: Path) -> Path:
    source = base / "source"
    (source / "mission").mkdir(parents=True)
    (source / "mission/index.html").write_text(
        '<!doctype html><html><head><title>ЭЛЕГСО</title>'
        '<link rel="canonical" href="https://elegso.ru/mission/"></head>'
        '<body><div id="allrecords"><!--header--><header>Шапка</header>'
        '<main>Исходная страница</main><!--footer--><footer>Подвал</footer></div></body></html>',
        encoding="utf-8",
    )
    return source


class Response:
    def __init__(self, url: str, data: bytes = PDF_BYTES, content_type: str = "application/pdf", status: int = 200):
        self.url, self.data, self.status = url, data, status
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, size: int = -1):
        return self.data if size < 0 else self.data[:size]


class PublicMaterialMirrorTests(unittest.TestCase):
    def test_file_bytes_and_prose_are_preserved_and_rendering_is_fully_local(self):
        case = record()
        photo = copy.deepcopy(case["published_materials"][1])
        photo.update({
            "id": 12, "media_kind": "image", "name": "Фото.jpg",
            "file_content_type": "image/jpeg", "file_size": len(JPEG_BYTES),
            "content_url": "/api/v1/public/legal-case-announcements/example-case/materials/12/photo.jpg",
        })
        case["published_materials"].append(photo)
        original = copy.deepcopy(case)
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(
                url, JPEG_BYTES if "/12/" in url else PDF_BYTES,
                "image/jpeg" if "/12/" in url else "application/pdf",
            )) as download:
                changed, release = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
            self.assertTrue(changed)
            self.assertEqual(download.call_count, 2)
            self.assertEqual(case, original, "Mirroring must not add local fields to source ERP records")
            detail = (release / "cases/example-case/index.html").read_text()
            self.assertIn(case["public_excerpt"], detail)
            self.assertIn('data-case-lazy-src="/cases/example-case/materials/', detail)
            self.assertIn('download="Решение суда.pdf"', detail)
            self.assertNotIn("/api/v1/", detail)
            self.assertNotIn("law.elegso.ru", detail)
            for item, expected in [(case["published_materials"][1], PDF_BYTES), (photo, JPEG_BYTES)]:
                local = publisher.material_local_url(case, item)
                self.assertEqual((release / local.lstrip("/")).read_bytes(), expected)
            manifest = json.loads((release / "cases/example-case/materials/manifest.json").read_text())
            self.assertEqual(manifest["version"], 1)
            self.assertEqual(len(manifest["items"]), 2)
            self.assertEqual(manifest["items"][0]["sha256"], hashlib.sha256(PDF_BYTES).hexdigest())
            self.assertNotIn("source_url", json.dumps(manifest))

    def test_unchanged_release_makes_no_downloads_and_design_change_reuses_integrity_checked_local_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            case = record()
            with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(url)) as download:
                _, first = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                changed, same = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                self.assertFalse(changed)
                self.assertEqual(first, same)
                document = source / "mission/index.html"
                document.write_text(document.read_text().replace("Шапка", "Обновлённая шапка"))
                changed, second = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                self.assertTrue(changed)
                self.assertNotEqual(first, second)
                self.assertEqual(download.call_count, 1)
                spec = publisher.public_material_spec(case, case["published_materials"][1])
                self.assertEqual((second / f"cases/example-case/materials/{spec.filename}").read_bytes(), PDF_BYTES)

    def test_case_version_change_refreshes_only_that_cases_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            first, second = record("first-case"), record("second-case")
            with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(url)) as download:
                publisher.write_release(source, base / "generated", [first, second], publisher.DEFAULT_API_BASE)
                second["updated_at"] = "2026-11-04T10:30:00Z"
                publisher.write_release(source, base / "generated", [first, second], publisher.DEFAULT_API_BASE)
                self.assertEqual(download.call_count, 3)
                self.assertIn("/second-case/", download.call_args.args[0])

    def test_removed_materials_and_cases_are_not_retained_in_new_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            first, second = record("first-case"), record("second-case")
            with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(url)):
                publisher.write_release(source, base / "generated", [first, second], publisher.DEFAULT_API_BASE)
                first["published_materials"] = []
                first["updated_at"] = "2026-11-04T10:30:00Z"
                _, release = publisher.write_release(source, base / "generated", [first], publisher.DEFAULT_API_BASE)
            self.assertFalse((release / "cases/first-case/materials").exists())
            self.assertFalse((release / "cases/second-case").exists())
            self.assertNotIn('id="materials"', (release / "cases/first-case/index.html").read_text())

    def test_force_rebuild_is_immutable_and_next_timer_keeps_it_without_downloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            case = record()
            with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(url)) as download:
                _, first = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                original = (first / "cases/example-case/index.html").read_bytes()
                changed, rebuilt = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE, force=True)
                self.assertTrue(changed)
                self.assertNotEqual(first, rebuilt)
                self.assertEqual((first / "cases/example-case/index.html").read_bytes(), original)
                self.assertEqual((base / "generated/current").resolve(), rebuilt.resolve())
                unchanged, active = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                self.assertFalse(unchanged)
                self.assertEqual(active.resolve(), rebuilt.resolve())
                self.assertEqual(download.call_count, 1)

    def test_corrupt_local_copy_is_redownloaded_instead_of_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            case = record()
            with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(url)) as download:
                _, first = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                local = first / publisher.material_local_url(case, case["published_materials"][1]).lstrip("/")
                local.write_bytes(b"corrupted")
                document = source / "mission/index.html"
                document.write_text(document.read_text().replace("Шапка", "Новая шапка"))
                _, second = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                self.assertEqual(download.call_count, 2)
                self.assertEqual((second / local.relative_to(first)).read_bytes(), PDF_BYTES)

    def test_absent_version_never_reuses_a_binary_on_changed_projection(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            case = record()
            case.pop("updated_at")
            with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(url)) as download:
                publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                document = source / "mission/index.html"
                document.write_text(document.read_text().replace("Шапка", "Новая шапка"))
                publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                self.assertEqual(download.call_count, 2)

    def test_failures_keep_all_previous_pages_feed_sitemap_and_documents(self):
        invalid_responses = [
            lambda url: Response(url, b"short"),
            lambda url: Response(url, b"<html>" + b"x" * (len(PDF_BYTES) - 6)),
            lambda url: Response(url, content_type="text/html"),
            lambda url: Response("https://example.org/document.pdf"),
            lambda url: Response(url, status=403),
        ]
        for invalid in invalid_responses:
            with self.subTest(response=invalid), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                source = source_tree(base)
                case = record()
                with patch.object(publisher, "open_public_material", side_effect=lambda url: Response(url)):
                    _, previous = publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                before = {path.relative_to(previous): path.read_bytes() for path in previous.rglob("*") if path.is_file()}
                case["updated_at"] = "2026-11-04T10:30:00Z"
                with patch.object(publisher, "open_public_material", side_effect=invalid), self.assertRaises(ValueError):
                    publisher.write_release(source, base / "generated", [case], publisher.DEFAULT_API_BASE)
                self.assertEqual((base / "generated/current").resolve(), previous.resolve())
                self.assertEqual({path.relative_to(previous): path.read_bytes() for path in previous.rglob("*") if path.is_file()}, before)
                self.assertFalse(any(path.name.startswith(".") for path in (base / "generated/releases").iterdir()))

    def test_source_url_allowlist_rejects_other_origin_case_id_and_traversal_before_network(self):
        urls = [
            "https://example.org/secret", "//127.0.0.1/secret",
            "/api/v1/public/legal-case-announcements/other-case/materials/11/decision.pdf",
            "/api/v1/public/legal-case-announcements/example-case/materials/12/decision.pdf",
            "/api/v1/public/legal-case-announcements/example-case/materials/11/%2E%2E%2Fprivate",
            "/api/v1/public/legal-case-announcements/example-case/materials/11/%2E%2E",
            "/api/v1/public/legal-case-announcements/example-case/materials/11/decision.pdf#fragment",
            "https://user:password@law.elegso.ru/api/v1/public/legal-case-announcements/example-case/materials/11/decision.pdf",
        ]
        for url in urls:
            with self.subTest(url=url), tempfile.TemporaryDirectory() as temporary:
                case = record()
                case["published_materials"][1]["content_url"] = url
                with patch.object(publisher, "open_public_material") as download, self.assertRaises(ValueError):
                    publisher.mirror_case_materials(case, publisher.DEFAULT_API_BASE, Path(temporary))
                download.assert_not_called()

    def test_redirect_handler_blocks_escaping_redirect_before_followup_request(self):
        url = "https://law.elegso.ru/api/v1/public/legal-case-announcements/example-case/materials/11/decision.pdf"
        handler = publisher.PublicMaterialRedirectHandler(url)
        request = urllib.request.Request(url)
        with self.assertRaises(ValueError):
            handler.redirect_request(request, None, 302, "Found", {}, "http://127.0.0.1/private")
        with self.assertRaises(ValueError):
            handler.redirect_request(request, None, 302, "Found", {}, "/other-endpoint")
        allowed = handler.redirect_request(request, None, 302, "Found", {}, f"{url}?disposition=inline")
        self.assertEqual(allowed.full_url, f"{url}?disposition=inline")

    def test_invalid_descriptors_fail_closed_without_requests(self):
        changes = [
            {"file_size": 0}, {"file_size": -1}, {"file_size": True},
            {"file_size": publisher.MAX_PUBLIC_MATERIAL_BYTES + 1},
            {"id": "../../private"}, {"file_content_type": "text/html"},
            {"file_content_type": "image/svg+xml", "media_kind": "image"},
            {"media_kind": "image"}, {"content_url": None},
        ]
        for change in changes:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                case = record()
                case["published_materials"][1].update(change)
                with patch.object(publisher, "open_public_material") as download, self.assertRaises(ValueError):
                    publisher.mirror_case_materials(case, publisher.DEFAULT_API_BASE, Path(temporary))
                download.assert_not_called()


class RedesignStylesheetOrderTests(unittest.TestCase):
    def head(self, marker: str) -> str:
        chrome = publisher.SiteChrome(
            head='<head><title>ЭЛЕГСО</title>' + marker
            + '<link rel="stylesheet" href="/assets/redesign/editorial-theme.css?v=2" data-original="editorial">'
            + '<link rel="stylesheet" href="/assets/redesign/production.css?v=1" data-original="production">'
            + '<link rel="stylesheet" href="/assets/unrelated.css"></head>',
            body_open="<body>", header="", tail="",
        )
        return publisher.customise_head(chrome, title="Дело", description="История", canonical="https://elegso.ru/cases/", schema={}, article=False)

    def test_redesign_theme_follows_case_rules_with_editorial_last(self):
        head = self.head('<meta data-elegso-design="2026">')
        self.assertLess(head.index("/assets/cases.css"), head.index("/assets/redesign/production.css"))
        self.assertLess(head.index("/assets/redesign/production.css"), head.index("/assets/redesign/editorial-theme.css"))
        self.assertTrue(head.endswith('data-original="editorial">\n</head>'))
        self.assertIn('data-original="production"', head)
        self.assertIn("/assets/unrelated.css", head)

    def test_legacy_chrome_does_not_reorder_existing_assets(self):
        head = self.head("")
        self.assertLess(head.index("/assets/redesign/editorial-theme.css"), head.index("/assets/cases.css"))
        self.assertLess(head.index("/assets/redesign/production.css"), head.index("/assets/cases.css"))

    def test_site_shell_is_added_only_for_redesign_body(self):
        for body, expected in [('<body class="elegso-redesign">', 'class="t-records site-shell"'), ('<body class="legacy">', 'class="t-records"')]:
            with self.subTest(body=body):
                chrome = publisher.SiteChrome(head="<head><title>ЭЛЕГСО</title></head>", body_open=body, header="", tail="</body></html>")
                page = publisher.render_page(chrome, title="Дело", description="История", canonical="https://elegso.ru/cases/", schema={}, article=False, alias="cases", content="История")
                self.assertIn(f'<div id="allrecords" {expected}', page)


if __name__ == "__main__":
    unittest.main()
