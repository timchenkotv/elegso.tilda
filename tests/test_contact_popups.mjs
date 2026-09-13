import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contactPopupAssetVersion, disableAutomaticContactPopups, prepareManualContactPopups } from '../scripts/disable-contact-autopopups.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'www/assets/migration.js'), 'utf8');
const finalizer = fs.readFileSync(path.join(root, 'scripts/finalize-site.mjs'), 'utf8');
const contactFunction = (source) => source.slice(source.indexOf('function migrationInitContactPopups()'), source.indexOf('function migrationInitLeaseBalanceCalculator()'));

function element(attrs = {}, classes = []) {
  const names = new Set(classes);
  const events = new Map();
  return {
    attrs: { ...attrs }, events,
    classList: { add: (...values) => values.forEach((value) => names.add(value)), remove: (...values) => values.forEach((value) => names.delete(value)), contains: (value) => names.has(value) },
    getAttribute(name) { return this.attrs[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, handler) { events.set(name, [...(events.get(name) || []), handler]); },
    emit(name, event = {}) { (events.get(name) || []).forEach((handler) => handler(event)); },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

function runtime(hash = '') {
  const popup = element({ 'data-tooltip-hook': '#popup:zakhvat' }, ['t-popup']);
  const otherPopup = element({ 'data-tooltip-hook': '#popup:calculator', 'aria-hidden': 'original' }, ['t-popup']);
  const close = element();
  close.focus = () => { close.focused = true; };
  popup.querySelector = (selector) => selector === '.elegso-contact-card--popup' ? {} : selector === '.t-popup__close-wrapper' ? close : null;
  popup.querySelectorAll = () => [close];
  const manual = element({ href: '#popup:zakhvat' });
  const automatic = element({ href: '#popup:zakhvat', 'data-timeout': '10' }, ['t724__opener']);
  const other = element({ href: '#popup:calculator' });
  const document = element();
  document.body = element();
  document.querySelectorAll = (selector) => selector === '.t-popup' ? [popup, otherPopup] : selector === 'a[href^="#popup:"]' ? [manual, automatic, other] : [];
  document.querySelector = (selector) => selector === '.elegso-contact-popup--visible' && popup.classList.contains('elegso-contact-popup--visible') ? popup : null;
  const timers = [];
  const window = { location: { hash }, setTimeout: (callback, delay) => { timers.push({ callback, delay }); } };
  vm.runInNewContext(contactFunction(script) + '\nmigrationInitContactPopups();', { document, window });
  return { popup, otherPopup, close, manual, automatic, other, document, timers };
}

const popupHtml = (hook, contact = true) => `<div class="t-popup" data-tooltip-hook="${hook}"><section class="${contact ? 'elegso-contact-card elegso-contact-card--popup' : 'calculator-panel'}">Content</section></div>`;
const openerHtml = (id, hook) => `<div id="rec${id}" data-record-type="724"><div class="t724"><a href="${hook}" class="t724__opener" data-timeout="10"></a></div><script>t_onReady(function(){t_onFuncLoad('t724_init',function(){t724_init('${id}');});});</script></div>`;

test('contact controller is identical in the finalizer and deployed asset', () => {
  assert.equal(contactFunction(script), contactFunction(finalizer));
  assert.match(finalizer, /html = disableAutomaticContactPopups\(html\)/);
  assert.match(finalizer, /migration\.js\?v=\$\{contactPopupAssetVersion\}/);
});

test('loading a page never opens contacts or registers an automatic trigger, including an initial hash', () => {
  const state = runtime('#popup:zakhvat');
  assert.equal(state.popup.getAttribute('aria-hidden'), 'true');
  assert.equal(state.popup.classList.contains('elegso-contact-popup--visible'), false);
  assert.deepEqual(state.timers, []);
  assert.deepEqual([...state.document.events.keys()], ['keydown']);
  assert.equal(state.automatic.events.size, 0);
});

test('an explicit contact click opens the dialog and focuses its close button', () => {
  const state = runtime();
  let prevented = false;
  state.manual.emit('click', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(state.popup.getAttribute('aria-hidden'), 'false');
  assert.equal(state.popup.classList.contains('elegso-contact-popup--visible'), true);
  assert.equal(state.document.body.classList.contains('elegso-contact-popup-open'), true);
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].delay, 0); // Focus scheduling is not an auto-open timer.
  state.timers[0].callback();
  assert.equal(state.close.focused, true);
});

test('close button, overlay and Escape preserve manual closing', () => {
  for (const action of ['button', 'overlay', 'escape']) {
    const state = runtime();
    state.manual.emit('click', { preventDefault() {} });
    if (action === 'button') state.close.emit('click');
    if (action === 'overlay') state.popup.emit('click', { target: state.popup });
    if (action === 'escape') state.document.emit('keydown', { key: 'Escape' });
    assert.equal(state.popup.getAttribute('aria-hidden'), 'true', action);
    assert.equal(state.popup.classList.contains('elegso-contact-popup--visible'), false, action);
    assert.equal(state.document.body.classList.contains('elegso-contact-popup-open'), false, action);
  }
});

test('calculator or other non-contact popups and triggers are untouched', () => {
  const state = runtime();
  assert.equal(state.otherPopup.getAttribute('aria-hidden'), 'original');
  assert.equal(state.otherPopup.events.size, 0);
  assert.equal(state.other.events.size, 0);
});

test('HTML cleanup neutralizes only the contact automatic opener and init, retaining manual DOM', () => {
  const manual = '<a class="contact-button" href="#popup:zakhvat">Написать нам</a>';
  const unrelated = openerHtml('2', '#popup:calculator');
  const html = popupHtml('#popup:zakhvat') + openerHtml('1', '#popup:zakhvat') + manual + popupHtml('#popup:calculator', false) + unrelated;
  const result = disableAutomaticContactPopups(html);
  assert.ok(result.includes(popupHtml('#popup:zakhvat')));
  assert.ok(result.includes(manual));
  assert.ok(result.includes(unrelated));
  assert.ok(result.includes('data-elegso-disabled-popup-hook="#popup:zakhvat"'));
  assert.ok(result.includes('data-elegso-contact-auto-disabled="true"'));
  assert.ok(!result.includes("t724_init('1')"));
  assert.equal(disableAutomaticContactPopups(result), result);
});

test('cleanup remains safe when previously disabled and new automatic blocks share a page', () => {
  const first = disableAutomaticContactPopups(popupHtml('#popup:zakhvat') + openerHtml('1', '#popup:zakhvat'));
  const result = disableAutomaticContactPopups(first + openerHtml('3', '#popup:zakhvat'));
  assert.ok(!result.includes("t724_init('3')"));
  assert.equal((result.match(/data-elegso-contact-auto-disabled="true"/g) || []).length, 2);
  assert.equal(disableAutomaticContactPopups(result), result);
});

test('cache bust changes only migration script references, not inline prose or other assets', () => {
  const html = '<p>/assets/migration.js?v=old</p><script src="/assets/migration.js?v=old" defer></script><script src="/assets/calc-report-cutoff.js?v=old"></script>';
  const expected = html.replace('src="/assets/migration.js?v=old"', `src="/assets/migration.js?v=${contactPopupAssetVersion}"`);
  assert.equal(prepareManualContactPopups(html), expected);
  assert.equal(prepareManualContactPopups(expected), expected);
});

function publishedHtml(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || ['_external', 'api', 'admin'].includes(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? publishedHtml(filename) : entry.isFile() && entry.name.endsWith('.html') ? [filename] : [];
  });
}

test('all published pages are already clean and inherit the new shared asset version', () => {
  let pagesWithMigration = 0;
  for (const filename of publishedHtml(path.join(root, 'www'))) {
    const html = fs.readFileSync(filename, 'utf8');
    assert.ok(prepareManualContactPopups(html) === html, path.relative(root, filename));
    if (html.includes('/assets/migration.js?')) pagesWithMigration += 1;
  }
  assert.ok(pagesWithMigration > 30);
});

test('mission template propagates the new script to articles and server-published cases', () => {
  const mission = fs.readFileSync(path.join(root, 'www/mission/index.html'), 'utf8');
  const tail = mission.slice(mission.indexOf('<!--footer-->'));
  assert.ok(tail.includes(`/assets/migration.js?v=${contactPopupAssetVersion}`));
  const publications = fs.readFileSync(path.join(root, 'scripts/build-publications.mjs'), 'utf8');
  const cases = fs.readFileSync(path.join(root, 'ops/case-publisher/publish.py'), 'utf8');
  assert.match(publications, /mission\/index\.html/);
  assert.match(cases, /mission/);
});
