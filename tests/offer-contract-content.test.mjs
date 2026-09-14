import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/offers.json')));
const current = config.offers.find(offer => !offer.retired);
const document = JSON.parse(fs.readFileSync(path.join(root, 'content/offers', current.id, current.currentVersion + '.json')));
const clauses = new Map(document.sections.flatMap(section => section.clauses.map(clause => [clause.number, clause.html])));

test('recruitment terms remain exclusively in section 12 of the current contract', () => {
  for (const [number, html] of clauses) {
    if (!number.startsWith('12.')) assert.doesNotMatch(html, /кадр|найм|раздел[ауе] 12|250 000/i, number);
  }
  assert.match(clauses.get('12.1'), /250 000/);
  assert.match(clauses.get('12.15'), /образовании, квалификации, опыте/);
});

test('invoice is a legal assignment without a mandatory version identifier', () => {
  assert.match(clauses.get('1.3'), /Счёт Исполнителя является юридическим заданием/);
  assert.match(clauses.get('1.3'), /Счёт на доплату или окончательный расчёт относится к ранее принятому поручению/);
  assert.match(clauses.get('2.1'), /действующая на дату совершения акцептующего действия/);
  assert.doesNotMatch(clauses.get('2.1'), /обозначение применимой редакции|указание номера редакции/);
});

test('business payment order is agreed FIFO with assignment and correspondence overrides', () => {
  const html = clauses.get('6.7');
  for (const phrase of ['наиболее ранним сроком оплаты', 'возникшее ранее', 'пропорционально суммам',
    'Назначение платежа, указанное плательщиком в одностороннем порядке, эту очерёдность не изменяет',
    'юридическим заданием или согласован Сторонами в переписке',
    'Для Заказчика-потребителя', 'по указанному им обязательству',
    'неустойка и проценты как мера ответственности погашаются после основного долга',
    'целевые расходы используются по их назначению']) assert.ok(html.includes(phrase), phrase);
  assert.match(clauses.get('2.4'), /пункту 6.7/);
});

test('official email includes company domain and later actual customer correspondence', () => {
  assert.match(clauses.get('3.1'), /любым именем до знака «@»/);
  assert.match(clauses.get('3.1'), /elegso.ru/);
  assert.match(clauses.get('3.8'), /прежним, так и по новым/);
  assert.match(clauses.get('3.8'), /без отдельного соглашения и обязательного дублирования/);
  assert.match(clauses.get('3.2'), /утрате контроля/);
  assert.match(clauses.get('3.4'), /компрометации/);
  assert.match(clauses.get('3.6'), /момента доставки/);
});

test('removed administrative preflight wording does not return', () => {
  const html = [...clauses.values()].join(' ');
  for (const phrase of ['Полномочия неизвестного отправителя подлежат проверке',
    'Должны определяться участник, содержание и относимость',
    'Документ доставляется по одному согласованному каналу',
    'проверяет содержание поручения, наличие ресурсов',
    'Стороны сохраняют принятую редакцию и доказательства согласования']) assert.ok(!html.includes(phrase), phrase);
});

test('business update mechanism preserves agreed assignments and an early exit', () => {
  assert.match(clauses.get('14.2'), /десяти календарных дней/);
  assert.match(clauses.get('14.2'), /без подписания дополнительного соглашения/);
  assert.match(clauses.get('14.3'), /Индивидуально согласованные условия задания/);
  assert.match(clauses.get('14.3'), /без месячного срока предупреждения/);
  assert.match(clauses.get('9.2'), /пункта 14.3/);
});

test('consumer may accept a new assignment or agree existing changes in writing', () => {
  const html = clauses.get('14.4');
  for (const phrase of ['К новому юридическому заданию или счёту',
    'письменным соглашением Сторон', 'по электронной почте',
    'принятием нового задания или счёта, прямо определяющего согласованные изменения',
    'пункта 2.2', 'пункта 5.9', 'Отдельное подписание полного текста оферты не требуется']) assert.ok(html.includes(phrase), phrase);
});

test('additional necessary work is disclosed and emergency authority is bounded', () => {
  assert.match(clauses.get('5.4'), /больший объём работы/);
  assert.match(clauses.get('5.5'), /Отдельное оформление каждого действия не требуется/);
  const emergency = clauses.get('5.6');
  for (const phrase of ['реальную угрозу', 'получить ответ не удалось',
    'без дополнительного согласования', 'в пределах цели задания, предоставленных полномочий',
    'установленных Заказчиком ограничений',
    'Заказчик заранее поручает', 'соразмерный угрозе объём',
    'при первой возможности', 'отражаются в акте',
    'твёрдая цена и предельный бюджет сохраняются',
    'оплачивается в порядке раздела 6']) assert.ok(emergency.includes(phrase), phrase);
  assert.doesNotMatch(emergency, /Для Заказчика-потребителя|Для предпринимательских отношений/);
  assert.match(clauses.get('5.9'), /подтверждает согласие письменно/);
});
