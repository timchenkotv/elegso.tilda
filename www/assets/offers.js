(() => {
  'use strict';
  const main = document.querySelector('.eo-main');
  if (!main) return;
  const desktop = window.matchMedia('(min-width: 981px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const header = document.getElementById('t-header');
  const toc = main.querySelector('.eo-toc');
  const details = toc?.querySelector('details');
  const links = [...(toc?.querySelectorAll('a[href^="#"]') || [])];
  const sections = [...main.querySelectorAll('[data-eo-section]')];
  const documentBody = main.querySelector('.eo-document');
  const progress = main.querySelector('[data-eo-progress]');
  let fixedBottom = 0;
  let frame = 0;
  let activeId = '';
  let checkTocVisibility = false;

  function measureHeader() {
    fixedBottom = 0;
    for (const panel of header?.querySelectorAll('.t228, .tmenu-mobile') || []) {
      const style = getComputedStyle(panel);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = panel.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (desktop.matches && panel.classList.contains('t228') && ['absolute', 'fixed'].includes(style.position)) {
        main.style.setProperty('--eo-header-space', `${Math.ceil(rect.height)}px`);
      }
      if (style.position === 'fixed' && rect.top <= 1 && rect.bottom > 0) {
        fixedBottom = Math.max(fixedBottom, Math.min(rect.bottom, window.innerHeight * .65));
      }
    }
    main.style.setProperty('--eo-fixed-top', `${Math.ceil(fixedBottom)}px`);
    main.style.setProperty('--eo-sticky-top', `${Math.ceil(fixedBottom + (desktop.matches ? 24 : 8))}px`);
    main.style.setProperty('--eo-anchor-offset', `${Math.ceil(fixedBottom + (desktop.matches ? 32 : 86))}px`);
  }
  function ensureActiveTocLinkVisible() {
    if (!details?.open || !activeId) return;
    const viewport = desktop.matches ? toc : toc?.querySelector('nav');
    const link = links.find(item => item.hash === `#${activeId}`);
    if (!viewport || !link || viewport.clientHeight <= 0 || viewport.scrollHeight <= viewport.clientHeight) return;
    const bounds = viewport.getBoundingClientRect();
    const target = link.getBoundingClientRect();
    const inset = Math.min(8, viewport.clientHeight / 4);
    let next = viewport.scrollTop;
    if (target.top < bounds.top + inset) next -= bounds.top + inset - target.top;
    else if (target.bottom > bounds.bottom - inset) next += target.bottom - bounds.bottom + inset;
    // Move only the contents scroller, never the document. Do not continuously
    // override a reader who scrolls the contents independently of the article.
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, next));
  }
  function update() {
    frame = 0;
    const requestedTocCheck = checkTocVisibility;
    checkTocVisibility = false;
    measureHeader();
    if (!sections.length || !documentBody) return;
    const readingLine = fixedBottom + (desktop.matches ? 95 : 98);
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= readingLine) current = section;
      else break;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 3) current = sections.at(-1);
    const activeChanged = current.id !== activeId;
    if (activeChanged) {
      activeId = current.id;
      for (const link of links) {
        if (link.hash === `#${activeId}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
    if (activeChanged || requestedTocCheck) ensureActiveTocLinkVisible();
    if (progress) {
      const rect = documentBody.getBoundingClientRect();
      const span = Math.max(1, rect.height - window.innerHeight + fixedBottom);
      const fraction = Math.max(0, Math.min(1, (fixedBottom - rect.top) / span));
      progress.style.transform = `scaleX(${fraction})`;
    }
  }
  function requestUpdate() { if (!frame) frame = window.requestAnimationFrame(update); }
  function requestTocViewportUpdate() {
    checkTocVisibility = true;
    requestUpdate();
  }
  function setTocMode() {
    if (details) details.open = desktop.matches;
    requestTocViewportUpdate();
  }
  for (const link of links) {
    link.addEventListener('click', event => {
      const section = document.getElementById(link.hash.slice(1));
      if (!section) return;
      event.preventDefault();
      if (!desktop.matches && details) details.open = false;
      measureHeader();
      const offset = fixedBottom + (desktop.matches ? 32 : 86);
      const top = window.scrollY + section.getBoundingClientRect().top - offset;
      window.history.replaceState(null, '', link.hash);
      window.scrollTo({ top, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      requestUpdate();
    });
  }
  main.querySelector('[data-eo-print]')?.addEventListener('click', () => window.print());
  const printButton = main.querySelector('[data-eo-print]');
  if (printButton && typeof window.print === 'function') printButton.hidden = false;
  details?.addEventListener('toggle', () => { if (details.open) requestTocViewportUpdate(); });
  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestTocViewportUpdate, { passive: true });
  window.addEventListener('hashchange', requestUpdate);
  window.addEventListener('load', requestUpdate, { once: true });
  if (desktop.addEventListener) desktop.addEventListener('change', setTocMode);
  else desktop.addListener(setTocMode);
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(requestTocViewportUpdate);
    if (header) observer.observe(header);
    if (documentBody) observer.observe(documentBody);
  }
  document.fonts?.ready.then(requestUpdate).catch(() => {});
  setTocMode();
})();
