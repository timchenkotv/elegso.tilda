#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { privacyInventory } from './privacy-analytics.mjs';
import { inspectStructuredData } from './structured-data.mjs';

const root = path.resolve(process.argv[2] || 'www');
const reportPath = path.resolve(process.argv[3] || 'reports/seo-audit.json');
const productionOrigin = 'https://elegso.ru';
// Exact routes produced outside the source www tree. The publisher's service
// writes to /srv/www/elegso.ru/generated; this is NOT a /cases/* exemption.
const configuredRuntimeRoutes = new Map([['/cases/', {
  producer: 'elegso-case-publisher.service',
  configuration: 'ops/case-publisher/elegso-case-publisher.service',
  implementation: 'ops/case-publisher/publish.py#write_release',
  generatedFile: '/srv/www/elegso.ru/generated/current/cases/index.html',
}]]);
const canonicalAliases = new Map([
  ['page28912341.html', '/header/'],
  ['page28912345.html', '/footer/'],
  ['page32088114.html', '/error404/'],
  ['page52312037.html', '/calculator_of_the_balance_of_counter_obligations_in_leasing/'],
  ['oferta-fiz/index.html', '/oferta/'],
]);

async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result;
}

function routeFor(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel}`;
}

function isTechnical(rel) {
  return rel.startsWith('_external/')
    || rel.startsWith('api/')
    || ['error404/index.html', 'footer/index.html', 'header/index.html'].includes(rel)
    || /^page\d+\.html$/.test(rel);
}

function isOfferArchive(rel) {
  return /^(?:oferta|oferta-fiz)\/versions\/[^/]+\/index\.html$/.test(rel)
    || ['oferta-fiz/index.html', 'oferta-fiz/history/index.html'].includes(rel);
}

function decodeEntities(value = '') {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function plain(value = '') {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function allMatches(html, regexp, group = 1) {
  return [...html.matchAll(regexp)].map((match) => decodeEntities(match[group] || '').trim());
}

function meta(html, key, value) {
  const tags = allMatches(html, /<meta\b[^>]*>/gi, 0);
  for (const tag of tags) {
    const keyMatch = tag.match(new RegExp(`\\b${key}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i'));
    if (!keyMatch) continue;
    const content = tag.match(/\bcontent=["']([^"']*)["']/i);
    if (content) return decodeEntities(content[1]).trim();
  }
  return '';
}

function linkRel(html, relValue) {
  for (const tag of allMatches(html, /<link\b[^>]*>/gi, 0)) {
    if (!new RegExp(`\\brel=["'][^"']*\\b${relValue}\\b[^"']*["']`, 'i').test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']*)["']/i);
    if (href) return decodeEntities(href[1]).trim();
  }
  return '';
}

function localPathFromUrl(raw) {
  if (!raw || /^(?:#|mailto:|tel:|javascript:|data:|blob:)/i.test(raw)) return null;
  let value = raw.trim();
  if (/^https?:\/\//i.test(value) || value.startsWith('//')) {
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (!['elegso.ru', 'www.elegso.ru', 'site.elegso.ru'].includes(url.hostname)) return null;
      value = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }
  if (!value.startsWith('/')) return null;
  const pathname = value.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

async function targetExists(urlPath) {
  if (urlPath === '/') return true;
  const clean = urlPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const candidates = [
    path.join(root, clean),
    path.join(root, clean, 'index.html'),
    path.join(root, `${clean}.html`),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return true;
    } catch {}
  }
  return false;
}

const files = (await walk(root)).filter((file) => file.endsWith('.html'));
const pages = [];
const allBroken = [];
const allAbsoluteInternal = [];
const allDocumentRelative = [];
const allRuntimeReferences = [];

for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.startsWith('_external/') || rel.startsWith('api/')) continue;
  const route = routeFor(rel);
  const technical = isTechnical(rel);
  const html = await fs.readFile(file, 'utf8');
  const title = plain((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const description = meta(html, 'name', 'description');
  const robots = meta(html, 'name', 'robots');
  const canonical = linkRel(html, 'canonical');
  const structural = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '');
  const h1 = allMatches(structural, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi).map(plain).filter(Boolean);
  const htmlLang = (html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i) || [])[1] || '';
  const ogTitle = meta(html, 'property', 'og:title');
  const ogDescription = meta(html, 'property', 'og:description');
  const ogUrl = meta(html, 'property', 'og:url');
  const ogImage = meta(html, 'property', 'og:image');
  const structuredData = inspectStructuredData(html);
  const schemaCount = structuredData.count;
  const imgTags = allMatches(structural, /<img\b[^>]*>/gi, 0);
  const imagesWithoutAlt = imgTags.filter((tag) => !/\balt=["'][^"']*["']/i.test(tag)).length;
  const hrefs = allMatches(html, /<a\b[^>]*\bhref=["']([^"']*)["']/gi);
  const assetUrls = allMatches(html, /<(?:img|script|link|source)\b[^>]*\b(?:src|href|data-src|data-original)=["']([^"']*)["']/gi);
  const absoluteInternal = [...new Set([...hrefs, ...assetUrls].filter((url) => url !== canonical && /^(?:https?:)?\/\/(?:www\.|site\.)?elegso\.ru(?:[\/:?#]|$)/i.test(url)))];
  const documentRelative = [...new Set(hrefs.filter((url) => url && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?|\{)/i.test(url)))];
  const broken = [];
  const runtimeReferences = [];
  for (const url of [...new Set([...hrefs, ...assetUrls])]) {
    const localPath = localPathFromUrl(url);
    if (!localPath || localPath.startsWith('/api/') || localPath.startsWith('/calculator-data/') || localPath.startsWith('/calc_nst/service/')) continue;
    const runtime = configuredRuntimeRoutes.get(localPath);
    if (runtime && hrefs.includes(url) && !assetUrls.includes(url)) {
      runtimeReferences.push({ url, path: localPath, validation: 'live-check-required', ...runtime });
      continue;
    }
    if (!await targetExists(localPath)) broken.push(url);
  }

  const expectedCanonical = `${productionOrigin}${canonicalAliases.get(rel) || route}`;
  const offerArchive = isOfferArchive(rel);
  const indexable = !technical && !offerArchive;
  const errors = [];
  if (!title) errors.push('missing-title');
  if (indexable && !description) errors.push('missing-description');
  if (!canonical) errors.push('missing-canonical');
  else if (canonical !== expectedCanonical) errors.push('wrong-canonical');
  if (!htmlLang) errors.push('missing-html-lang');
  if (indexable && /noindex/i.test(robots)) errors.push('unexpected-noindex');
  if (technical && !/noindex/i.test(robots)) errors.push('missing-noindex');
  if (offerArchive && (!/noindex/i.test(robots) || /nofollow/i.test(robots))) errors.push('offer-archive-robots');
  if (indexable && h1.length !== 1) errors.push(`h1-count:${h1.length}`);
  if (indexable && !ogTitle) errors.push('missing-og-title');
  if (indexable && !ogDescription) errors.push('missing-og-description');
  if (indexable && !ogUrl) errors.push('missing-og-url');
  if (indexable && !ogImage) errors.push('missing-og-image');
  if (indexable) errors.push(...structuredData.errors);
  const privacy = privacyInventory(html);
  const consentLoader = /<script\b[^>]*src=["']\/assets\/site-privacy\.js\?[^"']+["']/i.test(html)
    && html.includes('data-elegso-privacy-config') && html.includes('"counterId":87831358') && html.includes('"defaultEnabled":false');
  if (!consentLoader) errors.push('missing-consent-based-yandex-loader');
  if (privacy.inlineTrackers.length || privacy.resources.some(item => /googletagmanager|google-analytics|fonts\.google|fonts\.gstatic|top-fwz1\.mail|mc\.yandex/.test(item.host))) errors.push('unexpected-unconsented-external-analytics');
  if (absoluteInternal.length) errors.push(`absolute-internal:${absoluteInternal.length}`);
  if (documentRelative.length) errors.push(`document-relative:${documentRelative.length}`);
  if (broken.length) errors.push(`broken-local:${broken.length}`);

  allBroken.push(...broken.map((url) => ({ route, url })));
  allAbsoluteInternal.push(...absoluteInternal.map((url) => ({ route, url })));
  allDocumentRelative.push(...documentRelative.map((url) => ({ route, url })));
  allRuntimeReferences.push(...runtimeReferences.map(reference => ({ route, ...reference })));
  pages.push({
    route,
    file: rel,
    indexable,
    offerArchive,
    title,
    description,
    robots,
    canonical,
    expectedCanonical,
    h1,
    htmlLang,
    openGraph: { title: ogTitle, description: ogDescription, url: ogUrl, image: ogImage },
    schemaCount,
    structuredData,
    images: { total: imgTags.length, withoutAlt: imagesWithoutAlt },
    analytics: {
      yandexMetrika: consentLoader,
      requiresOptIn: true,
      googleTagManager: privacy.inlineTrackers.some(item => item.google),
      mailRu: privacy.inlineTrackers.some(item => item.mailRu),
      legacyTildaStats: privacy.inlineTrackers.some(item => item.tilda),
    },
    absoluteInternal,
    documentRelative,
    broken,
    runtimeReferences,
    errors,
  });
}

const duplicateGroups = (field) => {
  const groups = new Map();
  for (const page of pages.filter((item) => item.indexable && item[field])) {
    const value = page[field];
    groups.set(value, [...(groups.get(value) || []), page.route]);
  }
  return [...groups.entries()].filter(([, routes]) => routes.length > 1).map(([value, routes]) => ({ value, routes }));
};

const report = {
  generatedAt: new Date().toISOString(),
  root,
  summary: {
    htmlPages: pages.length,
    indexablePages: pages.filter((page) => page.indexable).length,
    technicalNoindexPages: pages.filter((page) => !page.indexable && !page.offerArchive).length,
    archivedOfferNoindexPages: pages.filter((page) => page.offerArchive).length,
    pagesWithErrors: pages.filter((page) => page.errors.length).length,
    absoluteInternalReferences: allAbsoluteInternal.length,
    documentRelativeReferences: allDocumentRelative.length,
    brokenLocalReferences: allBroken.length,
    runtimeReferences: allRuntimeReferences.length,
    runtimeValidationRequired: [...new Set(allRuntimeReferences.map(reference => reference.path))],
    images: pages.reduce((sum, page) => sum + page.images.total, 0),
    imagesWithoutAlt: pages.reduce((sum, page) => sum + page.images.withoutAlt, 0),
  },
  duplicateTitles: duplicateGroups('title'),
  duplicateDescriptions: duplicateGroups('description'),
  runtimeReferences: allRuntimeReferences,
  pages,
};

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Report: ${reportPath}`);
