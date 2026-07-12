#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('www');

async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result;
}

for (const file of await walk(root)) {
  if (!file.endsWith('.html')) continue;
  const rel = path.relative(root, file).split(path.sep).join('/');
  const route = rel === 'index.html'
    ? '/'
    : rel.endsWith('/index.html')
      ? `/${rel.slice(0, -'/index.html'.length)}`
      : `/${rel}`;
  const canonical = `https://elegso.ru${route}`;
  let html = await fs.readFile(file, 'utf8');

  html = html.replace(
    /(<link\s+rel=["']canonical["']\s+href=)["'][^"']*["']/i,
    `$1"${canonical}"`,
  );
  html = html.replace(
    /(<meta\s+property=["']og:url["']\s+content=)["'][^"']*["']/i,
    `$1"${canonical}"`,
  );

  // Tilda's CDN failover loader constructs regular expressions from absolute
  // CDN URLs. All required assets are local after migration, so the loader is
  // both unnecessary and incompatible with root-relative asset paths.
  html = html.replace(
    /\s*<script\s+src=["']\/_external\/neo\.tildacdn\.com\/js\/tilda-fallback-1\.0\.min\.js["'][^>]*><\/script>/gi,
    '',
  );
  html = html
    .replace(
      /\s*<script\s+[^>]*src=["'][^"']*\/tilda-(?:forms|lazyload|upwidget)-[^"']+\.js["'][^>]*><\/script>/gi,
      '',
    )
    .replace(
      /\s*<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?tilda-phone-mask-1\.1\.min\.js(?:(?!<\/script>)[\s\S])*?<\/script>/gi,
      '',
    );

  // Analytics must load current vendor code; local snapshots would silently
  // stop receiving fixes and can break dynamic query-string construction.
  html = html
    .replaceAll('/_external/mc.yandex.ru/metrika/tag.js', 'https://mc.yandex.ru/metrika/tag.js')
    .replaceAll('/_external/top-fwz1.mail.ru/js/code.js', 'https://top-fwz1.mail.ru/js/code.js')
    .replace(
      /\/_external\/www\.googletagmanager\.com\/gtm__q_[a-f0-9]+\.js/g,
      'https://www.googletagmanager.com/gtm.js?id=',
    )
    .replace(
      /\/_external\/www\.googletagmanager\.com\/ns__q_[a-f0-9]+\.html/g,
      'https://www.googletagmanager.com/ns.html?id=GTM-PBV2TC8',
    );

  // Some calculator scripts contain a literal </body> inside a printable HTML
  // template. Always target the final closing body tag, never the first one.
  html = html.replaceAll('<script src="/assets/migration.js" defer></script>', '');
  const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
  if (bodyEnd !== -1) {
    html = `${html.slice(0, bodyEnd)}<script src="/assets/migration.js" defer></script>${html.slice(bodyEnd)}`;
  }
  await fs.writeFile(file, html);
}

await fs.mkdir(path.join(root, 'assets'), { recursive: true });
await fs.writeFile(path.join(root, 'assets/migration.js'), `
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('img[data-original]').forEach((image) => {
    const source = image.getAttribute('data-original');
    if (source) image.src = source;
  });
  document.querySelectorAll('[data-content-cover-bg]').forEach((element) => {
    const source = element.getAttribute('data-content-cover-bg');
    if (source) element.style.backgroundImage = 'url("' + source + '")';
  });
  document.querySelectorAll('form').forEach((form) => {
    form.setAttribute('data-migration-form', 'disabled');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.alert('Форма временно не отправляет заявки. Пожалуйста, позвоните или напишите нам.');
    }, true);
  });
});
`, 'utf8');

const liveRobots = await fetch('https://elegso.ru/robots.txt').then((r) => {
  if (!r.ok) throw new Error(`robots.txt: HTTP ${r.status}`);
  return r.text();
});
const liveSitemap = await fetch('https://elegso.ru/sitemap.xml').then((r) => {
  if (!r.ok) throw new Error(`sitemap.xml: HTTP ${r.status}`);
  return r.text();
});

const feedUrl = 'https://feeds.tildaapi.com/api/getfeed/?feeduid=944414567261&recid=1282040271&size=&slice=1&sort%5Bdate%5D=desc&filters%5Bdate%5D=&getparts=true';
const feed = await fetch(feedUrl).then((r) => {
  if (!r.ok) throw new Error(`feed: HTTP ${r.status}`);
  return r.json();
});
const feedAssetMap = new Map();
async function localizeFeedValue(value) {
  if (typeof value === 'string' && /^https:\/\/[^/]*tildacdn\.com\//i.test(value)) {
    if (feedAssetMap.has(value)) return feedAssetMap.get(value);
    const url = new URL(value);
    const localUrl = `/_external/${url.host}${url.pathname}`;
    const destination = path.join(root, localUrl.slice(1));
    const response = await fetch(value);
    if (!response.ok) throw new Error(`feed asset ${value}: HTTP ${response.status}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    feedAssetMap.set(value, localUrl);
    return localUrl;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = await localizeFeedValue(value[i]);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = await localizeFeedValue(value[key]);
  }
  return value;
}
await localizeFeedValue(feed);
await fs.mkdir(path.join(root, 'api/getfeed'), { recursive: true });
await fs.writeFile(path.join(root, 'api/getfeed/index.html'), JSON.stringify(feed), 'utf8');

const feedScript = path.join(root, '_external/static.tildacdn.com/js/tilda-feed-1.1.min.js');
try {
  let source = await fs.readFile(feedScript, 'utf8');
  source = source.replaceAll(
    '"https://"+window.t_feeds_endpoint',
    'window.location.protocol+"//"+window.location.host',
  );
  await fs.writeFile(feedScript, source, 'utf8');
} catch {
  // Pages without a feed do not download this optional module.
}
await fs.writeFile(path.join(root, 'robots.production.txt'), liveRobots, 'utf8');
await fs.writeFile(path.join(root, 'sitemap.xml'), liveSitemap, 'utf8');

// The staging hostname must never compete with production in search results.
await fs.writeFile(path.join(root, 'robots.txt'), [
  'User-agent: *',
  'Disallow: /',
  '',
].join('\n'), 'utf8');

console.log('Finalized HTML metadata, staging robots and disabled forms.');
