import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'www/assets/offers.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'www/assets/offers.css'), 'utf8');

function target() {
  const events = new Map();
  const attrs = new Map();
  return {
    events, attrs,
    addEventListener(name, handler) { events.set(name, [...(events.get(name) || []), handler]); },
    emit(name, event = {}) { (events.get(name) || []).forEach(handler => handler(event)); },
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
  };
}

function fixture(width = 1440, height = 900, { headerHeight = 0, reducedMotion = true } = {}) {
  const frames = [];
  const desktop = Object.assign(target(), { matches: width >= 981 });
  const window = Object.assign(target(), {
    innerWidth: width, innerHeight: height, scrollY: 0,
    matchMedia: query => query.includes('min-width') ? desktop : { matches: reducedMotion },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    scrollCalls: [],
    scrollTo(options) { this.scrollCalls.push(options); this.scrollY = options.top; },
    history: { hash: '', replaceState(_state, _title, hash) { this.hash = hash; } },
    print() {},
  });
  const details = Object.assign(target(), { open: true });
  const toc = Object.assign(target(), {
    clientHeight: 280, scrollHeight: 1040, scrollTop: 0,
    getBoundingClientRect() { return { top: headerHeight + 24, bottom: headerHeight + 24 + this.clientHeight }; },
  });
  const nav = Object.assign(target(), {
    clientHeight: Math.min(height * .55, 430), scrollHeight: 980, scrollTop: 0,
    getBoundingClientRect() { return { top: headerHeight + 62, bottom: headerHeight + 62 + this.clientHeight }; },
  });
  const sections = Array.from({ length: 20 }, (_, index) => ({
    id: `section-${index + 1}`,
    getBoundingClientRect: () => ({ top: 1000 + index * 500 - window.scrollY }),
  }));
  const links = sections.map((section, index) => Object.assign(target(), {
    hash: `#${section.id}`,
    getBoundingClientRect() {
      const viewport = desktop.matches ? toc : nav;
      const top = viewport.getBoundingClientRect().top + (desktop.matches ? 60 : 0) + index * 44 - viewport.scrollTop;
      return { top, bottom: top + 44 };
    },
  }));
  toc.querySelector = selector => selector === 'details' ? details : selector === 'nav' ? nav : null;
  toc.querySelectorAll = () => links;
  const documentBody = { getBoundingClientRect: () => ({ top: 1000 - window.scrollY, height: 11000 }) };
  const progress = { style: {} };
  const print = Object.assign(target(), { hidden: true });
  const main = {
    style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
    querySelector: selector => ({ '.eo-toc': toc, '.eo-document': documentBody, '[data-eo-progress]': progress, '[data-eo-print]': print })[selector] || null,
    querySelectorAll: () => sections,
  };
  const headerPanel = {
    classList: { contains: name => name === 't228' },
    getBoundingClientRect: () => ({ width: window.innerWidth, height: headerHeight, top: 0, bottom: headerHeight }),
  };
  const header = { querySelectorAll: () => headerHeight ? [headerPanel] : [] };
  const document = {
    documentElement: { scrollHeight: 15000 },
    querySelector: () => main,
    getElementById: id => id === 't-header' ? header : sections.find(section => section.id === id),
  };
  vm.runInNewContext(script, { document, window, getComputedStyle: () => ({ display: 'block', visibility: 'visible', position: 'fixed' }) });
  const flush = () => { while (frames.length) frames.shift()(); };
  flush();
  return { window, desktop, details, toc, nav, links, sections, main, flush,
    scrollToSection(index) { window.scrollY = 1000 + index * 500 - headerHeight - 50; window.emit('scroll'); flush(); },
  };
}

test('contents mode matches every requested phone, tablet and desktop breakpoint', () => {
  for (const [width, height] of [[320, 640], [390, 844], [600, 900], [768, 1024], [800, 600], [1024, 768], [1440, 900]]) {
    const state = fixture(width, height);
    assert.equal(state.details.open, width >= 981, `${width}×${height}`);
    assert.equal(state.links[0].attrs.get('aria-current'), 'location');
    assert.equal(state.window.scrollCalls.length, 0);
  }
});

test('scrollspy keeps a newly active desktop link inside only the contents viewport', () => {
  const state = fixture(1024, 768);
  state.scrollToSection(12);
  assert.equal(state.links[12].attrs.get('aria-current'), 'location');
  assert.equal(state.links[0].attrs.has('aria-current'), false);
  assert.ok(state.toc.scrollTop > 0);
  const rect = state.links[12].getBoundingClientRect();
  const bounds = state.toc.getBoundingClientRect();
  assert.ok(rect.top >= bounds.top && rect.bottom <= bounds.bottom);
  assert.equal(state.nav.scrollTop, 0);
  assert.equal(state.window.scrollCalls.length, 0);
});

test('independent contents scrolling is not overridden while the active section stays the same', () => {
  const state = fixture();
  state.scrollToSection(12);
  state.toc.scrollTop = 0; // Reader intentionally browses the earlier links.
  state.window.emit('scroll');
  state.flush();
  assert.equal(state.toc.scrollTop, 0);
  state.window.scrollY += 5;
  state.window.emit('scroll');
  state.flush();
  assert.equal(state.toc.scrollTop, 0);
});

test('resize rechecks visibility even when the active section has not changed', () => {
  const state = fixture();
  state.scrollToSection(12);
  state.toc.scrollTop = 0;
  state.toc.clientHeight = 180;
  state.window.emit('resize');
  state.flush();
  assert.ok(state.toc.scrollTop > 0);
  assert.ok(state.links[12].getBoundingClientRect().bottom <= state.toc.getBoundingClientRect().bottom);
  assert.equal(state.window.scrollCalls.length, 0);
});

test('opening collapsed mobile contents reveals the active item by scrolling nav, not the page', () => {
  const state = fixture(390, 844);
  state.scrollToSection(12);
  assert.equal(state.nav.scrollTop, 0);
  state.details.open = true;
  state.details.emit('toggle');
  state.flush();
  assert.ok(state.nav.scrollTop > 0);
  assert.equal(state.toc.scrollTop, 0);
  assert.equal(state.window.scrollCalls.length, 0);
  state.nav.scrollTop = 0;
  state.window.emit('scroll');
  state.flush();
  assert.equal(state.nav.scrollTop, 0);
});

test('crossing the tablet breakpoint closes or opens contents without scrolling the document', () => {
  const state = fixture(800, 600);
  state.scrollToSection(12);
  state.desktop.matches = true;
  state.window.innerWidth = 1024;
  state.desktop.emit('change');
  state.flush();
  assert.equal(state.details.open, true);
  assert.ok(state.toc.scrollTop > 0);
  state.desktop.matches = false;
  state.window.innerWidth = 800;
  state.desktop.emit('change');
  state.flush();
  assert.equal(state.details.open, false);
  assert.equal(state.window.scrollCalls.length, 0);
});

test('mobile link selection closes contents, preserves the hash and compensates the fixed header', () => {
  const state = fixture(390, 844, { headerHeight: 56 });
  state.details.open = true;
  let prevented = false;
  state.links[3].emit('click', { preventDefault() { prevented = true; } });
  state.flush();
  assert.equal(prevented, true);
  assert.equal(state.details.open, false);
  assert.equal(state.window.history.hash, '#section-4');
  assert.equal(state.window.scrollCalls.length, 1);
  assert.equal(state.window.scrollCalls[0].top, 2500 - 56 - 86);
  assert.equal(state.window.scrollCalls[0].behavior, 'auto');
  assert.equal(state.links[3].attrs.get('aria-current'), 'location');
});

test('native hash navigation updates the active link without adding a second document scroll', () => {
  const state = fixture(1024, 768);
  state.window.scrollY = 7000 - 32; // Browser performs its native anchor jump first.
  state.window.emit('hashchange');
  state.flush();
  assert.equal(state.links[12].attrs.get('aria-current'), 'location');
  assert.equal(state.window.scrollCalls.length, 0);
  assert.ok(state.toc.scrollTop > 0);
});

test('CSS keeps practice aligned with the text column across wide, tablet and phone layouts', () => {
  assert.match(css, /\.eo-practice \{[^}]*margin:28px 0 0 calc\(250px \+ clamp\(34px,5vw,70px\)\)/);
  assert.match(css, /\.eo-practice \{ width:calc\(100% - 256px\); margin-left:256px; \}/);
  assert.match(css, /\.eo-practice \{ width:100%; max-width:none; margin-left:0; font-size:13px; \}/);
  assert.match(css, /#allrecords \.eo-toc a \{[^}]*min-height:44px/);
});
