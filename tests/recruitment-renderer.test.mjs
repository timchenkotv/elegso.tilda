import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderRecruitingPage } from '../scripts/recruitment-renderer.mjs';
import { esc } from '../scripts/site-shell.mjs';

const hub = {
  route: '/podbor_personala/', slug: 'podbor_personala', kind: 'hub',
  h1: 'Подбор персонала', title: 'Подбор персонала | ЭЛЕГСО', description: 'Поиск специалистов для бизнеса.',
  tagline: 'Люди под ваши задачи', lead: 'Исследуем потребности бизнеса.', roles: ['Юристы', 'Инженеры'],
  intro: { title: 'Задача бизнеса', paragraphs: ['Вникаем в функцию.', 'Проверяем опыт.'] },
  criteria: [{ title: 'Компетенции', text: 'Практика кандидата.' }],
  sections: [{ id: 'profile', title: 'Профиль вакансии', paragraphs: ['Первый абзац.', 'Второй абзац.', 'Полный статичный текст.'], bullets: ['Задачи', 'Опыт'] }],
  faq: [{ question: 'Как начать?', answer: 'Обсудить вакансию.' }],
};
const legal = { ...hub, route: '/podbor_yuristov/', slug: 'podbor_yuristov', kind: 'specialism', h1: 'Подбор юристов' };
const data = {
  pages: [hub, legal],
  plans: [
    { id: 'professional', title: 'Профессиональный', percent: 15, minFee: 120000, guaranteeDays: 60, summary: 'Для специалистов.', features: ['Поиск', 'Оценка'] },
    { id: 'expert', title: 'Экспертный', percent: 18, minFee: 180000, guaranteeDays: 90, summary: 'Для сложных функций.', features: ['Прямой поиск'] },
    { id: 'executive', title: 'Руководители', percent: 20, minFee: 250000, guaranteeDays: 120, summary: 'Для управленцев.', features: ['Оценка управления'] },
  ],
  linear: { price: 50000, guaranteeDays: 30, summary: 'Для линейных вакансий.' },
};

test('recruiting renderer publishes static full text and unique specialised metadata', () => {
  const html = renderRecruitingPage(legal, data);
  assert.match(html, /<h1[^>]*>Подбор юристов<\/h1>/);
  assert.match(html, /rel="canonical" href="https:\/\/elegso.ru\/podbor_yuristov\/"/);
  assert.match(html, /Полный статичный текст\./);
  assert.match(html, /<details class="recruitment-details">/);
  assert.match(html, /recruitment-hero-v3\.webp/);
  assert.match(html, /data-recruitment-calculator/);
  assert.match(html, /Доход в месяц до НДФЛ, ₽/);
  assert.match(html, /оклад и согласованные фиксированные надбавки/);
  assert.match(html, /годового фиксированного дохода/);
  assert.match(html, /не менее 120 000 ₽/);
  assert.match(html, /Гарантийный период — 60 календарных дней с первого рабочего дня/);
  assert.match(html, /Гарантийный период — 30 календарных дней с первого рабочего дня/);
  assert.match(html, /Один повторный подбор/);
  assert.match(html, /recruitment-assessment-v3-720\.webp 720w, \/assets\/redesign\/recruitment-assessment-v3\.webp 1200w/);
  assert.match(html, /sizes="\(max-width:767px\) 100vw, 50vw" width="1200" height="675"/);
  assert.match(html, /<output[^>]*>270 000 ₽<\/output>/);
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([^]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
  assert.equal(schemas[0]['@graph'].find(node => node['@type'] === 'Service').serviceType, 'Поиск и подбор персонала');
});

test('recruiting header, body and footer remain distinct from litigation promotion', () => {
  const html = renderRecruitingPage(hub, data);
  assert.match(html, /brand-caption">Подбор персонала/);
  assert.match(html, /data-recruitment-footer/);
  assert.match(html, /data-elegso-cookie-settings/);
  assert.match(html, /\/podbor_yuristov\//);
  assert.doesNotMatch(html, /data-elegso-case-carousel|data-case-source|\/cases\/|Тимченко|Калькулятор сальдо|Позвонить юристу|арбитражного юриста/);
  assert.doesNotMatch(html, /<form\b|<input[^>]*(?:email|tel)|type="file"/);
  assert.match(html, /Услуги ЭЛЕГСО/);
  assert.match(html, /mailto:mail@elegso\.ru/);
});

test('plain recruiting content cannot inject HTML or JSON-LD script endings', () => {
  const page = { ...hub, h1: '<img src=x onerror=alert(1)>', lead: '</script><script>alert(1)</script>' };
  const html = renderRecruitingPage(page, { ...data, pages: [page, legal] });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('every real recruiting page retains all authored copy and exact shared commercial terms', () => {
  const actual = JSON.parse(readFileSync(new URL('../content/recruitment-pages.json', import.meta.url), 'utf8'));
  for (const page of actual.pages) {
    const html = renderRecruitingPage(page, actual);
    const allCopy = [page.h1, page.tagline, page.lead, page.intro.title, ...page.intro.paragraphs, ...page.roles,
      ...page.criteria.flatMap(item => [item.title, item.text]),
      ...page.sections.flatMap(item => [item.title, ...item.paragraphs, ...(item.bullets || [])]),
      ...page.faq.flatMap(item => [item.question, item.answer]), actual.pricingBasis, actual.paymentTerms, actual.guaranteeTerms];
    for (const text of allCopy) assert.ok(html.includes(esc(text)), page.route + ': missing ' + text.slice(0, 70));
    assert.doesNotMatch(html, /data-elegso-case-carousel|\/cases\//, page.route);
    assert.match(html, /class="ym-disable-keys" data-recruitment-salary/);
    assert.doesNotMatch(html, /сумма на сервер не отправляется/);
    assert.match(html, /value="legal"[^>]*selected/);
    assert.ok(html.includes('324 000 ₽'));
  }
});

function calculatorMount() {
  const events = () => ({ listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, emit(name) { this.listeners.get(name)?.(); } });
  const salary = { ...events(), value: '150000', attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } };
  const plan = { ...events(), selectedOptions: [{ dataset: { percent: '15', minimum: '120000' } }] };
  const fee = { textContent: '' }, formula = { textContent: '' }, status = { textContent: '' };
  const elements = { '[data-recruitment-salary]': salary, '[data-recruitment-plan]': plan, '[data-recruitment-fee]': fee, '[data-recruitment-formula]': formula, '[data-recruitment-calculator-status]': status };
  const calculator = { querySelector: selector => elements[selector] };
  const script = readFileSync(new URL('../www/assets/redesign/recruitment.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, { document: { querySelectorAll: () => [calculator] } });
  return { salary, plan, fee, formula, status, script };
}

test('client calculator respects annual gross basis and minimum fee', () => {
  const app = calculatorMount();
  assert.equal(app.fee.textContent, '270 000 ₽');
  app.salary.value = '10000'; app.salary.emit('input');
  assert.equal(app.fee.textContent, '120 000 ₽');
  app.salary.value = '150000';
  app.plan.selectedOptions[0].dataset.percent = '20'; app.plan.emit('change');
  assert.equal(app.fee.textContent, '360 000 ₽');
});

test('invalid calculator values are cleared without storage, tracking or network', () => {
  const app = calculatorMount();
  for (const value of ['', '-10', 'not-a-number', '10000001', 'Infinity']) {
    app.salary.value = value; app.salary.emit('input');
    assert.equal(app.fee.textContent, '—');
    assert.equal(app.salary.attributes.get('aria-invalid'), 'true');
    assert.ok(app.status.textContent);
  }
  assert.doesNotMatch(app.script, /fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|\bym\s*\(/);
});
