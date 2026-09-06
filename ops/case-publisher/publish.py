#!/usr/bin/env python3
"""Build SEO-friendly public case pages from the INELSIBI.PRAVO public API."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import html
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable


SITE_ORIGIN = "https://elegso.ru"
DEFAULT_API_BASE = "https://law.elegso.ru/api/v1/public/legal-case-announcements"
ASSET_VERSION = "20260906-4"

OUTCOME_LABELS = {
    "in_progress": "Работа продолжается",
    "won": "Победа",
    "partial_win": "Частичный успех",
    "settlement": "Мировое соглашение",
    "pretrial_success": "Досудебный успех",
    "dismissed": "Требования прекращены",
    "refused": "В иске отказано",
    "lost": "Неблагоприятный результат",
    "other": "Иной результат",
}

STAGE_LABELS = {
    "consultation": "Анализ и консультация",
    "contract": "Договорная работа",
    "pretrial": "Досудебный этап",
    "first_instance": "Первая инстанция",
    "appeal": "Апелляция",
    "cassation": "Кассация",
    "supreme": "Верховный Суд",
    "enforcement": "Исполнение",
    "other": "Иной этап",
}

EFFECT_LABELS = {
    "recovery_for_client": "Взыскано в пользу доверителя",
    "opponent_claim_rejected": "Требование оппонента отклонено",
    "opponent_claim_reduced": "Требование оппонента снижено",
    "counterclaim_rejected": "Встречный иск отклонён",
    "penalty_reduced": "Неустойка или санкции снижены",
    "asset_returned": "Имущество возвращено",
    "asset_preserved": "Имущество сохранено",
    "pretrial_performance": "Досудебное исполнение",
    "settlement_benefit": "Выгода мирового соглашения",
    "enforcement_received": "Фактически получено",
    "other": "Иной имущественный эффект",
}

ALLOWED_RICH_TAGS = {
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "ul",
    "ol",
    "li",
    "h2",
    "h3",
    "h4",
    "blockquote",
    "a",
}


class SafeRichText(HTMLParser):
    """A second allowlist around rich text already sanitised by the source API."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag not in ALLOWED_RICH_TAGS:
            return
        if tag == "a":
            values = dict(attrs)
            href = (values.get("href") or "").strip()
            if not re.match(r"^(?:https?://|mailto:|tel:|/|#)", href, flags=re.I):
                href = ""
            if href:
                self.parts.append(
                    f'<a href="{escape(href)}" rel="nofollow noopener noreferrer">'
                )
                return
        self.parts.append(f"<{tag}>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ALLOWED_RICH_TAGS and tag not in {"br"}:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        self.parts.append(html.escape(data, quote=False))

    def get_html(self) -> str:
        return "".join(self.parts).strip()


class PlainText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


@dataclass(frozen=True)
class SiteChrome:
    head: str
    body_open: str
    header: str
    tail: str


def escape(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def safe_rich(value: Any) -> str:
    parser = SafeRichText()
    parser.feed(str(value or ""))
    parser.close()
    return parser.get_html()


def plain_text(value: Any) -> str:
    parser = PlainText()
    parser.feed(str(value or ""))
    parser.close()
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def first_text(*values: Any, fallback: str = "") -> str:
    for value in values:
        text = plain_text(value)
        if text:
            return text
    return fallback


def decimal(value: Any) -> Decimal:
    try:
        result = Decimal(str(value or "0"))
        return result if result.is_finite() else Decimal("0")
    except (InvalidOperation, ValueError):
        return Decimal("0")


def money(value: Any, currency: str = "RUB", *, short: bool = False) -> str:
    amount = decimal(value)
    if short and abs(amount) >= Decimal("1000000"):
        compact = amount / Decimal("1000000")
        number = f"{compact:,.1f}".replace(",", " ").replace(".0", "")
        return f"{number} млн руб."
    number = f"{amount:,.2f}".replace(",", " ")
    if number.endswith(".00"):
        number = number[:-3]
    symbols = {"RUB": "руб.", "USD": "$", "EUR": "€"}
    return f"{number} {symbols.get(currency, currency)}".strip()


def ru_date(value: Any) -> str:
    if not value:
        return ""
    try:
        parsed = date.fromisoformat(str(value)[:10])
    except ValueError:
        return str(value)
    return parsed.strftime("%d.%m.%Y")


def iso_lastmod(value: Any) -> str:
    text = str(value or "")
    if not text:
        return datetime.now(timezone.utc).date().isoformat()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return text[:10]


def outcome_label(value: Any) -> str:
    return OUTCOME_LABELS.get(str(value or "other"), OUTCOME_LABELS["other"])


def absolute_api_url(value: Any, api_base: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urllib.parse.urlsplit(api_base)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return urllib.parse.urljoin(f"{origin}/", raw)


def with_disposition(url: str, disposition: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = [(key, value) for key, value in query if key != "disposition"]
    query.append(("disposition", disposition))
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )


def ordered(rows: Iterable[dict[str, Any]], key: str = "row_order") -> list[dict[str, Any]]:
    return sorted(rows, key=lambda row: (int(row.get(key) or 0), int(row.get("id") or 0)))


def material_date(item: dict[str, Any]) -> date:
    raw = str(item.get("file_date") or "").strip()
    if raw:
        try:
            return date.fromisoformat(raw[:10])
        except ValueError:
            pass

    match = re.search(r"(?<!\d)(\d{4})[._-](\d{2})[._-](\d{2})(?!\d)", str(item.get("name") or ""))
    if match:
        try:
            return date(*(int(part) for part in match.groups()))
        except ValueError:
            pass
    return date.min


def material_display_key(item: dict[str, Any]) -> tuple[Any, ...]:
    if item.get("kind") == "folder":
        return (0, int(item.get("row_order") or 0), int(item.get("id") or 0))
    return (
        1,
        -material_date(item).toordinal(),
        int(item.get("carousel_order") or item.get("row_order") or 0),
        str(item.get("name") or "").casefold(),
        int(item.get("id") or 0),
    )


def load_chrome(source_root: Path) -> SiteChrome:
    template = (source_root / "mission" / "index.html").read_text(encoding="utf-8")
    body_match = re.search(r"<body\b[^>]*>", template, flags=re.I)
    header_start = template.find("<!--header-->")
    header_end = template.find("</header>", header_start)
    footer_start = template.find("<!--footer-->", header_end)
    if not body_match or min(header_start, header_end, footer_start) < 0:
        raise RuntimeError("Не удалось выделить шапку и подвал из шаблона сайта")
    header = template[header_start : header_end + len("</header>")]
    header = inject_cases_navigation(header)
    return SiteChrome(
        head=template[: body_match.start()],
        body_open=body_match.group(0),
        header=header,
        tail=template[footer_start:],
    )


def inject_cases_navigation(header: str) -> str:
    legacy_submenu_case = re.compile(
        r'\s*<li\b[^>]*class="[^"]*t978__menu-item[^"]*"[^>]*>'
        r'(?:(?!</li>)[\s\S])*?href="/cases/"(?:(?!</li>)[\s\S])*?</li>',
        flags=re.I,
    )
    header = legacy_submenu_case.sub("", header)
    top_level_cases = re.search(
        r'<li\b[^>]*class="[^"]*t228__list_item[^"]*"[^>]*>'
        r'(?:(?!</li>)[\s\S])*?href="/cases/"(?:(?!</li>)[\s\S])*?</li>',
        header,
        flags=re.I,
    )
    if top_level_cases:
        return header

    contact_pattern = re.compile(
        r'<li\b[^>]*class="[^"]*t228__list_item[^"]*"[^>]*>'
        r'(?:(?!</li>)[\s\S])*?href="/contacts/"(?:(?!</li>)[\s\S])*?</li>',
        flags=re.I,
    )
    contact_match = contact_pattern.search(header)
    if not contact_match:
        return header

    contact_item = contact_match.group(0)
    cases_item = contact_item
    cases_item = cases_item.replace('href="/contacts/"', 'href="/cases/"', 1)
    cases_item = re.sub(r'(>\s*)Контакты(\s*</a>)', r'\1Кейсы\2', cases_item, count=1)
    cases_item = cases_item.replace(
        'class="t228__list_item"',
        'class="t228__list_item elegso-cases-nav-item"',
        1,
    )
    cases_item = cases_item.replace(
        'class="t-menu__link-item"',
        'class="t-menu__link-item elegso-cases-nav-link"',
        1,
    )
    cases_item = cases_item.replace('data-menu-submenu-hook=""', '', 1)
    cases_item = cases_item.replace(
        'data-menu-item-number="3"',
        'data-menu-item-number="3" data-elegso-cases-nav="true" '
        'title="Юридические проекты и решённые дела" '
        'aria-label="Кейсы: юридические проекты и решённые дела"',
        1,
    )
    cases_item = re.sub(
        r'style="padding:0 0 0 15px;"',
        'style="padding:0 15px;position:relative;"',
        cases_item,
        count=1,
    )
    cases_item = cases_item.replace(
        "</a>",
        '</a><span class="elegso-cases-nav-hint" role="tooltip">'
        "Юридические проекты и решённые дела</span>",
        1,
    )
    contact_item = contact_item.replace('data-menu-item-number="3"', 'data-menu-item-number="4"', 1)
    return f"{header[:contact_match.start()]}{cases_item}{contact_item}{header[contact_match.end():]}"


def replace_meta(document: str, attribute: str, name: str, content: str) -> str:
    pattern = re.compile(
        rf"<meta\b(?=[^>]*\b{re.escape(attribute)}=[\"']{re.escape(name)}[\"'])[^>]*>",
        flags=re.I,
    )
    tag = f'<meta {attribute}="{escape(name)}" content="{escape(content)}">'
    if pattern.search(document):
        return pattern.sub(tag, document, count=1)
    return document.replace("</head>", f"{tag}\n</head>", 1)


def customise_head(
    chrome: SiteChrome,
    *,
    title: str,
    description: str,
    canonical: str,
    schema: dict[str, Any],
    article: bool,
) -> str:
    head = chrome.head
    head = re.sub(r"<title\b[^>]*>[\s\S]*?</title>", f"<title>{escape(title)}</title>", head, count=1, flags=re.I)
    head = re.sub(
        r"<link\b(?=[^>]*\brel=[\"'][^\"']*canonical[^\"']*[\"'])[^>]*>",
        f'<link rel="canonical" href="{escape(canonical)}">',
        head,
        count=1,
        flags=re.I,
    )
    head = re.sub(
        r"\s*<script\b[^>]*(?:data-elegso-seo-schema|data-elegso-cases-schema)[^>]*>[\s\S]*?</script>",
        "",
        head,
        flags=re.I,
    )
    head = replace_meta(head, "name", "description", description)
    head = replace_meta(head, "name", "robots", "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1")
    head = replace_meta(head, "property", "og:title", title)
    head = replace_meta(head, "property", "og:description", description)
    head = replace_meta(head, "property", "og:url", canonical)
    head = replace_meta(head, "property", "og:type", "article" if article else "website")
    head = replace_meta(
        head,
        "property",
        "og:image",
        f"{SITE_ORIGIN}/_external/static.tildacdn.com/tild3235-6433-4364-a535-643564626636/---.jpg",
    )
    schema_json = json.dumps(schema, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    extras = (
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        '<link href="https://fonts.googleapis.com/css2?family=Prata&display=swap" rel="stylesheet">\n'
        f'<link rel="stylesheet" href="/assets/cases.css?v={ASSET_VERSION}">\n'
        f'<script src="/assets/cases.js?v={ASSET_VERSION}" defer></script>\n'
        '<script type="application/ld+json" data-elegso-cases-schema>'
        f"{schema_json}"
        "</script>\n"
    )
    return head.replace("</head>", f"{extras}</head>", 1)


def render_page(
    chrome: SiteChrome,
    *,
    title: str,
    description: str,
    canonical: str,
    schema: dict[str, Any],
    article: bool,
    alias: str,
    content: str,
) -> str:
    head = customise_head(
        chrome,
        title=title,
        description=description,
        canonical=canonical,
        schema=schema,
        article=article,
    )
    body_open = chrome.body_open
    if "class=" in body_open:
        body_open = re.sub(
            r'class=(["\'])([^"\']*)\1',
            lambda match: f'class={match.group(1)}{match.group(2)} elegso-cases-page{match.group(1)}',
            body_open,
            count=1,
        )
    else:
        body_open = body_open[:-1] + ' class="elegso-cases-page">'
    allrecords = (
        '<div id="allrecords" class="t-records" data-hook="blocks-collection-content-node" '
        f'data-tilda-project-id="3964517" data-tilda-page-alias="{escape(alias)}" '
        'data-tilda-lazy="yes" data-tilda-root-zone="com" data-tilda-project-headcode="yes" '
        'data-tilda-project-country="RU">'
    )
    return f"{head}{body_open}\n{allrecords}\n{chrome.header}\n{content}\n{chrome.tail}"


def organisation_schema() -> dict[str, Any]:
    return {
        "@type": ["LegalService", "Organization"],
        "@id": f"{SITE_ORIGIN}/#organization",
        "name": "Юридическая компания «ЭЛЕГСО»",
        "url": f"{SITE_ORIGIN}/",
        "logo": f"{SITE_ORIGIN}/_external/static.tildacdn.com/tild6636-3836-4134-b236-373062316464/_v6_.png",
        "telephone": "+7-495-646-00-02",
        "email": "mail@elegso.ru",
        "address": {
            "@type": "PostalAddress",
            "streetAddress": "ул. Бутлерова, 17, БЦ Neo Geo, блок С, этаж 4, офис С01",
            "addressLocality": "Москва",
            "addressCountry": "RU",
        },
    }


def breadcrumbs_schema(items: list[tuple[str, str]]) -> dict[str, Any]:
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": index + 1, "name": name, "item": url}
            for index, (name, url) in enumerate(items)
        ],
    }


def case_excerpt(case: dict[str, Any]) -> str:
    stages = ordered(case.get("stages") or [])
    stage_values: list[Any] = []
    for stage in stages:
        stage_values.extend([stage.get("narrative_html"), stage.get("result_html")])
    stage_text = first_text(*stage_values) if stage_values else ""
    text = first_text(
        case.get("public_excerpt"),
        stage_text,
        case.get("result_html"),
        case.get("strategy_html"),
        fallback="Юридическая работа и достигнутый результат по делу.",
    )
    return text[:460].rstrip()


def card_search_text(case: dict[str, Any]) -> str:
    values: list[Any] = [
        case.get("public_title"),
        case.get("public_excerpt"),
        case.get("case_category"),
        case.get("court_case_number"),
        case.get("strategy_html"),
        case.get("result_html"),
        case.get("significance_html"),
    ]
    for stage in case.get("stages") or []:
        values.extend([stage.get("title"), stage.get("narrative_html"), stage.get("result_html")])
    for effect in case.get("economic_effects") or []:
        values.extend([effect.get("title"), effect.get("asset_description"), effect.get("note")])
    return plain_text(" ".join(str(value or "") for value in values)).lower()


def metric(icon: str, label: str, value: str) -> str:
    return (
        '<div class="case-metric">'
        f'<span aria-hidden="true">{icon}</span><small>{escape(label)}</small><strong>{escape(value)}</strong>'
        "</div>"
    )


def render_case_card(case: dict[str, Any], index: int) -> str:
    slug = str(case["public_slug"])
    title = str(case.get("public_title") or "Дело без названия")
    category = str(case.get("case_category") or "Юридическая практика")
    excerpt = case_excerpt(case)
    protected = decimal(case.get("protected_interest_amount"))
    duration = case.get("duration_days")
    instances = case.get("court_instance_count")
    search = card_search_text(case)
    metrics = []
    if protected > 0:
        metrics.append(metric("₽", "Защищено", money(protected, case.get("currency_code") or "RUB", short=True)))
    if duration is not None:
        metrics.append(metric("◷", "Длительность", f"{duration} дн."))
    if instances is not None:
        metrics.append(metric("§", "Инстанции", str(instances)))
    if not metrics:
        metrics.append(metric("§", "Результат", outcome_label(case.get("outcome_kind"))))
    return f"""
      <article class="case-card" data-case-card data-category="{escape(category.lower())}" data-search="{escape(search)}" style="--case-order:{index}">
        <a class="case-card__surface" href="/cases/{escape(slug)}/" aria-label="Открыть кейс: {escape(title)}">
          <div class="case-card__top">
            <span class="case-outcome case-outcome--{escape(case.get('outcome_kind') or 'other')}">{escape(outcome_label(case.get('outcome_kind')))}</span>
            <time datetime="{escape(case.get('document_date') or '')}">{escape(ru_date(case.get('document_date')))}</time>
          </div>
          <p class="case-card__category">{escape(category)}</p>
          <h2>{escape(title)}</h2>
          <p class="case-card__excerpt">{escape(excerpt)}</p>
          <div class="case-card__metrics">{''.join(metrics)}</div>
          <div class="case-card__foot"><span>{escape(case.get('court_case_number') or 'Практика ЭЛЕГСО')}</span><b>Читать историю <i aria-hidden="true">→</i></b></div>
        </a>
      </article>"""


def listing_schema(cases: list[dict[str, Any]]) -> dict[str, Any]:
    canonical = f"{SITE_ORIGIN}/cases/"
    return {
        "@context": "https://schema.org",
        "@graph": [
            organisation_schema(),
            {
                "@type": "CollectionPage",
                "@id": f"{canonical}#page",
                "url": canonical,
                "name": "Кейсы юридической компании «ЭЛЕГСО»",
                "description": "Истории судебной и досудебной защиты бизнеса, стратегии и подтверждённые результаты юридической компании «ЭЛЕГСО».",
                "inLanguage": "ru-RU",
                "about": {"@id": f"{SITE_ORIGIN}/#organization"},
                "mainEntity": {
                    "@type": "ItemList",
                    "numberOfItems": len(cases),
                    "itemListElement": [
                        {
                            "@type": "ListItem",
                            "position": index + 1,
                            "url": f"{SITE_ORIGIN}/cases/{case['public_slug']}/",
                            "name": case.get("public_title"),
                        }
                        for index, case in enumerate(cases)
                    ],
                },
            },
            breadcrumbs_schema(
                [("Главная", f"{SITE_ORIGIN}/"), ("Кейсы", canonical)]
            ),
        ],
    }


def render_listing(chrome: SiteChrome, cases: list[dict[str, Any]]) -> str:
    categories = sorted(
        {str(case.get("case_category") or "Юридическая практика") for case in cases},
        key=str.casefold,
    )
    total = sum((decimal(case.get("protected_interest_amount")) for case in cases), Decimal("0"))
    cards = "".join(render_case_card(case, index) for index, case in enumerate(cases))
    options = "".join(
        f'<option value="{escape(category.lower())}">{escape(category)}</option>' for category in categories
    )
    empty = "" if cases else """
      <section class="case-empty-state">
        <span>§</span>
        <h2>Первые публичные кейсы готовятся</h2>
        <p>Мы публикуем истории только после юридической проверки, удаления закрытых сведений и подготовки подтверждающих материалов.</p>
      </section>"""
    protected_stat = (
        f'<div><strong>{escape(money(total, "RUB", short=True))}</strong><span>защищённый имущественный интерес</span></div>'
        if total > 0
        else '<div><strong>Проверено</strong><span>перед каждой публикацией</span></div>'
    )
    content = f"""
    <main class="cases-page" data-cases-index>
      <section class="cases-hero">
        <div class="cases-hero__inner">
          <p class="cases-eyebrow">Практика в действии</p>
          <h1>Дела, в которых право<br><em>стало результатом</em></h1>
          <p class="cases-hero__lead">Показываем не обещания, а ход работы: исходную задачу, правовую стратегию, решения судов и имущественный эффект для доверителя.</p>
          <div class="cases-hero__facts">
            <div><strong>{len(cases)}</strong><span>опубликованных историй</span></div>
            {protected_stat}
            <div><strong>По документам</strong><span>с подтверждающими судебными актами</span></div>
          </div>
        </div>
      </section>

      <section class="cases-catalog" aria-labelledby="cases-catalog-title">
        <div class="cases-catalog__head">
          <div><p class="cases-eyebrow">Библиотека решений</p><h2 id="cases-catalog-title">Найдите похожую задачу</h2></div>
          <p>Поиск работает по названию, обстоятельствам, этапам, правовой позиции, номеру дела и результату.</p>
        </div>
        <div class="cases-tools" role="search">
          <label class="cases-search"><span aria-hidden="true">⌕</span><input type="search" data-cases-search placeholder="Например: неустойка, лизинг, кассация" autocomplete="off"><kbd>⌘ K</kbd></label>
          <label class="cases-filter"><span>Направление</span><select data-cases-category><option value="">Все практики</option>{options}</select></label>
          <div class="cases-found"><strong data-cases-found>{len(cases)}</strong><span>найдено</span></div>
        </div>
        <div class="cases-grid" data-cases-grid>{cards}</div>
        <div class="cases-no-results" data-cases-no-results hidden><strong>Совпадений нет</strong><span>Измените формулировку или выберите все практики.</span></div>
        {empty}
      </section>

      <section class="cases-method">
        <p class="cases-eyebrow">Как читать кейсы</p>
        <div><h2>Без рекламной дымки.<br>С юридической логикой.</h2><p>Каждая история разбита на этапы и содержит тот объём сведений, который допустим к публикации. Суммы отражают защищённый имущественный интерес: взысканное, сохранённое имущество, отклонённые или уменьшенные требования оппонента.</p></div>
        <ol><li><span>01</span>Исходная ситуация</li><li><span>02</span>Стратегия и доказательства</li><li><span>03</span>Решения по инстанциям</li><li><span>04</span>Фактический эффект</li></ol>
      </section>

      <section class="cases-contact">
        <div><p class="cases-eyebrow">Обсудить вашу ситуацию</p><h2>Похожее дело не означает одинаковый путь.</h2><p>Разберём документы и предложим стратегию с учётом вашей фактической ситуации.</p></div>
        <div><a href="tel:+74956460002">+7 (495) 646-00-02</a><a class="cases-contact__button" href="mailto:mail@elegso.ru">Написать юристу</a></div>
      </section>
    </main>"""
    return render_page(
        chrome,
        title="Кейсы и результаты юридической компании «ЭЛЕГСО»",
        description="Судебные и досудебные кейсы юридической компании «ЭЛЕГСО»: история спора, стратегия, решения судов, защищённый имущественный интерес и материалы дела.",
        canonical=f"{SITE_ORIGIN}/cases/",
        schema=listing_schema(cases),
        article=False,
        alias="cases",
        content=content,
    )


def render_metrics(case: dict[str, Any]) -> str:
    values: list[tuple[str, str, str]] = []
    protected = decimal(case.get("protected_interest_amount"))
    if protected > 0:
        values.append(("₽", "Защищённый имущественный интерес", money(protected, case.get("currency_code") or "RUB")))
    if case.get("duration_days") is not None:
        values.append(("◷", "Продолжительность", f"{case['duration_days']} календарных дней"))
    if case.get("hearing_count") is not None:
        values.append(("§", "Судебных заседаний", str(case["hearing_count"])))
    if case.get("opponent_meeting_count") is not None:
        values.append(("↔", "Встреч с оппонентом", str(case["opponent_meeting_count"])))
    if case.get("court_instance_count") is not None:
        values.append(("⌂", "Судебных инстанций", str(case["court_instance_count"])))
    if case.get("project_cost_amount") is not None and decimal(case.get("project_cost_amount")) > 0:
        values.append(("•", "Стоимость проекта", money(case["project_cost_amount"], case.get("currency_code") or "RUB")))
    return "".join(
        f'<div><span aria-hidden="true">{icon}</span><small>{escape(label)}</small><strong>{escape(value)}</strong></div>'
        for icon, label, value in values
    )


def render_stages(case: dict[str, Any]) -> str:
    stages = ordered(case.get("stages") or [])
    if not stages:
        return ""
    rows = []
    for index, stage in enumerate(stages, start=1):
        period = " — ".join(filter(None, [ru_date(stage.get("started_on")), ru_date(stage.get("ended_on"))]))
        narrative = safe_rich(stage.get("narrative_html"))
        result = safe_rich(stage.get("result_html"))
        rows.append(f"""
          <article class="case-stage">
            <div class="case-stage__rail"><i>{index:02d}</i><span></span></div>
            <div class="case-stage__body">
              <header><div><small>{escape(STAGE_LABELS.get(str(stage.get('stage_type')), 'Этап дела'))}</small><h3>{escape(stage.get('title') or 'Этап дела')}</h3></div>{f'<time>{escape(period)}</time>' if period else ''}</header>
              {f'<div class="case-prose">{narrative}</div>' if narrative else ''}
              {f'<div class="case-stage__result"><strong>Результат этапа</strong><div class="case-prose">{result}</div></div>' if result else ''}
            </div>
          </article>""")
    return f"""
      <section class="case-section case-story" id="history">
        <div class="case-section__label"><span>02</span><p>Хронология</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Как развивалось дело</p><h2>История по этапам</h2><div class="case-timeline">{''.join(rows)}</div></div>
      </section>"""


def render_economics(case: dict[str, Any]) -> str:
    effects = ordered(case.get("economic_effects") or [])
    if not effects:
        return ""
    cards = []
    for effect in effects:
        protected = decimal(effect.get("protected_amount"))
        initial = decimal(effect.get("initial_amount"))
        final = decimal(effect.get("final_amount"))
        details = []
        if initial > 0:
            details.append(f"Исходная сумма: {money(initial, case.get('currency_code') or 'RUB')}")
        if final > 0:
            details.append(f"Итоговая сумма: {money(final, case.get('currency_code') or 'RUB')}")
        if effect.get("asset_description"):
            details.append(str(effect["asset_description"]))
        included = effect.get("include_in_total", True) is not False
        cards.append(f"""
          <article class="case-effect{' is-reference' if not included else ''}">
            <div><small>{escape(EFFECT_LABELS.get(str(effect.get('effect_type')), 'Имущественный эффект'))}</small><h3>{escape(effect.get('title') or 'Результат')}</h3></div>
            <strong>{escape(money(protected, case.get('currency_code') or 'RUB'))}</strong>
            {f'<p>{escape(" · ".join(details))}</p>' if details else ''}
            {'<p class="case-effect__reference">Справочно, не включено в итоговый защищённый имущественный интерес</p>' if not included else ''}
            {f'<p class="case-effect__note">{escape(effect.get("note"))}</p>' if effect.get('note') else ''}
          </article>""")
    return f"""
      <section class="case-section case-economics" id="economics">
        <div class="case-section__label"><span>03</span><p>В цифрах</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Подтверждённый эффект</p><h2>Что удалось защитить</h2><div class="case-effects">{''.join(cards)}</div></div>
      </section>"""


def material_tree(materials: list[dict[str, Any]], api_base: str) -> str:
    by_parent: dict[Any, list[dict[str, Any]]] = {}
    ids = {item.get("id") for item in materials}
    for item in materials:
        parent = item.get("parent_id") if item.get("parent_id") in ids else None
        by_parent.setdefault(parent, []).append(item)

    for rows in by_parent.values():
        rows.sort(key=material_display_key)

    def walk(parent: Any, trail: set[Any]) -> str:
        rows = []
        for item in by_parent.get(parent, []):
            item_id = item.get("id")
            if item_id in trail:
                continue
            if item.get("kind") == "folder":
                children = walk(item_id, trail | {item_id})
                rows.append(
                    f'<li class="case-folder"><details open><summary><span>▱</span>{escape(item.get("name") or "Папка")}</summary>{f"<ul>{children}</ul>" if children else ""}</details></li>'
                )
            else:
                url = absolute_api_url(item.get("content_url"), api_base)
                rows.append(
                    f'<li class="case-file"><a href="{escape(with_disposition(url, "inline"))}" data-case-open-material="{escape(item_id)}"><span>{"PDF" if item.get("media_kind") == "pdf" else "IMG"}</span><b>{escape(item.get("name") or "Материал")}</b></a></li>'
                )
        return "".join(rows)

    return f'<ul class="case-material-tree">{walk(None, set())}</ul>'


def render_materials(case: dict[str, Any], api_base: str) -> str:
    materials = case.get("published_materials") or []
    files = [item for item in materials if item.get("kind") == "file" and item.get("content_url")]
    files.sort(key=material_display_key)
    if not files:
        return ""
    slides = []
    for index, item in enumerate(files):
        url = absolute_api_url(item.get("content_url"), api_base)
        inline_url = with_disposition(url, "inline")
        download_url = with_disposition(url, "attachment")
        viewer = (
            f'<img data-case-lazy-src="{escape(inline_url)}" alt="{escape(item.get("name") or "Материал дела")}">'
            if item.get("media_kind") == "image"
            else f'<iframe data-case-lazy-src="{escape(inline_url)}" title="{escape(item.get("name") or "Судебный акт")}" loading="lazy"></iframe>'
        )
        slides.append(f"""
          <article class="case-material-slide" data-case-slide data-material-id="{escape(item.get('id'))}" {'hidden' if index else ''}>
            <header><div><small>{escape(item.get('path') or 'Материалы дела')}</small><strong>{escape(item.get('name') or 'Документ')}</strong></div><div><a href="{escape(inline_url)}" target="_blank" rel="noopener">Открыть</a><a href="{escape(download_url)}">Скачать</a></div></header>
            <div class="case-material-viewer case-material-viewer--{escape(item.get('media_kind') or 'pdf')}">{viewer}</div>
          </article>""")
    return f"""
      <section class="case-section case-materials" id="materials">
        <div class="case-section__label"><span>04</span><p>Документы</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Материалы дела</p><h2>Решения и подтверждения</h2>
          <div class="case-materials-layout" data-case-carousel>
            <aside><div><strong>Состав дела</strong><span>{len(files)} {plural_documents(len(files))}</span></div>{material_tree(materials, api_base)}</aside>
            <div class="case-carousel"><div class="case-carousel__toolbar"><span><b data-case-current>1</b> / {len(files)}</span><div><button type="button" data-case-prev aria-label="Предыдущий документ">←</button><button type="button" data-case-next aria-label="Следующий документ">→</button></div></div>{''.join(slides)}</div>
          </div>
        </div>
      </section>"""


def plural_documents(count: int) -> str:
    if count % 10 == 1 and count % 100 != 11:
        return "документ"
    if count % 10 in {2, 3, 4} and count % 100 not in {12, 13, 14}:
        return "документа"
    return "документов"


def detail_schema(case: dict[str, Any], description: str) -> dict[str, Any]:
    canonical = f"{SITE_ORIGIN}/cases/{case['public_slug']}/"
    article: dict[str, Any] = {
        "@type": "Article",
        "@id": f"{canonical}#article",
        "url": canonical,
        "headline": case.get("public_title"),
        "description": description,
        "datePublished": case.get("published_at") or case.get("document_date"),
        "dateModified": case.get("updated_at"),
        "inLanguage": "ru-RU",
        "author": {"@id": f"{SITE_ORIGIN}/#organization"},
        "publisher": {"@id": f"{SITE_ORIGIN}/#organization"},
        "about": [case.get("case_category"), "Юридическая защита бизнеса"],
        "mainEntityOfPage": {"@id": f"{canonical}#page"},
    }
    return {
        "@context": "https://schema.org",
        "@graph": [
            organisation_schema(),
            {
                "@type": "WebPage",
                "@id": f"{canonical}#page",
                "url": canonical,
                "name": case.get("seo_title") or case.get("public_title"),
                "description": description,
                "inLanguage": "ru-RU",
                "isPartOf": {"@id": f"{SITE_ORIGIN}/#website"},
            },
            article,
            breadcrumbs_schema(
                [
                    ("Главная", f"{SITE_ORIGIN}/"),
                    ("Кейсы", f"{SITE_ORIGIN}/cases/"),
                    (str(case.get("public_title") or "Кейс"), canonical),
                ]
            ),
        ],
    }


def render_detail(chrome: SiteChrome, case: dict[str, Any], api_base: str) -> str:
    title = str(case.get("public_title") or "Юридический кейс")
    description = first_text(case.get("seo_description"), case.get("public_excerpt"), fallback=case_excerpt(case))[:500]
    category = str(case.get("case_category") or "Юридическая практика")
    canonical = f"{SITE_ORIGIN}/cases/{case['public_slug']}/"
    summary = case_excerpt(case)
    metrics = render_metrics(case)
    strategy = safe_rich(case.get("strategy_html"))
    result = safe_rich(case.get("result_html"))
    significance = safe_rich(case.get("significance_html"))
    published_files = [
        item
        for item in case.get("published_materials") or []
        if item.get("kind") == "file" and item.get("media_kind") in {"pdf", "image"}
    ]
    materials_link = (
        '<a class="case-hero__materials-link" href="#materials">'
        '<span>Смотреть судебные акты</span>'
        f'<small>{len(published_files)} {plural_documents(len(published_files))}</small>'
        '<i aria-hidden="true">↓</i></a>'
        if published_files
        else ""
    )
    period = " — ".join(filter(None, [ru_date(case.get("dispute_started_on")), ru_date(case.get("dispute_ended_on"))]))
    overview_sections = "".join(
        section
        for section in [
            f'<article><small>Правовая стратегия</small><h3>Как строилась защита</h3><div class="case-prose">{strategy}</div></article>' if strategy else "",
            f'<article><small>Итог</small><h3>Что изменилось для доверителя</h3><div class="case-prose">{result}</div></article>' if result else "",
            f'<article><small>Практическое значение</small><h3>Почему этот результат важен</h3><div class="case-prose">{significance}</div></article>' if significance else "",
        ]
    )
    overview = f"""
      <section class="case-section case-overview" id="overview">
        <div class="case-section__label"><span>01</span><p>Суть дела</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Задача и решение</p><h2>За сухими формулировками<br>стоит работа команды</h2><p class="case-summary">{escape(summary)}</p>{f'<div class="case-overview__grid">{overview_sections}</div>' if overview_sections else ''}</div>
      </section>"""
    content = f"""
    <main class="case-page" data-case-detail>
      <nav class="case-breadcrumbs" aria-label="Навигационная цепочка"><a href="/">Главная</a><span>·</span><a href="/cases/">Кейсы</a><span>·</span><b>{escape(category)}</b></nav>
      <article>
        <header class="case-hero">
          <div class="case-hero__copy"><div class="case-hero__meta"><span class="case-outcome case-outcome--{escape(case.get('outcome_kind') or 'other')}">{escape(outcome_label(case.get('outcome_kind')))}</span><span>{escape(category)}</span>{f'<span>Дело № {escape(case.get("court_case_number"))}</span>' if case.get('court_case_number') else ''}</div><h1>{escape(title)}</h1><p>{escape(summary)}</p><div class="case-hero__footer"><div class="case-hero__dates"><time datetime="{escape(case.get('document_date') or '')}">Анонс от {escape(ru_date(case.get('document_date')))}</time>{f'<span>Период спора: {escape(period)}</span>' if period else ''}</div>{materials_link}</div></div>
        </header>
        {f'<section class="case-metrics-strip">{metrics}</section>' if metrics else ''}
        <nav class="case-anchor-nav" aria-label="Содержание кейса"><a href="#overview">Суть дела</a>{'<a href="#history">История</a>' if case.get('stages') else ''}{'<a href="#economics">Имущественный эффект</a>' if case.get('economic_effects') else ''}{f'<a class="case-anchor-nav__materials" href="#materials">Судебные акты · {len(published_files)}</a>' if published_files else ''}</nav>
        {overview}
        {render_stages(case)}
        {render_economics(case)}
        {render_materials(case, api_base)}
      </article>
      <section class="case-disclaimer"><strong>Важно</strong><p>Опубликованный результат относится к конкретным обстоятельствам дела и не гарантирует такой же исход в другой ситуации. Для правовой оценки нужны документы и фактический контекст.</p></section>
      <section class="cases-contact cases-contact--detail"><div><p class="cases-eyebrow">Есть похожая задача?</p><h2>Разберём факты до того, как они станут риском.</h2><p>Свяжитесь с юристом и расскажите, на какой стадии находится спор.</p></div><div><a href="tel:+74956460002">+7 (495) 646-00-02</a><a class="cases-contact__button" href="mailto:mail@elegso.ru">Написать юристу</a></div></section>
      <a class="case-back-link" href="/cases/">← Все кейсы</a>
    </main>"""
    return render_page(
        chrome,
        title=str(case.get("seo_title") or f"{title} — кейс юридической компании «ЭЛЕГСО»"),
        description=description,
        canonical=canonical,
        schema=detail_schema(case, description),
        article=True,
        alias=f"case-{case['public_slug']}",
        content=content,
    )


def fetch_json(url: str, timeout: int = 35) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "ElegsoCasePublisher/1.0"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"API returned HTTP {response.status}: {url}")
        return json.loads(response.read().decode("utf-8"))


def fetch_cases(api_base: str) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    offset = 0
    while True:
        separator = "&" if "?" in api_base else "?"
        page = fetch_json(f"{api_base}{separator}limit=200&offset={offset}")
        if not isinstance(page, list):
            raise RuntimeError("Публичный API вернул неожиданный формат списка")
        summaries.extend(page)
        if len(page) < 200:
            break
        offset += len(page)
    result = []
    seen: set[str] = set()
    for summary in summaries:
        slug = str(summary.get("public_slug") or "")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            raise RuntimeError(f"Недопустимый публичный адрес кейса: {slug!r}")
        if slug in seen:
            raise RuntimeError(f"Публичный API вернул повтор адреса: {slug}")
        seen.add(slug)
        detail = fetch_json(f"{api_base.rstrip('/')}/{urllib.parse.quote(slug, safe='')}")
        if not isinstance(detail, dict):
            raise RuntimeError(f"Публичный API вернул неожиданный формат кейса {slug}")
        result.append(detail)
    return result


def validate_cases(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    for case in cases:
        slug = str(case.get("public_slug") or "")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            raise RuntimeError(f"Недопустимый публичный адрес кейса: {slug!r}")
        if slug in seen:
            raise RuntimeError(f"Повтор публичного адреса кейса: {slug}")
        if not str(case.get("public_title") or "").strip():
            raise RuntimeError(f"У кейса {slug} отсутствует публичный заголовок")
        seen.add(slug)
    return sorted(
        cases,
        key=lambda case: (
            str(case.get("published_at") or ""),
            str(case.get("document_date") or ""),
            str(case.get("public_slug") or ""),
        ),
        reverse=True,
    )


def source_sitemap_path(source_root: Path) -> Path:
    base = source_root / "sitemap.base.xml"
    return base if base.exists() else source_root / "sitemap.xml"


def render_sitemap(source_root: Path, cases: list[dict[str, Any]]) -> str:
    sitemap_path = source_sitemap_path(source_root)
    existing = sitemap_path.read_text(encoding="utf-8") if sitemap_path.exists() else ""
    existing_urls = re.findall(r"<url>[\s\S]*?</url>", existing)
    rows = [row for row in existing_urls if not re.search(r"<loc>https://elegso\.ru/cases(?:/|<)", row)]
    today = datetime.now(timezone.utc).date().isoformat()
    rows.append(
        f"  <url>\n    <loc>{SITE_ORIGIN}/cases/</loc>\n    <lastmod>{today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>"
    )
    for case in cases:
        rows.append(
            "  <url>\n"
            f"    <loc>{SITE_ORIGIN}/cases/{html.escape(str(case['public_slug']))}/</loc>\n"
            f"    <lastmod>{escape(iso_lastmod(case.get('updated_at')))}</lastmod>\n"
            "    <changefreq>monthly</changefreq>\n"
            "    <priority>0.8</priority>\n"
            "  </url>"
        )
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" + "\n".join(rows) + "\n</urlset>\n"


def content_digest(source_root: Path, cases: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    digest.update(Path(__file__).read_bytes())
    digest.update((source_root / "mission" / "index.html").read_bytes())
    sitemap = source_sitemap_path(source_root)
    if sitemap.exists():
        digest.update(sitemap.read_bytes())
    digest.update(json.dumps(cases, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return digest.hexdigest()


def write_release(
    source_root: Path,
    output_root: Path,
    cases: list[dict[str, Any]],
    api_base: str,
    *,
    force: bool = False,
) -> tuple[bool, Path]:
    cases = validate_cases(cases)
    digest = content_digest(source_root, cases)
    releases = output_root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    release = releases / digest[:16]
    current = output_root / "current"
    if release.exists():
        release.chmod(0o755)
    if current.is_symlink() and current.resolve() == release.resolve() and not force:
        return False, release

    if not release.exists() or force:
        temp = Path(tempfile.mkdtemp(prefix=f".{digest[:12]}-", dir=releases))
        try:
            chrome = load_chrome(source_root)
            cases_dir = temp / "cases"
            cases_dir.mkdir(parents=True)
            (cases_dir / "index.html").write_text(render_listing(chrome, cases), encoding="utf-8")
            for case in cases:
                destination = cases_dir / str(case["public_slug"])
                destination.mkdir()
                (destination / "index.html").write_text(
                    render_detail(chrome, case, api_base), encoding="utf-8"
                )
            (temp / "sitemap.xml").write_text(render_sitemap(source_root, cases), encoding="utf-8")
            (temp / "manifest.json").write_text(
                json.dumps(
                    {
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "source_api": api_base,
                        "case_count": len(cases),
                        "content_digest": digest,
                        "slugs": [case["public_slug"] for case in cases],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            if release.exists():
                shutil.rmtree(release)
            temp.chmod(0o755)
            os.replace(temp, release)
        except Exception:
            shutil.rmtree(temp, ignore_errors=True)
            raise

    next_link = output_root / ".current.new"
    next_link.unlink(missing_ok=True)
    next_link.symlink_to(release)
    os.replace(next_link, current)

    current_release = current.resolve()
    old_releases = sorted(
        (path for path in releases.iterdir() if path.is_dir() and path.resolve() != current_release),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for old in old_releases[2:]:
        shutil.rmtree(old, ignore_errors=True)
    return True, release


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--api-base", default=os.environ.get("ELEGSO_CASES_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--allow-empty-fallback", action="store_true")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output_root.mkdir(parents=True, exist_ok=True)
    lock_path = args.output_root / ".publish.lock"
    with lock_path.open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if args.fixture:
                payload = json.loads(args.fixture.read_text(encoding="utf-8"))
                cases = payload.get("cases", []) if isinstance(payload, dict) else payload
            else:
                cases = fetch_cases(args.api_base)
        except (OSError, urllib.error.URLError, json.JSONDecodeError, RuntimeError) as error:
            if not args.allow_empty_fallback or (args.output_root / "current" / "cases" / "index.html").exists():
                raise
            print(f"WARNING: public API unavailable, creating safe empty catalogue: {error}", file=sys.stderr)
            cases = []
        if not isinstance(cases, list):
            raise RuntimeError("Источник кейсов должен вернуть список")
        changed, release = write_release(
            args.source_root.resolve(),
            args.output_root.resolve(),
            cases,
            args.api_base,
            force=args.force,
        )
        verb = "published" if changed else "unchanged"
        print(f"cases={len(cases)} status={verb} release={release}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
