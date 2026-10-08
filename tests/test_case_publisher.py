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
    def test_catalogue_is_sorted_by_latest_judicial_act_descending(self):
        older_published_later = sample_case()
        older_published_later["public_slug"] = "older-published-later"
        older_published_later["document_date"] = "2024-12-03"
        older_published_later["published_at"] = "2026-10-05T12:00:00Z"

        newer_published_earlier = sample_case()
        newer_published_earlier["public_slug"] = "newer-published-earlier"
        newer_published_earlier["document_date"] = "2025-10-16"
        newer_published_earlier["published_at"] = "2026-09-01T12:00:00Z"

        without_date = sample_case()
        without_date["public_slug"] = "without-date"
        without_date["document_date"] = None

        ordered = publisher.validate_cases(
            [older_published_later, without_date, newer_published_earlier]
        )

        self.assertEqual(
            [case["public_slug"] for case in ordered],
            ["newer-published-earlier", "older-published-later", "without-date"],
        )

    def test_partial_win_display_label_is_success_without_changing_status(self):
        case = sample_case()
        case['outcome_kind'] = 'partial_win'
        card = publisher.render_case_card(case, 0)
        self.assertIn('Успех', card)
        self.assertNotIn('Частичный успех', card)
        self.assertIn('case-outcome--partial_win', card)
        self.assertEqual(publisher.OUTCOME_LABELS['won'], 'Победа')
        self.assertEqual(publisher.OUTCOME_LABELS['settlement'], 'Мировое соглашение')

    def test_navigation_shows_protected_amount_and_exact_tooltip(self):
        case = sample_case()
        tile = publisher.render_case_jump(case, 0)
        self.assertIn('class="cases-jump__number">№ А40-117474/2023', tile)
        self.assertIn('Защищено</span><strong>18,4 млн руб.</strong>', tile)
        self.assertIn('Защищённый имущественный интерес в размере 18 450 000 руб.', tile)
        case['protected_interest_amount'] = '950000.52'
        self.assertIn('950 000,52 руб.', publisher.render_case_jump(case, 0))
        case['protected_interest_amount'] = None
        tile = publisher.render_case_jump(case, 0)
        self.assertNotIn('Защищено', tile)
        self.assertIn('Результат в истории дела', tile)

    def test_case_navigation_is_data_driven_and_omits_unnumbered_cases(self):
        cases = []
        for i in range(100):
            case = sample_case()
            case['public_slug'] = f'case-{i}'
            case['court_case_number'] = f'А40-{i}/2026'
            cases.append(case)
        cases.append({**sample_case(), 'public_slug': 'pretrial', 'court_case_number': None})
        page = publisher.render_listing(publisher.load_chrome(ROOT / 'www'), cases)
        self.assertEqual(page.count('data-case-jump '), 100)
        self.assertIn('href="#case-case-99"', page)
        self.assertNotIn('href="#case-pretrial"', page)
        self.assertIn('data-case-strip-pause', page)

    def test_card_case_number_badge(self):
        case = sample_case()
        card = publisher.render_case_card(case, 0)
        self.assertIn('class="case-card__number">Дело № А40-117474/2023</span>', card)
        self.assertIn('Читать историю', card)
        self.assertIn('id="case-snizhenie-neustoyki-v-kassatsii" tabindex="-1"', card)
        case['court_case_number'] = '№ <test>'
        self.assertIn('Дело № &lt;test&gt;', publisher.render_case_card(case, 0))
        case['court_case_number'] = None
        self.assertIn('class="case-card__number">Практика ЭЛЕГСО</span>', publisher.render_case_card(case, 0))
    def test_case_excerpt_keeps_complete_public_text(self) -> None:
        case = sample_case()
        case["public_excerpt"] = (
            "Длинное публичное описание "
            + "с подробностями дела " * 30
            + "не должно обрываться посреди заключительной фразы."
        )

        self.assertEqual(publisher.case_excerpt(case), case["public_excerpt"])
        self.assertTrue(publisher.case_excerpt(case).endswith("заключительной фразы."))

    def test_separate_story_changes_only_detail_narrative(self) -> None:
        case = sample_case()
        case["public_excerpt"] = "Короткий публичный анонс."
        case["use_separate_public_story"] = True
        case["public_story"] = "Большой подробный рассказ о работе команды без сокращений."

        detail = publisher.render_detail(
            publisher.load_chrome(ROOT / "www"),
            case,
            "https://law.elegso.ru/api/v1/public/legal-case-announcements",
        )

        self.assertIn("<p>Короткий публичный анонс.</p>", detail)
        self.assertIn(
            '<p class="case-summary">Большой подробный рассказ о работе команды без сокращений.</p>',
            detail,
        )
        self.assertNotIn('<p class="case-summary">Короткий публичный анонс.</p>', detail)
        self.assertIn('class="case-card__excerpt is-clamped"', publisher.render_case_card(case, 0))

    def test_old_case_without_separate_story_keeps_previous_rendering(self) -> None:
        case = sample_case()
        case.pop("use_separate_public_story", None)
        case.pop("public_story", None)

        self.assertEqual(publisher.case_story(case), publisher.case_excerpt(case))
        self.assertIn('class="case-card__excerpt"', publisher.render_case_card(case, 0))
        self.assertNotIn('case-card__excerpt is-clamped', publisher.render_case_card(case, 0))

    def test_rich_text_uses_one_compact_heading_level(self) -> None:
        self.assertEqual(
            publisher.safe_rich("<h2>Первый</h2><h3>Второй</h3><h4>Третий</h4>"),
            "<h4>Первый</h4><h4>Второй</h4><h4>Третий</h4>",
        )

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
            self.assertIn('class="cases-jump"', listing)
            self.assertIn('href="#case-snizhenie-neustoyki-v-kassatsii" data-case-jump', listing)
            self.assertIn('class="cases-author"', listing)
            notice = listing.split('<div class="cases-author__notice">', 1)[1].split('</div>', 1)[0]
            self.assertIn('Будьте бдительны. Обратите на это внимание.', notice)
            self.assertIn('недобросовестно представляют наши судебные дела как свои результаты, вводя клиентов в заблуждение.', notice)
            self.assertNotIn('Кейсы этой страницы', notice)
            self.assertIn('<p class="cases-author__provenance">Кейсы этой страницы', listing)
            self.assertIn('Тимур Васильевич', listing)
            self.assertIn('Эксперт по экономическим спорам · юридический ментор', listing)
            self.assertNotIn('мотиватор', listing.lower())
            self.assertIn('высшее правовое образование', listing)
            self.assertIn('большой опыт экономической экспертизы', listing)
            self.assertNotIn('<p>Тимур Васильевич', listing)
            self.assertIn('делах Тимченко Тимур Васильевич', listing)
            self.assertIn('</strong> Тимченко Тимур Васильевич', listing)
            self.assertIn('Центральное звено проекта — Тимченко Тимур Васильевич.', listing)
            self.assertIn('управленческий и менторский талант', listing)
            self.assertNotIn('высшее юридическое образование', listing)
            self.assertIn('лично участвовал в судебных заседаниях', listing)
            self.assertIn('class="cases-author__details"', listing)
            self.assertIn('Номер дела можно скопировать.', listing)
            self.assertIn('tild6262-6533-4064-a136-623633626539/photo.jpg', listing)
            self.assertNotIn('class="cases-author"', detail)
            self.assertIn('href="/cases/"', listing)
            header = listing[listing.index("<!--header-->") : listing.index("</header>")]
            self.assertIn("elegso-cases-nav-item", header)
            self.assertIn("Юридические проекты и решённые дела", header)
            self.assertLess(header.index('href="/cases/"'), header.index('href="/contacts/"'))
            self.assertEqual(header.count('href="/cases/"'), 1)
            self.assertIn("Снизили договорную неустойку", listing)
            self.assertIn("18,45 млн", listing)
            self.assertNotIn("cases-hero__mark", listing)
            self.assertIn("Защищённый имущественный интерес", detail)
            self.assertIn("18 450 000 руб.", detail)
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
            self.assertIn('<span>05</span><p>Документы</p>', detail)
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

    def test_case_card_uses_millions_for_sub_million_result(self) -> None:
        case = sample_case()
        case["protected_interest_amount"] = "737224.70"

        card = publisher.render_case_card(case, 0)

        self.assertIn("0,74 млн", card)
        self.assertNotIn("737 224,70", card)

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
