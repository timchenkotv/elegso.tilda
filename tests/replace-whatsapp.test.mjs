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
  if (homepage.includes('data-elegso-modern-footer')) {
    const cards = [...homepage.matchAll(/<a\b(?=[^>]*\bclass="[^"]*\bcontact-card\b)[^>]*>[\s\S]*?<\/a>/g)].map(match => match[0]);
    const mail = cards.find(card => /href="mailto:mail@elegso\.ru"/.test(card));
    const phone = cards.find(card => /href="tel:\+74958221920"/.test(card));
    assert.ok(mail, 'Modern shared contact block must retain the actual mail action');
    assert.ok(phone, 'Modern shared contact block must retain the actual telephone action');
    assert.match(mail.replace(/<[^>]*>/g, ' '), /mail@elegso\.ru/);
    assert.match(phone.replace(/<[^>]*>/g, ' '), /\+7\s*\(495\)\s*822-19-20/);
  } else {
    // Legacy output remains supported by the migration utility.
    assert.match(homepage, /class="t1036__item"><a class="[^"]*t1036__btn_email[^>]*href="mailto:mail@elegso\.ru"/);
    assert.match(homepage, /class="t1036__item"><a class="[^"]*t1036__btn_phone[^>]*href="tel:\+74958221920"/);
  }
});
