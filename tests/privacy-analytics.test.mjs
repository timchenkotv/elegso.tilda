import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyPrivacyAnalytics, privacyInventory, validatePrivacyConfig, loadPrivacyBuild, publicHtmlFiles } from '../scripts/privacy-analytics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/site-privacy.json'), 'utf8'));
const runtimeCode = fs.readFileSync(path.join(root, 'www/assets/site-privacy.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'www/assets/site-privacy.css'), 'utf8');
const build = { config, assetVersion: 'test123' };
const receipt = (choiceId, analytics) => ({ choice_id: choiceId, version: config.consentVersion, analytics,
  recorded_at: new Date().toISOString(), expires_at: new Date(Date.now() + 180 * 86400000).toISOString(), retain_until: new Date(Date.now() + 365 * 86400000).toISOString() });
const choice = (analytics, overrides = {}) => { const choiceId = randomUUID(); return { version: config.consentVersion, necessary: true, analytics, choiceId, receipt: receipt(choiceId, analytics),
  updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(), ...overrides }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function node() {
  const events = new Map();
  return {
    events, attrs: {}, children: [], hidden: false, checked: false, textContent: '', isConnected: true,
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { events.set(name, [...(events.get(name) || []), callback]); },
    emit(name, event = {}) { (events.get(name) || []).forEach(callback => callback(event)); },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.isConnected = false; },
    focus() { this.focused = true; },
  };
}
function runtime({ stored = null, storageBlocked = false, receiptFailure = false, manualReceipts = false } = {}) {
  const storage = new Map(stored ? [[config.storageKey, JSON.stringify(stored)]] : []);
  const session = new Map();
  const storageApi = (map, blocked = false) => ({
    get length() { return map.size; }, key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { if (blocked) throw new Error('blocked'); return map.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('blocked'); map.set(key, value); },
    removeItem(key) { if (blocked) throw new Error('blocked'); map.delete(key); },
  });
  const cookieJar = new Map([['_ym_uid', 'old'], ['_ga', 'old'], ['tmr_lvid', 'old'], ['sid', 'keep'], ['calculator_sid', 'keep']]);
  const deletedCookies = [];
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const window = Object.assign(node(), {
    location: { href: 'https://elegso.ru/calc_nst/?private=value#report', origin: 'https://elegso.ru', hostname: 'elegso.ru', pathname: '/calc_nst/', protocol: 'https:' },
    localStorage: storageApi(storage, storageBlocked), sessionStorage: storageApi(session, storageBlocked),
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    crypto: { randomUUID },
    fetch(url, options) {
      const payload = JSON.parse(options.body);
      const request = { url, options, payload };
      requests.push(request);
      if (receiptFailure) return Promise.reject(new Error('offline'));
      const response = { ok: true, json: async () => ({ receipt: receipt(payload.choice_id, payload.analytics) }) };
      if (manualReceipts) return new Promise(resolve => { request.resolve = () => resolve(response); });
      return Promise.resolve(response);
    },
  });
  const controls = new Map();
  const document = Object.assign(node(), {
    head: node(), body: node(), title: 'Калькулятор неустойки', referrer: 'https://yandex.ru/search/?text=private-query',
    querySelector(selector) { return selector === '[data-elegso-privacy-config]' ? { textContent: JSON.stringify(config) } : null; },
    createElement(tag) {
      const result = node(); result.tagName = tag;
      if (tag === 'section') {
        for (const key of ['analytics', 'settings', 'status', 'accept', 'reject', 'save', 'close']) controls.set(`[data-esp-${key}]`, node());
        controls.set('[id="esp-options"]', Object.assign(node(), { hidden: true }));
        result.querySelector = selector => controls.get(selector);
      }
      return result;
    },
  });
  Object.defineProperty(document, 'cookie', {
    get() { return [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; '); },
    set(value) { const name = value.split('=', 1)[0]; deletedCookies.push(name); if (/Max-Age=0/.test(value)) cookieJar.delete(name); },
  });
  vm.runInNewContext(runtimeCode, { window, document, URL, Date, AbortController, Uint8Array });
  const calls = [];
  const panel = document.body.children[0];
  return { window, document, controls, panel, calls, storage, session, cookieJar, deletedCookies, timers, requests,
    click(name) { controls.get(`[data-esp-${name}]`).emit('click'); },
    finishLoad() { const loader = document.head.children.find(item => item.tagName === 'script'); assert.ok(loader); window.ym = (...args) => calls.push(args); loader.onload(); },
    openSettings() { const trigger = node(); document.emit('click', { target: { closest: () => trigger }, preventDefault() {} }); return trigger; },
  };
}

test('default and malformed, outdated or expired choices fail closed without analytics requests', () => {
  for (const stored of [null, choice(true, { version: 'old' }), choice(true, { receipt: null }), choice(true, { expiresAt: '2020-01-01T00:00:00Z' }), choice('true'), choice(true, { necessary: false })]) {
    const state = runtime({ stored });
    assert.equal(state.document.head.children.length, 0);
    assert.equal(state.window.ym, undefined);
    assert.equal(state.requests.length, 0);
    assert.equal(state.panel.hidden, false);
    assert.equal(state.controls.get('[data-esp-analytics]').checked, false);
    assert.equal(state.cookieJar.get('sid'), 'keep');
    assert.equal(state.cookieJar.get('calculator_sid'), 'keep');
    assert.equal(state.cookieJar.has('_ym_uid'), false);
  }
});

test('closing the non-modal panel or pressing Escape is not consent', () => {
  const state = runtime();
  state.click('close');
  assert.equal(state.panel.hidden, true);
  assert.equal(state.storage.size, 0);
  assert.equal(state.document.head.children.length, 0);
  state.openSettings();
  state.document.emit('keydown', { key: 'Escape' });
  assert.equal(state.panel.hidden, true);
  assert.equal(state.storage.size, 0);
});

test('explicit opt-in loads one counter only after receipt and sends sanitized pageview metadata', async () => {
  const state = runtime();
  state.click('accept');
  state.click('accept');
  assert.equal(state.document.head.children.length, 0);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].url, '/api/privacy/consent');
  assert.deepEqual(Object.keys(state.requests[0].payload).sort(), ['analytics', 'choice_id', 'version']);
  assert.equal(state.requests[0].options.referrerPolicy, 'no-referrer');
  await flush();
  assert.equal(state.document.head.children.length, 1);
  assert.equal(state.document.head.children[0].src, 'https://mc.yandex.ru/metrika/tag.js');
  assert.equal(state.calls.length, 0);
  state.finishLoad();
  assert.equal(state.calls.length, 2);
  const [init, hit] = state.calls;
  assert.equal(init[0], 87831358); assert.equal(init[1], 'init');
  assert.equal(init[2].defer, true);
  for (const key of ['webvisor', 'clickmap', 'trackLinks', 'accurateTrackBounce', 'ecommerce', 'trackHash', 'childIframe', 'sendTitle']) assert.equal(init[2][key], false, key);
  assert.equal(hit[1], 'hit');
  assert.equal(hit[2], 'https://elegso.ru/calc_nst/');
  assert.equal(hit[3].referer, 'https://yandex.ru/search/');
  assert.ok(!JSON.stringify(state.calls).includes('private'));
  const stored = JSON.parse(state.storage.get(config.storageKey));
  assert.equal(stored.analytics, true);
  assert.deepEqual(Object.keys(stored).sort(), ['analytics', 'choiceId', 'expiresAt', 'necessary', 'receipt', 'updatedAt', 'version']);
  assert.ok([...state.timers.values()].every(timer => timer.delay <= 2147483647));
});

test('rejection persists the default-off choice and does not create a remote loader', async () => {
  const state = runtime();
  state.click('reject');
  assert.equal(JSON.parse(state.storage.get(config.storageKey)).analytics, false);
  assert.equal(state.document.head.children.length, 0);
  await flush();
  assert.equal(state.panel.hidden, true);
});

test('successful receipt clears saving status and reopening settings does not show stale errors', async () => {
  const state = runtime();
  state.click('accept'); await flush();
  assert.equal(state.controls.get('[data-esp-status]').textContent, '');
  state.openSettings();
  assert.equal(state.controls.get('[data-esp-status]').textContent, '');
  state.click('accept');
  assert.equal(state.requests.length, 1);
  const failed = runtime({ receiptFailure: true });
  failed.click('accept'); await flush();
  assert.notEqual(failed.controls.get('[data-esp-status]').textContent, '');
  failed.openSettings();
  assert.equal(failed.controls.get('[data-esp-status]').textContent, '');
});

test('prior valid opt-in works, while prior refusal keeps the banner quiet and statistics disabled', () => {
  const allowed = runtime({ stored: choice(true) });
  assert.equal(allowed.document.head.children.length, 1);
  assert.equal(allowed.panel.hidden, true);
  const denied = runtime({ stored: choice(false) });
  assert.equal(denied.document.head.children.length, 0);
  assert.equal(denied.panel.hidden, true);
});

test('withdrawal uses destruct, removes accessible analytics cookies and preserves calculator state', async () => {
  const state = runtime();
  state.click('accept'); await flush(); state.finishLoad();
  state.cookieJar.set('_ym_uid', 'new');
  const trigger = state.openSettings();
  assert.equal(state.controls.get('[data-esp-analytics]').checked, true);
  state.controls.get('[data-esp-analytics]').checked = false;
  state.click('save');
  assert.equal(state.calls.at(-1)[1], 'destruct');
  assert.equal(state.document.head.children.length, 0);
  assert.equal(state.cookieJar.has('_ym_uid'), false);
  assert.equal(state.cookieJar.get('sid'), 'keep');
  assert.equal(state.cookieJar.get('calculator_sid'), 'keep');
  assert.equal(state.requests[0].payload.choice_id, state.requests[1].payload.choice_id);
  await flush();
  assert.equal(trigger.focused, true);
  assert.equal(JSON.parse(state.storage.get(config.storageKey)).analytics, false);
});

test('withdrawal while the vendor script is still loading prevents its late initialization', async () => {
  const state = runtime();
  state.click('accept');
  await flush();
  const pendingLoad = state.document.head.children[0].onload;
  state.click('reject');
  state.window.ym = (...args) => state.calls.push(args);
  pendingLoad();
  assert.equal(state.calls.length, 0);
  assert.equal(state.document.head.children.length, 0);
});

test('withdrawal is synchronized across browser tabs through the storage event', () => {
  const state = runtime({ stored: choice(true) });
  state.finishLoad();
  state.storage.set(config.storageKey, JSON.stringify(choice(false)));
  state.window.emit('storage', { key: config.storageKey });
  assert.equal(state.calls.at(-1)[1], 'destruct');
  assert.equal(state.document.head.children.length, 0);
});

test('blocked storage stays default-off; confirmed choice affects only this page without clearing other data', async () => {
  const state = runtime({ storageBlocked: true });
  assert.equal(state.document.head.children.length, 0);
  state.click('accept');
  await flush();
  assert.equal(state.document.head.children.length, 1);
  assert.equal(state.storage.size, 0);
  assert.equal(state.cookieJar.get('calculator_sid'), 'keep');
});

test('failed receipt fails closed without hanging; withdrawal is immediate even offline', async () => {
  const grant = runtime({ receiptFailure: true });
  grant.click('accept'); await flush();
  assert.equal(grant.document.head.children.length, 0);
  assert.equal(JSON.parse(grant.storage.get(config.storageKey)).analytics, false);
  assert.match(grant.controls.get('[data-esp-status]').textContent, /Аналитика не включена/);
  assert.equal(grant.panel.hidden, false);
  const revoke = runtime({ stored: choice(true), receiptFailure: true });
  revoke.finishLoad(); revoke.click('reject');
  assert.equal(revoke.calls.at(-1)[1], 'destruct');
  assert.equal(revoke.document.head.children.length, 0);
  await flush();
  assert.equal(JSON.parse(revoke.storage.get(config.storageKey)).analytics, false);
  assert.match(revoke.controls.get('[data-esp-status]').textContent, /не мешает отзыву/);
});

test('late grant acknowledgement cannot re-enable analytics after withdrawal', async () => {
  const state = runtime({ manualReceipts: true });
  state.click('accept'); state.click('reject');
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0].payload.choice_id, state.requests[1].payload.choice_id);
  state.requests[0].resolve(); await flush();
  assert.equal(state.document.head.children.length, 0);
  state.requests[1].resolve(); await flush();
  assert.equal(JSON.parse(state.storage.get(config.storageKey)).analytics, false);
  assert.equal(state.document.head.children.length, 0);
});

test('withdrawal deletes only analytics storage keys and preserves calculator drafts and consent', async () => {
  const state = runtime({ stored: choice(true) });
  state.storage.set('_ym12345', 'vendor'); // _ym without separator is not a documented owned key.
  state.storage.set('_ym_uid', 'vendor');
  state.storage.set('calc_nst_draft', 'draft');
  state.session.set('_ym_session', 'vendor');
  state.session.set('calculator_sid', 'sid');
  state.click('reject');
  assert.equal(state.storage.has('_ym_uid'), false);
  assert.equal(state.session.has('_ym_session'), false);
  assert.equal(state.storage.get('calc_nst_draft'), 'draft');
  assert.equal(state.session.get('calculator_sid'), 'sid');
  assert.equal(state.storage.has(config.storageKey), true);
  await flush();
});

test('Tilda UTM autosave is disabled idempotently without removing UI helpers', () => {
  const original = '<html><head></head><body><div id="allrecords" data-tilda-cookie="yes"><p>Text</p></div><script src="/_external/static.tildacdn.com/js/tilda-events-1.0.min.js"></script></body></html>';
  const result = applyPrivacyAnalytics(original, build);
  assert.match(result, /id="allrecords" data-tilda-cookie="no"/);
  assert.ok(result.includes('tilda-events-1.0.min.js'));
  assert.equal(applyPrivacyAnalytics(result, build), result);
});

test('cleanup removes legacy executable trackers and pixels while preserving documents and local assets', () => {
  const html = `<html><head><link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Ubuntu"><script src="https://www.googletagmanager.com/gtag/js?id=G-123"></script><script>gtag('config','G-123');</script><script>var _tmr=[];_tmr.push({id:3662487});</script><script>ym(87831358,'init',{webvisor:true});</script><script>setTimeout(()=>load('/_external/static.tildacdn.com/js/tilda-stat-1.0.min.js'),2000)</script><script type="application/ld+json">{"citation":"https://www.google.com/legal"}</script></head><body><p>Текст договора</p><a href="https://www.google.com/legal">Источник статьи</a><img src="/_external/example/google-shaped-logo.png"><script>const API=location.origin+'/calc_nst/service';</script><noscript><div><img src="https://mc.yandex.ru/watch/87831358"></div></noscript><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-PBV2TC8"></iframe></noscript></body></html>`;
  const result = applyPrivacyAnalytics(html, build);
  assert.equal(privacyInventory(result).resources.length, 0);
  assert.equal(privacyInventory(result).inlineTrackers.length, 0);
  assert.ok(result.includes('<p>Текст договора</p>'));
  assert.ok(result.includes('<a href="https://www.google.com/legal">Источник статьи</a>'));
  assert.ok(result.includes('/_external/example/google-shaped-logo.png'));
  assert.ok(result.includes("const API=location.origin+'/calc_nst/service'"));
  assert.equal((result.match(/data-elegso-privacy-config/g) || []).length, 1);
  assert.equal(applyPrivacyAnalytics(result, build), result);
});

test('all current pages can be cleaned idempotently in memory with no article text mutation', async () => {
  const bundle = await loadPrivacyBuild(root);
  for (const filename of await publicHtmlFiles(path.join(root, 'www'))) {
    const original = fs.readFileSync(filename, 'utf8');
    const cleaned = applyPrivacyAnalytics(original, bundle);
    assert.ok(applyPrivacyAnalytics(cleaned, bundle) === cleaned, filename);
    assert.equal(privacyInventory(cleaned).inlineTrackers.length, 0, filename);
    assert.equal(privacyInventory(cleaned).resources.length, 0, filename);
    const article = original.match(/<article class="(?:eo-document|ep-article)[^>]*>[\s\S]*?<\/article>/)?.[0];
    if (article) assert.ok(cleaned.includes(article), filename);
  }
});

test('configuration rejects extra providers and behavioral tracking; banner has accessible alternatives', () => {
  for (const analytics of [{ ...config.analytics, provider: 'google' }, { ...config.analytics, webvisor: true }, { ...config.analytics, defaultEnabled: true }]) assert.throws(() => validatePrivacyConfig({ ...config, analytics }));
  assert.ok(runtimeCode.includes('data-esp-accept>Разрешить</button>'));
  assert.ok(runtimeCode.includes('data-esp-reject>Отклонить</button>'));
  assert.ok(runtimeCode.includes('href="/consent/"'));
  assert.ok(runtimeCode.includes('data-elegso-cookie-settings'));
  assert.ok(runtimeCode.includes('setAttribute(\'role\', \'region\')'));
  assert.ok(!runtimeCode.includes('aria-modal'));
  assert.match(css, /min-height:44px/);
  assert.match(css, /@media print \{ \.esp-panel \{ display:none!important; \} \}/);
});

test('compact notice keeps explicit purpose and puts detailed links inside settings', () => {
  const state = runtime();
  const markup = state.panel.innerHTML;
  assert.match(markup, /Разрешить cookie для статистики сайта\?/);
  assert.match(markup, /href="\/consent\/">Подробнее<\/a>/);
  assert.ok(!markup.includes('Яндекс'));
  const initial = markup.split('<div class="esp-options"')[0];
  assert.ok(!initial.includes('Политика обработки данных'));
  assert.ok(initial.includes('data-esp-accept>Разрешить'));
  assert.ok(initial.includes('data-esp-reject>Отклонить'));
  state.click('settings');
  assert.equal(state.controls.get('[id="esp-options"]').hidden, false);
  state.click('settings');
  assert.equal(state.controls.get('[id="esp-options"]').hidden, true);
  assert.equal(state.requests.length, 0);
  assert.match(css, /width:min\(520px,calc\(100% - 24px\)\)/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\) auto/);
  assert.match(css, /max-height:calc\(100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
});

test('local fonts and future case/finalize generators cannot reintroduce Google Fonts', () => {
  const fonts = fs.readFileSync(path.join(root, 'www/assets/site-fonts.css'), 'utf8');
  assert.ok(!/https?:|@import/.test(fonts));
  for (const match of fonts.matchAll(/url\('([^']+)'\)/g)) assert.ok(fs.existsSync(path.join(root, 'www', match[1])));
  assert.ok(fs.existsSync(path.join(root, 'www/assets/fonts/Ubuntu-LICENCE.txt')));
  assert.ok(fs.existsSync(path.join(root, 'www/assets/fonts/Prata-OFL.txt')));
  const cases = fs.readFileSync(path.join(root, 'ops/case-publisher/publish.py'), 'utf8');
  assert.ok(!cases.includes('https://fonts.googleapis.com'));
  assert.ok(cases.includes('/assets/site-fonts.css'));
  const finalizer = fs.readFileSync(path.join(root, 'scripts/finalize-site.mjs'), 'utf8');
  assert.ok(finalizer.includes('html = applyPrivacyAnalytics(html, privacyBuild)'));
});
