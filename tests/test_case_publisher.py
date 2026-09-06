from __future__ import annotations

import importlib.util
import stat
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "ops" / "case-publisher" / "publish.py"
SPEC = importlib.util.spec_from_file_location("elegso_case_publisher", MODULE_PATH)
assert SPEC and SPEC.loader
publisher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publisher
SPEC.loader.exec_module(publisher)


def sample_case() -> dict:
    return {
        "code": "ANN-TEST",
        "public_title": "Снизили договорную неустойку в кассации",
        "public_excerpt": "Кассационный суд направил спор на новое рассмотрение после анализа соразмерности санкций.",
        "public_slug": "snizhenie-neustoyki-v-kassatsii",
        "outcome_kind": "won",
        "case_category": "Выкупной лизинг",
        "document_date": "2026-09-05",
        "court_case_number": "А40-117474/2023",
        "dispute_started_on": "2023-06-01",
        "dispute_ended_on": "2025-04-21",
        "duration_days": 691,
        "hearing_count": 9,
        "opponent_meeting_count": 2,
        "court_instance_count": 3,
        "protected_interest_amount": "18450000.00",
        "project_cost_amount": "1727500.00",
        "currency_code": "RUB",
        "strategy_html": "<p>Сопоставили неустойку с убытками, ставкой кредита и процентами по статье 395 ГК РФ.</p>",
        "result_html": "<p><strong>Кассация согласилась</strong> с необходимостью проверить расчёты.</p>",
        "significance_html": "<p>Условия договора не исключают судебную проверку соразмерности санкций.</p>",
        "seo_title": "Снижение неустойки по договору лизинга: судебный кейс",
        "seo_description": "Как кассационный суд проверил соразмерность договорной неустойки по статье 333 ГК РФ.",
        "published_at": "2026-09-06T08:00:00Z",
        "updated_at": "2026-09-06T08:00:00Z",
        "stages": [
            {
                "row_order": 1,
                "stage_type": "first_instance",
                "title": "Первая инстанция",
                "started_on": "2023-06-01",
                "ended_on": "2024-05-03",
                "narrative_html": "<p>Суд отказался снижать договорную неустойку.</p>",
                "result_html": "<p>Требования удовлетворены без полной проверки расчётов.</p>",
            },
            {
                "row_order": 2,
                "stage_type": "cassation",
                "title": "Поворот в кассации",
                "started_on": "2024-08-19",
                "ended_on": "2024-12-03",
                "narrative_html": "<p>Представили экономические модели возможных потерь.</p>",
                "result_html": "<p>Судебные акты отменены.</p>",
            },
        ],
        "economic_effects": [
            {
                "row_order": 1,
                "stage_type": "cassation",
                "effect_type": "penalty_reduced",
                "calculation_mode": "difference",
                "title": "Предотвращённое взыскание",
                "initial_amount": "22000000",
                "final_amount": "3550000",
                "protected_amount": "18450000",
                "include_in_total": True,
                "asset_description": None,
                "note": "Разница между заявленной и соразмерной суммой.",
            }
        ],
        "project_cost_items": [
            {
                "row_order": 1,
                "stage_type": "first_instance",
                "stage_row_order": 1,
                "cost_type": "legal_work",
                "calculation_mode": "fixed",
                "title": "Иск и первая инстанция",
                "amount": "292500.00",
                "base_amount": "0",
                "rate_percent": "0",
                "include_in_total": True,
                "note": None,
            },
            {
                "row_order": 2,
                "stage_type": "cassation",
                "stage_row_order": 2,
                "cost_type": "legal_work",
                "calculation_mode": "fixed",
                "title": "Кассационная инстанция",
                "amount": "150000.00",
                "base_amount": "0",
                "rate_percent": "0",
                "include_in_total": True,
                "note": None,
            },
            {
                "row_order": 3,
                "stage_type": "other",
                "stage_row_order": None,
                "cost_type": "success_fee",
                "calculation_mode": "percentage",
                "title": "Премия за достигнутый результат",
                "amount": "1285000.00",
                "base_amount": "4750000.00",
                "rate_percent": "30",
                "include_in_total": True,
                "note": "Итоговая сумма согласована сторонами.",
            },
        ],
        "published_materials": [
            {
                "id": 10,
                "parent_id": None,
                "published_root_id": 10,
                "is_published_root": True,
                "kind": "folder",
                "media_kind": "folder",
                "name": "Судебные акты",
                "row_order": 1,
                "carousel_order": None,
                "path": None,
                "content_url": None,
            },
            {
                "id": 11,
                "parent_id": 10,
                "published_root_id": 10,
                "is_published_root": False,
                "kind": "file",
                "media_kind": "pdf",
                "name": "Постановление кассации.pdf",
                "row_order": 1,
                "carousel_order": 1,
                "path": "Судебные акты",
                "file_date": "2024-12-03",
                "file_content_type": "application/pdf",
                "file_size": 450000,
                "content_url": "/api/v1/public/legal-case-announcements/snizhenie-neustoyki-v-kassatsii/materials/11/document.pdf",
            },
            {
                "id": 12,
                "parent_id": 10,
                "published_root_id": 10,
                "is_published_root": False,
                "kind": "file",
                "media_kind": "image",
                "name": "Фотография предмета спора.jpg",
                "row_order": 2,
                "carousel_order": 2,
                "path": "Судебные акты",
                "file_date": "2024-12-04",
                "file_content_type": "image/jpeg",
                "file_size": 250000,
                "content_url": "/api/v1/public/legal-case-announcements/snizhenie-neustoyki-v-kassatsii/materials/12/photo.jpg",
            },
        ],
    }


class CasePublisherTests(unittest.TestCase):
    def test_atomic_static_release_contains_search_seo_and_materials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "generated"
            changed, release = publisher.write_release(
                ROOT / "www",
                output,
                [sample_case()],
                "https://law.elegso.ru/api/v1/public/legal-case-announcements",
            )
            self.assertTrue(changed)
            self.assertTrue((output / "current").is_symlink())
            self.assertEqual((output / "current").resolve(), release.resolve())
            self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o755)

            listing = (output / "current" / "cases" / "index.html").read_text(encoding="utf-8")
            detail = (
                output
                / "current"
                / "cases"
                / "snizhenie-neustoyki-v-kassatsii"
                / "index.html"
            ).read_text(encoding="utf-8")
            sitemap = (output / "current" / "sitemap.xml").read_text(encoding="utf-8")

            self.assertIn('data-cases-search', listing)
            self.assertIn('href="/cases/"', listing)
            header = listing[listing.index("<!--header-->") : listing.index("</header>")]
            self.assertIn("elegso-cases-nav-item", header)
            self.assertIn("Юридические проекты и решённые дела", header)
            self.assertLess(header.index('href="/cases/"'), header.index('href="/contacts/"'))
            self.assertEqual(header.count('href="/cases/"'), 1)
            self.assertIn("Снизили договорную неустойку", listing)
            self.assertNotIn("cases-hero__mark", listing)
            self.assertIn("Защищённый имущественный интерес", detail)
            self.assertIn("Смотреть судебные акты", detail)
            self.assertIn("Судебные акты · 2", detail)
            self.assertNotIn('<aside><span aria-hidden="true">Э</span>', detail)
            self.assertIn("Поворот в кассации", detail)
            self.assertIn("Судебные акты", detail)
            self.assertIn("Встреч с оппонентом", detail)
            self.assertIn("Стоимость юридического проекта", detail)
            self.assertIn("Итого стоимость проекта", detail)
            self.assertIn("1 727 500 руб.", detail)
            self.assertIn("Стоимость этапа", detail)
            self.assertIn("Премия за результат", detail)
            self.assertIn('data-case-carousel', detail)
            self.assertIn('data-case-next', detail)
            self.assertIn('case-material-viewer--pdf', detail)
            self.assertIn('case-material-viewer--image', detail)
            self.assertIn("Фотография предмета спора.jpg", detail)
            self.assertNotIn("Документы показаны в той же структуре папок", detail)
            self.assertLess(
                detail.index("Фотография предмета спора.jpg"),
                detail.index("Постановление кассации.pdf"),
            )
            self.assertRegex(detail, r'data-material-id="12"\s+>')
            self.assertRegex(detail, r'data-material-id="11"\s+hidden>')
            self.assertIn("https://law.elegso.ru/api/v1/", detail)
            self.assertIn('data-elegso-cases-schema', detail)
            self.assertIn("/cases/snizhenie-neustoyki-v-kassatsii/", sitemap)

            changed_again, same_release = publisher.write_release(
                ROOT / "www",
                output,
                [sample_case()],
                "https://law.elegso.ru/api/v1/public/legal-case-announcements",
            )
            self.assertFalse(changed_again)
            self.assertEqual(release, same_release)

    def test_shared_site_navigation_exposes_cases_in_hero_and_footer(self) -> None:
        script = (ROOT / "www" / "assets" / "migration.js").read_text(encoding="utf-8")
        self.assertIn("migrationInitCasesHeroButton", script)
        self.assertIn("migrationInitCasesFooterCard", script)
        self.assertIn("Решённые юридические дела", script)
        self.assertIn("Решённые юридические задачи и подтверждённые результаты", script)

    def test_rejects_unsafe_or_duplicate_slugs(self) -> None:
        invalid = sample_case()
        invalid["public_slug"] = "../outside"
        with self.assertRaises(RuntimeError):
            publisher.validate_cases([invalid])

        first = sample_case()
        second = sample_case()
        with self.assertRaises(RuntimeError):
            publisher.validate_cases([first, second])


if __name__ == "__main__":
    unittest.main()
