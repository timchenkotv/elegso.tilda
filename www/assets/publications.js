(() => {
  'use strict';

  const main = document.querySelector('.ep-main');
  if (!main) return;

  const desktop = window.matchMedia('(min-width: 981px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const toc = main.querySelector('.ep-toc');
  const details = toc?.querySelector('details');
  const tocLinks = [...(toc?.querySelectorAll('a[href^="#"]') || [])];
  const sections = [...main.querySelectorAll('[data-ep-section]')];
  const prose = main.querySelector('.ep-prose');
  const progress = main.querySelector('[data-ep-progress]');
  const header = document.getElementById('t-header');
  let fixedBottom = 0;
  let activeId = '';
  let frameRequested = false;
  let resizeRequested = false;

  function measureHeader() {
    fixedBottom = 0;
    const panels = header ? [...header.querySelectorAll('.t228, .tmenu-mobile')] : [];
    for (const panel of panels) {
      const style = getComputedStyle(panel);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = panel.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (desktop.matches && panel.classList.contains('t228') && ['absolute', 'fixed'].includes(style.position)) {
        main.style.setProperty('--ep-header-space', `${Math.ceil(rect.height)}px`);
      }
      if (style.position === 'fixed' && rect.top <= 1 && rect.bottom > 0) {
        fixedBottom = Math.max(fixedBottom, Math.min(rect.bottom, window.innerHeight * .65));
      }
    }
    main.style.setProperty('--ep-fixed-top', `${Math.ceil(fixedBottom)}px`);
    main.style.setProperty('--ep-sticky-top', `${Math.ceil(fixedBottom + (desktop.matches ? 24 : 8))}px`);
    main.style.setProperty('--ep-anchor-offset', `${Math.ceil(fixedBottom + (desktop.matches ? 32 : 86))}px`);
  }

  function updateReading() {
    frameRequested = false;
    measureHeader();
    if (!sections.length || !prose) return;
    const line = fixedBottom + (desktop.matches ? 95 : 98);
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= line) current = section;
      else break;
    }
    if (current.id !== activeId) {
      activeId = current.id;
      for (const link of tocLinks) {
        if (link.hash.slice(1) === activeId) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }
    if (progress) {
      const rect = prose.getBoundingClientRect();
      const available = Math.max(1, rect.height - window.innerHeight + fixedBottom + 40);
      const ratio = Math.min(1, Math.max(0, (fixedBottom + 40 - rect.top) / available));
      progress.style.transform = `scaleX(${ratio})`;
    }
  }

  function requestReadingUpdate() {
    if (frameRequested) return;
    frameRequested = true;
    window.requestAnimationFrame(updateReading);
  }

  function setTocMode() {
    if (details) details.open = desktop.matches;
    requestReadingUpdate();
  }

  function requestLayoutUpdate() {
    if (resizeRequested) return;
    resizeRequested = true;
    window.requestAnimationFrame(() => {
      resizeRequested = false;
      requestReadingUpdate();
    });
  }

  for (const link of tocLinks) {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      let id;
      try { id = decodeURIComponent(link.hash.slice(1)); } catch { return; }
      const target = document.getElementById(id);
      if (!target || !main.contains(target)) return;
      event.preventDefault();
      if (!desktop.matches && details) details.open = false;
      window.requestAnimationFrame(() => {
        measureHeader();
        const offset = fixedBottom + (desktop.matches ? 32 : 86);
        const destination = target.getBoundingClientRect().top + window.scrollY - offset;
        const heading = target.querySelector('h2') || target;
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
        if (window.location.hash !== link.hash) history.pushState(null, '', link.hash);
        window.scrollTo({ top: Math.max(0, destination), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
        requestReadingUpdate();
      });
    });
  }

  if (details) {
    setTocMode();
    desktop.addEventListener('change', setTocMode);
    details.addEventListener('toggle', requestReadingUpdate);
  }
  window.addEventListener('scroll', requestReadingUpdate, { passive: true });
  window.addEventListener('resize', requestLayoutUpdate, { passive: true });
  window.addEventListener('hashchange', requestReadingUpdate);
  window.addEventListener('load', requestLayoutUpdate, { once: true });
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(requestLayoutUpdate);
    if (header) observer.observe(header);
    if (prose) observer.observe(prose);
  }
  if (document.fonts?.ready) document.fonts.ready.then(requestLayoutUpdate);
  requestReadingUpdate();

  const tools = main.querySelector('[data-ep-tools]');
  if (tools) {
    const buttons = [...tools.querySelectorAll('[data-filter]')];
    const search = tools.querySelector('[data-ep-search]');
    const cards = [...main.querySelectorAll('.ep-grid--catalog .ep-card')];
    const results = main.querySelector('[data-ep-results]');
    const empty = main.querySelector('[data-ep-empty]');
    let category = 'Все';
    const normalize = value => String(value).toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
    const indexed = cards.map(card => ({ card, text: normalize(card.dataset.search || card.textContent) }));

    function filter() {
      const words = normalize(search?.value || '').split(' ').filter(Boolean);
      let count = 0;
      for (const { card, text } of indexed) {
        const visible = (category === 'Все' || card.dataset.category === category) && words.every(word => text.includes(word));
        card.hidden = !visible;
        if (visible) count += 1;
      }
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.filter === category));
      if (results) results.textContent = `Найдено материалов: ${count} из ${cards.length}.`;
      if (empty) empty.hidden = count !== 0;
    }
    for (const button of buttons) button.addEventListener('click', () => { category = button.dataset.filter || 'Все'; filter(); });
    search?.addEventListener('input', filter);
    search?.addEventListener('search', filter);
    tools.hidden = false;
    filter();
  }

  const printButton = main.querySelector('[data-ep-print]');
  if (printButton && typeof window.print === 'function') {
    printButton.hidden = false;
    printButton.addEventListener('click', () => window.print());
  }

  const copyButton = main.querySelector('[data-ep-copy]');
  const copyStatus = main.querySelector('[data-ep-copy-status]');
  if (copyButton) {
    copyButton.hidden = false;
    const label = copyButton.textContent;
    let resetTimer;
    copyButton.addEventListener('click', async () => {
      const canonical = document.querySelector('link[rel="canonical"]')?.href;
      const url = canonical || `${location.origin}${location.pathname}`;
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          copied = true;
        }
      } catch { /* A denied clipboard permission can still allow a user-initiated copy. */ }
      if (!copied) {
        const buffer = document.createElement('textarea');
        buffer.className = 'ep-copy-buffer';
        buffer.value = url;
        buffer.readOnly = true;
        buffer.setAttribute('aria-label', 'Ссылка на статью');
        main.append(buffer);
        buffer.select();
        try { copied = document.execCommand('copy'); } catch { copied = false; }
        buffer.remove();
        copyButton.focus({ preventScroll: true });
      }
      clearTimeout(resetTimer);
      copyButton.textContent = copied ? 'Ссылка скопирована' : 'Не удалось скопировать';
      if (copyStatus) copyStatus.textContent = copied ? 'Ссылка на статью скопирована в буфер обмена.' : 'Браузер не разрешил копирование. Можно скопировать адрес статьи из адресной строки.';
      resetTimer = setTimeout(() => { copyButton.textContent = label; }, 3500);
    });
  }
})();
