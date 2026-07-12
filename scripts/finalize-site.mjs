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

  if (!html.includes('/assets/migration.js')) {
    html = html.replace(/<\/body>/i, '<script src="/assets/migration.js" defer></script></body>');
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
