#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('www');
const productionOrigin = 'https://elegso.ru';
const defaultOgImage = `${productionOrigin}/_external/static.tildacdn.com/tild3235-6433-4364-a535-643564626636/---.jpg`;
const today = new Date().toISOString().slice(0, 10);

const descriptions = new Map([
  [
    'soglashenie/index.html',
    'Политика обработки персональных данных и конфиденциальности юридической компании «ЭЛЕГСО»: цели, основания, порядок обработки и права пользователей.',
  ],
]);

const canonicalAliases = new Map([
  ['page28912341.html', '/header/'],
  ['page28912345.html', '/footer/'],
  ['page32088114.html', '/error404/'],
  ['page52312037.html', '/calculator_of_the_balance_of_counter_obligations_in_leasing/'],
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

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function plain(value = '') {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function contentOfMeta(html, attribute, value) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!new RegExp(`\\b${attribute}=["']${value}["']`, 'i').test(tag)) continue;
    return plain((tag.match(/\bcontent=["']([^"']*)["']/i) || [])[1] || '');
  }
  return '';
}

function setMeta(html, attribute, name, content) {
  let found = false;
  const next = html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!new RegExp(`\\b${attribute}=["']${name}["']`, 'i').test(tag)) return tag;
    found = true;
    if (/\bcontent=["'][^"']*["']/i.test(tag)) {
      return tag.replace(/\bcontent=["'][^"']*["']/i, `content="${escapeAttribute(content)}"`);
    }
    return tag.replace(/\s*\/?\s*>$/, ` content="${escapeAttribute(content)}">`);
  });
  if (found) return next;
  return next.replace(/<\/head>/i, `<meta ${attribute}="${name}" content="${escapeAttribute(content)}">\n</head>`);
}

function setCanonical(html, canonical) {
  let found = false;
  const next = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel=["'][^"']*\bcanonical\b[^"']*["']/i.test(tag)) return tag;
    found = true;
    if (/\bhref=["'][^"']*["']/i.test(tag)) {
      return tag.replace(/\bhref=["'][^"']*["']/i, `href="${canonical}"`);
    }
    return tag.replace(/\s*\/?\s*>$/, ` href="${canonical}">`);
  });
  if (found) return next;
  return next.replace(/<\/head>/i, `<link rel="canonical" href="${canonical}">\n</head>`);
}

function titleOf(html) {
  return plain((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
}

function maskExecutableBlocks(html) {
  const blocks = [];
  const masked = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (block) => {
    const marker = `<!--ELEGSO-BLOCK-${blocks.length}-->`;
    blocks.push(block);
    return marker;
  });
  return {
    masked,
    restore(value) {
      return value.replace(/<!--ELEGSO-BLOCK-(\d+)-->/g, (_match, index) => blocks[Number(index)]);
    },
  };
}

function normalizeInternalAnchors(html, pageRoute, directoryRoutes) {
  const { masked, restore } = maskExecutableBlocks(html);
  const normalized = masked.replace(/(<a\b[^>]*\bhref=)(["'])([^"']*)(\2)/gi, (match, prefix, quote, raw) => {
    if (!raw || /^(?:#|mailto:|tel:|javascript:|data:|blob:|\?)/i.test(raw)) return match;
    let resolved;
    try {
      resolved = new URL(raw, `${productionOrigin}${pageRoute}`);
    } catch {
      return match;
    }
    if (!['elegso.ru', 'www.elegso.ru', 'site.elegso.ru'].includes(resolved.hostname)) return match;
    let pathname = resolved.pathname;
    if (directoryRoutes.has(`${pathname.replace(/\/$/, '')}/`)) pathname = `${pathname.replace(/\/$/, '')}/`;
    const value = `${pathname}${resolved.search}${resolved.hash}`;
    return `${prefix}${quote}${value}${quote}`;
  });
  return restore(normalized);
}

function structuralHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '');
}

function ensureH1(html, title, indexable) {
  if (!indexable || /<h1\b/i.test(structuralHtml(html))) return html;
  const hiddenHeading = `<h1 class="elegso-visually-hidden">${title.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</h1>`;
  if (!html.includes('data-elegso-visually-hidden-style')) {
    html = html.replace(
      /<\/head>/i,
      '<style data-elegso-visually-hidden-style>.elegso-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}</style>\n</head>',
    );
  }
  return html.replace(/<body\b([^>]*)>/i, `<body$1>\n${hiddenHeading}`);
}

function ensureSchema(html, { canonical, description, pageTitle, route }) {
  html = html.replace(/\s*<script\b[^>]*data-elegso-seo-schema[^>]*>[\s\S]*?<\/script>/gi, '');
  const graph = [
    {
      '@type': ['LegalService', 'Organization'],
      '@id': `${productionOrigin}/#organization`,
      name: 'Юридическая компания «ЭЛЕГСО»',
      url: `${productionOrigin}/`,
      logo: `${productionOrigin}/_external/static.tildacdn.com/tild6636-3836-4134-b236-373062316464/_v6_.png`,
      image: defaultOgImage,
      telephone: '+7-495-646-00-02',
      email: 'mail@elegso.ru',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'ул. Бутлерова, 17, БЦ Neo Geo, блок С, этаж 4, офис С01',
        addressLocality: 'Москва',
        addressCountry: 'RU',
      },
    },
    {
      '@type': 'WebSite',
      '@id': `${productionOrigin}/#website`,
      url: `${productionOrigin}/`,
      name: 'Юридическая компания «ЭЛЕГСО»',
      inLanguage: 'ru-RU',
      publisher: { '@id': `${productionOrigin}/#organization` },
    },
    {
      '@type': 'WebPage',
      '@id': `${canonical}#webpage`,
      url: canonical,
      name: pageTitle,
      description,
      inLanguage: 'ru-RU',
      isPartOf: { '@id': `${productionOrigin}/#website` },
      about: { '@id': `${productionOrigin}/#organization` },
    },
  ];
  if (route !== '/') {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${canonical}#breadcrumbs`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Главная', item: `${productionOrigin}/` },
        { '@type': 'ListItem', position: 2, name: pageTitle, item: canonical },
      ],
    });
  }
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replaceAll('<', '\\u003c');
  return html.replace(/<\/head>/i, `<script type="application/ld+json" data-elegso-seo-schema>${json}</script>\n</head>`);
}

const files = (await walk(root)).filter((file) => file.endsWith('.html'));
const relativeFiles = files.map((file) => path.relative(root, file).split(path.sep).join('/'));
const directoryRoutes = new Set(relativeFiles.filter((rel) => rel.endsWith('/index.html')).map(routeFor));
const sitemapRoutes = [];

for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.startsWith('_external/') || rel.startsWith('api/')) continue;
  const route = routeFor(rel);
  const indexable = !isTechnical(rel);
  const canonicalRoute = canonicalAliases.get(rel) || route;
  const canonical = `${productionOrigin}${canonicalRoute}`;
  let html = await fs.readFile(file, 'utf8');
  const pageTitle = titleOf(html);
  const description = descriptions.get(rel) || contentOfMeta(html, 'name', 'description');

  html = html.replace(/<html(?!\b[^>]*\blang=)(\b[^>]*)>/i, '<html lang="ru"$1>');
  html = setCanonical(html, canonical);
  html = setMeta(html, 'name', 'robots', indexable
    ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
    : 'noindex, nofollow, noarchive');
  if (description) html = setMeta(html, 'name', 'description', description);
  html = setMeta(html, 'property', 'og:title', contentOfMeta(html, 'property', 'og:title') || pageTitle);
  html = setMeta(html, 'property', 'og:description', contentOfMeta(html, 'property', 'og:description') || description);
  html = setMeta(html, 'property', 'og:url', canonical);
  html = setMeta(html, 'property', 'og:type', contentOfMeta(html, 'property', 'og:type') || 'website');
  const currentOgImage = contentOfMeta(html, 'property', 'og:image');
  const absoluteOgImage = currentOgImage.startsWith('/') ? `${productionOrigin}${currentOgImage}` : currentOgImage;
  html = setMeta(html, 'property', 'og:image', absoluteOgImage || defaultOgImage);
  html = setMeta(html, 'property', 'og:locale', 'ru_RU');
  html = setMeta(html, 'name', 'twitter:card', 'summary_large_image');
  html = normalizeInternalAnchors(html, route, directoryRoutes);
  html = ensureH1(html, pageTitle, indexable);
  if (indexable) html = ensureSchema(html, { canonical, description, pageTitle, route });
  html = html.replace(/[ \t]+$/gm, '');
  await fs.writeFile(file, html);
  if (indexable) sitemapRoutes.push(canonicalRoute);
}

const uniqueSitemapRoutes = [...new Set(sitemapRoutes)].sort((a, b) => {
  if (a === '/') return -1;
  if (b === '/') return 1;
  return a.localeCompare(b, 'en');
});
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...uniqueSitemapRoutes.flatMap((route) => [
    '  <url>',
    `    <loc>${productionOrigin}${route}</loc>`,
    `    <lastmod>${today}</lastmod>`,
    '  </url>',
  ]),
  '</urlset>',
  '',
].join('\n');
await fs.writeFile(path.join(root, 'sitemap.xml'), sitemap);

const productionRobots = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /calculator-data/
Disallow: /calc_nst/service/
Disallow: /tilda/
Disallow: /members/

User-agent: Yandex
Allow: /
Disallow: /api/
Disallow: /calculator-data/
Disallow: /calc_nst/service/
Disallow: /tilda/
Disallow: /members/
Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&utm_place&utm_referer&utm_ya_campaign&utm_etext

Sitemap: ${productionOrigin}/sitemap.xml
`;
await fs.writeFile(path.join(root, 'robots.production.txt'), productionRobots);
console.log(`SEO prepared: ${uniqueSitemapRoutes.length} indexable routes, ${files.length} HTML files inspected.`);
