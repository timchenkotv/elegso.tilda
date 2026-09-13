#!/usr/bin/env node
/** Static, versioned offers. Legal content is authored in content/offers, never here. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = path.resolve(rootArg < 0 ? path.join(import.meta.dirname, '..') : args[rootArg + 1] || '');
const knownArgs = new Set(['--seal', '--preview-unsealed', '--root']);
for (let i = 0; i < args.length; i++) {
  if (!knownArgs.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] === '--root') { if (!args[++i]) throw new Error('--root requires a directory'); }
}
const seal = args.includes('--seal');
const preview = args.includes('--preview-unsealed');
if (seal && preview) throw new Error('--seal and --preview-unsealed are mutually exclusive');
const web = path.join(root, 'www');
const registryPath = path.join(root, 'config/offer-version-hashes.json');
const config = JSON.parse(await fs.readFile(path.join(root, 'config/offers.json'), 'utf8'));
const esc = (s = '') => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
const sha = value => createHash('sha256').update(stable(value)).digest('hex');
const versionPattern = /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/;
const routePattern = /^\/(?:[a-z0-9_-]+\/)+$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = value => typeof value === 'string' && dayPattern.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const date = value => new Date(`${value}T12:00:00+03:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
const documentIcon = '<svg viewBox="0 0 32 36" fill="none" aria-hidden="true" focusable="false"><path d="M6 2h13l7 7v24H6z" stroke="currentColor" stroke-width="1.5"/><path d="M19 2v8h7M11 16h10M11 21h10M11 26h6" stroke="currentColor" stroke-width="1.5"/></svg>';
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(config.schemaVersion === 1 && config.origin === 'https://elegso.ru', 'Unsupported offers config/origin');
assert(config.publisher?.name && config.publisher?.brand && /^\/(?!\/)/.test(config.publisher?.logo || ''), 'Incomplete publisher');
assert(Array.isArray(config.offers) && config.offers.length === 2, 'Exactly two audience offers must be configured');
assert(new Set(config.offers.map(item => item.id)).size === config.offers.length, 'Duplicate offer IDs');
assert(config.offers.some(item => item.id === 'business') && config.offers.some(item => item.id === 'individual'), 'Both business and individual offers are required');
assert(new Set(config.offers.flatMap(item => [item.url, item.historyUrl])).size === config.offers.length * 2, 'Duplicate offer routes');
const origin = config.origin;
let registry;
try { registry = JSON.parse(await fs.readFile(registryPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; registry = { schemaVersion: 1, algorithm: 'sha256', versions: [] }; }
assert(registry.schemaVersion === 1 && registry.algorithm === 'sha256' && Array.isArray(registry.versions), 'Unsupported version integrity registry');
const sealed = new Map();
for (const entry of registry.versions) {
  const key = `${entry.id}/${entry.version}`;
  assert(!sealed.has(key) && /^[a-f0-9]{64}$/.test(entry.sha256), `Invalid or duplicate sealed version: ${key}`);
  sealed.set(key, entry);
}

function validateDocument(document, offer, filename) {
  const ref = `${offer.id}/${filename}`;
  assert(document.id === offer.id && versionPattern.test(document.version || '') && filename === `${document.version}.json`, `Invalid version identity: ${ref}`);
  for (const field of ['title', 'description', 'audience', 'lead']) assert(typeof document[field] === 'string' && document[field].trim(), `Missing ${field}: ${ref}`);
  for (const field of ['revisionDate', 'effectiveDate']) assert(isoDay(document[field]), `Invalid ${field}: ${ref}`);
  assert(typeof document.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(document.publishedAt) && Number.isFinite(Date.parse(document.publishedAt)), `Invalid publishedAt: ${ref}`);
  if (document.baseApprovalDate != null) assert(isoDay(document.baseApprovalDate), `Invalid baseApprovalDate: ${ref}`);
  assert(Array.isArray(document.sections) && document.sections.length, `Empty offer: ${ref}`);
  const ids = new Set();
  const numbers = new Set();
  for (const section of document.sections) {
    assert(/^[a-z][a-z0-9-]*$/.test(section.id || '') && !ids.has(section.id), `Invalid or duplicate section: ${ref}`);
    ids.add(section.id);
    assert(typeof section.title === 'string' && section.title.trim() && Array.isArray(section.clauses) && section.clauses.length, `Empty section: ${ref}/${section.id}`);
    for (const clause of section.clauses) {
      assert(/^\d+(?:\.\d+)+\.?$/.test(clause.number || '') && !numbers.has(clause.number), `Invalid or duplicate clause: ${ref}/${clause.number}`);
      numbers.add(clause.number);
      assert(typeof clause.html === 'string' && clause.html.trim(), `Empty clause: ${ref}/${clause.number}`);
      // Text is trusted local legal prose, but active document elements are never appropriate here.
      assert(!/<\s*\/?\s*(?:script|style|iframe|object|embed|form|input|button|textarea|select|html|head|body)\b|\bon[a-z]+\s*=|(?:javascript|data|vbscript)\s*:/i.test(clause.html), `Active HTML is forbidden: ${ref}/${clause.number}`);
      for (const match of clause.html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
        const link = match[1];
        assert(/^(?:\/(?!\/)|#|https:\/\/|mailto:|tel:)/.test(link), `Unsupported relative link in ${ref}: ${link}`);
        assert(!link.startsWith(origin + '/'), `Internal links must be root-relative in ${ref}: ${link}`);
      }
    }
  }
}

const offers = [];
const allKeys = new Set();
let newlySealed = 0;
for (const offer of config.offers) {
  assert(/^[a-z][a-z0-9-]*$/.test(offer.id || '') && routePattern.test(offer.url || '') && offer.historyUrl === `${offer.url}history/` && versionPattern.test(offer.currentVersion || ''), 'Invalid offer route or current version');
  assert(offer.url === (offer.id === 'business' ? '/oferta/' : '/oferta-fiz/'), 'Published offer routes are permanent; do not move version archives');
  const directory = path.join(root, 'content/offers', offer.id);
  const filenames = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const versions = [];
  for (const filename of filenames) {
    const document = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
    validateDocument(document, offer, filename);
    const key = `${offer.id}/${document.version}`;
    allKeys.add(key);
    const hash = sha(document);
    const prior = sealed.get(key);
    if (prior) assert(prior.sha256 === hash, `IMMUTABLE VERSION CHANGED: ${key}. Create a new version; do not alter an already published document.`);
    else if (seal) {
      const entry = { id: offer.id, version: document.version, sha256: hash, sealedAt: new Date().toISOString() };
      registry.versions.push(entry);
      sealed.set(key, entry);
      newlySealed++;
    } else assert(preview, `Unsealed version: ${key}. Review the document and run --seal before publication (or --preview-unsealed for local QA only).`);
    versions.push({ ...document, hash, url: `${offer.url}versions/${document.version}/` });
  }
  assert(versions.some(document => document.version === offer.currentVersion), `Current version missing: ${offer.id}/${offer.currentVersion}`);
  versions.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    || b.version.localeCompare(a.version, 'en', { numeric: true }));
  offers.push({ ...offer, versions, current: versions.find(document => document.version === offer.currentVersion) });
}
for (const key of sealed.keys()) assert(allKeys.has(key), `SEALED VERSION DELETED: ${key}. Published versions must remain available.`);

const footerMarker = /<!--elegso-offers-footer:start-->[\s\S]*?<!--elegso-offers-footer:end-->/g;
function footerLinks() {
  return `<!--elegso-offers-footer:start--><div class="r t-rec" data-elegso-offers-footer><style>
#t-footer .eo-footer{box-sizing:border-box;width:min(1160px,calc(100% - 40px));display:flex;align-items:center;justify-content:space-between;gap:18px 32px;flex-wrap:wrap;margin:0 auto 30px;padding:21px 24px;border:1px solid rgba(53,90,86,.25);border-radius:6px;background:#f4efe6;color:#203f3c;font:14px/1.5 Ubuntu,Arial,sans-serif}#t-footer .eo-footer__label{display:flex;align-items:center;gap:13px;font-weight:500}#t-footer .eo-footer svg{width:24px;height:28px;flex:none;color:#a04b38}#t-footer .eo-footer__links{display:flex;flex-wrap:wrap;gap:12px 24px}#t-footer .eo-footer a{color:#355a56!important;text-decoration:underline!important;text-underline-offset:4px;text-decoration-color:#9cafa5!important}#t-footer .eo-footer a:hover{color:#a04b38!important}#t-footer .eo-footer a:focus-visible{outline:2px solid #a04b38;outline-offset:5px}@media(max-width:640px){#t-footer .eo-footer{padding:18px;gap:16px}#t-footer .eo-footer__links{flex-direction:column;gap:12px}}@media print{[data-elegso-offers-footer]{display:none!important}}
</style><nav class="eo-footer" aria-label="Условия оказания юридических услуг"><span class="eo-footer__label">${documentIcon}Условия сотрудничества</span><span class="eo-footer__links">${offers.map(offer => `<a href="${offer.url}">${offer.id === 'business' ? 'Оферта для бизнеса' : 'Оферта для физических лиц'}</a>`).join('')}</span></nav></div><!--elegso-offers-footer:end-->`;
}
function applyFooter(html) {
  html = html.replaceAll(
    'Любая информация на сайте не является публичной офертой.',
    'Информационные материалы сайта не являются публичной офертой. Условия заключения договоров приведены в соответствующих офертах.',
  );
  const card = footerLinks();
  if (html.includes('<!--elegso-offers-footer:start-->')) return html.replace(footerMarker, card);
  if (html.includes('<div id="rec1169591771"')) return html.replace('<div id="rec1169591771"', `${card}\n<div id="rec1169591771"`);
  if (html.includes('id="t-footer"')) return html.replace(/<\/footer>/i, `${card}</footer>`);
  return html;
}

const template = applyFooter(await fs.readFile(path.join(web, 'mission/index.html'), 'utf8'));
const bodyStart = template.search(/<body\b/i);
const headerStart = template.indexOf('<!--header-->');
const headerEnd = template.indexOf('</header>', headerStart) + 9;
const footerStart = template.indexOf('<!--footer-->', headerEnd);
assert(bodyStart >= 0 && headerStart >= 0 && headerEnd > headerStart && footerStart > headerEnd, 'Site header/footer template markers missing');
const header = template.slice(headerStart, headerEnd);
const tail = template.slice(footerStart);
const assetVersion = createHash('sha256').update(await fs.readFile(path.join(web, 'assets/offers.css'))).update(await fs.readFile(path.join(web, 'assets/offers.js'))).digest('hex').slice(0, 12);

function meta(head, attribute, name, value) {
  const tag = `<meta ${attribute}="${name}" content="${esc(value)}">`;
  const expression = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${name}["'])[^>]*>`, 'gi');
  return expression.test(head) ? head.replace(expression, tag) : head.replace('</head>', `${tag}\n</head>`);
}
function shell({ title, description, url, body, document, archived = false, history = false, offer }) {
  let head = template.slice(0, bodyStart)
    .replace(/<html\b/i, '<html data-elegso-offers-document')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`)
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b(?=[^>]*rel=["']canonical["'])[^>]*>/gi, '')
    .replace(/<link\b(?=[^>]*href=["']\/assets\/offers\.css)[^>]*>/gi, '')
    .replace(/<script\b[^>]*src=["']\/assets\/offers\.js[^"']*["'][^>]*><\/script>/gi, '')
    .replace(/<meta\b(?=[^>]*property=["']article:[^"']*["'])[^>]*>/gi, '');
  for (const [attribute, name, value] of [
    ['name', 'description', description], ['name', 'robots', archived ? 'noindex, follow' : 'index, follow, max-image-preview:large, max-snippet:-1'],
    ['property', 'og:title', title], ['property', 'og:description', description], ['property', 'og:url', origin + url],
    ['property', 'og:type', 'website'], ['property', 'og:image', origin + config.publisher.logo], ['property', 'og:locale', 'ru_RU'],
    ['name', 'twitter:card', 'summary'],
  ]) head = meta(head, attribute, name, value);
  const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Главная', item: origin + '/' }, { '@type': 'ListItem', position: 2, name: offer.id === 'business' ? 'Оферта для бизнеса' : 'Оферта для физических лиц', item: origin + offer.url }];
  if (history || archived) crumbs.push({ '@type': 'ListItem', position: 3, name: history ? 'История редакций' : `Редакция ${document.version}`, item: origin + url });
  const page = { '@type': history ? 'CollectionPage' : 'WebPage', '@id': origin + url + '#webpage', url: origin + url, name: title, description, inLanguage: 'ru-RU', isPartOf: { '@id': origin + '/#website' }, datePublished: document.publishedAt, dateModified: document.publishedAt };
  if (!history) page.mainEntity = { '@type': 'DigitalDocument', name: document.title, version: document.version, datePublished: document.publishedAt, dateModified: document.publishedAt, inLanguage: 'ru-RU', url: origin + document.url, encodingFormat: 'text/html', publisher: { '@id': origin + '/#organization' } };
  const graph = [{ '@type': 'Organization', '@id': origin + '/#organization', name: config.publisher.name, url: origin + '/', logo: origin + config.publisher.logo }, { '@type': 'WebSite', '@id': origin + '/#website', name: config.publisher.brand, url: origin + '/' }, page, { '@type': 'BreadcrumbList', itemListElement: crumbs }];
  head = head.replace('</head>', `<link rel="canonical" href="${origin}${url}"><link rel="stylesheet" href="/assets/offers.css?v=${assetVersion}"><script src="/assets/offers.js?v=${assetVersion}" defer></script><script type="application/ld+json" data-elegso-offers-schema>${json({ '@context': 'https://schema.org', '@graph': graph })}</script></head>`);
  return (head + `<body class="t-body elegso-offers-page" style="margin:0"><a class="eo-skip" href="#offer-content">К тексту оферты</a><div id="allrecords" class="t-records" data-tilda-project-id="3964517" data-tilda-lazy="yes" data-tilda-root-zone="com">${header}${body}${tail}`).replace(/[ \t]+$/gm, '');
}
function audienceSwitch(offer) {
  return `<nav class="eo-audiences" aria-label="Для кого предназначена оферта">${offers.map(item => `<a href="${item.url}"${item.id === offer.id ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`).join('')}</nav>`;
}
function crumbs(offer, suffix = '') {
  return `<nav class="eo-crumbs" aria-label="Хлебные крошки"><a href="/">Главная</a><span aria-hidden="true">/</span>${suffix ? `<a href="${offer.url}">${offer.id === 'business' ? 'Оферта для бизнеса' : 'Оферта для физических лиц'}</a><span aria-hidden="true">/</span><span>${esc(suffix)}</span>` : `<span>${offer.id === 'business' ? 'Оферта для бизнеса' : 'Оферта для физических лиц'}</span>`}</nav>`;
}
function documentBody(offer, document, archived) {
  const isCurrent = offer.currentVersion === document.version;
  const actualPublication = new Date(document.publishedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
  return `<main class="eo-main" id="offer-content" data-offer-id="${offer.id}" data-offer-version="${document.version}" data-offer-sha256="${document.hash}">
  <div class="eo-progress" aria-hidden="true"><i data-eo-progress></i></div><div class="eo-wrap">
  ${crumbs(offer, archived ? `Редакция ${document.version}` : '')}${audienceSwitch(offer)}
  <header class="eo-hero"><div class="eo-hero__copy"><p class="eo-kicker">Юридическая компания «ЭЛЕГСО»</p><h1>${esc(document.title)}</h1><p class="eo-lead">${esc(document.lead)}</p></div><div class="eo-hero__seal" aria-hidden="true">${documentIcon}<span>Условия<br>сотрудничества</span></div></header>
  ${preview ? '<aside class="eo-notice eo-notice--preview" role="status">Предварительный просмотр: редакция ещё не закреплена в реестре. Не использовать эту сборку для публикации.</aside>' : ''}
  ${archived ? `<aside class="eo-notice"><strong>Неизменяемая копия редакции ${esc(document.version)}</strong><p>${isCurrent ? 'Эта редакция сейчас указана как действующая.' : 'Это архивная редакция. Она сохранена для проверки условий, относящихся к конкретному договору.'} <a href="${offer.url}">Открыть текущую оферту</a> или <a href="${offer.historyUrl}">посмотреть историю</a>. Действующая редакция определяется условиями заключённого договора, а не только датой просмотра сайта.</p></aside>` : ''}
  ${document.notice ? `<aside class="eo-notice"><p>${esc(document.notice)}</p></aside>` : ''}
  <div class="eo-document-meta"><div><span>Редакция</span><strong>${esc(document.version)}</strong></div><div><span>Опубликована</span><strong>${esc(actualPublication)}</strong></div><div><span>Вступает в силу</span><strong>${esc(date(document.effectiveDate))}</strong></div><div><span>Кому адресована</span><strong>${esc(document.audience)}</strong></div></div>
  ${document.baseApprovalDate ? `<p class="eo-base-date">Дата утверждения базового документа: ${esc(date(document.baseApprovalDate))}. Дата публикации и вступления в силу настоящей редакции указана выше.</p>` : ''}
  <div class="eo-actions"><button type="button" class="eo-button" data-eo-print hidden>${documentIcon}<span>Печать</span></button><a class="eo-link" href="${offer.historyUrl}">История редакций <span aria-hidden="true">↗</span></a>${!archived ? `<a class="eo-link" href="${document.url}">Постоянная ссылка на редакцию</a>` : ''}<p>Распечатайте договор кнопкой „Печать“ или через меню браузера. В печатный вид входит полный текст выбранной редакции без меню и подвала сайта.</p></div>
  <div class="eo-reading"><aside class="eo-toc"><details open><summary>Содержание оферты</summary><nav aria-label="Разделы оферты">${document.sections.map((section, index) => `<a href="#${section.id}"><span>${String(index + 1).padStart(2, '0')}</span>${esc(section.title.replace(/^\d+\.\s*/, ''))}</a>`).join('')}</nav></details></aside>
  <article class="eo-document"><div class="eo-print-identity"><img src="${esc(config.publisher.logo)}" width="166" height="48" alt="Юридическая компания ЭЛЕГСО"><p>${esc(config.publisher.name)}</p></div>
  <div class="eo-print-heading"><h2>${esc(document.title)}</h2><p>Редакция ${esc(document.version)} · Опубликована ${esc(actualPublication)} · Вступает в силу ${esc(date(document.effectiveDate))}</p><p>${esc(document.audience)}. Постоянный адрес: ${origin}${document.url}</p></div>
  ${document.sections.map(section => `<section id="${section.id}" data-eo-section><h2>${esc(section.title)}</h2>${section.clauses.map(clause => `<div class="eo-clause" id="clause-${clause.number.replaceAll('.', '-')}"><span class="eo-clause__number">${esc(clause.number)}</span><div class="eo-clause__text">${clause.html}</div></div>`).join('')}</section>`).join('')}
  <footer class="eo-document-proof"><p><strong>Идентификатор редакции:</strong> ${esc(offer.id)}/${esc(document.version)}</p><p><strong>Постоянный адрес:</strong> <a href="${document.url}">${origin}${document.url}</a></p><p class="eo-hash"><strong>Контрольная сумма текста и реквизитов редакции (SHA-256):</strong> <span>${document.hash}</span></p><p class="eo-proof-note">Контрольная сумма позволяет проверить неизменность исходного содержания редакции. Она не является электронной подписью или независимым подтверждением времени публикации.</p></footer>
  </article></div><div class="eo-bottom"><a href="${offer.historyUrl}">Все редакции оферты <span aria-hidden="true">↗</span></a><a href="/contacts/">Задать вопрос об условиях</a></div></div></main>`;
}
function historyBody(offer) {
  return `<main class="eo-main eo-history" id="offer-content"><div class="eo-wrap">${crumbs(offer, 'История редакций')}${audienceSwitch(offer)}<header class="eo-hero"><div class="eo-hero__copy"><p class="eo-kicker">Открытый архив условий</p><h1>История редакций оферты</h1><p class="eo-lead">${esc(offer.label)}. Здесь сохраняются редакции договора, их даты и постоянные ссылки. Старые тексты не заменяются новыми: каждое изменение публикуется отдельной редакцией.</p></div><div class="eo-hero__seal" aria-hidden="true">${documentIcon}<span>Версии<br>и даты</span></div></header><aside class="eo-notice"><p>По <a href="${offer.url}">основной ссылке</a> всегда доступна текущая редакция. Применимость изменений к ранее заключённому договору определяется самим договором и законом. Новая публикация сама по себе не означает замену условий уже согласованного задания.</p></aside><div class="eo-version-list">${offer.versions.map(document => `<article class="eo-version"><div class="eo-version__top"><span class="eo-version__status${document.version === offer.currentVersion ? ' eo-version__status--current' : ''}">${document.version === offer.currentVersion ? 'Текущая редакция' : 'Архивная редакция'}</span><time datetime="${document.revisionDate}">${esc(date(document.revisionDate))}</time></div><h2><a href="${document.url}">Редакция ${esc(document.version)} <span aria-hidden="true">↗</span></a></h2><p>${esc(document.description)}</p><dl><div><dt>Вступает в силу</dt><dd>${esc(date(document.effectiveDate))}</dd></div><div><dt>Идентификатор</dt><dd>${esc(offer.id)}/${esc(document.version)}</dd></div></dl><a class="eo-link" href="${document.url}">Открыть текст и распечатать</a></article>`).join('')}</div><div class="eo-bottom"><a href="${offer.url}">← Текущая оферта</a><a href="/contacts/">Контакты компании</a></div></div></main>`;
}

const output = new Map();
for (const offer of offers) {
  const titleSuffix = offer.id === 'business' ? 'Оферта для бизнеса' : 'Оферта для физических лиц';
  output.set(offer.url, shell({ title: `${titleSuffix} — юридические услуги ЭЛЕГСО`, description: offer.current.description, url: offer.url, body: documentBody(offer, offer.current, false), document: offer.current, offer }));
  output.set(offer.historyUrl, shell({ title: `История редакций: ${titleSuffix.toLocaleLowerCase('ru')} — ЭЛЕГСО`, description: `История изменений условий юридических услуг ЭЛЕГСО. ${offer.label}: даты редакций, постоянные ссылки и сохранённые тексты оферты.`, url: offer.historyUrl, body: historyBody(offer), document: offer.current, history: true, offer }));
  for (const document of offer.versions) output.set(document.url, shell({ title: `${titleSuffix}: редакция ${document.version} — ЭЛЕГСО`, description: `${document.description} Сохранённая редакция ${document.version}.`, url: document.url, body: documentBody(offer, document, true), document, archived: true, offer }));
}

// Validate completely before touching generated pages or the integrity manifest.
for (const [route, html] of output) {
  assert((html.match(/<h1\b/gi) || []).length === 1, `Exactly one H1 required: ${route}`);
  assert((html.match(/<!--elegso-offers-footer:start-->/g) || []).length === 1, `Footer marker missing or duplicate: ${route}`);
}
if (seal && newlySealed) {
  registry.versions.sort((a, b) => `${a.id}/${a.version}`.localeCompare(`${b.id}/${b.version}`));
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}
for (const [route, html] of output) {
  const directory = path.join(web, route.slice(1));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'index.html'), html);
}
async function htmlFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['_external', 'api'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(filename));
    else if (entry.name.endsWith('.html')) files.push(filename);
  }
  return files;
}
let footerChanged = 0;
for (const filename of await htmlFiles(web)) {
  const before = await fs.readFile(filename, 'utf8');
  const after = applyFooter(before);
  if (before !== after) { await fs.writeFile(filename, after); footerChanged++; }
}
for (const name of ['sitemap.xml', 'sitemap.base.xml']) {
  const filename = path.join(web, name);
  let sitemap;
  try { sitemap = await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; if (name === 'sitemap.base.xml') continue; sitemap = ''; }
  const rows = [...sitemap.matchAll(/<url>[\s\S]*?<\/url>/g)].map(match => match[0]).filter(row => !offers.some(offer => row.includes(`<loc>${origin}${offer.url}`)));
  for (const offer of offers) {
    for (const url of [offer.url, offer.historyUrl]) rows.push(`<url><loc>${origin}${url}</loc><lastmod>${offer.current.publishedAt.slice(0, 10)}</lastmod></url>`);
  }
  await fs.writeFile(filename, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`);
}
console.log(JSON.stringify({ offers: offers.map(offer => ({ id: offer.id, url: offer.url, history: offer.historyUrl, currentVersion: offer.currentVersion, versions: offer.versions.length, sha256: offer.current.hash })), pages: output.size, footerChanged, newlySealed, previewUnsealed: preview }, null, 2));
