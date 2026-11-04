import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../www/assets/redesign/motion.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../www/assets/redesign/motion.css', import.meta.url), 'utf8');
const airProperties = ['--scene-air-x', '--scene-air-y', '--scene-air-front-x', '--scene-air-opacity'];

function mount({ reduced = false, coarse = false, width = 1200, stored = 'on', missing = false } = {}) {
  const events = () => {
    const listeners = new Map();
    return {
      addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(callback);
      },
      emit(name, event = {}) { for (const callback of listeners.get(name) || []) callback(event); },
    };
  };
  const element = () => ({
    ...events(),
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
      removeProperty(name) { this.values.delete(name); },
    },
    dataset: {}, attributes: new Map(), children: [],
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    append(child) { this.children.push(child); },
    getBoundingClientRect: () => ({ width, height: 650, left: 0, top: 0, bottom: 650 }),
  });
  const hero = element();
  const scene = element();
  const label = element();
  const button = element();
  button.querySelector = () => label;
  const canvas = element();
  const context = { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {} };
  canvas.getContext = () => context;
  scene.querySelector = () => canvas;
  const document = {
    ...events(), hidden: false, documentElement: element(), createElement: element,
    querySelector: selector => missing ? null : ({ '.hero': hero, '[data-hero-scene]': scene, '[data-motion-toggle]': button })[selector],
    querySelectorAll: () => [],
  };
  const media = matches => ({ ...events(), matches });
  const mediaReduced = media(reduced);
  const mediaCoarse = media(coarse);
  let now = 0;
  let nextFrame = 0;
  let intersection;
  const frames = new Map();
  class IntersectionObserver {
    constructor(callback) { intersection = callback; }
    observe() {}
  }
  class ResizeObserver { observe() {} }
  const window = {
    ...events(), devicePixelRatio: 1, innerHeight: 900, IntersectionObserver, ResizeObserver,
    matchMedia: query => query.includes('reduced-motion') ? mediaReduced : mediaCoarse,
  };
  const storage = new Map([['previewmotion', stored]]);
  vm.runInNewContext(script, {
    window, document, innerHeight: 900, IntersectionObserver, ResizeObserver,
    performance: { now: () => now },
    localStorage: { getItem: name => storage.get(name), setItem: (name, value) => storage.set(name, value) },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  return {
    hero, scene, button, document, frames, storage,
    tick(timestamp) {
      now = timestamp;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(timestamp);
    },
    setReduced(matches) { mediaReduced.matches = matches; mediaReduced.emit('change'); },
    setHidden(hidden) { document.hidden = hidden; document.emit('visibilitychange'); },
    setVisible(isIntersecting) { intersection([{ isIntersecting }]); },
  };
}

function assertAirCleared(app) {
  for (const name of airProperties) assert.equal(app.hero.style.values.has(name), false, name);
  assert.equal(app.frames.size, 0);
  assert.equal(app.scene.dataset.motion, 'paused');
}

test('creates two decorative air depths and a restrained glint at Themis scales', () => {
  const app = mount();
  const air = app.scene.children.filter(child => child.className.startsWith('hero-scene__air'));
  const glints = app.scene.children.filter(child => child.className.startsWith('hero-scene__glint'));
  assert.equal(air.length, 2);
  assert.equal(glints.length, 4);
  for (const child of [...air, ...glints]) assert.equal(child.attributes.get('aria-hidden'), 'true');
  assert.match(glints[3].className, /hero-scene__glint--themis/);
  assert.equal(glints[3].style.left, '85.5%');
  assert.equal(glints[3].style.top, '31%');
  assert.equal(app.frames.size, 1);
});

test('air uses the existing single loop with the same 30 FPS render budget', () => {
  const app = mount();
  app.tick(10);
  assert.equal(app.hero.style.values.has('--scene-air-x'), false);
  assert.equal(app.frames.size, 1);
  app.tick(40);
  for (const name of airProperties) assert.ok(Number.isFinite(parseFloat(app.hero.style.values.get(name))), name);
  const previous = app.hero.style.values.get('--scene-air-x');
  app.tick(50);
  assert.equal(app.hero.style.values.get('--scene-air-x'), previous);
  app.tick(80);
  assert.notEqual(app.hero.style.values.get('--scene-air-x'), previous);
  assert.equal(app.frames.size, 1);
});

test('manual motion preference stops and clears air, then resumes only one loop', () => {
  const app = mount();
  app.tick(40);
  app.button.emit('click');
  assertAirCleared(app);
  assert.equal(app.document.documentElement.dataset.previewMotion, 'off');
  assert.equal(app.storage.get('previewmotion'), 'off');
  app.button.emit('click');
  assert.equal(app.frames.size, 1);
  app.tick(80);
  assert.ok(app.hero.style.values.has('--scene-air-x'));
});

test('reduced motion never starts an animation and preference changes clear it', () => {
  const app = mount({ reduced: true });
  assertAirCleared(app);
  assert.equal(app.button.disabled, true);
  app.setReduced(false);
  assert.equal(app.frames.size, 1);
  app.tick(40);
  app.setReduced(true);
  assertAirCleared(app);
});

test('hidden documents and out-of-view scenes have no active animation or air state', () => {
  const app = mount();
  app.tick(40);
  app.setHidden(true);
  assertAirCleared(app);
  app.setHidden(false);
  assert.equal(app.frames.size, 1);
  app.tick(80);
  app.setVisible(false);
  assertAirCleared(app);
  app.setVisible(true);
  assert.equal(app.frames.size, 1);
});

test('touch and narrow viewports reduce air intensity without additional loops', () => {
  const desktop = mount();
  const touch = mount({ coarse: true });
  const narrow = mount({ width: 390 });
  for (const app of [desktop, touch, narrow]) app.tick(40);
  const opacity = app => Number(app.hero.style.values.get('--scene-air-opacity'));
  assert.ok(opacity(touch) < opacity(desktop));
  assert.ok(opacity(narrow) < opacity(desktop));
  for (const app of [desktop, touch, narrow]) assert.equal(app.frames.size, 1);
});

test('persisted off and absent hero leave no animation running', () => {
  assertAirCleared(mount({ stored: 'off' }));
  const missing = mount({ missing: true });
  assert.equal(missing.frames.size, 0);
  assert.equal(missing.scene.children.length, 0);
});

test('air is local, non-interactive and disabled in paused, reduced and print modes', () => {
  const airRules = [...css.matchAll(/[^{}]*\.hero-scene__air[^{}]*\{[^{}]*\}/g)].map(match => match[0]);
  assert.ok(airRules.some(rule => rule.includes('pointer-events:none')));
  assert.ok(airRules.some(rule => rule.includes('[data-motion="paused"]') && rule.includes('display:none')));
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)[\s\S]*\.hero-scene__air\{display:none!important\}/);
  assert.match(css, /@media print\{\.hero-scene,\[data-motion-toggle\]\{display:none!important\}/);
  for (const rule of airRules) {
    assert.doesNotMatch(rule, /\bfilter\s*:|\bblur\s*\(|\burl\s*\(|\banimation\s*:/);
  }
});
