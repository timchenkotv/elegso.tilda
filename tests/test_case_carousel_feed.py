"""Public ERP carousel/card contract and atomic-release regression tests."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("case_carousel_publisher", ROOT / "ops/case-publisher/publish.py")
assert SPEC and SPEC.loader
publisher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publisher
SPEC.loader.exec_module(publisher)


def case(index: int = 1, *, document_date: str | None = "2026-11-03") -> dict:
    return {
        "code": f"CASE-{index}",
        "public_slug": f"example-{index}",
        "public_title": f"Дело {index}: восстановили расчёт сальдо",
        "public_excerpt": "Полный публичный анонс без сокращения. Второе предложение остаётся в данных.",
        "outcome_kind": "partial_win",
        "case_category": "Лизинговый спор",
        "document_date": document_date,
        "court_case_number": f"А40-{index}/2026",
        "protected_interest_amount": "6784502.36",
        "duration_days": 274,
        "court_instance_count": 2,
        "currency_code": "RUB",
        "strategy_html": "<p>Полная правовая стратегия.</p>",
        "result_html": "<p>Полный результат спора.</p>",
        "significance_html": "<p>Практическое значение дела.</p>",
        "stages": [],
        "economic_effects": [],
        "project_cost_items": [],
        "published_materials": [],
        "updated_at": "2026-11-03T10:00:00Z",
    }


def illustrate(record: dict, data: bytes = b"RIFF0000WEBPexact-ERP-original") -> bytes:
    record["illustration"] = {
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
        "content_type": "image/webp",
        "illustration_alt": "Объёмная иллюстрация предмета спора",
        "content_url": f"/api/v1/public/legal-case-announcements/{record['public_slug']}/illustration?v=sha",
    }
    return data


def source_tree(base: Path) -> Path:
    source = base / "source"
    (source / "mission").mkdir(parents=True)
    (source / "assets/redesign").mkdir(parents=True)
    (source / "mission/index.html").write_text(
        '<!doctype html><html lang="ru"><head><title>ЭЛЕГСО</title>'
        '<link rel="canonical" href="https://elegso.ru/mission/"></head>'
        '<body class="elegso-redesign"><div id="allrecords">'
        '<!--header--><header><a href="/contacts/">Контакты</a></header>'
        '<main>Страница-источник оформления.</main>'
        '<!--footer--><footer>Общий подвал</footer></div></body></html>',
        encoding="utf-8",
    )
    (source / "sitemap.xml").write_text(
        '<urlset><url><loc>https://elegso.ru/</loc></url></urlset>', encoding="utf-8"
    )
    (source / "assets/cases.css").write_text(".case-card{color:green}", encoding="utf-8")
    (source / "assets/cases.js").write_text("/* case runtime */", encoding="utf-8")
    (source / "assets/redesign/site.css").write_text("body{background:#08271f}", encoding="utf-8")
    return source


class Response:
    def __init__(self, url: str, data: bytes):
        self.url = url
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, size: int = -1) -> bytes:
        return self.data if size < 0 else self.data[:size]


class CarouselFeedTests(unittest.TestCase):
    def test_feed_has_only_explicit_public_fields_and_preserves_full_excerpt(self):
        record = case()
        illustrate(record)
        record["private_notes"] = "NEVER-EXPOSE-ME"
        record["api_token"] = "PRIVATE-API-TOKEN"
        record["illustration"]["private_storage_path"] = "/private/storage/secret"
        feed = publisher.render_carousel_feed([record])
        self.assertEqual(set(feed), {"version", "items"})
        self.assertEqual(feed["version"], 1)
        row = feed["items"][0]
        self.assertEqual(set(row), {
            "code", "slug", "url", "title", "excerpt", "outcome_kind", "outcome_label",
            "document_date", "formatted_date", "case_number", "category",
            "protected_interest_amount", "protected_interest_label", "duration_days",
            "duration_label", "court_instance_count", "illustration",
        })
        self.assertEqual(row["excerpt"], record["public_excerpt"])
        self.assertEqual(row["url"], "/cases/example-1/")
        self.assertEqual(row["outcome_kind"], "partial_win")
        self.assertEqual(row["outcome_label"], "Успех")
        self.assertEqual(row["protected_interest_amount"], "6784502.36")
        self.assertEqual(row["protected_interest_label"], "6,78 млн ₽")
        self.assertEqual(set(row["illustration"]), {"url", "alt"})
        self.assertEqual(row["illustration"]["url"], f"/cases/example-1/{publisher.illustration_filename(record)}")
        serialised = json.dumps(feed, ensure_ascii=False)
        for private in ["NEVER-EXPOSE-ME", "PRIVATE-API-TOKEN", "/private/storage", "content_url", "project_cost_items"]:
            self.assertNotIn(private, serialised)

    def test_feed_is_sorted_by_last_judicial_act_not_publication_date(self):
        older = case(1, document_date="2024-12-03")
        older["published_at"] = "2026-11-03T10:00:00Z"
        newer = case(2, document_date="2026-10-21")
        newer["published_at"] = "2024-01-01T10:00:00Z"
        missing = case(3, document_date=None)
        feed = publisher.render_carousel_feed([missing, older, newer])
        self.assertEqual([row["code"] for row in feed["items"]], ["CASE-2", "CASE-1", "CASE-3"])
        self.assertIsNone(feed["items"][-1]["document_date"])

    def test_missing_image_and_case_number_are_explicit_without_invented_values(self):
        record = case()
        record["court_case_number"] = None
        record["duration_days"] = None
        record["court_instance_count"] = 0
        row = publisher.render_carousel_feed([record])["items"][0]
        self.assertIsNone(row["illustration"])
        self.assertEqual(row["case_number"], "")
        self.assertIsNone(row["duration_days"])
        self.assertEqual(row["duration_label"], "")
        self.assertEqual(row["court_instance_count"], 0)
        self.assertEqual(publisher.carousel_count(True), None)
        self.assertEqual(publisher.carousel_count(-1), None)
        self.assertEqual(publisher.carousel_count("4.5"), None)

    def test_card_image_is_first_direct_child_and_badge_is_prominent(self):
        record = case()
        illustrate(record)
        markup = publisher.render_case_card(record, 0)
        self.assertRegex(markup, r'<a class="case-card__surface"[^>]*>\s*<img class="case-card__image"')
        self.assertIn(f'src="/cases/example-1/{publisher.illustration_filename(record)}"', markup)
        self.assertIn('class="case-card__badge" aria-hidden="true">Дело № А40-1/2026', markup)
        self.assertIn('loading="lazy"', markup)
        self.assertIn(record["public_excerpt"], markup)
        self.assertIn('class="case-card__number">Дело № А40-1/2026', markup)
        self.assertNotIn("/api/v1/", markup)

    def test_card_missing_image_uses_generic_fallback_not_another_case(self):
        markup = publisher.render_case_card(case(), 0)
        self.assertIn('src="/assets/redesign/leasing-balance.webp"', markup)
        self.assertIn('alt="Иллюстрация юридической практики"', markup)
        self.assertNotIn("illustration-", markup)

    def test_feed_and_card_escape_rich_alt_without_executing_markup(self):
        record = case()
        illustrate(record)
        record["illustration"]["illustration_alt"] = '<strong>Иллюстрация</strong> <img src=x onerror="alert(1)">'
        self.assertEqual(publisher.render_carousel_feed([record])["items"][0]["illustration"]["alt"], "Иллюстрация")
        card = publisher.render_case_card(record, 0)
        self.assertNotIn('onerror=', card)
        self.assertIn('alt="Иллюстрация"', card)

    def test_atomic_release_contains_feed_and_exact_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            output = base / "generated"
            record = case()
            data = illustrate(record)
            with patch.object(publisher.urllib.request, "urlopen", side_effect=lambda req, timeout: Response(req.full_url, data)):
                changed, release = publisher.write_release(source, output, [record], publisher.DEFAULT_API_BASE)
            self.assertTrue(changed)
            self.assertEqual((output / "current").resolve(), release.resolve())
            feed = json.loads((release / "cases/carousel.json").read_text(encoding="utf-8"))
            self.assertEqual(feed["items"][0]["code"], "CASE-1")
            self.assertEqual((release / "cases/example-1" / publisher.illustration_filename(record)).read_bytes(), data)
            self.assertTrue((release / "sitemap.xml").is_file())
            detail = (release / "cases/example-1/index.html").read_text(encoding="utf-8")
            self.assertIn('class="elegso-redesign elegso-cases-page"', detail)
            self.assertIn("Полная правовая стратегия.", detail)
            self.assertIn("Полный результат спора.", detail)

    def test_new_case_appears_and_removed_image_does_not_leak_from_previous_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            output = base / "generated"
            first = case()
            data = illustrate(first)
            with patch.object(publisher.urllib.request, "urlopen", side_effect=lambda req, timeout: Response(req.full_url, data)):
                _, original = publisher.write_release(source, output, [first], publisher.DEFAULT_API_BASE)
            second = case(2, document_date="2026-11-04")
            first_without_image = copy.deepcopy(first)
            first_without_image["illustration"] = None
            with patch.object(publisher.urllib.request, "urlopen") as network:
                changed, current = publisher.write_release(source, output, [first_without_image, second], publisher.DEFAULT_API_BASE)
                network.assert_not_called()
            self.assertTrue(changed)
            self.assertNotEqual(original, current)
            feed = json.loads((current / "cases/carousel.json").read_text(encoding="utf-8"))
            self.assertEqual([row["code"] for row in feed["items"]], ["CASE-2", "CASE-1"])
            self.assertIsNone(feed["items"][1]["illustration"])
            self.assertEqual(list((current / "cases/example-1").glob("illustration-*")), [])
            self.assertIn(publisher.CASE_ILLUSTRATION_FALLBACK, (current / "cases/index.html").read_text(encoding="utf-8"))

    def test_removed_case_disappears_from_feed_and_sitemap(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            output = base / "generated"
            publisher.write_release(source, output, [case(1), case(2)], publisher.DEFAULT_API_BASE)
            _, current = publisher.write_release(source, output, [case(2)], publisher.DEFAULT_API_BASE)
            feed = json.loads((current / "cases/carousel.json").read_text(encoding="utf-8"))
            self.assertEqual([row["code"] for row in feed["items"]], ["CASE-2"])
            self.assertNotIn("/cases/example-1/", (current / "sitemap.xml").read_text(encoding="utf-8"))
            self.assertFalse((current / "cases/example-1").exists())

    def test_corrupt_new_image_retains_previous_feed_and_current_pointer(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            output = base / "generated"
            _, previous = publisher.write_release(source, output, [case(1)], publisher.DEFAULT_API_BASE)
            before = (previous / "cases/carousel.json").read_bytes()
            image_case = case(2)
            illustrate(image_case)
            with patch.object(publisher.urllib.request, "urlopen", side_effect=lambda req, timeout: Response(req.full_url, b"corrupted")):
                with self.assertRaisesRegex(ValueError, "SHA-256"):
                    publisher.write_release(source, output, [case(1), image_case], publisher.DEFAULT_API_BASE)
            self.assertEqual((output / "current").resolve(), previous.resolve())
            self.assertEqual((output / "current/cases/carousel.json").read_bytes(), before)
            self.assertEqual(list((output / "releases").iterdir()), [previous])

    def test_design_asset_change_invalidates_generated_release_without_erp_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = source_tree(base)
            output = base / "generated"
            records = [case()]
            _, previous = publisher.write_release(source, output, records, publisher.DEFAULT_API_BASE)
            before = publisher.content_digest(source, records)
            (source / "assets/redesign/site.css").write_text("body{background:#092b23}", encoding="utf-8")
            self.assertNotEqual(before, publisher.content_digest(source, records))
            changed, current = publisher.write_release(source, output, records, publisher.DEFAULT_API_BASE)
            self.assertTrue(changed)
            self.assertNotEqual(previous, current)
            self.assertTrue((current / "cases/carousel.json").is_file())
            for relative in ["assets/cases.css", "assets/cases.js"]:
                before = publisher.content_digest(source, records)
                asset = source / relative
                asset.write_text(asset.read_text(encoding="utf-8") + "\n/* update */", encoding="utf-8")
                self.assertNotEqual(before, publisher.content_digest(source, records))


if __name__ == "__main__":
    unittest.main()
