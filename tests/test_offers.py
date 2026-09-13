"""Offers: sealed legal versions, source-driven HTML, SEO and print contracts."""
import json
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/build-offers.mjs"
MARKER = "<!--elegso-offers-footer:start-->"
VERSION = "2026-09-13"
ORIGIN = "https://elegso.ru"


class Outline(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.links = []
        self.h1 = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.append(attrs["id"])
        if tag == "a":
            self.links.append(attrs.get("href", ""))
        if tag == "h1":
            self.h1 += 1


def sample(offer_id):
    return {
        "id": offer_id, "version": VERSION,
        "title": "Договор-оферта об оказании юридических услуг",
        "description": "Условия юридической помощи, оплаты, приёмки и обмена документами.",
        "audience": "Организации и ИП" if offer_id == "business" else "Физические лица",
        "revisionDate": VERSION, "effectiveDate": VERSION,
        "publishedAt": VERSION + "T12:30:00+03:00",
        "baseApprovalDate": None,
        "lead": "Условия оказания юридических услуг компании ЭЛЕГСО.",
        "sections": [
            {"id": "terms", "title": "1. Общие условия", "clauses": [
                {"number": "1.1", "html": "<p>Полный юридический текст должен оставаться доступным без JavaScript.</p>"},
                {"number": "1.2", "html": '<p><a href="/contacts/">Контакты</a> и <a href="mailto:mail@elegso.ru">электронная почта</a>.</p>'},
            ]},
            {"id": "requisites", "title": "2. Реквизиты исполнителя", "clauses": [
                {"number": "2.1", "html": "<p>ООО «ЮК ЭЛЕГСО». ИНН 7733472977.</p>"},
            ]},
        ],
    }


class OfferBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="elegso-offer-test-")
        self.root = Path(self.tmp.name)
        (self.root / "config").mkdir()
        (self.root / "www/assets").mkdir(parents=True)
        for asset in ("offers.css", "offers.js"):
            shutil.copyfile(ROOT / "www/assets" / asset, self.root / "www/assets" / asset)
        self.config = {
            "schemaVersion": 1, "origin": ORIGIN,
            "publisher": {"name": "ООО «ЮК ЭЛЕГСО»", "brand": "ЭЛЕГСО", "logo": "/logo.png"},
            "offers": [
                {"id": "business", "url": "/oferta/", "historyUrl": "/oferta/history/", "currentVersion": VERSION, "label": "Для организаций и ИП"},
                {"id": "individual", "url": "/oferta-fiz/", "historyUrl": "/oferta-fiz/history/", "currentVersion": VERSION, "label": "Для физических лиц"},
            ],
        }
        self.write_config()
        for offer_id in ("business", "individual"):
            self.write_document(sample(offer_id))
        template = '''<!DOCTYPE html><html lang="ru"><head><title>Наша миссия</title>
<meta name="description" content="Старая страница"><meta property="og:url" content="https://elegso.ru/mission/">
<meta name="robots" content="index, follow"><link rel="canonical" href="https://elegso.ru/mission/">
<script type="application/ld+json">{"@type":"OldMissionSchema"}</script></head>
<body><div id="allrecords"><!--header--><header id="t-header"><a href="/">Главная</a><a href="/articles/">Статьи</a></header>
<main><h1>Наша миссия</h1><p>Старый важный текст.</p></main><!--footer--><footer id="t-footer">
<!--elegso-articles-footer:start--><a href="/articles/">Статьи</a><!--elegso-articles-footer:end-->
<div id="rec1169591771"><p>Старый подвал</p><p>Любая информация на сайте не является публичной офертой.</p></div></footer></div></body></html>'''
        (self.root / "www/mission").mkdir()
        (self.root / "www/mission/index.html").write_text(template)
        (self.root / "www/index.html").write_text(template)
        (self.root / "www/api").mkdir()
        (self.root / "www/api/index.html").write_text('{"unchanged": true}')
        (self.root / "www/_external").mkdir()
        (self.root / "www/_external/remote.html").write_text("External file, leave alone")
        (self.root / "www/sitemap.xml").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://elegso.ru/mission/</loc><lastmod>2020-01-02</lastmod></url></urlset>''')

    def tearDown(self):
        self.tmp.cleanup()

    def write_config(self):
        (self.root / "config/offers.json").write_text(json.dumps(self.config, ensure_ascii=False))

    def write_document(self, document):
        directory = self.root / "content/offers" / document["id"]
        directory.mkdir(parents=True, exist_ok=True)
        (directory / (document["version"] + ".json")).write_text(json.dumps(document, ensure_ascii=False))

    def build(self, *args, success=True):
        result = subprocess.run(["node", str(SCRIPT), "--root", str(self.root), *args], capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def page(self, route):
        return (self.root / "www" / route.strip("/") / "index.html").read_text()

    def test_first_publication_needs_explicit_seal(self):
        result = self.build(success=False)
        self.assertIn("Unsealed version", result.stderr)
        self.assertFalse((self.root / "www/oferta").exists())
        self.build("--seal")
        registry = json.loads((self.root / "config/offer-version-hashes.json").read_text())
        self.assertEqual(len(registry["versions"]), 2)
        self.assertTrue(all(re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) for item in registry["versions"]))

    def test_preview_does_not_seal(self):
        self.build("--preview-unsealed")
        self.assertIn("Предварительный просмотр", self.page("/oferta/"))
        self.assertFalse((self.root / "config/offer-version-hashes.json").exists())

    def test_build_is_idempotent_and_registry_unchanged(self):
        self.build("--seal")
        snapshot = {str(file.relative_to(self.root)): file.read_bytes() for file in self.root.rglob("*") if file.is_file()}
        result = self.build()
        self.assertEqual(json.loads(result.stdout)["footerChanged"], 0)
        self.assertEqual(snapshot, {str(file.relative_to(self.root)): file.read_bytes() for file in self.root.rglob("*") if file.is_file()})

    def test_sealed_content_change_is_rejected_even_with_seal(self):
        self.build("--seal")
        old = self.page("/oferta/")
        document = sample("business")
        document["sections"][0]["clauses"][0]["html"] += " Исправление."
        self.write_document(document)
        for mode in ((), ("--seal",), ("--preview-unsealed",)):
            result = self.build(*mode, success=False)
            self.assertIn("IMMUTABLE VERSION CHANGED", result.stderr)
        self.assertEqual(old, self.page("/oferta/"))

    def test_sealed_versions_cannot_be_deleted(self):
        self.build("--seal")
        document = sample("business")
        document.update(version="2026-09-14", revisionDate="2026-09-14", effectiveDate="2026-09-14", publishedAt="2026-09-14T12:30:00+03:00")
        self.write_document(document)
        self.config["offers"][0]["currentVersion"] = "2026-09-14"
        self.write_config()
        (self.root / "content/offers/business/2026-09-13.json").unlink()
        result = self.build("--seal", success=False)
        self.assertIn("SEALED VERSION DELETED", result.stderr)

    def test_new_version_keeps_old_document_and_changes_current(self):
        self.build("--seal")
        old_html = self.page("/oferta/versions/2026-09-13/")
        old_hash = re.search(r'data-offer-sha256="([^"]+)"', old_html).group(1)
        document = sample("business")
        document.update(version="2026-09-14", revisionDate="2026-09-14", effectiveDate="2026-09-14", publishedAt="2026-09-14T12:30:00+03:00")
        document["sections"][0]["clauses"][0]["html"] += " Новая редакция."
        self.write_document(document)
        self.config["offers"][0]["currentVersion"] = document["version"]
        self.write_config()
        self.build("--seal")
        self.assertIn('data-offer-version="2026-09-14"', self.page("/oferta/"))
        self.assertIn('data-offer-sha256="' + old_hash + '"', self.page("/oferta/versions/2026-09-13/"))
        self.assertNotIn("Новая редакция.", self.page("/oferta/versions/2026-09-13/"))
        self.assertIn("2026-09-13", self.page("/oferta/history/"))
        self.assertIn("2026-09-14", self.page("/oferta/history/"))

    def test_canonicalization_ignores_json_key_order(self):
        self.build("--seal")
        document = sample("business")
        document = {key: document[key] for key in reversed(document)}
        self.write_document(document)
        self.build()

    def test_same_day_versions_sort_by_publication_time(self):
        self.build("--seal")
        for suffix, published_at in (("2", "2026-09-13T15:00:00+03:00"),
                                     ("10", "2026-09-13T14:00:00+03:00")):
            document = sample("business")
            document.update(version=VERSION + "-" + suffix, publishedAt=published_at)
            self.write_document(document)
        self.config["offers"][0]["currentVersion"] = VERSION + "-2"
        self.write_config()
        self.build("--seal")
        links = re.findall(r'<h2><a href="(/oferta/versions/[^\"]+/)"', self.page("/oferta/history/"))
        self.assertEqual(links, ["/oferta/versions/2026-09-13-2/",
                                 "/oferta/versions/2026-09-13-10/",
                                 "/oferta/versions/2026-09-13/"])

    def test_same_day_suffix_2_and_10_sort_numerically_when_time_equal(self):
        self.build("--seal")
        original_registry = json.loads((self.root / "config/offer-version-hashes.json").read_text())
        for suffix in ("2", "10"):
            document = sample("business")
            document.update(version=VERSION + "-" + suffix, publishedAt="2026-09-13T14:00:00+03:00")
            self.write_document(document)
        self.config["offers"][0]["currentVersion"] = VERSION + "-10"
        self.write_config()
        self.build("--seal")
        links = re.findall(r'<h2><a href="(/oferta/versions/[^\"]+/)"', self.page("/oferta/history/"))
        self.assertEqual(links, ["/oferta/versions/2026-09-13-10/",
                                 "/oferta/versions/2026-09-13-2/",
                                 "/oferta/versions/2026-09-13/"])
        self.assertIn('data-offer-version="2026-09-13-10"', self.page("/oferta/"))
        updated_registry = json.loads((self.root / "config/offer-version-hashes.json").read_text())
        for original_entry in original_registry["versions"]:
            self.assertIn(original_entry, updated_registry["versions"])
        self.assertIn('data-offer-version="2026-09-13"', self.page("/oferta/versions/2026-09-13/"))

    def test_generated_pages_have_full_text_without_javascript(self):
        self.build("--seal")
        for route in ("/oferta/", "/oferta-fiz/", "/oferta/versions/2026-09-13/", "/oferta-fiz/versions/2026-09-13/"):
            html = self.page(route)
            self.assertIn("Полный юридический текст должен оставаться доступным без JavaScript", html)
            self.assertIn("ИНН 7733472977", html)
            self.assertIn('id="t-header"', html)
            self.assertIn('id="t-footer"', html)
            parser = Outline()
            parser.feed(html)
            self.assertEqual(parser.h1, 1)
            self.assertEqual(len(parser.ids), len(set(parser.ids)))
            self.assertFalse(any(link.startswith(ORIGIN + "/") for link in parser.links))

    def test_current_history_indexable_and_archives_noindex_self_canonical(self):
        self.build("--seal")
        for route in ("/oferta/", "/oferta/history/", "/oferta-fiz/", "/oferta-fiz/history/"):
            html = self.page(route)
            self.assertIn('name="robots" content="index, follow', html)
            self.assertIn('rel="canonical" href="' + ORIGIN + route + '"', html)
        for route in ("/oferta/versions/2026-09-13/", "/oferta-fiz/versions/2026-09-13/"):
            html = self.page(route)
            self.assertIn('name="robots" content="noindex, follow"', html)
            self.assertIn('rel="canonical" href="' + ORIGIN + route + '"', html)

    def test_sitemap_only_current_and_history_preserves_others_dates(self):
        self.build("--seal")
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        rows = ET.parse(self.root / "www/sitemap.xml").findall("s:url", ns)
        dates = {row.findtext("s:loc", namespaces=ns): row.findtext("s:lastmod", namespaces=ns) for row in rows}
        self.assertEqual(len(rows), 5)
        self.assertEqual(dates[ORIGIN + "/mission/"], "2020-01-02")
        self.assertFalse(any("/versions/" in url for url in dates))
        for route in ("/oferta/", "/oferta/history/", "/oferta-fiz/", "/oferta-fiz/history/"):
            self.assertEqual(dates[ORIGIN + route], VERSION)

    def test_global_seo_preparation_preserves_archive_policy(self):
        self.build("--seal")
        result = subprocess.run(["node", str(ROOT / "scripts/prepare-seo.mjs")], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for route in ("/oferta/versions/2026-09-13/", "/oferta-fiz/versions/2026-09-13/"):
            self.assertIn('name="robots" content="noindex, follow"', self.page(route))
        sitemap = (self.root / "www/sitemap.xml").read_text()
        self.assertNotIn("/versions/", sitemap)
        self.assertIn(ORIGIN + "/oferta/", sitemap)

    def test_footer_added_once_preserves_old_navigation(self):
        self.build("--seal")
        self.build()
        for file in (self.root / "www").rglob("*.html"):
            if "api" in file.parts or "_external" in file.parts:
                continue
            html = file.read_text()
            self.assertEqual(html.count(MARKER), 1)
            self.assertIn("Оферта для бизнеса", html)
            self.assertIn("Оферта для физических лиц", html)
            self.assertIn("<!--elegso-articles-footer:start-->", html)
            self.assertNotIn("Любая информация на сайте не является публичной офертой.", html)
            self.assertIn("Информационные материалы сайта не являются публичной офертой. Условия заключения договоров приведены в соответствующих офертах.", html)
        self.assertIn("Старый важный текст.", self.page("/mission/"))
        self.assertEqual((self.root / "www/api/index.html").read_text(), '{"unchanged": true}')
        self.assertEqual((self.root / "www/_external/remote.html").read_text(), "External file, leave alone")

    def test_print_identity_revision_fulltext_and_browser_hint(self):
        self.build("--seal")
        html = self.page("/oferta/")
        self.assertIn('class="eo-print-identity"', html)
        self.assertIn('class="eo-print-heading"', html)
        self.assertIn('data-eo-print hidden', html)
        self.assertIn("<span>Печать</span>", html)
        self.assertIn("Распечатайте договор кнопкой „Печать“ или через меню браузера. В печатный вид входит полный текст выбранной редакции без меню и подвала сайта.", html)
        self.assertNotIn("Сохранить как PDF", html)
        self.assertNotRegex(html, r'href="[^"\n]*\.pdf(?:[?#][^"\n]*)?"')
        self.assertIn("не является электронной подписью", html)
        css = (ROOT / "www/assets/offers.css").read_text()
        self.assertIn("@page { size:A4;", css)
        self.assertIn("<html data-elegso-offers-document", html)
        self.assertIn("html[data-elegso-offers-document], body.elegso-offers-page { min-width:0!important;", css)
        self.assertIn(".eo-document section { border:0; padding:12pt 0 2pt; break-inside:auto; }", css)
        self.assertIn("overflow:visible!important", css)

    def test_dates_never_substitute_base_approval_for_publication(self):
        document = sample("business")
        document["baseApprovalDate"] = "2025-08-20"
        self.write_document(document)
        self.build("--seal")
        html = self.page("/oferta/")
        self.assertIn("20 августа 2025", html)
        self.assertIn('"datePublished":"2026-09-13T12:30:00+03:00"', html)
        self.assertIn("13 сентября 2026", html)

    def test_invalid_duplicate_clause_rejected_before_any_writes(self):
        document = sample("business")
        document["sections"][0]["clauses"][1]["number"] = "1.1"
        self.write_document(document)
        self.build("--seal", success=False)
        self.assertFalse((self.root / "config/offer-version-hashes.json").exists())

    def test_active_html_rejected(self):
        for html in ('<script>alert(1)</script>', '<img src="/x" onerror="alert(1)">', '<a href="javascript:alert(1)">x</a>', '<form><input></form>'):
            document = sample("business")
            document["sections"][0]["clauses"][0]["html"] = html
            self.write_document(document)
            self.build("--seal", success=False)

    def test_document_relative_and_absolute_internal_links_rejected(self):
        for link in ("contacts/", "../contacts/", ORIGIN + "/contacts/", "//example.com/"):
            document = sample("business")
            document["sections"][0]["clauses"][0]["html"] = '<p><a href="' + link + '">Link</a></p>'
            self.write_document(document)
            self.build("--seal", success=False)

    def test_invalid_dates_and_path_traversal_rejected(self):
        document = sample("business")
        document["effectiveDate"] = "2026-02-30"
        self.write_document(document)
        self.build("--seal", success=False)
        self.write_document(sample("business"))
        self.config["offers"][0]["id"] = "../outside"
        self.write_config()
        self.build("--seal", success=False)

    def test_scrollspy_and_mobile_toc_contract(self):
        script = (ROOT / "www/assets/offers.js").read_text()
        self.assertIn("details.open = desktop.matches", script)
        self.assertIn("window.addEventListener('scroll', requestUpdate, { passive: true })", script)
        self.assertIn("link.setAttribute('aria-current', 'location')", script)
        self.assertIn("window.print()", script)


class PublishedOfferContentTests(unittest.TestCase):
    @unittest.skipUnless((ROOT / "config/offers.json").exists(), "Authored content has not been supplied yet")
    def test_authored_content_complete_in_both_generated_representations(self):
        config = json.loads((ROOT / "config/offers.json").read_text())
        for offer in config["offers"]:
            content = json.loads((ROOT / "content/offers" / offer["id"] / (offer["currentVersion"] + ".json")).read_text())
            for route in (offer["url"], offer["url"] + "versions/" + offer["currentVersion"] + "/"):
                file = ROOT / "www" / route.strip("/") / "index.html"
                self.assertTrue(file.exists(), f"Run build-offers.mjs first: {route}")
                html = file.read_text()
                self.assertIn('id="t-header"', html)
                self.assertIn('id="t-footer"', html)
                for section in content["sections"]:
                    self.assertIn('id="' + section["id"] + '"', html)
                    for clause in section["clauses"]:
                        self.assertIn(clause["html"], html, f"Missing clause {clause['number']} in {route}")
                self.assertEqual(html.count(MARKER), 1)


if __name__ == "__main__":
    unittest.main()
