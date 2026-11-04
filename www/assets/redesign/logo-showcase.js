/* A lightweight, local-only 3D presentation of the existing ELEGSO mark. */
(() => {
  'use strict';
  const brand = document.querySelector('.site-header .brand');
  if (!brand || brand.hasAttribute('data-logo-showcase-ready')) return;
  const logo = brand.querySelector('img');
  if (!logo) return;
  let source;
  try {
    source = new URL(logo.getAttribute('src'), window.location.href);
    if (source.origin !== window.location.origin) return;
  } catch { return; }
  const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const popup = document.createElement('div');
  popup.id = 'elegso-logo-showcase';
  popup.className = 'els-showcase';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-modal', 'false');
  popup.setAttribute('aria-label', 'Логотип ЭЛЕГСО');
  popup.setAttribute('aria-hidden', 'true');
  popup.setAttribute('data-open', 'false');
  popup.inert = true;
  popup.setAttribute('inert', '');
  popup.style.setProperty('--els-mark', `url("${source.pathname.replace(/["\\\r\n]/g, '')}")`);

  const close = document.createElement('button');
  close.className = 'els-showcase__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть логотип');
  close.textContent = '×';
  const stage = document.createElement('div');
  stage.className = 'els-showcase__stage';
  stage.setAttribute('aria-hidden', 'true');
  const aura = document.createElement('div');
  aura.className = 'els-showcase__aura';
  const model = document.createElement('div');
  model.className = 'els-showcase__model';
  // Separate silhouette planes form the depth; the source image stays intact.
  for (let depth = 0; depth < 10; depth++) {
    const layer = document.createElement('span');
    layer.className = 'els-showcase__depth';
    layer.style.setProperty('--els-depth', String(depth));
    model.append(layer);
  }
  const front = document.createElement('span');
  front.className = 'els-showcase__front';
  model.append(front);
  const shadow = document.createElement('div');
  shadow.className = 'els-showcase__shadow';
  stage.append(aura, shadow, model);
  const home = document.createElement('a');
  home.className = 'els-showcase__home';
  home.href = '/';
  home.textContent = 'На главную ↗';
  popup.append(close, stage, home);
  document.body.append(popup);
  brand.setAttribute('data-logo-showcase-ready', '');
  brand.setAttribute('role', 'button');
  brand.setAttribute('aria-label', 'Показать объёмный логотип ЭЛЕГСО');
  brand.setAttribute('aria-haspopup', 'dialog');
  brand.setAttribute('aria-controls', popup.id);
  brand.setAttribute('aria-expanded', 'false');

  let opened = false;
  let overBrand = false;
  let overPopup = false;
  let openingTimer = 0;
  let closingTimer = 0;
  let poseFrame = 0;
  let pose = [7, -10];
  function cancelOpening() { window.clearTimeout(openingTimer); openingTimer = 0; }
  function cancelClosing() { window.clearTimeout(closingTimer); closingTimer = 0; }
  function containsFocus() { return brand.contains(document.activeElement) || popup.contains(document.activeElement); }
  function position() {
    const rect = brand.getBoundingClientRect();
    const gap = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = Math.max(gap, Math.min(rect.bottom + 10, vh - 180));
    const width = Math.max(90, Math.min(hover.matches ? 390 : 310, vw - gap * 2, (vh - top - 58) * .9));
    const left = hover.matches ? Math.max(gap, Math.min(rect.left - 24, vw - width - gap)) : Math.max(gap, (vw - width) / 2);
    popup.style.setProperty('--els-left', `${Math.round(left)}px`);
    popup.style.setProperty('--els-top', `${Math.round(top)}px`);
    popup.style.setProperty('--els-width', `${Math.round(width)}px`);
    popup.style.setProperty('--els-origin', `${Math.max(10, Math.min(width - 10, rect.left + rect.width * .35 - left))}px`);
  }
  function setPose(rx = 7, ry = -10) {
    model.style.setProperty('--els-rx', `${rx}deg`);
    model.style.setProperty('--els-ry', `${ry}deg`);
  }
  function dismiss(restoreFocus = false) {
    cancelOpening(); cancelClosing();
    if (poseFrame) window.cancelAnimationFrame(poseFrame);
    poseFrame = 0;
    const focusInside = popup.contains(document.activeElement);
    opened = false;
    overPopup = false;
    popup.setAttribute('data-open', 'false');
    popup.setAttribute('aria-hidden', 'true');
    popup.inert = true;
    popup.setAttribute('inert', '');
    brand.setAttribute('aria-expanded', 'false');
    setPose();
    if (restoreFocus && focusInside) brand.focus({ preventScroll: true });
  }
  function show(keyboard = false) {
    cancelOpening(); cancelClosing();
    if (document.body.classList.contains('menu-open')) return;
    position();
    opened = true;
    popup.inert = false;
    popup.removeAttribute('inert');
    popup.setAttribute('aria-hidden', 'false');
    popup.setAttribute('data-open', 'true');
    brand.setAttribute('aria-expanded', 'true');
    setPose();
    if (keyboard) window.requestAnimationFrame(() => { if (opened) close.focus({ preventScroll: true }); });
  }
  function scheduleDismiss() {
    cancelOpening(); cancelClosing();
    closingTimer = window.setTimeout(() => {
      closingTimer = 0;
      if (!overBrand && !overPopup && !containsFocus()) dismiss();
    }, 150);
  }
  brand.addEventListener('pointerenter', event => {
    if (!hover.matches || event.pointerType === 'touch') return;
    overBrand = true;
    cancelClosing(); cancelOpening();
    if (!opened) openingTimer = window.setTimeout(() => { openingTimer = 0; if (overBrand) show(); }, 900);
  });
  brand.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    overBrand = false;
    // A mouse click leaves focus on the brand. Pointer exit must still close it.
    cancelOpening(); cancelClosing();
    closingTimer = window.setTimeout(() => {
      closingTimer = 0;
      if (!overBrand && !overPopup && !popup.contains(document.activeElement)) dismiss();
    }, 150);
  });
  popup.addEventListener('pointerenter', event => {
    if (!hover.matches || event.pointerType === 'touch') return;
    overPopup = true; cancelClosing();
  });
  popup.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    overPopup = false;
    cancelClosing();
    closingTimer = window.setTimeout(() => {
      closingTimer = 0;
      if (!overBrand && !overPopup) dismiss(popup.contains(document.activeElement));
    }, 150);
  });
  brand.addEventListener('click', event => {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const toggleActivation = event.detail === 0 || !hover.matches || event.pointerType === 'touch';
    if (opened && toggleActivation) dismiss(event.detail === 0); else show(event.detail === 0);
  });
  brand.addEventListener('keydown', event => {
    if (!['Enter', ' ', 'Spacebar'].includes(event.key) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (opened) dismiss(true); else show(true);
  });
  close.addEventListener('click', () => dismiss(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && opened) { event.preventDefault(); dismiss(true); }
  });
  document.addEventListener('pointerdown', event => {
    if (!brand.contains(event.target) && !popup.contains(event.target)) dismiss();
  });
  document.addEventListener('click', event => {
    if (event.target.closest?.('.menu-toggle, .desktop-nav summary')) dismiss();
    else if (!brand.contains(event.target) && !popup.contains(event.target)) dismiss();
  });
  [brand, popup].forEach(element => element.addEventListener('focusout', scheduleDismiss));
  popup.addEventListener('pointermove', event => {
    if (!opened || !hover.matches || reduced.matches || event.pointerType === 'touch') return;
    const rect = stage.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    pose = [7 - y * 4, -10 + x * 6];
    if (!poseFrame) poseFrame = window.requestAnimationFrame(() => { poseFrame = 0; if (opened && !reduced.matches) setPose(...pose); });
  });
  window.addEventListener('scroll', event => { if (!popup.contains(event.target)) dismiss(); }, { passive: true });
  window.addEventListener('resize', () => dismiss());
  document.addEventListener('visibilitychange', () => { if (document.hidden) dismiss(); });
  reduced.addEventListener('change', () => { if (poseFrame) window.cancelAnimationFrame(poseFrame); poseFrame = 0; setPose(); });
  hover.addEventListener('change', () => dismiss());
})();
