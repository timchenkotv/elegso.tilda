import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { replaceWhatsapp } from '../scripts/replace-whatsapp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

function htmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith('.html') ? [full] : [];
  });
}

test('all published HTML pages are free of WhatsApp links and buttons', () => {
  for (const file of htmlFiles(root)) {
    const html = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /whatsapp|wa\.me/i, path.relative(root, file));
    assert.equal(replaceWhatsapp(html), html, path.relative(root, file));
  }
});

test('service contact strips retain a mail link and a phone link', () => {
  const homepage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(homepage, /class="t1036__item"><a class="[^"]*t1036__btn_email[^>]*href="mailto:mail@elegso\.ru"/);
  assert.match(homepage, /class="t1036__item"><a class="[^"]*t1036__btn_phone[^>]*href="tel:\+74958221920"/);
});
