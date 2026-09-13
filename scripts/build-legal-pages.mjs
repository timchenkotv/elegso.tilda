#!/usr/bin/env node
/** Static public legal documents. Text lives only in content/legal/*.json. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { updateFooterCards } from './footer-cards.mjs';
import { applyPrivacyAnalytics, loadPrivacyBuild } from './privacy-analytics.mjs';

const origin = 'https://elegso.ru';
const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const date = value => new Date(`${value}T12:00:00+03:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
const icon = '<svg viewBox="0 0 32 36" fill="none" aria-hidden="true" focusable="false"><path d="M6 2h13l7 7v24H6zM19 2v8h7M11 16h10M11 21h10M11 26h6" stroke="currentColor" stroke-width="1.5"/></svg>';
const reservedRoutes = new Set(['/documents/', '/oferta/', '/oferta-fiz/', '/offer_for_lawyer_20231103/']);

export function validateLegalDocument(document) {
  assert(document && /^[a-z][a-z0-9-]*$/.test(document.id || ''), 'Invalid legal document id');
  assert(/^\/(?:[a-z0-9_-]+\/)+$/.test(document.url || '') && !reservedRoutes.has(document.url), `Invalid or reserved legal URL: ${document.url}`);
  assert(!/^\/(?:oferta|oferta-fiz)\//.test(document.url), 'Offer archives are not legal-page generator targets');
  for (const key of ['title', 'description']) assert(typeof document[key] === 'string' && document[key].trim(), `Missing legal ${key}`);
  assert(day(document.revisionDate), 'Invalid legal revisionDate');
  assert(Array.isArray(document.sections) && document.sections.length, 'Legal document has no sections');
  const ids = new Set(['legal-content']);
  const numbers = new Set();
  for (const section of document.sections) {
    assert(/^[a-z][a-z0-9-]*$/.test(section.id || '') && !ids.has(section.id) && !section.id.startsWith('clause-'), 'Invalid or duplicate legal section ID');
    ids.add(section.id);
    assert(typeof section.title === 'string' && section.title.trim() && Array.isArray(section.clauses) && section.clauses.length, 'Empty legal section');
    for (const clause of section.clauses) {
      assert(/^\d+(?:\.\d+)*\.?$/.test(clause.number || '') && !numbers.has(clause.number), 'Invalid or duplicate legal clause number');
      numbers.add(clause.number);
      assert(typeof clause.html === 'string' && clause.html.trim(), 'Empty legal clause');
      // Locally authored prose may contain links/lists/tables, never active UI.
      assert(!/<\s*\/?\s*(?:script|style|iframe|object|embed|form|input|button|textarea|select|html|head|body)\b|\bon[a-z]+\s*=|(?:javascript|data|vbscript)\s*:/i.test(clause.html), 'Active HTML is forbidden in legal clauses');
      for (const match of clause.html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
        assert(/^(?:\/(?!\/)|#|https:\/\/|mailto:|tel:)/.test(match[1]), `Unsupported legal link: ${match[1]}`);
        assert(!match[1].startsWith(origin + '/'), 'Internal legal links must be root-relative');
      }
    }
  }
  return document;
}

function breadcrumbs(label = '') {
  return `<nav class="eo-crumbs" aria-label="Хлебные крошки"><a href="/">Главная</a><span aria-hidden="true">/</span>${label ? `<a href="/documents/">Правовые документы</a><span aria-hidden="true">/</span><span>${esc(label)}</span>` : '<span>Правовые документы</span>'}</nav>`;
}

export function renderLegalBody(document, publisher, documents = [document]) {
  const title = esc(document.title);
  return `<main class="eo-main el-main" id="legal-content"><div class="eo-progress" aria-hidden="true"><i data-eo-progress></i></div><div class="eo-wrap">${breadcrumbs(document.title)}<div class="eo-hero el-hero${document.id === 'privacy' ? ' el-hero--art' : ''}"><div><p class="eo-kicker">Правовые документы · ${esc(publisher.brand)}</p><h1>${title}</h1><p class="el-revision">Редакция от <time datetime="${document.revisionDate}">${esc(date(document.revisionDate))}</time></p></div>${document.id === 'privacy' ? '<img class="el-privacy-art" src="/assets/publications/privacy-data-600.webp" alt="" width="96" height="96" decoding="async">' : ''}</div><div class="eo-actions el-actions"><button type="button" class="eo-button" data-eo-print hidden>${icon}Печать документа</button>${document.id === 'cookies' ? '<button type="button" class="eo-button el-cookie-button" data-elegso-cookie-settings>Настроить cookie</button>' : ''}<a class="eo-link" href="/documents/">Все правовые документы</a><p>Для сохранения документа в PDF выберите «Сохранить как PDF» в окне печати браузера.</p></div><div class="eo-reading"><aside class="eo-toc"><details open><summary>Содержание документа</summary><nav aria-label="Разделы документа">${document.sections.map((section, index) => `<a href="#${section.id}"><span>${index + 1}</span>${esc(section.title.replace(/^\d+\.\s*/, ''))}</a>`).join('')}</nav></details></aside><article class="eo-document"><div class="eo-print-identity"><img src="${esc(publisher.logo)}" alt="${esc(publisher.brand)}"><p>${esc(publisher.name)}<br>${origin}${document.url}</p></div><div class="eo-print-heading"><h2>${title}</h2><p>Редакция от ${esc(date(document.revisionDate))}</p></div>${document.sections.map(section => `<section id="${section.id}" data-eo-section><h2>${esc(section.title)}</h2>${section.clauses.map(clause => `<div class="eo-clause" id="clause-${clause.number.replaceAll('.', '-')}"><span class="eo-clause__number">${esc(clause.number)}</span><div class="eo-clause__text">${clause.html}</div></div>`).join('')}</section>`).join('')}</article></div><nav class="eo-bottom el-related" aria-label="Связанные правовые документы"><a href="/oferta/">Публичная оферта →</a>${documents.filter(item => item.id !== document.id).map(item => `<a href="${item.url}">${esc(item.title)} →</a>`).join('')}<a href="/documents/">Все документы →</a></nav></div></main>`;
}

export function renderLegalHub(documents) {
  const cards = [
    { url: '/oferta/', title: 'Публичная оферта', description: 'Условия оказания юридических услуг и история редакций.' },
    ...documents.map(item => ({ url: item.url, title: item.title, description: item.description, date: item.revisionDate, privacy: item.id === 'privacy' })),
    { url: '/offer_for_lawyer_20231103/', title: 'Присоединение исполнителей', description: 'Условия сотрудничества для исполнителей.' },
  ];
  return `<main class="eo-main el-main el-hub" id="legal-content"><div class="eo-wrap">${breadcrumbs()}<div class="eo-hero el-hero"><div><p class="eo-kicker">ЭЛЕГСО</p><h1>Правовые документы</h1></div></div><div class="el-document-grid">${cards.map(card => `<article class="el-document-card">${card.privacy ? '<img class="el-privacy-art" src="/assets/publications/privacy-data-600.webp" alt="" width="96" height="96" loading="lazy" decoding="async">' : icon}<h2><a href="${card.url}">${esc(card.title)}</a></h2><p>${esc(card.description)}</p>${card.date ? `<p class="el-card-date">Редакция от <time datetime="${card.date}">${esc(date(card.date))}</time></p>` : ''}<a class="el-card-link" href="${card.url}">Открыть документ <span aria-hidden="true">→</span></a></article>`).join('')}</div><div class="eo-actions el-hub-actions"><button type="button" class="eo-button" data-elegso-cookie-settings>Настроить cookie</button></div></div></main>`;
}

function meta(head, attribute, name, value) {
  const tag = `<meta ${attribute}="${name}" content="${esc(value)}">`;
  const expression = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${name}["'])[^>]*>`, 'gi');
  return expression.test(head) ? head.replace(expression, tag) : head.replace('</head>', `${tag}\n</head>`);
}

export async function buildLegalPages({ root = path.join(import.meta.dirname, '..'), write = false } = {}) {
  root = path.resolve(root);
  const web = path.join(root, 'www');
  const privacyBuild = await loadPrivacyBuild(root);
  const content = path.join(root, 'content/legal');
  const names = (await fs.readdir(content)).filter(name => name.endsWith('.json')).sort();
  assert(names.length, 'No content/legal documents; refusing to build an empty legal hub');
  const documents = await Promise.all(names.map(async name => validateLegalDocument(JSON.parse(await fs.readFile(path.join(content, name), 'utf8')))));
  assert(new Set(documents.map(item => item.id)).size === documents.length && new Set(documents.map(item => item.url)).size === documents.length, 'Duplicate legal document IDs or URLs');
  documents.sort((a, b) => (['privacy', 'cookies', 'consent'].indexOf(a.id) + 1 || 99) - (['privacy', 'cookies', 'consent'].indexOf(b.id) + 1 || 99));
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/offers.json'), 'utf8'));
  const publisher = config.publisher;
  assert(config.origin === origin && publisher?.name && publisher?.brand && /^\/(?!\/)/.test(publisher?.logo || ''), 'Missing legal-page publisher configuration');
  const template = updateFooterCards(await fs.readFile(path.join(web, 'mission/index.html'), 'utf8'));
  const bodyStart = template.search(/<body\b/i);
  const headerStart = template.indexOf('<!--header-->');
  const headerEnd = template.indexOf('</header>', headerStart) + 9;
  const footerStart = template.indexOf('<!--footer-->', headerEnd);
  assert(bodyStart >= 0 && headerStart >= 0 && headerEnd > headerStart && footerStart > headerEnd, 'Site shell markers missing');
  const header = template.slice(headerStart, headerEnd);
  const tail = template.slice(footerStart);
  const assets = ['offers.css', 'offers.js', 'legal-pages.css'];
  const hash = createHash('sha256');
  for (const asset of assets) hash.update(await fs.readFile(path.join(web, 'assets', asset)));
  const version = hash.digest('hex').slice(0, 12);
  function shell({ title, description, url, body, revisionDate, hub = false }) {
    let head = template.slice(0, bodyStart)
      .replace(/<html\b/i, '<html data-elegso-offers-document data-elegso-legal-document')
      .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${esc(title)} — ЭЛЕГСО</title>`)
      .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b(?=[^>]*rel=["']canonical["'])[^>]*>/gi, '')
      .replace(/<link\b(?=[^>]*href=["']\/assets\/(?:offers|legal-pages)\.css)[^>]*>/gi, '')
      .replace(/<script\b[^>]*src=["']\/assets\/offers\.js[^"']*["'][^>]*><\/script>/gi, '')
      .replace(/<meta\b(?=[^>]*property=["']article:[^"']*["'])[^>]*>/gi, '');
    for (const [attribute, name, value] of [
      ['name', 'description', description], ['name', 'robots', 'index, follow, max-image-preview:large, max-snippet:-1'],
      ['property', 'og:title', title], ['property', 'og:description', description], ['property', 'og:url', origin + url],
      ['property', 'og:type', 'website'], ['property', 'og:locale', 'ru_RU'], ['property', 'og:image', origin + publisher.logo], ['name', 'twitter:card', 'summary'],
    ]) head = meta(head, attribute, name, value);
    const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Главная', item: origin + '/' }, { '@type': 'ListItem', position: 2, name: 'Правовые документы', item: origin + '/documents/' }];
    if (!hub) crumbs.push({ '@type': 'ListItem', position: 3, name: title, item: origin + url });
    const graph = [
      { '@type': 'Organization', '@id': origin + '/#organization', name: publisher.name, url: origin + '/', logo: origin + publisher.logo },
      { '@type': hub ? 'CollectionPage' : 'WebPage', '@id': origin + url + '#webpage', url: origin + url, name: title, description, inLanguage: 'ru-RU', dateModified: revisionDate, publisher: { '@id': origin + '/#organization' } },
      { '@type': 'BreadcrumbList', itemListElement: crumbs },
    ];
    head = head.replace('</head>', `<link rel="canonical" href="${origin}${url}"><link rel="stylesheet" href="/assets/offers.css?v=${version}"><link rel="stylesheet" href="/assets/legal-pages.css?v=${version}"><script src="/assets/offers.js?v=${version}" defer></script><script type="application/ld+json" data-elegso-legal-schema>${json({ '@context': 'https://schema.org', '@graph': graph })}</script></head>`);
    return applyPrivacyAnalytics(head + `<body class="t-body elegso-offers-page elegso-legal-page" style="margin:0"><a class="eo-skip" href="#legal-content">К тексту документа</a><div id="allrecords" class="t-records" data-tilda-project-id="3964517" data-tilda-lazy="yes" data-tilda-root-zone="com">${header}${body}${tail}`, privacyBuild);
  }
  const output = new Map();
  const latestDate = documents.map(item => item.revisionDate).sort().at(-1);
  for (const document of documents) output.set(path.join(web, document.url, 'index.html'), shell({ ...document, body: renderLegalBody(document, publisher, documents) }));
  output.set(path.join(web, 'documents/index.html'), shell({ title: 'Правовые документы', description: 'Публичная оферта ЭЛЕГСО, политика обработки персональных данных, документы о файлах cookie и условия для исполнителей.', url: '/documents/', revisionDate: latestDate, hub: true, body: renderLegalHub(documents) }));
  const routes = [...documents.map(item => ({ url: item.url, revisionDate: item.revisionDate })), { url: '/documents/', revisionDate: latestDate }];
  const urls = new Set(routes.map(item => origin + item.url));
  for (const name of ['sitemap.xml', 'sitemap.base.xml']) {
    const filename = path.join(web, name);
    let before;
    try { before = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; if (name === 'sitemap.base.xml') continue; before = ''; }
    const rows = [...before.matchAll(/<url>[\s\S]*?<\/url>/g)].map(match => match[0]).filter(row => !urls.has(row.match(/<loc>([^<]+)<\/loc>/)?.[1]));
    rows.push(...routes.map(item => `<url><loc>${origin}${item.url}</loc><lastmod>${item.revisionDate}</lastmod></url>`));
    output.set(filename, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`);
  }
  const changed = [];
  for (const [filename, html] of output) {
    let before;
    try { before = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before !== html) changed.push({ filename, html });
  }
  if (write) for (const item of changed) { await fs.mkdir(path.dirname(item.filename), { recursive: true }); await fs.writeFile(item.filename, item.html); }
  return { mode: write ? 'write' : 'dry-run', pages: documents.length + 1, documents: routes, changed: changed.map(item => path.relative(root, item.filename)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let root = path.join(import.meta.dirname, '..');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root') { assert(args[++index], '--root needs a directory'); root = args[index]; }
    else assert(['--write', '--check'].includes(args[index]), `Unknown argument: ${args[index]}`);
  }
  assert(!(args.includes('--write') && args.includes('--check')), '--write and --check are mutually exclusive');
  const result = await buildLegalPages({ root, write: args.includes('--write') });
  console.log(JSON.stringify(result, null, 2));
  if (args.includes('--check') && result.changed.length) process.exitCode = 1;
}
