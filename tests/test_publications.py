"""Static publication contract: sources, generated HTML, feeds and content preservation."""
import json
import re
import subprocess
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WWW = ROOT / "www"
CONFIG = json.loads((ROOT / "config/publications.json").read_text())
ARTICLES = [item for file in (ROOT / "content/publications").glob("*.json")
            for item in json.loads(file.read_text())]


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ignored = 0
        self.parts = []
        self.ids = []

    def handle_starttag(self, tag, attrs):
        self.ids.extend(value for name, value in attrs if name == "id")
        if tag in {"script", "style", "head", "template"}:
            self.ignored += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "head", "template"}:
            self.ignored = max(0, self.ignored - 1)

    def handle_data(self, data):
        if not self.ignored:
            self.parts.append(data)


def visible(html):
    parser = VisibleText()
    parser.feed(html)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


class PublicationsTest(unittest.TestCase):
    def test_articles_navigation_location(self):
        for file in WWW.rglob("*.html"):
            if "_external" in file.parts or "api" in file.parts:
                continue
            html = file.read_text()
            if 'id="nav1210506996"' in html:
                about = re.search(r'<div id="nav1210506996".*?</ul>', html, re.S).group()
                self.assertEqual(about.count("data-elegso-articles-nav"), 1, str(file))
                self.assertEqual(html.count("data-elegso-articles-nav"), 1, str(file))
                self.assertIn('href="/articles/"', about)
            if 'id="rec1169591771"' in html:
                self.assertEqual(html.count("data-elegso-articles-footer"), 1, str(file))
                self.assertIn('class="elegso-articles-footer-card__title">Статьи</strong>', html)
                self.assertIn('class="elegso-articles-footer-card__image"', html)

    def test_seven_complete_sources(self):
        manifest = json.loads((ROOT / "config/publication-sources.json").read_text())
        self.assertEqual(len(manifest), 7)
        self.assertEqual(sum(row["pages"] for row in manifest), 41)
        self.assertTrue(CONFIG["migration"]["originalFullTextRetrieved"])
        self.assertEqual({a["slug"] for a in ARTICLES}, {a["slug"] for a in manifest})
        for row in manifest:
            self.assertRegex(row["sha256"], r"^[a-f0-9]{64}$")
            self.assertGreater(row["textCharacters"], 5000)
        self.assertEqual(len({a["source"]["url"] for a in CONFIG["publications"]}), 7)

    def test_article_html_and_images(self):
        for item in CONFIG["publications"]:
            article = next(a for a in ARTICLES if a["slug"] == item["slug"])
            html = (WWW / item["url"].strip("/") / "index.html").read_text()
            with self.subTest(slug=item["slug"]):
                self.assertEqual(len(re.findall(r"<h1\b", html)), 1)
                self.assertEqual(len(re.findall(r'type="application/rss\+xml"', html)), 1)
                self.assertIn('href="https://elegso.ru' + item["url"] + '"', html)
                self.assertNotIn('content="noindex', html)
                self.assertIn('id="t-header"', html)
                self.assertIn('id="t-footer"', html)
                for section in article["sections"]:
                    self.assertIn('id="' + section["id"] + '"', html)
                    self.assertIn(section["html"], html)
                self.assertTrue((WWW / item["image"].lstrip("/")).is_file())
                self.assertTrue((WWW / item["image"].lstrip("/").replace(".webp", "-600.webp")).is_file())
                for schema in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
                    json.loads(schema)
                parser = VisibleText()
                parser.feed(html)
                ids = parser.ids
                self.assertEqual(len(ids), len(set(ids)), "Duplicate HTML identifiers")

    def test_feed_contract(self):
        full = ET.parse(WWW / "articles/rss.xml").getroot()
        short = ET.parse(WWW / "articles/announcements.xml").getroot()
        content_key = "{http://purl.org/rss/1.0/modules/content/}encoded"
        full_items, short_items = full.findall("channel/item"), short.findall("channel/item")
        self.assertEqual(len(full_items), 7)
        self.assertEqual(len(short_items), 7)
        for a, b in zip(full_items, short_items):
            self.assertEqual(a.findtext("guid"), b.findtext("guid"))
            self.assertEqual(a.findtext("guid"), a.findtext("link"))
            self.assertGreater(len(a.findtext(content_key)), len(b.findtext(content_key)) * 3)
            self.assertNotRegex(a.findtext(content_key), r'(href|src)="/(?!/)')
        self.assertEqual(len({a.findtext("guid") for a in full_items}), 7)

    def test_sitemap_and_outgoing_dzen_removed(self):
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        urls = ET.parse(WWW / "sitemap.xml").findall("s:url/s:loc", ns)
        locations = [u.text for u in urls]
        self.assertEqual(len(locations), len(set(locations)))
        for item in CONFIG["publications"]:
            self.assertIn("https://elegso.ru" + item["url"], locations)
        routes = CONFIG["migration"]["sourcePages"] + ["/articles/"]
        for route in routes:
            html = (WWW / route.strip("/") / "index.html").read_text()
            self.assertNotRegex(html, r'href=["\']https?://(?:dzen\.ru|zen\.yandex\.ru)')
        feed = json.loads((WWW / "api/getfeed/index.html").read_text())
        self.assertTrue(all(p["directlink"].startswith("/articles/") for p in feed["posts"]))

    def test_existing_page_text_preserved(self):
        # Compare against pre-publications revision. Only the replaced news feed
        # and added navigation label may differ in existing visible body copy.
        baseline = "15677545e1c0663ef8a2e5e8de9772fa104ef7e3"
        files = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", baseline, "www"], cwd=ROOT, text=True).splitlines()
        for name in files:
            if not name.endswith(".html") or name.startswith(("www/api/", "www/_external/")):
                continue
            old = subprocess.check_output(["git", "show", f"{baseline}:{name}"], cwd=ROOT).decode()
            new = (ROOT / name).read_text()
            match = re.search(r'<div id="rec(?:1282040271|1345693691|1345701461)"', old)
            if match:
                end = old.index('<div id="rec', match.start() + 1)
                old = old[:match.start()] + old[end:]
            new = re.sub(r"<!--elegso-publications:start-->.*?<!--elegso-publications:end-->", "", new, flags=re.S)
            new = re.sub(r'<li\b[^>]*>(?:(?!</li>).)*data-elegso-articles-nav(?:(?!</li>).)*</li>', "", new, flags=re.S)
            new = re.sub(r'<!--elegso-articles-footer:start-->.*?<!--elegso-articles-footer:end-->', "", new, flags=re.S)
            with self.subTest(file=name):
                self.assertEqual(visible(old), visible(new))


if __name__ == "__main__":
    unittest.main()
