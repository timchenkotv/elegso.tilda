"""Static publication contract: sources, generated HTML, feeds and content preservation."""
import json
import re
import subprocess
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime
from decimal import Decimal
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[1]
WWW = ROOT / "www"
CONFIG = json.loads((ROOT / "config/publications.json").read_text())
ARTICLES = [item for file in (ROOT / "content/publications").glob("*.json")
            for item in json.loads(file.read_text())]
ORIGIN = "https://elegso.ru"


def publication(item):
    article = {**item, **next(a for a in ARTICLES if a["slug"] == item["slug"])}
    article.setdefault("publishedAt", CONFIG["section"]["publishedAt"])
    article.setdefault("modifiedAt", article["publishedAt"])
    return article


def newest_publications():
    return sorted((publication(item) for item in CONFIG["publications"]),
                  key=lambda item: datetime.fromisoformat(item["publishedAt"]), reverse=True)


def article_schema(html):
    schemas = [json.loads(schema) for schema in re.findall(
        r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S)]
    return next(node for schema in schemas for node in schema.get("@graph", [])
                if node.get("@type") == "Article")


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ignored = 0
        self.parts = []
        self.ids = []
        self.images = []

    def handle_starttag(self, tag, attrs):
        self.ids.extend(value for name, value in attrs if name == "id")
        if tag == "img":
            self.images.append(dict(attrs))
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


def image_attributes(html):
    parser = VisibleText()
    parser.feed(html)
    return parser.images


class PublicationsTest(unittest.TestCase):
    def test_publication_preview_selection(self):
        newest = newest_publications()
        homepage = list(dict.fromkeys([newest[0]["slug"], "leasing-lawyer-when-to-contact",
                                      "messenger-correspondence-preservation",
                                      *(item["slug"] for item in newest)]))[:3]
        leasing = [item["slug"] for item in CONFIG["publications"]
                   if publication(item)["category"] == "Лизинг"][:3]
        self.assertEqual(len(leasing), 3)
        for route in CONFIG["migration"]["sourcePages"]:
            html = (WWW / route.strip("/") / "index.html").read_text()
            preview = re.search(r'<!--elegso-publications:start-->(.*?)<!--elegso-publications:end-->',
                                html, re.S).group(1)
            links = re.findall(r'<a href="([^"]+)" class="ep-card-image"', preview)
            expected = homepage if route == "/" else leasing
            self.assertEqual(links, ["/articles/" + slug + "/" for slug in expected], route)
            self.assertEqual(len(links), len(set(links)), route)

        catalogue = (WWW / "articles/index.html").read_text()
        cover_article = next(item for item in CONFIG["publications"]
                             if item["slug"] == "leasing-lawyer-when-to-contact")
        hero = re.search(r'<figure class="ep-hero-art">(.*?)</figure>', catalogue, re.S).group(1)
        self.assertEqual(image_attributes(hero)[0]["src"], cover_article["image"])
        self.assertIn('property="og:image" content="' + ORIGIN + cover_article["image"] + '"', catalogue)
        cards = re.findall(r'<a href="([^"]+)" class="ep-card-image"', catalogue)
        self.assertEqual(cards, [item["url"] for item in newest])

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

    def test_seven_complete_dzen_pdf_sources(self):
        manifest = json.loads((ROOT / "config/publication-sources.json").read_text())
        dzen = [a for a in CONFIG["publications"] if a["source"]["platform"] == "Дзен"]
        self.assertEqual(len(manifest), 7)
        self.assertEqual(sum(row["pages"] for row in manifest), 41)
        self.assertTrue(CONFIG["migration"]["originalFullTextRetrieved"])
        self.assertEqual({a["slug"] for a in dzen}, {a["slug"] for a in manifest})
        self.assertTrue({a["slug"] for a in manifest} <= {a["slug"] for a in ARTICLES})
        for row in manifest:
            self.assertRegex(row["sha256"], r"^[a-f0-9]{64}$")
            self.assertGreater(row["textCharacters"], 5000)
        self.assertEqual(len({a["source"]["url"] for a in dzen}), 7)

    def test_publication_registry(self):
        registered = CONFIG["publications"]
        self.assertEqual(len(ARTICLES), len(registered))
        self.assertEqual({a["slug"] for a in ARTICLES}, {a["slug"] for a in registered})
        for values in ([a["slug"] for a in registered],
                       [a["url"] for a in registered],
                       [a["source"]["url"] for a in registered],
                       [a["source"]["legacyUid"] for a in registered]):
            self.assertEqual(len(set(values)), len(registered))

    def test_article_html_and_images(self):
        for item in CONFIG["publications"]:
            article = publication(item)
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
                schema = article_schema(html)
                expected_author = article.get("author", {
                    "name": CONFIG["section"]["publisher"], "url": "/our_team/"})
                self.assertEqual(schema["datePublished"], article["publishedAt"])
                self.assertEqual(schema["dateModified"], article["modifiedAt"])
                self.assertEqual(schema["author"], {
                    "@type": "Person" if article.get("author") else "Organization",
                    "name": expected_author["name"],
                    "url": urljoin(ORIGIN, expected_author["url"]),
                })
                self.assertEqual(schema["publisher"], {"@id": ORIGIN + "/#organization"})
                self.assertIn('property="article:published_time" content="' + article["publishedAt"] + '"', html)
                self.assertIn('property="article:modified_time" content="' + article["modifiedAt"] + '"', html)
                byline = re.search(r'<div class="ep-byline">(.*?)</div>', html, re.S).group(1)
                self.assertIn(expected_author["name"], visible(byline))
                self.assertIn('href="' + expected_author["url"] + '"', byline)
                self.assertIn('datetime="' + article["modifiedAt"] + '"', byline)
                parser = VisibleText()
                parser.feed(html)
                ids = parser.ids
                self.assertEqual(len(ids), len(set(ids)), "Duplicate HTML identifiers")

    def test_feed_contract(self):
        full = ET.parse(WWW / "articles/rss.xml").getroot()
        short = ET.parse(WWW / "articles/announcements.xml").getroot()
        content_key = "{http://purl.org/rss/1.0/modules/content/}encoded"
        creator_key = "{http://purl.org/dc/elements/1.1/}creator"
        full_items, short_items = full.findall("channel/item"), short.findall("channel/item")
        self.assertEqual(len(full_items), len(CONFIG["publications"]))
        self.assertEqual(len(short_items), len(CONFIG["publications"]))
        registered = {ORIGIN + item["url"]: publication(item) for item in CONFIG["publications"]}
        expected_order = [ORIGIN + item["url"] for item in newest_publications()]
        for items in (full_items, short_items):
            guids = [item.findtext("guid") for item in items]
            self.assertEqual(guids, expected_order)
            self.assertEqual(len(guids), len(set(guids)))
        for a, b in zip(full_items, short_items):
            self.assertEqual(a.findtext("guid"), b.findtext("guid"))
            self.assertEqual(a.findtext("guid"), a.findtext("link"))
            article = registered[a.findtext("guid")]
            author_name = article.get("author", {}).get("name", CONFIG["section"]["publisher"])
            for feed_item in (a, b):
                self.assertEqual(feed_item.findtext(creator_key), author_name)
                self.assertEqual(parsedate_to_datetime(feed_item.findtext("pubDate")),
                                 datetime.fromisoformat(article["publishedAt"]))
            self.assertGreater(len(a.findtext(content_key)), len(b.findtext(content_key)) * 3)
            self.assertNotRegex(a.findtext(content_key), r'(href|src)="/(?!/)')
            for image in image_attributes(a.findtext(content_key)):
                for candidate in image.get("srcset", "").split(","):
                    if candidate.strip():
                        self.assertRegex(candidate.strip().split()[0], r"^https?://")
        self.assertEqual({a.findtext("guid") for a in full_items}, set(registered))
        latest = max(datetime.fromisoformat(CONFIG["section"]["modifiedAt"]),
                     *(datetime.fromisoformat(a["modifiedAt"]) for a in registered.values()))
        for feed in (full, short):
            self.assertEqual(parsedate_to_datetime(feed.findtext("channel/lastBuildDate")), latest)

    def test_original_author_source(self):
        self.assert_original_author_source("debt-recovery-reconciliation")

    def assert_original_author_source(self, slug):
        item = next((a for a in CONFIG["publications"] if a["slug"] == slug), None)
        self.assertIsNotNone(item, "Original article must be registered: " + slug)
        article = publication(item)
        self.assertEqual(article["status"], "original-author-source")
        self.assertEqual(article["source"]["platform"], "Авторский материал")
        self.assertTrue(article["source"]["originalPublishedAt"])
        self.assertTrue(article["source"]["legacyUid"])
        self.assertEqual(article["author"], {
            "name": "Тимченко Тимур Васильевич", "url": "/our_team/"})
        self.assertNotEqual(article["publishedAt"], CONFIG["section"]["publishedAt"])
        html = (WWW / article["url"].strip("/") / "index.html").read_text()
        self.assertEqual(article_schema(html)["author"]["@type"], "Person")

    def test_original_article_illustrations(self):
        self.assert_three_illustrations("debt-recovery-reconciliation")

    def test_articles_explain_without_copyable_document_templates(self):
        for article in ARTICLES:
            content = visible(" ".join(s["html"] for s in article["sections"]))
            with self.subTest(slug=article["slug"]):
                self.assertNotRegex(content, r"\[(?:номер|дата|дату|сумма|краткое описание|указать)[^\]]*\]")
                self.assertNotIn("Пример сопроводительного письма", content)
                self.assertNotIn("Образец предложения о досрочном закрытии", content)
        debt = next(a for a in ARTICLES if a["slug"] == "debt-recovery-reconciliation")
        example = next(s["html"] for s in debt["sections"] if s["id"] == "example")
        self.assertIn("Учебный пример", example)
        self.assertIn("450 000 руб.", example)

    def test_customer_refuses_to_sign_act(self):
        slug = "customer-refuses-to-sign-act"
        self.assert_original_author_source(slug)
        self.assert_three_illustrations(slug)
        html = (WWW / "articles" / slug / "index.html").read_text()
        article = publication(next(a for a in CONFIG["publications"] if a["slug"] == slug))
        content = " ".join(s["html"] for s in article["sections"])
        for rejected_phrase in ("чужая подпись", "автоматически появилась",
                                "ставить подпись за заказчика",
                                "подписывать документ за заказчика",
                                "волшебной бумагой", "формально красивый акт"):
            self.assertNotIn(rejected_phrase, content)
            self.assertNotIn(rejected_phrase, html)
        self.assertIn("услуги считаются принятыми и подлежат оплате", visible(content))
        self.assertIn("Если договор предусматривает", visible(content))
        letter = next(s["html"] for s in article["sections"] if s["id"] == "cover-letter")
        self.assertNotIn("Пример сопроводительного письма", letter)
        self.assertNotIn("структура письма для адаптации", letter)
        self.assertNotRegex(visible(letter), r"\[[^\]]+\]")
        self.assertNotIn("<aside", letter)
        for subject in ("приёмк", "оплат", "замечани", "приложени", "307"):
            self.assertIn(subject, letter)
        objections = visible(next(s["html"] for s in article["sections"]
                                  if s["id"] == "motivated-refusal"))
        self.assertNotIn("десять страниц", objections)
        self.assertNotIn("Короткое сообщение", objections)
        self.assertIn("установить конкретные недостатки", objections)
        self.assertIn("подтверждающие материалы", objections)
        self.assertIn("не нужно оправдываться перед общими", objections)
        self.assertIn("проверьте, требуется ли ответ по договору или закону", objections)
        self.assertNotIn("молчание не является универсально безопасной стратегией", objections)
        for fragment in ("1cd43e51fbd4129343b325971a466ec5cd32a425",
                         "33c65ab7522b599d12e61cc848aebcd09e651f9c",
                         "b4e192e502ea85e2cf31e682d6dbd8ad395a5012"):
            self.assertTrue(any(fragment in source["url"] for source in article["sources"]))
        canonical = ORIGIN + "/articles/" + slug + "/"
        self.assertIn('<link rel="canonical" href="' + canonical + '">', html)
        self.assertIn('name="robots" content="index, follow', html)
        self.assertNotIn('content="noindex', html)
        for name in ("rss.xml", "announcements.xml"):
            items = ET.parse(WWW / "articles" / name).findall("channel/item")
            self.assertEqual(sum(item.findtext("guid") == canonical for item in items), 1)

    def assert_three_illustrations(self, slug):
        article = publication(next(a for a in CONFIG["publications"] if a["slug"] == slug))
        embedded = image_attributes("".join(section["html"] for section in article["sections"]))
        self.assertEqual(len(embedded), 1, "One embedded image complements the cover and inline illustration")
        images = [article["image"], article["inlineImage"], embedded[0]["src"]]
        self.assertEqual(len(set(images)), 3)
        self.assertTrue(embedded[0].get("alt"))
        self.assertTrue(embedded[0].get("sizes"))
        candidates = [candidate.strip().split() for candidate in embedded[0]["srcset"].split(",")]
        self.assertEqual(candidates, [[images[2].replace(".webp", "-600.webp"), "600w"],
                                      [images[2], "1200w"]])
        html = (WWW / article["url"].strip("/") / "index.html").read_text()
        html_images = image_attributes(html)
        for source in images:
            self.assertTrue((WWW / source.lstrip("/")).is_file(), source)
            self.assertTrue((WWW / source.lstrip("/").replace(".webp", "-600.webp")).is_file())
            self.assertEqual(sum(image.get("src") == source for image in html_images), 1)

        full_items = ET.parse(WWW / "articles/rss.xml").findall("channel/item")
        feed_item = next(item for item in full_items if item.findtext("link") == ORIGIN + article["url"])
        feed_images = image_attributes(feed_item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded"))
        self.assertEqual({image["src"] for image in feed_images}, {ORIGIN + source for source in images})
        third = next(image for image in feed_images if image["src"] == ORIGIN + images[2])
        self.assertEqual(third["srcset"], ", ".join(ORIGIN + source + " " + size for source, size in candidates))

    def test_original_article_calculation_and_links(self):
        article = publication(next(a for a in CONFIG["publications"]
                                   if a["slug"] == "debt-recovery-reconciliation"))
        content = "".join(section["html"] for section in article["sections"])
        result = next(section["html"] for section in article["sections"] if section["id"] == "result")
        table = re.search(r"<table\b.*?</table>", result, re.S).group()
        amounts = [Decimal(re.sub(r"\s", "", value).replace(",", "."))
                   for value in re.findall(r"(?<!\d)(?:\d{1,3}(?:\s\d{3})+|\d+)[,.]\d{2}(?!\d)", visible(table))]
        self.assertEqual(amounts, [Decimal("1741415.65"), Decimal("950000.52"),
                                   Decimal("282282.51"), Decimal("950000.52"),
                                   Decimal("70772.69"), Decimal("282282.51"),
                                   Decimal("1020773.21"), Decimal("1970773.73")])
        self.assertEqual(amounts[3] + amounts[4], amounts[6])
        self.assertEqual(amounts[1] + amounts[6], amounts[7])
        self.assertEqual(amounts[6] - amounts[2], Decimal("738490.70"))
        self.assertIn("738 490,70 руб.", visible(result))
        self.assertIn("3,62 раза", visible(result))
        self.assertEqual(article["sections"][0]["id"], "full-history")
        full_history = visible(article["sections"][0]["html"])
        self.assertIn("все начисления и все оплаты", full_history)
        self.assertIn("Независимо от того", full_history)
        self.assertNotIn("при спорной или непрозрачной истории", full_history)
        self.assertIn('id="previous-judgment"',
                      (WWW / article["url"].strip("/") / "index.html").read_text())
        self.assertIn("Все документы были подписаны", article["lead"])
        self.assertIn("950 000,52 руб.", result)
        self.assertIn('href="/calc_nst/"', content)
        for number in (65, 9):
            sources = [source for source in article["sources"]
                       if "АПК" in source["title"] and re.search(r"\b" + str(number) + r"\b", source["title"])]
            self.assertTrue(sources, "Article " + str(number) + " of the Arbitration Procedure Code must be cited")
            self.assertTrue(any('href="' + source["url"] + '"' in content for source in sources))

    def test_sitemap_and_outgoing_dzen_removed(self):
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        urls = ET.parse(WWW / "sitemap.xml").findall("s:url/s:loc", ns)
        locations = [u.text for u in urls]
        self.assertEqual(len(locations), len(set(locations)))
        for item in CONFIG["publications"]:
            self.assertIn("https://elegso.ru" + item["url"], locations)
        for sitemap in ("sitemap.xml", "sitemap.base.xml"):
            if sitemap == "sitemap.base.xml" and not (WWW / sitemap).exists():
                continue
            rows = ET.parse(WWW / sitemap).findall("s:url", ns)
            dates = {row.findtext("s:loc", namespaces=ns): row.findtext("s:lastmod", namespaces=ns)
                     for row in rows}
            for item in CONFIG["publications"]:
                self.assertEqual(dates[ORIGIN + item["url"]], publication(item)["modifiedAt"][:10])
        routes = CONFIG["migration"]["sourcePages"] + ["/articles/"]
        for route in routes:
            html = (WWW / route.strip("/") / "index.html").read_text()
            self.assertNotRegex(html, r'href=["\']https?://(?:dzen\.ru|zen\.yandex\.ru)')
        feed = json.loads((WWW / "api/getfeed/index.html").read_text())
        self.assertEqual(len(feed["posts"]), len(CONFIG["publications"]))
        self.assertEqual([post["url"] for post in feed["posts"]],
                         [item["url"] for item in newest_publications()])
        self.assertTrue(all(p["directlink"].startswith("/articles/") for p in feed["posts"]))
        posts = {post["url"]: post for post in feed["posts"]}
        for item in CONFIG["publications"]:
            article = publication(item)
            self.assertEqual(posts[item["url"]]["uid"], item["source"]["legacyUid"])
            self.assertEqual(posts[item["url"]]["date"], article["publishedAt"])
            self.assertEqual(posts[item["url"]]["published"], article["publishedAt"])

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
