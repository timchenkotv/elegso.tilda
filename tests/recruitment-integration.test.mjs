import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateRecruitment } from '../scripts/build-recruitment.mjs';
import { addRecruitmentNavigation } from '../scripts/recruitment-navigation.mjs';
import { siteHeader, siteFooter } from '../scripts/site-shell.mjs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const data = JSON.parse(read('content/recruitment-pages.json'));

test('recruiting data has ten unique real service routes with distinct substantive content', () => {
  assert.equal(validateRecruitment(data), data);
  assert.equal(data.pages.length, 10);
  assert.equal(new Set(data.pages.map(p => p.description)).size, data.pages.length);
  assert.equal(new Set(data.pages.map(p => p.intro.paragraphs.join(''))).size, data.pages.length);
});

test('unsafe routes, duplicate routes, anchors and pricing fail closed', () => {
  for (const mutate of [
    d => d.pages[1].route = '/../../admin/',
    d => d.pages[1].route = d.pages[0].route,
    d => d.pages[1].sections[0].id = 'prices',
    d => d.plans[0].percent = NaN,
    d => d.plans[1].id = d.plans[0].id,
  ]) {
    const copy = structuredClone(data); mutate(copy);
    assert.throws(() => validateRecruitment(copy));
  }
});

test('navigation insertion is idempotent, separate from legal cards and preserves body bytes', () => {
  const middle = '<main><h1>Расчёт</h1><p>Исходные данные и формулы</p></main>';
  const before = siteHeader() + middle + siteFooter();
  const after = addRecruitmentNavigation(before);
  for (const marker of ['desktop', 'mobile', 'footer']) assert.equal((after.match(new RegExp(`data-recruitment-${marker}-link`, 'g')) || []).length, 1);
  assert.ok(after.includes(middle));
  assert.equal(addRecruitmentNavigation(after), after);
  const hiring = '<!--header--><header></header><main>Кадровая страница</main><!--footer--><footer data-recruitment-footer></footer>';
  assert.equal(addRecruitmentNavigation(hiring), hiring);
});

test('generated recruiting pages are indexable static documents with privacy and isolated service chrome', () => {
  for (const page of data.pages) {
    const html = read(`www${page.route}index.html`);
    assert.match(html, /data-recruitment-footer/);
    assert.match(html, /data-elegso-privacy-config/);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://elegso.ru${page.route}">`));
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.doesNotMatch(html, /data-elegso-case-carousel|data-case-source|expert-grid|Позвонить юристу/);
    assert.match(html, /recruitment-hero\.webp/);
    assert.match(html, /recruitment\.css\?v=/);
  }
});
