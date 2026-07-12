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
await fs.writeFile(path.join(root, 'robots.production.txt'), liveRobots, 'utf8');
await fs.writeFile(path.join(root, 'sitemap.xml'), liveSitemap, 'utf8');

// The staging hostname must never compete with production in search results.
await fs.writeFile(path.join(root, 'robots.txt'), [
  'User-agent: *',
  'Disallow: /',
  '',
].join('\n'), 'utf8');

console.log('Finalized HTML metadata, staging robots and disabled forms.');
