#!/usr/bin/env node
/** Keep the public phone, links and contact disclosure consistent on static pages. */
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('www');
const version = '20261023-1';
const css = `<link rel="stylesheet" href="/assets/contact-reveal.css?v=${version}">`;
const js = `<script src="/assets/contact-reveal.js?v=${version}" defer></script>`;

async function walk(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (target.endsWith('.html')) files.push(target);
  }
  return files;
}

for (const file of await walk(root)) {
  let html = await fs.readFile(file, 'utf8');
  const relative = path.relative(root, file).split(path.sep).join('/');
  // Published contract revisions retain their exact historical wording.
  if (!/^(?:oferta|oferta-fiz)\/versions\//.test(relative)) html = html
    .replaceAll('+74956460002', '+74958221920')
    .replaceAll('74956460002', '74958221920')
    .replaceAll('+7 (495) 646-00-02', '+7 (495) 822-19-20')
    .replaceAll('+7 495 646-00-02', '+7 495 822-19-20')
    .replaceAll('+7-495-646-00-02', '+7-495-822-19-20')
    .replaceAll('+7(495)646-00-02', '+7(495)822-19-20');
  if (!html.includes('</head>')) continue;
  html = html.replace(/<link\b[^>]*href=["']\/assets\/contact-reveal\.css[^"']*["'][^>]*>\s*/gi, '');
  html = html.replace(/<script\b[^>]*src=["']\/assets\/contact-reveal\.js[^"']*["'][^>]*><\/script>\s*/gi, '');
  html = html.replace('</head>', `${css}${js}</head>`);
  await fs.writeFile(file, html);
}
