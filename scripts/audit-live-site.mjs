#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = (process.argv[2] || 'https://elegso.ru').replace(/\/$/, '');
const reportPath = path.resolve(process.argv[3] || 'reports/seo-live-audit.json');

function decodeEntities(value = '') {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

function meta(html, attribute, value) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!new RegExp(`\\b${attribute}=["']${value}["']`, 'i').test(tag)) continue;
    return decodeEntities((tag.match(/\bcontent=["']([^"']*)["']/i) || [])[1] || '').trim();
  }
  return '';
}

function canonical(html) {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel=["'][^"']*\bcanonical\b[^"']*["']/i.test(tag)) continue;
    return decodeEntities((tag.match(/\bhref=["']([^"']*)["']/i) || [])[1] || '').trim();
  }
  return '';
}

function pageMarkup(html) {
  return html
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '');
}

function attrValues(html, regexp) {
  return [...html.matchAll(regexp)].map((match) => decodeEntities(match[1] || '').trim()).filter(Boolean);
}

function localUrl(raw, pageUrl) {
  if (!raw || /^(?:#|mailto:|tel:|javascript:|data:|blob:|\?)/i.test(raw)) return null;
  try {
    const url = new URL(raw, pageUrl);
    if (url.origin !== origin) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
}

const robotsResponse = await fetchWithTimeout(`${origin}/robots.txt`);
const robots = await robotsResponse.text();
const sitemapResponse = await fetchWithTimeout(`${origin}/sitemap.xml`);
const sitemap = await sitemapResponse.text();
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => decodeEntities(match[1]));

const pages = [];
const references = new Map();
for (const pageUrl of sitemapUrls) {
  const response = await fetchWithTimeout(pageUrl, { redirect: 'manual' });
  const html = await response.text();
  const markup = pageMarkup(html);
  const links = attrValues(markup, /<a\b[^>]*\bhref=["']([^"']*)["']/gi);
  const assets = [
    ...attrValues(markup, /<(?:img|script|link|source)\b[^>]*\b(?:src|href|data-src|data-original)=["']([^"']*)["']/gi),
    ...attrValues(markup, /\bsrcset=["']([^"']*)["']/gi).flatMap((value) => value.split(',').map((item) => item.trim().split(/\s+/, 1)[0])),
  ];
  const absoluteInternalAnchors = links.filter((value) => /^https?:\/\//i.test(value) && localUrl(value, pageUrl));
  for (const raw of [...links, ...assets]) {
    const url = localUrl(raw, pageUrl);
    if (!url || /^https?:\/\/elegso\.ru\/(?:api|calculator-data|calc_nst\/service)\//.test(url)) continue;
    if (!references.has(url)) references.set(url, new Set());
    references.get(url).add(pageUrl);
  }

  const expectedCanonical = pageUrl;
  const pageErrors = [];
  if (response.status !== 200) pageErrors.push(`http:${response.status}`);
  if (!/text\/html/i.test(response.headers.get('content-type') || '')) pageErrors.push('wrong-content-type');
  if (!/\bindex\b/i.test(response.headers.get('x-robots-tag') || '')) pageErrors.push('missing-index-header');
  if (/\bnoindex\b/i.test(response.headers.get('x-robots-tag') || '')) pageErrors.push('noindex-header');
  if (canonical(html) !== expectedCanonical) pageErrors.push('wrong-canonical');
  if (/\bnoindex\b/i.test(meta(html, 'name', 'robots'))) pageErrors.push('noindex-meta');
  if (!/<title\b[^>]*>[^<]+<\/title>/i.test(html)) pageErrors.push('missing-title');
  if (!meta(html, 'name', 'description')) pageErrors.push('missing-description');
  if (!/<html\b[^>]*\blang=["']ru["']/i.test(html)) pageErrors.push('missing-lang');
  if (!html.includes('data-elegso-seo-schema')) pageErrors.push('missing-structured-data');
  if (!html.includes('87831358')) pageErrors.push('missing-yandex-metrika');
  if (!html.includes('GTM-PBV2TC8')) pageErrors.push('missing-gtm');
  if (!html.includes('3662487')) pageErrors.push('missing-mailru');
  if (absoluteInternalAnchors.length) pageErrors.push(`absolute-internal-anchors:${absoluteInternalAnchors.length}`);
  pages.push({
    url: pageUrl,
    status: response.status,
    contentType: response.headers.get('content-type'),
    xRobotsTag: response.headers.get('x-robots-tag'),
    canonical: canonical(html),
    robots: meta(html, 'name', 'robots'),
    absoluteInternalAnchors,
    errors: pageErrors,
  });
}

const referenceEntries = [...references.entries()];
const checkedReferences = new Array(referenceEntries.length);
let cursor = 0;
async function worker() {
  while (cursor < referenceEntries.length) {
    const index = cursor++;
    const [url, sources] = referenceEntries[index];
    try {
      const response = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'manual' });
      checkedReferences[index] = {
        url,
        status: response.status,
        sources: [...sources],
        error: response.status >= 400 ? `http:${response.status}` : '',
      };
    } catch (error) {
      checkedReferences[index] = { url, status: 0, sources: [...sources], error: error.message };
    }
  }
}
await Promise.all(Array.from({ length: Math.min(16, referenceEntries.length || 1) }, () => worker()));

const report = {
  generatedAt: new Date().toISOString(),
  origin,
  summary: {
    robotsStatus: robotsResponse.status,
    sitemapStatus: sitemapResponse.status,
    sitemapPages: sitemapUrls.length,
    pagesChecked: pages.length,
    pagesWithErrors: pages.filter((page) => page.errors.length).length,
    uniqueInternalReferences: checkedReferences.length,
    brokenInternalReferences: checkedReferences.filter((item) => item.error).length,
    analyticsCoverage: {
      yandexMetrika: pages.filter((page) => !page.errors.includes('missing-yandex-metrika')).length,
      googleTagManager: pages.filter((page) => !page.errors.includes('missing-gtm')).length,
      mailRu: pages.filter((page) => !page.errors.includes('missing-mailru')).length,
    },
  },
  robots,
  pages,
  brokenReferences: checkedReferences.filter((item) => item.error),
};

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
if (report.summary.pagesWithErrors || report.summary.brokenInternalReferences || robotsResponse.status !== 200 || sitemapResponse.status !== 200) {
  process.exitCode = 1;
}
