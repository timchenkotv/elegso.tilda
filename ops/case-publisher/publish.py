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
ASSET_VERSION = "20261104-static-materials-1"
CASE_ILLUSTRATION_FALLBACK = "/assets/redesign/leasing-balance.webp"
MAX_PUBLIC_MATERIAL_BYTES = 64 * 1024 * 1024
MATERIAL_CONTENT_TYPES = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
}

OUTCOME_LABELS = {
    "in_progress": "Работа продолжается",
    "won": "Победа",
    "partial_win": "Успех",
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

COST_LABELS = {
    "legal_work": "Юридическая работа",
    "success_fee": "Премия за результат",
    "expense": "Расходы проекта",
    "other": "Иная часть стоимости",
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
RICH_HEADING_TAGS = {"h2", "h3", "h4"}
RICH_HEADING_OUTPUT_TAG = "h4"


def rich_output_tag(tag: str) -> str:
    if tag in RICH_HEADING_TAGS:
        return RICH_HEADING_OUTPUT_TAG
    return tag


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
        self.parts.append(f"<{rich_output_tag(tag)}>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ALLOWED_RICH_TAGS and tag not in {"br"}:
            self.parts.append(f"</{rich_output_tag(tag)}>")

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


def case_card_money(value: Any) -> str:
    """Keep the case-library cards comparable, including sub-million results."""
    compact = decimal(value) / Decimal("1000000")
    number = f"{compact:.2f}".rstrip("0").rstrip(".").replace(".", ",")
    return f"{number} млн"


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


def case_document_date(case: dict[str, Any]) -> date:
    """Date shown on the card: the latest judicial act for catalogue ordering."""
    raw = str(case.get("document_date") or "").strip()
    if not raw:
        return date.min
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return date.min


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
    cases_item = re.sub(r'(>\s*)Контакты(\s*</a>)', r'\1Успешный опыт\2', cases_item, count=1)
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
        'aria-label="Успешный опыт: юридические проекты и решённые дела"',
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
        '<link rel="stylesheet" href="/assets/site-fonts.css?v=20260913-local-fonts-1">\n'
        f'<link rel="stylesheet" href="/assets/cases.css?v={ASSET_VERSION}">\n'
        f'<script src="/assets/cases.js?v={ASSET_VERSION}" defer></script>\n'
        '<script type="application/ld+json" data-elegso-cases-schema>'
        f"{schema_json}"
        "</script>\n"
    )
    head = head.replace("</head>", f"{extras}</head>", 1)
    if re.search(r"\bdata-elegso-design\s*=", head, flags=re.I):
        # The shared redesign overrides the legacy case rules. Keep this
        # opt-in so pages using the original chrome retain their old order.
        theme_links: dict[str, str] = {}

        def remove_theme_link(match: re.Match[str]) -> str:
            tag = match.group(0)
            href = re.search(r"\bhref\s*=\s*([\"'])(.*?)\1", tag, flags=re.I)
            if href:
                filename = Path(urllib.parse.urlsplit(html.unescape(href.group(2))).path).name
                if filename in {"production.css", "editorial-theme.css"}:
                    theme_links.setdefault(filename, tag)
                    return ""
            return tag

        head = re.sub(r"<link\b[^>]*>", remove_theme_link, head, flags=re.I)
        overrides = "\n".join(
            theme_links[name] for name in ["production.css", "editorial-theme.css"] if name in theme_links
        )
        if overrides:
            head = head.replace("</head>", f"{overrides}\n</head>", 1)
    return head


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
    records_class = "t-records site-shell" if re.search(r"\bclass=[\"'][^\"']*\belegso-redesign\b", chrome.body_open) else "t-records"
    allrecords = (
        f'<div id="allrecords" class="{records_class}" data-hook="blocks-collection-content-node" '
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
        "telephone": "+7-495-822-19-20",
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
    return text.rstrip()


def case_story(case: dict[str, Any]) -> str:
    if case.get("use_separate_public_story"):
        raw = str(case.get("public_story") or "").replace("\r\n", "\n").replace("\r", "\n")
        paragraphs = [" ".join(part.split()) for part in re.split(r"\n\s*\n", raw)]
        story = "\n\n".join(part for part in paragraphs if part)
        if story:
            return story
    return case_excerpt(case)


def render_case_story(case: dict[str, Any]) -> str:
    rendered = [f'<p>{escape(part)}</p>' for part in case_story(case).split("\n\n") if part]
    opening = "".join(rendered[:3])
    if len(rendered) <= 3:
        return f'<div class="case-summary">{opening}</div>'
    return f'<div class="case-summary">{opening}</div>' + (
        '<details class="case-story-more">'
        '<summary><span class="case-story-more__dots" aria-hidden="true">…</span>'
        '<span class="case-story-more__expand">Развернуть продолжение рассказа'
        '<small>Рассказ продолжается — часть текста скрыта</small></span>'
        '<span class="case-story-more__collapse">Свернуть текст</span>'
        '<span class="case-story-more__arrow" aria-hidden="true">↓</span></summary>'
        '<div class="case-summary case-story-more__text">' + "".join(rendered[3:]) + '</div></details>'
    )


def card_search_text(case: dict[str, Any]) -> str:
    values: list[Any] = [
        case.get("public_title"),
        case.get("public_excerpt"),
        case.get("public_story"),
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
    for cost in case.get("project_cost_items") or []:
        values.extend([cost.get("title"), cost.get("note")])
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
    excerpt_class = "case-card__excerpt is-clamped" if case.get("use_separate_public_story") else "case-card__excerpt"
    protected = decimal(case.get("protected_interest_amount"))
    duration = case.get("duration_days")
    instances = case.get("court_instance_count")
    search = card_search_text(case)
    number = str(case.get("court_case_number") or "").strip()
    number_label = f"Дело № {number.lstrip('№ ').strip()}" if number else "Практика ЭЛЕГСО"
    illustration_url = case_illustration_url(case)
    illustration_alt = (
        first_text(case["illustration"].get("illustration_alt"), case.get("public_title"), fallback="Иллюстрация дела")
        if illustration_url else "Иллюстрация юридической практики"
    )
    metrics = []
    if protected > 0:
        metrics.append(metric("₽", "Защищено", case_card_money(protected)))
    if duration is not None:
        metrics.append(metric("◷", "Длительность", f"{duration} дн."))
    if instances is not None:
        metrics.append(metric("§", "Инстанции", str(instances)))
    if not metrics:
        metrics.append(metric("§", "Результат", outcome_label(case.get("outcome_kind"))))
    return f"""
      <article class="case-card" id="case-{escape(slug)}" tabindex="-1" data-case-card data-category="{escape(category.lower())}" data-search="{escape(search)}" style="--case-order:{index}">
        <a class="case-card__surface" href="/cases/{escape(slug)}/" aria-label="Открыть историю дела: {escape(title)}">
          <img class="case-card__image" src="{escape(illustration_url or CASE_ILLUSTRATION_FALLBACK)}" alt="{escape(illustration_alt)}" width="1600" height="900" loading="lazy" decoding="async">
          <span class="case-card__badge" aria-hidden="true">{escape(number_label)}</span>
          <div class="case-card__top">
            <span class="case-outcome case-outcome--{escape(case.get('outcome_kind') or 'other')}">{escape(outcome_label(case.get('outcome_kind')))}</span>
            <time datetime="{escape(case.get('document_date') or '')}">{escape(ru_date(case.get('document_date')))}</time>
          </div>
          <p class="case-card__category">{escape(category)}</p>
          <h2>{escape(title)}</h2>
          <p class="{excerpt_class}">{escape(excerpt)}</p>
          <div class="case-card__metrics">{''.join(metrics)}</div>
          <div class="case-card__foot"><span class="case-card__number">{escape(number_label)}</span><b>Читать историю <i aria-hidden="true">→</i></b></div>
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
                "name": "Успешный опыт юридической компании «ЭЛЕГСО»",
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
                [("Главная", f"{SITE_ORIGIN}/"), ("Успешный опыт", canonical)]
            ),
        ],
    }


def render_case_jump(case: dict[str, Any], index: int) -> str:
    number = str(case.get("court_case_number") or "").strip().lstrip("№ ").strip()
    if not number:
        return ""
    amount = decimal(case.get("protected_interest_amount"))
    currency = str(case.get("currency_code") or "RUB")
    exact = re.sub(r"(?<=\d)\.(?=\d)", ",", money(amount, currency))
    compact = re.sub(r"(?<=\d)\.(?=\d)", ",", money(amount, currency, short=currency == "RUB"))
    protection = (
        f'<span class="cases-jump__amount" title="Защищённый имущественный интерес в размере {escape(exact)}">'
        f'<span>Защищено</span><strong>{escape(compact)}</strong></span>'
        if amount > 0 else '<span class="cases-jump__amount cases-jump__amount--empty">Результат в истории дела</span>'
    )
    accessible_amount = f". Защищённый имущественный интерес — {exact}" if amount > 0 else ""
    return (
        f'<a class="cases-jump__tile" href="#case-{escape(case["public_slug"])}" data-case-jump '
        f'aria-label="Перейти к карточке дела {escape(number + accessible_amount)}" style="--jump-order:{index}">'
        f'<span class="cases-jump__number">№ {escape(number)}<i aria-hidden="true">↘</i></span>'
        f'{protection}</a>'
    )


def render_listing(chrome: SiteChrome, cases: list[dict[str, Any]]) -> str:
    categories = sorted(
        {str(case.get("case_category") or "Юридическая практика") for case in cases},
        key=str.casefold,
    )
    total = sum((decimal(case.get("protected_interest_amount")) for case in cases), Decimal("0"))
    cards = "".join(render_case_card(case, index) for index, case in enumerate(cases))
    case_links = "".join(render_case_jump(case, index) for index, case in enumerate(cases))
    case_navigation = (
        '<nav class="cases-jump" aria-label="Быстрый переход к судебным делам">'
        '<div class="cases-jump__heading"><span>Навигатор по делам</span><small>Нажмите на номер</small></div>'
        f'<div class="cases-jump__viewport" data-case-strip><div class="cases-jump__grid">{case_links}</div></div>'
        '<div class="cases-jump__footer"><small>Листайте или перетаскивайте</small>'
        '<div class="cases-jump__controls" data-case-strip-controls hidden>'
        '<button type="button" data-case-strip-prev aria-label="Предыдущие номера дел">←</button>'
        '<button type="button" data-case-strip-pause aria-label="Приостановить движение номеров дел" aria-pressed="false">Пауза</button>'
        '<button type="button" data-case-strip-next aria-label="Следующие номера дел">→</button>'
        '</div></div></nav>'
        if case_links else ""
    )
    options = "".join(
        f'<option value="{escape(category.lower())}">{escape(category)}</option>' for category in categories
    )
    empty = "" if cases else """
      <section class="case-empty-state">
        <span>§</span>
        <h2>Готовим первые истории дел</h2>
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
          <div class="cases-hero__intro">
          <p class="cases-eyebrow">Практика в действии</p>
          <h1>Дела, в которых право<br><em>стало результатом</em></h1>
          <p class="cases-hero__lead">Показываем не обещания, а ход работы: исходную задачу, правовую стратегию, решения судов и имущественный эффект для доверителя.</p>
          <p class="cases-hero__context">ЭЛЕГСО защищает бизнес в сложных экономических и лизинговых спорах: взыскание задолженности и убытков, сальдо встречных обязательств, защита имущества и пересмотр судебных актов. В этих делах — правовая стратегия, экономическая экспертиза и личное участие Тимченко Тимура Васильевича.</p>
          <div class="cases-hero__facts">
            <div><strong>{len(cases)}</strong><span>опубликованных историй</span></div>
            {protected_stat}
            <div><strong>По документам</strong><span>с подтверждающими судебными актами</span></div>
          </div>
          {case_navigation}
          </div>
          <aside class="cases-author" aria-labelledby="cases-author-name">
            <div class="cases-author__profile">
              <img src="/_external/static.tildacdn.com/tild6262-6533-4064-a136-623633626539/photo.jpg" width="104" height="104" alt="Тимченко Тимур Васильевич — руководитель юридической компании ЭЛЕГСО" decoding="async">
              <div><p class="cases-author__eyebrow">За результатом — стратегия и команда</p><h2 id="cases-author-name">Тимченко<br>Тимур Васильевич</h2><p class="cases-author__role">Руководитель ЭЛЕГСО · правовой стратег<br>Эксперт по экономическим спорам · юридический ментор</p></div>
            </div>
            <p class="cases-author__lead">Сложный экономический спор требует большего, чем знания закона. Нужно увидеть логику денег, проверить расчёты и превратить детали дела в убедительную правовую позицию.</p>
            <div class="cases-author__notice">
              <strong>Важно: проверяйте, кто работал над делом</strong>
              <p>Мы замечаем, что другие компании недобросовестно представляют наши судебные дела как свои результаты, вводя клиентов в заблуждение.</p>
              <p>Будьте бдительны. Обратите на это внимание.</p>
            </div>
            <p class="cases-author__provenance">Дела на этой странице — работа команды ЭЛЕГСО под руководством и при непосредственном личном участии Тимченко Тимура Васильевича, включая участие в судебных заседаниях. У нас сохраняются договоры с доверителями и материалы дел, подтверждающие участие компании.</p>
            <details class="cases-author__details">
              <summary>Кто выстраивает стратегию этих дел<span aria-hidden="true">+</span></summary>
              <div class="cases-author__story">
                <p>Тимченко Тимур Васильевич — эксперт в правовых, экономических и технических вопросах, а также в вопросах судебного процесса. Его подготовка объединяет высшее правовое образование, техническое образование и большой опыт экономической экспертизы. Это позволяет разбирать спор во взаимосвязи: устанавливать фактические и технические обстоятельства, проверять экономическую логику и расчёты, формировать правовую позицию и выстраивать процессуальную стратегию её защиты в суде.</p>
                <p>В представленных здесь делах Тимченко Тимур Васильевич сочетал руководство командой с непосредственной работой над спором: формировал стратегию и правовую позицию, разбирал документы и расчёты, готовил доводы и лично участвовал в судебных заседаниях. Он представлял и отстаивал позицию доверителей в суде, отвечал на вопросы, работал с возражениями оппонентов и направлял действия юристов на разных этапах процесса. За судебным результатом стоит не одна удачная фраза, а последовательная личная и командная работа с доказательствами и экономической сутью дела.</p>
                <p><strong>Юридический ментор.</strong> Тимченко Тимур Васильевич готовит и развивает специалистов: обучает юристов, разбирает с ними каждую значимую деталь экономической сути спора, объясняет сложные взаимосвязи простыми словами и помогает видеть за отдельным документом всю конструкцию дела. Он задаёт высокий профессиональный уровень, учит команду углубляться в обстоятельства и доводить аргументацию до ясной, доказательной позиции. Юристы понимают не только, какой довод заявить, но и почему он работает в конкретном споре.</p>
                <p><strong>Центральное звено проекта — Тимченко Тимур Васильевич.</strong> Экономический спор может длиться годами, проходить несколько инстанций и требовать участия разных специалистов. Состав юристов меняется, к работе подключаются новые участники. При этом знание истории дела, экономической сути конфликта и логики выбранной стратегии должно сохраняться. В этих проектах такую преемственность обеспечивает Тимченко Тимур Васильевич: объединяет работу специалистов, удерживает целостную картину и связывает действия каждого юриста с общей целью защиты доверителя.</p>
                <p><strong>Передать документы — ещё не значит передать понимание дела.</strong> Новому юристу необходимо объяснить, откуда возник спор, как связаны расчёты и доказательства, почему выбран именно этот довод, где находятся слабые места оппонента и какие процессуальные действия нужны дальше. Тимченко Тимур Васильевич последовательно погружает специалистов в эту логику: рассказывает, показывает, разбирает вопросы, обучает и проверяет понимание. Так наработанная позиция получает продолжение в работе каждого следующего участника проекта.</p>
                <p>В этом проявляется особый управленческий и менторский талант: находить неочевидное решение самому и передавать сложную систему знаний так, чтобы другой специалист смог осмысленно применить её в суде. Тимченко Тимур Васильевич объединяет людей с разным опытом, раскрывает их профессиональные возможности и выстраивает согласованную работу над сложными экономическими спорами. За действиями разных юристов сохраняются единый стратегический замысел, глубокая междисциплинарная экспертиза и личное участие руководителя. Именно эта преемственность связывает многолетнюю работу команды в целостную историю защиты интересов клиента.</p>
                <p><strong>Номер дела можно скопировать. Знание дела и опыт его ведения — нет.</strong> ЭЛЕГСО — первоисточник опубликованных здесь историй своей работы. Мы подробно знаем ход этих споров и можем подтвердить своё участие документами в пределах обязательств по конфиденциальности.</p>
                <p>Если похожее дело представляют вам как чужой результат, уточните роль конкретной компании и специалистов, этапы их участия и документальные основания таких заявлений. Выбирайте команду, которая способна объяснить свою стратегию и подтвердить свою работу.</p>
              </div>
            </details>
            <a class="cases-author__contact" href="#elegso-contact">Обсудить сложный спор <span aria-hidden="true">↓</span></a>
          </aside>
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
        <p class="cases-eyebrow">Как читать истории дел</p>
        <div><h2>Без рекламной дымки.<br>С юридической логикой.</h2><p>Каждая история разбита на этапы и содержит тот объём сведений, который допустим к публикации. Суммы отражают защищённый имущественный интерес: взысканное, сохранённое имущество, отклонённые или уменьшенные требования оппонента.</p></div>
        <ol><li><span>01</span>Исходная ситуация</li><li><span>02</span>Стратегия и доказательства</li><li><span>03</span>Решения по инстанциям</li><li><span>04</span>Фактический эффект</li></ol>
      </section>

      <section class="cases-contact">
        <div><p class="cases-eyebrow">Обсудить вашу ситуацию</p><h2>Похожее дело не означает одинаковый путь.</h2><p>Разберём документы и предложим стратегию с учётом вашей фактической ситуации.</p></div>
        <div><a href="tel:+74958221920">+7 (495) 822-19-20</a><a class="cases-contact__button" href="mailto:mail@elegso.ru">Написать юристу</a></div>
      </section>
    </main>"""
    return render_page(
        chrome,
        title="Успешный опыт юридической компании «ЭЛЕГСО»",
        description="Судебные и досудебные дела юридической компании «ЭЛЕГСО»: история спора, стратегия, решения судов, защищённый имущественный интерес и материалы дела.",
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
        values.append(("₽", "Стоимость проекта", money(case["project_cost_amount"], case.get("currency_code") or "RUB")))
    return "".join(
        f'<div><span aria-hidden="true">{icon}</span><small>{escape(label)}</small><strong>{escape(value)}</strong></div>'
        for icon, label, value in values
    )


def project_costs_by_stage(case: dict[str, Any], stages: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    result: dict[int, list[dict[str, Any]]] = {}
    assigned: set[int] = set()
    for cost in ordered(case.get("project_cost_items") or []):
        if cost.get("include_in_total", True) is False:
            continue
        target_index = None
        stage_row_order = cost.get("stage_row_order")
        if stage_row_order is not None:
            target_index = next(
                (index for index, stage in enumerate(stages) if stage.get("row_order") == stage_row_order),
                None,
            )
        if target_index is None:
            target_index = next(
                (
                    index
                    for index, stage in enumerate(stages)
                    if index not in assigned and stage.get("stage_type") == cost.get("stage_type")
                ),
                None,
            )
        if target_index is not None:
            result.setdefault(target_index, []).append(cost)
            assigned.add(target_index)
    return result


def render_stages(case: dict[str, Any]) -> str:
    stages = ordered(case.get("stages") or [])
    if not stages:
        return ""
    costs_by_stage = project_costs_by_stage(case, stages)
    rows = []
    for index, stage in enumerate(stages, start=1):
        period = " — ".join(filter(None, [ru_date(stage.get("started_on")), ru_date(stage.get("ended_on"))]))
        narrative = safe_rich(stage.get("narrative_html"))
        result = safe_rich(stage.get("result_html"))
        stage_costs = costs_by_stage.get(index - 1, [])
        stage_cost = sum((decimal(item.get("amount")) for item in stage_costs), Decimal("0"))
        stage_cost_html = (
            '<div class="case-stage__cost"><small>Стоимость этапа</small>'
            f'<strong>{escape(money(stage_cost, case.get("currency_code") or "RUB"))}</strong></div>'
            if stage_cost > 0 else ""
        )
        rows.append(f"""
          <article class="case-stage">
            <div class="case-stage__rail"><i>{index:02d}</i><span></span></div>
            <div class="case-stage__body">
              <header><div><small>{escape(STAGE_LABELS.get(str(stage.get('stage_type')), 'Этап дела'))}</small><h3>{escape(stage.get('title') or 'Этап дела')}</h3></div><div class="case-stage__meta">{f'<time>{escape(period)}</time>' if period else ''}{stage_cost_html}</div></header>
              {f'<div class="case-prose">{narrative}</div>' if narrative else ''}
              {f'<div class="case-stage__result"><strong>Результат этапа</strong><div class="case-prose">{result}</div></div>' if result else ''}
            </div>
          </article>""")
    return f"""
      <section class="case-section case-story" id="history">
        <div class="case-section__label"><span>02</span><p>Хронология</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Как развивалось дело</p><h2>История по этапам</h2><div class="case-timeline">{''.join(rows)}</div></div>
      </section>"""


def render_project_costs(case: dict[str, Any], section_number: str = "03") -> str:
    costs = ordered(case.get("project_cost_items") or [])
    if not costs or case.get("project_cost_amount") is None:
        return ""
    currency = case.get("currency_code") or "RUB"
    cards = []
    for cost in costs:
        amount = decimal(cost.get("amount"))
        if amount <= 0:
            continue
        details = []
        if cost.get("calculation_mode") == "percentage":
            base = decimal(cost.get("base_amount"))
            rate = decimal(cost.get("rate_percent"))
            if base > 0 and rate > 0:
                rate_text = f"{rate:f}".rstrip("0").rstrip(".").replace(".", ",")
                details.append(f"{rate_text}% от {money(base, currency)}")
        if cost.get("note"):
            details.append(str(cost["note"]))
        stage_label = STAGE_LABELS.get(str(cost.get("stage_type")), "Проект в целом")
        cost_label = COST_LABELS.get(str(cost.get("cost_type")), "Стоимость проекта")
        cards.append(f"""
          <article class="case-cost{' is-success-fee' if cost.get('cost_type') == 'success_fee' else ''}">
            <div><small>{escape(cost_label)} · {escape(stage_label)}</small><h3>{escape(cost.get('title') or cost_label)}</h3>{f'<p>{escape(" · ".join(details))}</p>' if details else ''}</div>
            <strong>{escape(money(amount, currency))}</strong>
          </article>""")
    if not cards:
        return ""
    total = decimal(case.get("project_cost_amount"))
    return f"""
      <section class="case-section case-project-cost" id="project-cost">
        <div class="case-section__label"><span>{escape(section_number)}</span><p>Стоимость</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Прозрачная структура</p><h2>Стоимость юридического проекта</h2><p class="case-section__intro">Цена разделена по этапам работы. Премия за достигнутый результат показана отдельно от базовой стоимости юридических услуг.</p><div class="case-costs">{''.join(cards)}</div><div class="case-cost-total"><span>Итого стоимость проекта</span><strong>{escape(money(total, currency))}</strong></div></div>
      </section>"""


def render_economics(case: dict[str, Any], section_number: str = "03") -> str:
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
        <div class="case-section__label"><span>{escape(section_number)}</span><p>В цифрах</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Подтверждённый эффект</p><h2>Что удалось защитить</h2><div class="case-effects">{''.join(cards)}</div></div>
      </section>"""


@dataclass(frozen=True)
class PublicMaterial:
    material_id: int
    filename: str
    fingerprint: str
    size_bytes: int
    content_type: str
    source_url: str


def public_material_spec(case: dict[str, Any], item: dict[str, Any]) -> PublicMaterial:
    """A deterministic local filename and source-version key, without mutation."""
    material_id = carousel_count(item.get("id"))
    size = carousel_count(item.get("file_size"))
    content_type = str(item.get("file_content_type") or "").split(";", 1)[0].strip().lower()
    media_kind = str(item.get("media_kind") or "")
    source_url = str(item.get("content_url") or "").strip()
    if not material_id or not size or size > MAX_PUBLIC_MATERIAL_BYTES:
        raise ValueError("Invalid public case material id or size")
    if content_type not in MATERIAL_CONTENT_TYPES or (
        (content_type == "application/pdf" and media_kind != "pdf")
        or (content_type.startswith("image/") and media_kind != "image")
    ):
        raise ValueError("Unsupported public case material type")
    if not source_url:
        raise ValueError("Public case material has no content URL")
    metadata = {
        "case_updated_at": str(case.get("updated_at") or ""),
        "id": material_id,
        "file_size": size,
        "file_content_type": content_type,
        "file_date": item.get("file_date"),
        "name": item.get("name"),
        "content_url": source_url,
    }
    fingerprint = hashlib.sha256(
        json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    filename = f"{material_id}-{fingerprint[:20]}.{MATERIAL_CONTENT_TYPES[content_type]}"
    return PublicMaterial(material_id, filename, fingerprint, size, content_type, source_url)


def material_local_url(case: dict[str, Any], item: dict[str, Any]) -> str:
    spec = public_material_spec(case, item)
    return f"/cases/{case['public_slug']}/materials/{spec.filename}"


def public_material_url(case: dict[str, Any], spec: PublicMaterial, api_base: str) -> str:
    """Only this case's public material endpoint can be downloaded."""
    origin = urllib.parse.urlsplit(api_base)
    url = absolute_api_url(spec.source_url, api_base)
    parsed = urllib.parse.urlsplit(url)
    prefix = f"{origin.path.rstrip('/')}/{case['public_slug']}/materials/{spec.material_id}/"
    filename = urllib.parse.unquote(parsed.path[len(prefix):]) if parsed.path.startswith(prefix) else ""
    if (
        origin.scheme not in {"http", "https"}
        or origin.username or origin.password
        or (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc)
        or parsed.username or parsed.password or parsed.fragment
        or not filename or filename in {".", ".."}
        or any(character in filename for character in "/\\\x00")
    ):
        raise ValueError("Material URL is outside the public case API")
    return url


class PublicMaterialRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject an escaping redirect before urllib sends a second request."""

    def __init__(self, allowed_url: str):
        super().__init__()
        parsed = urllib.parse.urlsplit(allowed_url)
        self.allowed_target = (parsed.scheme, parsed.netloc, parsed.path)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(urllib.parse.urljoin(req.full_url, newurl))
        if (parsed.scheme, parsed.netloc, parsed.path) != self.allowed_target or parsed.fragment or parsed.username or parsed.password:
            raise ValueError("Unexpected public material redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_public_material(url: str):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "ElegsoCasePublisher/1.0", "Accept-Encoding": "identity"},
    )
    return urllib.request.build_opener(PublicMaterialRedirectHandler(url)).open(request, timeout=60)


def validate_material_bytes(data: bytes, spec: PublicMaterial) -> None:
    if len(data) != spec.size_bytes:
        raise ValueError("Public material size mismatch; previous release retained")
    signatures = {
        "application/pdf": data.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"%PDF-"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
        "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
        "image/avif": len(data) >= 16 and data[4:8] == b"ftyp" and b"avif" in data[8:32],
        "image/bmp": data.startswith(b"BM"),
        "image/tiff": data.startswith((b"II*\x00", b"MM\x00*")),
    }
    if not signatures.get(spec.content_type, False):
        raise ValueError("Public material signature does not match its type; previous release retained")


def mirror_case_materials(case: dict[str, Any], api_base: str, destination: Path, previous: Path | None = None) -> None:
    """Mirror public files into staging; an incomplete set never becomes live.

    The API supplies no content digest. Its case updated_at and exact public
    file metadata identify a source version; our own stored SHA-256 verifies
    reused local bytes. An unchanged release exits before any downloads. A
    changed source case refreshes only that case's files, not the catalogue.
    """
    files = [item for item in case.get("published_materials") or [] if item.get("kind") == "file"]
    if not files:
        return
    material_dir = destination / "materials"
    material_dir.mkdir()
    previous_dir = previous / "cases" / case["public_slug"] / "materials" if previous else None
    cached_items: dict[int, dict[str, Any]] = {}
    if previous_dir and previous_dir.is_dir() and not previous_dir.is_symlink():
        manifest_path = previous_dir / "manifest.json"
        try:
            if manifest_path.is_symlink() or manifest_path.stat().st_size > 2 * 1024 * 1024:
                raise ValueError("Invalid local material manifest")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("version") == 1 and isinstance(manifest.get("items"), list):
                cached_items = {
                    item["id"]: item for item in manifest["items"]
                    if isinstance(item, dict) and isinstance(item.get("id"), int)
                }
        except (OSError, ValueError, TypeError, AttributeError):
            cached_items = {}
    manifest_items = []
    seen: set[int] = set()
    for item in files:
        spec = public_material_spec(case, item)
        if spec.material_id in seen:
            raise ValueError("Duplicate public case material id")
        seen.add(spec.material_id)
        url = public_material_url(case, spec, api_base)
        cached = cached_items.get(spec.material_id) or {}
        data: bytes | None = None
        if (
            case.get("updated_at") and previous_dir
            and cached.get("fingerprint") == spec.fingerprint
            and cached.get("filename") == spec.filename
            and cached.get("size_bytes") == spec.size_bytes
            and cached.get("content_type") == spec.content_type
            and re.fullmatch(r"[0-9a-f]{64}", str(cached.get("sha256") or ""))
        ):
            cached_path = previous_dir / spec.filename
            if cached_path.is_file() and not cached_path.is_symlink():
                with cached_path.open("rb") as cached_file:
                    candidate = cached_file.read(spec.size_bytes + 1)
                if len(candidate) == spec.size_bytes and hashlib.sha256(candidate).hexdigest() == cached["sha256"]:
                    validate_material_bytes(candidate, spec)
                    data = candidate
        if data is None:
            with open_public_material(url) as response:
                final = urllib.parse.urlsplit(response.url)
                expected = urllib.parse.urlsplit(url)
                if (final.scheme, final.netloc, final.path) != (expected.scheme, expected.netloc, expected.path):
                    raise ValueError("Unexpected public material redirect")
                if getattr(response, "status", 200) != 200:
                    raise ValueError("Public material download did not return HTTP 200")
                headers = getattr(response, "headers", {})
                content_type = str(headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()
                if content_type and content_type not in {spec.content_type, "application/octet-stream"}:
                    raise ValueError("Unexpected public material HTTP content type")
                data = response.read(spec.size_bytes + 1)
            validate_material_bytes(data, spec)
        (material_dir / spec.filename).write_bytes(data)
        manifest_items.append({
            "id": spec.material_id,
            "fingerprint": spec.fingerprint,
            "filename": spec.filename,
            "size_bytes": spec.size_bytes,
            "sha256": hashlib.sha256(data).hexdigest(),
            "content_type": spec.content_type,
        })
    (material_dir / "manifest.json").write_text(
        json.dumps({"version": 1, "items": manifest_items}, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def material_tree(materials: list[dict[str, Any]], api_base: str, case: dict[str, Any] | None = None) -> str:
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
                if case is None:
                    raise ValueError("A case is required for local public material URLs")
                url = material_local_url(case, item)
                rows.append(
                    f'<li class="case-file"><a href="{escape(url)}" data-case-open-material="{escape(item_id)}"><span>{"PDF" if item.get("media_kind") == "pdf" else "IMG"}</span><b>{escape(item.get("name") or "Материал")}</b></a></li>'
                )
        return "".join(rows)

    return f'<ul class="case-material-tree">{walk(None, set())}</ul>'


def render_materials(case: dict[str, Any], api_base: str, section_number: str = "04") -> str:
    materials = case.get("published_materials") or []
    files = [item for item in materials if item.get("kind") == "file" and item.get("content_url")]
    files.sort(key=material_display_key)
    if not files:
        return ""
    slides = []
    for index, item in enumerate(files):
        inline_url = material_local_url(case, item)
        download_url = inline_url
        viewer = (
            f'<img data-case-lazy-src="{escape(inline_url)}" alt="{escape(item.get("name") or "Материал дела")}">'
            if item.get("media_kind") == "image"
            else f'<iframe data-case-lazy-src="{escape(inline_url)}" title="{escape(item.get("name") or "Судебный акт")}" loading="lazy"></iframe>'
        )
        slides.append(f"""
          <article class="case-material-slide" data-case-slide data-material-id="{escape(item.get('id'))}" {'hidden' if index else ''}>
            <header><div><small>{escape(item.get('path') or 'Материалы дела')}</small><strong>{escape(item.get('name') or 'Документ')}</strong></div><div><a href="{escape(inline_url)}" target="_blank" rel="noopener">Открыть</a><a href="{escape(download_url)}" download="{escape(item.get('name') or public_material_spec(case, item).filename)}">Скачать</a></div></header>
            <div class="case-material-viewer case-material-viewer--{escape(item.get('media_kind') or 'pdf')}">{viewer}</div>
          </article>""")
    return f"""
      <section class="case-section case-materials" id="materials">
        <div class="case-section__label"><span>{escape(section_number)}</span><p>Документы</p></div>
        <div class="case-section__content"><p class="cases-eyebrow">Материалы дела</p><h2>Решения и подтверждения</h2>
          <div class="case-materials-layout" data-case-carousel>
            <aside><div><strong>Состав дела</strong><span>{len(files)} {plural_documents(len(files))}</span></div>{material_tree(materials, api_base, case)}</aside>
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
                    ("Успешный опыт", f"{SITE_ORIGIN}/cases/"),
                    (str(case.get("public_title") or "История дела"), canonical),
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
    illustration = render_illustration(case)
    intro = f'<div class="case-hero__intro">{illustration}<p>{escape(summary)}</p></div>' if illustration else f'<p>{escape(summary)}</p>'
    story = render_case_story(case)
    metrics = render_metrics(case)
    strategy = safe_rich(case.get("strategy_html"))
    result = safe_rich(case.get("result_html"))
    significance = safe_rich(case.get("significance_html"))
    project_cost_section = render_project_costs(case, "03")
    economics_number = "04" if project_cost_section else "03"
    economics_section = render_economics(case, economics_number)
    materials_number = f"{3 + int(bool(project_cost_section)) + int(bool(economics_section)):02d}"
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
        <div class="case-section__content"><p class="cases-eyebrow">Задача и решение</p><h2>За сухими формулировками<br>стоит работа команды</h2>{story}{f'<div class="case-overview__grid">{overview_sections}</div>' if overview_sections else ''}</div>
      </section>"""
    content = f"""
    <main class="case-page" data-case-detail>
      <nav class="case-breadcrumbs" aria-label="Навигационная цепочка"><a href="/">Главная</a><span>·</span><a href="/cases/">Успешный опыт</a><span>·</span><b>{escape(category)}</b></nav>
      <article>
        <header class="case-hero">
          <div class="case-hero__copy"><div class="case-hero__meta"><span class="case-outcome case-outcome--{escape(case.get('outcome_kind') or 'other')}">{escape(outcome_label(case.get('outcome_kind')))}</span><span>{escape(category)}</span>{f'<span>Дело № {escape(case.get("court_case_number"))}</span>' if case.get('court_case_number') else ''}</div><h1>{escape(title)}</h1>{intro}<div class="case-hero__footer"><div class="case-hero__dates"><time datetime="{escape(case.get('document_date') or '')}">Анонс от {escape(ru_date(case.get('document_date')))}</time>{f'<span>Период спора: {escape(period)}</span>' if period else ''}</div>{materials_link}</div></div>
        </header>
        {f'<section class="case-metrics-strip">{metrics}</section>' if metrics else ''}
        <nav class="case-anchor-nav" aria-label="Содержание истории дела"><a href="#overview">Суть дела</a>{'<a href="#history">История</a>' if case.get('stages') else ''}{'<a href="#project-cost">Стоимость проекта</a>' if project_cost_section else ''}{'<a href="#economics">Имущественный эффект</a>' if economics_section else ''}{f'<a class="case-anchor-nav__materials" href="#materials">Судебные акты · {len(published_files)}</a>' if published_files else ''}</nav>
        {overview}
        {render_stages(case)}
        {project_cost_section}
        {economics_section}
        {render_materials(case, api_base, materials_number)}
      </article>
      <section class="case-disclaimer"><strong>Важно</strong><p>Опубликованный результат относится к конкретным обстоятельствам дела и не гарантирует такой же исход в другой ситуации. Для правовой оценки нужны документы и фактический контекст.</p></section>
      <section class="cases-contact cases-contact--detail"><div><p class="cases-eyebrow">Есть похожая задача?</p><h2>Разберём факты до того, как они станут риском.</h2><p>Свяжитесь с юристом и расскажите, на какой стадии находится спор.</p></div><div><a href="tel:+74958221920">+7 (495) 822-19-20</a><a class="cases-contact__button" href="mailto:mail@elegso.ru">Написать юристу</a></div></section>
      <a class="case-back-link" href="/cases/">← Успешный опыт</a>
    </main>"""
    return render_page(
        chrome,
        title=str(case.get("seo_title") or f"{title} — дело из практики юридической компании «ЭЛЕГСО»"),
        description=description,
        canonical=canonical,
        schema=detail_schema(case, description),
        article=True,
        alias=f"case-{case['public_slug']}",
        content=content,
    )


def illustration_filename(case: dict[str, Any]) -> str | None:
    image = case.get("illustration")
    if not image:
        return None
    extensions = {"image/webp": "webp", "image/png": "png", "image/jpeg": "jpg"}
    digest = str(image.get("sha256") or "")
    extension = extensions.get(image.get("content_type"))
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or not extension:
        raise ValueError("Invalid case illustration metadata")
    return f"illustration-{digest}.{extension}"


def case_illustration_url(case: dict[str, Any]) -> str | None:
    """Public URL of the exact ERP original mirrored in this case release."""
    filename = illustration_filename(case)
    return f"/cases/{case['public_slug']}/{filename}" if filename else None


def render_illustration(case: dict[str, Any]) -> str:
    href = case_illustration_url(case)
    if not href:
        return ""
    alt = case["illustration"].get("illustration_alt") or case.get("public_title") or "Иллюстрация дела"
    return (f'<figure class="case-illustration"><a href="{escape(href)}" target="_blank" rel="noopener" title="Открыть оригинал">'
        f'<img src="{escape(href)}" alt="{escape(alt)}" decoding="async"></a></figure>')


def download_illustration(case: dict[str, Any], api_base: str, destination: Path, previous: Path | None = None) -> None:
    filename = illustration_filename(case)
    if not filename:
        return
    image = case["illustration"]
    expected_size = int(image.get("size_bytes") or 0)
    if not 0 < expected_size <= 32 * 1024 * 1024:
        raise ValueError("Invalid case illustration size")
    cached = previous / "cases" / case["public_slug"] / filename if previous else None
    if cached and cached.is_file():
        data = cached.read_bytes()
    else:
        origin = urllib.parse.urlsplit(api_base)
        path = f"{origin.path.rstrip('/')}/{case['public_slug']}/illustration"
        url = urllib.parse.urljoin(api_base, str(image.get("content_url") or ""))
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme, parsed.netloc, parsed.path) != (origin.scheme, origin.netloc, path):
            raise ValueError("Illustration URL is outside the public case API")
        request = urllib.request.Request(url, headers={"User-Agent": "ElegsoCasePublisher/1.0"})
        with urllib.request.urlopen(request, timeout=45) as response:
            final = urllib.parse.urlsplit(response.url)
            if (final.scheme, final.netloc, final.path) != (origin.scheme, origin.netloc, path):
                raise ValueError("Unexpected illustration redirect")
            data = response.read(expected_size + 1)
    if len(data) != expected_size or hashlib.sha256(data).hexdigest() != image["sha256"]:
        raise ValueError("Illustration SHA-256 or size mismatch; previous release retained")
    (destination / filename).write_bytes(data)


def carousel_count(value: Any) -> int | None:
    """Keep typed, nonnegative counters in the public carousel payload."""
    if isinstance(value, bool) or value is None:
        return None
    raw = str(value)
    if not re.fullmatch(r"[0-9]+", raw):
        return None
    number = int(raw)
    return number if number <= 9007199254740991 else None


def render_carousel_feed(cases: list[dict[str, Any]]) -> dict[str, Any]:
    """An explicit public field allowlist; never expose raw ERP records."""
    items: list[dict[str, Any]] = []
    for case in validate_cases(cases):
        slug = str(case["public_slug"])
        title = first_text(case.get("public_title"), fallback="История дела")
        protected = decimal(case.get("protected_interest_amount"))
        currency = str(case.get("currency_code") or "RUB")
        duration = carousel_count(case.get("duration_days"))
        instances = carousel_count(case.get("court_instance_count"))
        illustration_url = case_illustration_url(case)
        illustration = (
            {
                "url": illustration_url,
                "alt": first_text(case["illustration"].get("illustration_alt"), title, fallback="Иллюстрация дела"),
            }
            if illustration_url else None
        )
        protected_label = (
            f"{case_card_money(protected)} ₽" if currency == "RUB"
            else re.sub(r"(?<=\d)\.(?=\d)", ",", money(protected, currency))
        ) if protected > 0 else ""
        document_date = case_document_date(case)
        items.append(
            {
                "code": first_text(case.get("code"), fallback=slug),
                "slug": slug,
                "url": f"/cases/{slug}/",
                "title": title,
                "excerpt": case_excerpt(case),
                "outcome_kind": str(case.get("outcome_kind") or "other"),
                "outcome_label": outcome_label(case.get("outcome_kind")),
                "document_date": document_date.isoformat() if document_date != date.min else None,
                "formatted_date": ru_date(case.get("document_date")),
                "case_number": first_text(case.get("court_case_number")),
                "category": first_text(case.get("case_category"), fallback="Юридическая практика"),
                "protected_interest_amount": format(protected, "f"),
                "protected_interest_label": protected_label,
                "duration_days": duration,
                "duration_label": f"{duration} дн." if duration is not None else "",
                "court_instance_count": instances,
                "illustration": illustration,
            }
        )
    return {"version": 1, "items": items}


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
    # The catalogue must reflect the chronology of the litigation, not the
    # chronology of publishing. ``document_date`` is also the date displayed
    # in the top-right corner of every card and represents the latest judicial
    # act entered for the case. Missing/invalid dates are deliberately last.
    return sorted(
        cases,
        key=lambda case: (
            -case_document_date(case).toordinal(),
            str(case.get("public_slug") or "").casefold(),
        ),
    )


def source_sitemap_path(source_root: Path) -> Path:
    base = source_root / "sitemap.base.xml"
    return base if base.exists() else source_root / "sitemap.xml"


def render_sitemap(source_root: Path, cases: list[dict[str, Any]]) -> str:
    sitemap_path = source_sitemap_path(source_root)
    existing = sitemap_path.read_text(encoding="utf-8") if sitemap_path.exists() else ""
    existing_urls = re.findall(r"<url>[\s\S]*?</url>", existing)
    rows = [row for row in existing_urls if not re.search(r"<loc>https://elegso\.ru/cases(?:/|<)", row)]
    legal = published_legal_sitemap(source_root)
    if legal:
        roots = set(legal["roots"])
        rows = [row for row in rows if not any(f"<loc>{SITE_ORIGIN}/{root}/" in row for root in roots)]
        rows.extend(legal["rows"])
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
    # The generated chrome inherits the source page's theme and static assets.
    # Include those inputs so a design-only update also invalidates the case
    # projection even when the ERP records did not change.
    theme_inputs = [
        source_root / "assets" / "cases.css",
        source_root / "assets" / "cases.js",
        source_root / "assets" / "site-fonts.css",
    ]
    redesign_assets = source_root / "assets" / "redesign"
    if redesign_assets.is_dir() and not redesign_assets.is_symlink():
        theme_inputs.extend(sorted(redesign_assets.rglob("*")))
    for asset in theme_inputs:
        if asset.is_file() and not asset.is_symlink():
            digest.update(asset.relative_to(source_root).as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(asset.read_bytes())
    sitemap = source_sitemap_path(source_root)
    if sitemap.exists():
        digest.update(sitemap.read_bytes())
    digest.update(json.dumps(published_legal_sitemap(source_root), sort_keys=True).encode())
    digest.update(json.dumps(cases, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return digest.hexdigest()


def published_legal_sitemap(source_root: Path) -> dict[str, Any] | None:
    # In production source_root is <release>/www; tests/local trees need no
    # access to the production projection. This file contains public URLs only.
    override = os.environ.get("LEGAL_SITEMAP_MANIFEST")
    path = Path(override) if override else Path("/srv/www/elegso.ru/generated-legal/current/sitemap-legal.json")
    if not override and not str(source_root).startswith("/srv/www/elegso.ru/"):
        return None
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    allowed = {"oferta", "oferta-fiz", "soglashenie", "consent", "cookies", "documents", "offer_for_lawyer_20231103"}
    if not isinstance(value, dict) or set(value.get("roots", [])) != allowed or not isinstance(value.get("rows"), list):
        raise ValueError("Invalid published legal sitemap manifest")
    for row in value["rows"]:
        if not isinstance(row, str) or not re.fullmatch(r"<url>[\s\S]*</url>", row) or not any(f"<loc>{SITE_ORIGIN}/{root}/" in row for root in allowed):
            raise ValueError("Invalid legal sitemap row")
    return value


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
    # Forced rebuilds are immutable too: never delete the directory currently
    # served by Nginx. Recognise its full digest even when it has a unique
    # rebuild suffix, so the next timer does not revert to an older copy.
    if current.is_symlink() and not force:
        active = current.resolve()
        try:
            manifest_path = active / "manifest.json"
            if active.parent == releases.resolve() and manifest_path.stat().st_size <= 2 * 1024 * 1024:
                active_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if active_manifest.get("content_digest") == digest:
                    return False, releases / active.name
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    if force and release.exists():
        release = releases / f"{digest[:16]}-rebuild-{os.urandom(6).hex()}"
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
                download_illustration(case, api_base, destination, current.resolve() if current.is_symlink() else None)
                mirror_case_materials(case, api_base, destination, current.resolve() if current.is_symlink() else None)
                (destination / "index.html").write_text(
                    render_detail(chrome, case, api_base), encoding="utf-8"
                )
            # Feed, pages, exact ERP illustrations and all public documents share the same
            # temporary release and become visible in one current-link switch.
            # A failed download/check never exposes a partial static projection.
            (cases_dir / "carousel.json").write_text(
                json.dumps(render_carousel_feed(cases), ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c") + "\n",
                encoding="utf-8",
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
                raise FileExistsError("Refusing to overwrite an immutable case release")
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
