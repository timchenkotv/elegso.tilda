(() => {
  'use strict';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobileViewport = window.matchMedia('(max-width: 1100px)');
  const header = document.querySelector('.site-header');
  const menuToggle = document.querySelector('.menu-toggle');
  const menu = document.querySelector('.mobile-menu');
  const desktopMenus = [...document.querySelectorAll('.desktop-nav details.nav-mega')];
  const mobileBar = document.querySelector('.mobile-contact-bar');
  const backTop = document.querySelector('.back-top');
  const contact = document.getElementById('contact');
  let menuReturnFocus = null;
  let toastTimer;
  let frame = 0;

  function updateFloatingControls() {
    frame = 0;
    const belowHero = window.scrollY > Math.max(500, window.innerHeight * .65);
    const contactRect = contact?.getBoundingClientRect();
    const contactVisible = Boolean(contactRect && contactRect.top < window.innerHeight - 60 && contactRect.bottom > 80);
    const showBar = Boolean(mobileViewport.matches && belowHero && !contactVisible && !document.body.classList.contains('menu-open'));
    if (mobileBar) {
      mobileBar.classList.toggle('is-visible', showBar);
      mobileBar.setAttribute('aria-hidden', String(!showBar));
      mobileBar.inert = !showBar;
      mobileBar.toggleAttribute('inert', !showBar);
    }
    if (backTop) {
      const visible = !mobileViewport.matches && window.scrollY > 1100;
      backTop.classList.toggle('is-visible', visible);
      backTop.setAttribute('aria-hidden', String(!visible));
      backTop.tabIndex = visible ? 0 : -1;
    }
  }

  function closeDesktopMenus(except = null) {
    desktopMenus.forEach(disclosure => {
      if (disclosure !== except) disclosure.open = false;
    });
  }

  function positionMenu() {
    if (menu && !menu.hidden && header) menu.style.top = `${Math.max(0, header.getBoundingClientRect().bottom)}px`;
  }

  function setMenu(open, restoreFocus = true) {
    if (!menu || !menuToggle) return;
    open = Boolean(open && mobileViewport.matches);
    const wasOpen = !menu.hidden;
    menu.hidden = !open;
    menu.inert = !open;
    menu.toggleAttribute('inert', !open);
    menu.setAttribute('aria-hidden', String(!open));
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    document.body.classList.toggle('menu-open', open);
    updateFloatingControls();
    if (open) {
      closeDesktopMenus();
      positionMenu();
      menuReturnFocus = document.activeElement;
      requestAnimationFrame(() => { if (!menu.hidden) menu.querySelector('a, button, summary')?.focus(); });
    } else if (wasOpen && restoreFocus && menuReturnFocus?.isConnected) {
      menuReturnFocus.focus({ preventScroll: true });
    }
    if (!open) menuReturnFocus = null;
  }

  menuToggle?.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
  menu?.addEventListener('click', event => {
    if (event.target.closest?.('a')) setMenu(false, false);
  });
  desktopMenus.forEach(disclosure => {
    const summary = disclosure.querySelector(':scope > summary');
    const sync = () => {
      summary?.setAttribute('aria-expanded', String(disclosure.open));
      if (disclosure.open) closeDesktopMenus(disclosure);
    };
    disclosure.addEventListener('toggle', sync);
    disclosure.addEventListener('click', event => {
      if (event.target.closest?.('.mega-panel a')) closeDesktopMenus();
    });
    sync();
  });
  document.addEventListener('click', event => {
    if (menu && !menu.hidden && !menu.contains(event.target) && !menuToggle?.contains(event.target)) setMenu(false, false);
    if (!event.target.closest?.('.desktop-nav')) closeDesktopMenus();
  });
  document.addEventListener('focusin', event => {
    if (!event.target.closest?.('.desktop-nav')) closeDesktopMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (menu && !menu.hidden) { event.preventDefault(); setMenu(false); return; }
      const openDesktop = desktopMenus.find(disclosure => disclosure.open);
      if (openDesktop) {
        event.preventDefault();
        closeDesktopMenus();
        openDesktop.querySelector(':scope > summary')?.focus({ preventScroll: true });
      }
      return;
    }
    if (!menu || menu.hidden) return;
    if (event.key === 'Tab') {
      const controls = [...menu.querySelectorAll('a[href],button:not([disabled]),summary')].filter(el => el.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === menuToggle)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); menuToggle?.focus();
      }
    }
  });
  mobileViewport.addEventListener('change', event => {
    if (!event.matches) setMenu(false, false);
    else closeDesktopMenus();
    updateFloatingControls();
  });
  window.addEventListener('resize', () => { positionMenu(); updateFloatingControls(); }, { passive: true });
  setMenu(false, false);

  function notify(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.append(toast);
    }
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3300);
  }

  document.querySelectorAll('[data-copy-email]').forEach(button => {
    button.addEventListener('click', async () => {
      const email = button.dataset.copyEmail || 'mail@elegso.ru';
      try {
        await navigator.clipboard.writeText(email);
        notify('Адрес электронной почты скопирован');
      } catch {
        notify(email);
      }
    });
  });
  // Contact disclosure and tel/mail clicks are tracked by contact-reveal.js through
  // window.elegsoTrackContactInterest. Do not install a second click tracker here.

  document.querySelectorAll('[data-expand-all]').forEach(button => {
    button.addEventListener('click', () => {
      const details = [...document.querySelectorAll('main details')];
      const open = !details.length || details.some(item => !item.open);
      details.forEach(item => { item.open = open; });
      button.textContent = open ? 'Свернуть подробности' : 'Развернуть все подробности';
      button.setAttribute('aria-expanded', String(open));
    });
  });

  document.querySelectorAll('main details').forEach(disclosure => {
    const summary = disclosure.querySelector(':scope > summary');
    const label = summary?.querySelector(':scope > .disclosure-label');
    const textNode = [...(summary?.childNodes || [])].find(node => node.nodeType === 3 && node.textContent.trim().startsWith('Развернуть'));
    const original = textNode?.textContent;
    const originalLabel = label?.textContent;
    const update = () => {
      if (textNode) textNode.textContent = disclosure.open ? original.replace('Развернуть','Свернуть') : original;
      if (label && originalLabel?.startsWith('Развернуть')) label.textContent = disclosure.open ? originalLabel.replace('Развернуть','Свернуть') : originalLabel;
    };
    disclosure.addEventListener('toggle', update);
    update();
  });

  let printStates = [];
  window.addEventListener('beforeprint', () => {
    printStates = [...document.querySelectorAll('main details')].map(item => [item, item.open]);
    printStates.forEach(([item]) => { item.open = true; });
  });
  window.addEventListener('afterprint', () => {
    printStates.forEach(([item, open]) => { item.open = open; });
    printStates = [];
  });
  document.querySelectorAll('[data-print]').forEach(button => button.addEventListener('click', () => window.print()));

  function localTarget(link) {
    const href = link.getAttribute('href');
    if (!href?.startsWith('#') || href === '#') return null;
    let id;
    try { id = decodeURIComponent(href.slice(1)); } catch { return null; }
    return document.getElementById(id);
  }

  function expandForTarget(target) {
    if (!target) return;
    let parent = target.closest('details');
    while (parent) { parent.open = true; parent = parent.parentElement?.closest('details'); }
    const ownDisclosure = target.querySelector('details.detail-service');
    if (ownDisclosure) ownDisclosure.open = true;
  }

  function openHashTarget() {
    if (!location.hash) return;
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    expandForTarget(target);
    if (target) requestAnimationFrame(() => target.scrollIntoView({block:'start',behavior:'instant'}));
  }
  window.addEventListener('hashchange', openHashTarget);
  if (document.fonts?.ready) document.fonts.ready.then(openHashTarget);
  else openHashTarget();

  document.querySelectorAll('a[href^="#"],[data-contact]').forEach(link => {
    link.addEventListener('click', event => {
      const target = link.hasAttribute('data-contact') ? document.getElementById('contact') : localTarget(link);
      if (!target) return;
      event.preventDefault();
      expandForTarget(target);
      target.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
      if (target.id) history.replaceState(null, '', `#${encodeURIComponent(target.id)}`);
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
  });

  const tabs = [...document.querySelectorAll('.page-tabs__inner a[href^="#"]')];
  const tabTargets = tabs.map(link => [link, localTarget(link)]).filter(([, target]) => target);
  if ('IntersectionObserver' in window && tabTargets.length) {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (!visible.length) return;
      tabs.forEach(link => {
        const active = localTarget(link) === visible[0].target;
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-75px 0px -55% 0px', threshold: [0, .1, .3] });
    tabTargets.forEach(([, target]) => observer.observe(target));
  }

  window.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(updateFloatingControls);
  }, { passive: true });
  updateFloatingControls();
  backTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'instant' : 'smooth' }));

  const art = document.querySelector('.hero-art');
  const hero = document.querySelector('.hero');
  if (art && hero && window.matchMedia('(hover:hover) and (min-width:1024px)').matches) {
    hero.addEventListener('pointermove', event => {
      if (reducedMotion.matches) return;
      const rect = hero.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width - .5) * 8;
      const y = ((event.clientY - rect.top) / rect.height - .5) * 8;
      art.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
    }, { passive: true });
    hero.addEventListener('pointerleave', () => { art.style.transform = ''; });
  }

})();
