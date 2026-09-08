#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = new URL(process.argv[2] || 'https://elegso.ru');
const reportPath = path.resolve('reports/seo-url-canonicalization.json');
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

async function request(url, method = 'HEAD') {
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { 'user-agent': 'ELEGSO-SEO-Audit/1.0' },
  });
  const location = response.headers.get('location');
  return {
    url,
    status: response.status,
    location: location ? new URL(location, url).href : null,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

const sitemapUrl = new URL('/sitemap.xml', origin).href;
const sitemapResponse = await fetch(sitemapUrl, {
  headers: { 'user-agent': 'ELEGSO-SEO-Audit/1.0' },
});
if (!sitemapResponse.ok) {
  throw new Error(`${sitemapUrl}: HTTP ${sitemapResponse.status}`);
}

const sitemap = await sitemapResponse.text();
const canonicalUrls = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
  .map((match) => new URL(match[1]).href);

const checks = [];
for (const canonical of canonicalUrls) {
  const url = new URL(canonical);
  checks.push({ canonical, kind: 'canonical', url: canonical, expectRedirect: false });

  const indexUrl = new URL(url.href);
  indexUrl.pathname = `${indexUrl.pathname}index.html`;
  checks.push({ canonical, kind: 'index-html', url: indexUrl.href, expectRedirect: true });

  const wwwUrl = new URL(url.href);
  wwwUrl.hostname = `www.${origin.hostname}`;
  checks.push({ canonical, kind: 'www', url: wwwUrl.href, expectRedirect: true });

  const httpUrl = new URL(url.href);
  httpUrl.protocol = 'http:';
  checks.push({ canonical, kind: 'http', url: httpUrl.href, expectRedirect: true });

  const httpWwwUrl = new URL(wwwUrl.href);
  httpWwwUrl.protocol = 'http:';
  checks.push({ canonical, kind: 'http-www', url: httpWwwUrl.href, expectRedirect: true });

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    const noSlashUrl = new URL(url.href);
    noSlashUrl.pathname = noSlashUrl.pathname.slice(0, -1);
    checks.push({ canonical, kind: 'missing-trailing-slash', url: noSlashUrl.href, expectRedirect: true });
  }
}

const results = await mapLimit(checks, 8, async (check) => {
  try {
    const response = await request(check.url);
    const errors = [];
    if (check.expectRedirect) {
      if (response.status !== 301) errors.push(`expected-301-got-${response.status}`);
      if (response.location !== check.canonical) {
        errors.push(`redirect-target-${response.location || 'missing'}`);
      }
    } else if (response.status !== 200) {
      errors.push(`expected-200-got-${response.status}`);
    }
    if (!check.expectRedirect && redirectStatuses.has(response.status)) {
      errors.push('canonical-url-redirects');
    }
    return { ...check, ...response, errors };
  } catch (error) {
    return { ...check, status: null, location: null, errors: [String(error)] };
  }
});

const failures = results.filter((result) => result.errors.length > 0);
const report = {
  generatedAt: new Date().toISOString(),
  origin: origin.origin,
  sitemapUrl,
  summary: {
    canonicalPages: canonicalUrls.length,
    checks: results.length,
    failures: failures.length,
  },
  failures,
  results,
};

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Report: ${reportPath}`);
if (failures.length > 0) process.exitCode = 1;
