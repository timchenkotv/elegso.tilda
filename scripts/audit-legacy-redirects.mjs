#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = new URL(process.argv[2] || 'https://elegso.ru');
const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'ops/nginx/legacy-redirects.json');
const jsonReportPath = path.join(root, 'reports/legacy-redirect-audit.json');
const markdownReportPath = path.join(root, 'reports/legacy-redirect-audit.md');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

assertUnique(manifest.aliases, 'source', 'alias');
assertUnique(manifest.page_ids, 'id', 'Tilda page ID');
assertUnique(manifest.products, 'id', 'Tilda product ID');

const sitemapResponse = await fetch(new URL('/sitemap.xml', origin), {
  headers: { 'user-agent': 'ELEGSO-Legacy-Redirect-Audit/1.0' },
});
if (!sitemapResponse.ok) throw new Error(`sitemap.xml: HTTP ${sitemapResponse.status}`);
const sitemap = await sitemapResponse.text();
const canonicalPaths = new Set(
  [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => new URL(match[1]).pathname),
);
for (const item of [...manifest.aliases, ...manifest.page_ids, ...manifest.products]) {
  if (!canonicalPaths.has(item.target)) throw new Error(`Target is absent from sitemap: ${item.target}`);
}

const checks = [];
for (const item of manifest.aliases) {
  checks.push({ category: 'alias', source: item.source, target: item.target, title: item.title });
  if (item.source !== '/' && !item.source.endsWith('/')) {
    checks.push({ category: 'alias-slash', source: `${item.source}/`, target: item.target, title: item.title });
  }
}
for (const item of manifest.page_ids) {
  for (const suffix of ['', '/', '.html', '.html/']) {
    checks.push({
      category: 'page-id',
      source: `/page${item.id}${suffix}`,
      target: item.target,
      title: item.title,
      id: item.id,
    });
  }
}
for (const item of manifest.products) {
  const slugs = [item.slug, ...(item.alternate_slugs || [])];
  for (const prefix of ['1-', '714506532-']) {
    for (const slug of slugs) {
      const source = `/tproduct/${prefix}${item.id}-${slug}`;
      checks.push({ category: 'tproduct', source, target: item.target, title: item.title, id: item.id });
      checks.push({ category: 'tproduct-slash', source: `${source}/`, target: item.target, title: item.title, id: item.id });
    }
  }
}

async function request(item) {
  const url = new URL(item.source, origin);
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'user-agent': 'ELEGSO-Legacy-Redirect-Audit/1.0' },
  });
  const rawLocation = response.headers.get('location');
  const location = rawLocation ? new URL(rawLocation, url).href : null;
  const expected = new URL(item.target, origin).href;
  return {
    ...item,
    url: url.href,
    status: response.status,
    location,
    expected,
    ok: response.status === 301 && location === expected,
  };
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  }));
  return output;
}

const results = await mapLimit(checks, 12, request);
const targets = [...new Set(results.map((item) => item.expected))];
const targetResults = await mapLimit(targets, 8, async (url) => {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'user-agent': 'ELEGSO-Legacy-Redirect-Audit/1.0' },
  });
  return { url, status: response.status, ok: response.status === 200 };
});
const failures = results.filter((item) => !item.ok);
const targetFailures = targetResults.filter((item) => !item.ok);

const report = {
  generatedAt: new Date().toISOString(),
  origin: origin.href,
  manifest: path.relative(root, manifestPath),
  sources: manifest.sources,
  summary: {
    aliases: manifest.aliases.length,
    tildaPageIds: manifest.page_ids.length,
    tildaProducts: manifest.products.length,
    redirectChecks: results.length,
    redirectFailures: failures.length,
    uniqueTargets: targetResults.length,
    targetFailures: targetFailures.length,
  },
  failures,
  targetFailures,
  mappings: {
    aliases: manifest.aliases,
    pageIds: manifest.page_ids,
    products: manifest.products,
  },
  checks: results,
  targets: targetResults,
};

await fs.writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => [
  `| ${headers.join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
].join('\n');

const markdown = [
  '# Карта 301-перенаправлений старых URL ELEGSO',
  '',
  `Проверено: ${report.generatedAt}. Все адреса приведены относительно \`${origin.origin}\`.`,
  '',
  `- Старых именованных адресов: ${report.summary.aliases}.`,
  `- Внутренних ID страниц Tilda: ${report.summary.tildaPageIds}.`,
  `- Карточек услуг Tilda: ${report.summary.tildaProducts} (проверяются оба исторических префикса магазина).`,
  `- Фактических HTTP-проверок: ${report.summary.redirectChecks}.`,
  `- Ошибок 301: ${report.summary.redirectFailures}.`,
  `- Ошибок конечных страниц: ${report.summary.targetFailures}.`,
  '',
  '## Старые именованные страницы',
  '',
  table(['Старый URL', 'Новый URL', 'Прежнее назначение'], manifest.aliases.map((item) => [item.source, item.target, item.title])),
  '',
  '## Старые внутренние адреса Tilda',
  '',
  'Для каждого ID проверены варианты `page<ID>`, `page<ID>/`, `page<ID>.html` и `page<ID>.html/`.',
  '',
  table(['ID Tilda', 'Новый URL', 'Прежнее назначение'], manifest.page_ids.map((item) => [`page${item.id}.html`, item.target, item.title])),
  '',
  '## Старые карточки услуг Tilda',
  '',
  'Для каждой карточки проверены префиксы `/tproduct/1-…` и `/tproduct/714506532-…`, со слэшем и без него.',
  '',
  table(['ID товара', 'Новый URL', 'Прежнее назначение'], manifest.products.map((item) => [item.id, item.target, item.title])),
  '',
];
await fs.writeFile(markdownReportPath, markdown.join('\n'));

console.log(JSON.stringify(report.summary, null, 2));
console.log(`JSON: ${jsonReportPath}`);
console.log(`Markdown: ${markdownReportPath}`);
if (failures.length || targetFailures.length) process.exitCode = 1;
