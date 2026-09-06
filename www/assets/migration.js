
function migrationHydrateImages() {
  document.querySelectorAll('img[data-original]').forEach((image) => {
    const source = image.getAttribute('data-original');
    if (source) image.src = source;
  });
  document.querySelectorAll('[data-original]:not(img)').forEach((element) => {
    const source = element.getAttribute('data-original');
    if (source) element.style.backgroundImage = 'url("' + source + '")';
  });
  document.querySelectorAll('[data-content-cover-bg]').forEach((element) => {
    const source = element.getAttribute('data-content-cover-bg');
    if (source) element.style.backgroundImage = 'url("' + source + '")';
  });
}
function migrationInitContactPopups() {
  const popups = Array.from(document.querySelectorAll('.t-popup')).filter((popup) => (
    popup.querySelector('.elegso-contact-card--popup')
  ));
  if (!popups.length) return;

  const popupByHook = (hook) => popups.find((popup) => popup.getAttribute('data-tooltip-hook') === hook);
  const storageKeyFor = (popup) => 'elegso-contact-popup-shown:' + popup.getAttribute('data-tooltip-hook');
  const wasShown = (popup) => {
    try { return window.sessionStorage.getItem(storageKeyFor(popup)) === '1'; } catch { return false; }
  };
  const markShown = (popup) => {
    try { window.sessionStorage.setItem(storageKeyFor(popup), '1'); } catch {}
  };
  const closePopup = (popup) => {
    popup.classList.remove('t-popup_show', 'elegso-contact-popup--visible');
    popup.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.elegso-contact-popup--visible')) {
      document.body.classList.remove('t-body_popupshowed', 'elegso-contact-popup-open');
    }
  };
  const openPopup = (popup) => {
    if (!popup) return;
    popup.classList.add('t-popup_show', 'elegso-contact-popup--visible');
    popup.setAttribute('aria-hidden', 'false');
    document.body.classList.add('t-body_popupshowed', 'elegso-contact-popup-open');
    markShown(popup);
    window.setTimeout(() => {
      const closeButton = popup.querySelector('.t-popup__close-wrapper');
      if (closeButton) closeButton.focus({ preventScroll: true });
    }, 0);
  };

  document.querySelectorAll('a[href^="#popup:"]').forEach((trigger) => {
    const popup = popupByHook(trigger.getAttribute('href'));
    if (!popup) return;
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      openPopup(popup);
    });
  });

  popups.forEach((popup) => {
    popup.setAttribute('aria-hidden', 'true');
    popup.querySelectorAll('.t-popup__close, .t-popup__close-wrapper').forEach((button) => {
      button.addEventListener('click', () => closePopup(popup));
    });
    popup.addEventListener('click', (event) => {
      if (event.target === popup) closePopup(popup);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    popups.filter((popup) => popup.classList.contains('elegso-contact-popup--visible'))
      .forEach(closePopup);
  });

  const hashPopup = popupByHook(window.location.hash);
  if (hashPopup) openPopup(hashPopup);

  document.querySelectorAll('.t724__opener[href^="#popup:"]').forEach((opener) => {
    const popup = popupByHook(opener.getAttribute('href'));
    if (!popup) return;
    const delay = Math.max(0, Number(opener.getAttribute('data-timeout') || 0) * 1000);
    if (wasShown(popup)) return;
    window.setTimeout(() => {
      if (wasShown(popup)) return;
      openPopup(popup);
    }, delay);
  });
}
function migrationInitLeaseBalanceCalculator() {
  const page = document.querySelector('[data-tilda-page-alias="calculator_of_the_balance_of_counter_obligations_in_leasing"]');
  const host = document.getElementById('rec1164640016');
  if (!page || !host || host.dataset.elegsoLeaseLoader === 'ready') return;
  host.dataset.elegsoLeaseLoader = 'ready';

  if (!document.querySelector('link[data-elegso-lease-styles]')) {
    const styles = document.createElement('link');
    styles.rel = 'stylesheet';
    styles.href = '/assets/lease-balance-calculator.css?v=20260719-4';
    styles.dataset.elegsoLeaseStyles = 'true';
    document.head.appendChild(styles);
  }

  if (!document.querySelector('script[data-elegso-lease-script]')) {
    const script = document.createElement('script');
    script.src = '/assets/lease-balance-calculator.js?v=20260719-4';
    script.defer = true;
    script.dataset.elegsoLeaseScript = 'true';
    document.body.appendChild(script);
  }
}
function migrationEnsureCasesExperienceStyles() {
  if (document.getElementById('elegso-cases-experience-styles')) return;
  const styles = document.createElement('style');
  styles.id = 'elegso-cases-experience-styles';
  styles.textContent = `
    #t-header .elegso-cases-nav-item { position: relative; }
    #t-header .elegso-cases-nav-link {
      color: #355a56 !important;
      font-weight: 700 !important;
    }
    @media (min-width: 981px) and (max-width: 1360px) {
      #t-header .t228__list_item { padding-right: 5px !important; padding-left: 5px !important; }
      #t-header a.t-menu__link-item { font-size: 17px !important; }
    }
    #t-header .elegso-cases-nav-hint {
      position: absolute;
      z-index: 10020;
      top: calc(100% + 10px);
      left: 50%;
      width: max-content;
      max-width: 260px;
      padding: 9px 12px;
      color: #fff;
      background: #203f3c;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 5px;
      box-shadow: 0 12px 28px rgba(0, 11, 48, 0.22);
      font: 500 11px/1.35 Ubuntu, sans-serif;
      letter-spacing: 0;
      opacity: 0;
      pointer-events: none;
      text-align: center;
      text-transform: none;
      transform: translate(-50%, -4px);
      transition: opacity .18s ease, transform .18s ease;
    }
    #t-header .elegso-cases-nav-item:hover .elegso-cases-nav-hint,
    #t-header .elegso-cases-nav-link:focus-visible + .elegso-cases-nav-hint {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    .elegso-cases-cta-row {
      display: flex !important;
      flex-wrap: wrap;
      align-items: stretch;
      justify-content: center;
      gap: 12px;
    }
    .elegso-cases-cta-row--generated { margin-top: 30px; }
    .elegso-cases-cta-row > .t-btn { margin: 0 !important; }
    .elegso-cases-cta {
      position: relative;
      min-height: 60px;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      padding: 0 24px !important;
      overflow: hidden;
      isolation: isolate;
      color: #ffde41 !important;
      background: #a04b38 !important;
      border: 0 !important;
      border-radius: 6px !important;
      box-shadow: 0 10px 20px rgba(0, 11, 48, 0.25) !important;
      font-family: Ubuntu, sans-serif !important;
      text-decoration: none !important;
      transition: transform .2s ease, box-shadow .2s ease !important;
    }
    .elegso-cases-cta:hover,
    .elegso-cases-cta:focus-visible {
      transform: translateY(-2px);
      box-shadow: 0 4px 10px rgba(0, 11, 48, 0.24) !important;
    }
    .elegso-cases-cta::after {
      content: "";
      position: absolute;
      z-index: -1;
      top: -80%;
      left: -38%;
      width: 24%;
      height: 260%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .42), transparent);
      transform: rotate(16deg);
      animation: elegso-cases-flash 3.4s ease-in-out infinite;
    }
    .elegso-cases-cta .t-btnflex__text {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
      line-height: 1.05;
      text-align: center;
    }
    .elegso-cases-cta strong { font-size: 15px; font-weight: 500; }
    .elegso-cases-cta small {
      color: rgba(255, 255, 255, .76);
      font-size: 9px;
      font-weight: 400;
      letter-spacing: .02em;
    }
    @keyframes elegso-cases-flash {
      0%, 48% { left: -38%; }
      72%, 100% { left: 126%; }
    }
    #t-footer .elegso-cases-footer-card {
      box-sizing: border-box;
      width: min(1160px, calc(100% - 40px));
      min-height: 104px;
      display: grid;
      grid-template-columns: minmax(150px, .45fr) minmax(280px, 1fr) auto;
      align-items: center;
      gap: 24px;
      margin: 0 auto 30px;
      padding: 20px 24px;
      overflow: hidden;
      color: #fff !important;
      background:
        linear-gradient(105deg, #203f3c 0%, #355a56 72%, #416862 100%);
      border: 1px solid rgba(53, 90, 86, .24);
      border-radius: 6px;
      box-shadow: 0 12px 30px rgba(32, 63, 60, .14);
      font-family: Ubuntu, sans-serif;
      text-decoration: none !important;
      transition: transform .2s ease, box-shadow .2s ease;
    }
    #t-footer .elegso-cases-footer-card:hover,
    #t-footer .elegso-cases-footer-card:focus-visible {
      transform: translateY(-2px);
      box-shadow: 0 16px 34px rgba(32, 63, 60, .2);
    }
    .elegso-cases-footer-card__title {
      color: #e7c77e;
      font: 400 25px/1.15 Prata, Georgia, serif;
    }
    .elegso-cases-footer-card__text {
      color: rgba(255, 255, 255, .74);
      font-size: 13px;
      line-height: 1.45;
    }
    .elegso-cases-footer-card__action {
      min-width: 170px;
      padding: 13px 18px;
      color: #fff;
      background: #a04b38;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
    }
    @media (max-width: 980px) {
      #t-header .elegso-cases-nav-hint { display: none; }
      .elegso-cases-cta-row { gap: 9px; }
      #t-footer .elegso-cases-footer-card {
        grid-template-columns: 1fr auto;
      }
      .elegso-cases-footer-card__text { grid-column: 1 / -1; grid-row: 2; }
      .elegso-cases-footer-card__action { grid-column: 2; grid-row: 1; }
    }
    @media (max-width: 640px) {
      .elegso-cases-cta-row { flex-direction: column; align-items: stretch; }
      .elegso-cases-cta-row > .t-btn { width: 100% !important; }
      #t-footer .elegso-cases-footer-card {
        grid-template-columns: 1fr;
        gap: 10px;
        padding: 20px;
      }
      .elegso-cases-footer-card__text,
      .elegso-cases-footer-card__action { grid-column: auto; grid-row: auto; }
      .elegso-cases-footer-card__action { margin-top: 5px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .elegso-cases-cta::after { animation: none; }
    }
  `;
  document.head.appendChild(styles);
}
function migrationInitCasesNavigation() {
  migrationEnsureCasesExperienceStyles();
  let casesLink = document.querySelector('#t-header a[href="/cases/"]');
  let casesItem = casesLink && casesLink.closest('.t228__list_item');

  if (casesLink && !casesItem) {
    const oldItem = casesLink.closest('li');
    if (oldItem) oldItem.remove();
    casesLink = null;
  }

  const contactsLink = document.querySelector('#t-header .t228__list a[href="/contacts/"]');
  const contactsItem = contactsLink && contactsLink.closest('.t228__list_item');
  if (!casesLink && contactsItem && contactsItem.parentElement) {
    casesItem = contactsItem.cloneNode(true);
    casesItem.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    casesLink = casesItem.querySelector('a');
    if (!casesLink) return;
    casesLink.textContent = 'Кейсы';
    casesLink.href = '/cases/';
    casesLink.setAttribute('href', '/cases/');
    contactsItem.insertAdjacentElement('beforebegin', casesItem);
  }

  if (!casesLink || !casesItem) return;
  casesItem.classList.add('elegso-cases-nav-item');
  casesLink.classList.add('elegso-cases-nav-link');
  casesLink.removeAttribute('data-menu-submenu-hook');
  casesLink.setAttribute('data-elegso-cases-nav', 'true');
  casesLink.setAttribute('data-menu-item-number', '3');
  casesLink.setAttribute('title', 'Юридические проекты и решённые дела');
  casesLink.setAttribute('aria-label', 'Кейсы: юридические проекты и решённые дела');
  if (contactsLink) contactsLink.setAttribute('data-menu-item-number', '4');

  let hint = casesItem.querySelector('.elegso-cases-nav-hint');
  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'elegso-cases-nav-hint';
    hint.setAttribute('role', 'tooltip');
    casesLink.insertAdjacentElement('afterend', hint);
  }
  hint.textContent = 'Юридические проекты и решённые дела';
}
function migrationInitCasesHeroButton() {
  migrationEnsureCasesExperienceStyles();
  if (window.location.pathname.startsWith('/cases/')) return;
  if (document.querySelector('.elegso-cases-cta')) return;

  const primaryButton = Array.from(document.querySelectorAll('#allrecords a.t-btn[href="#send_a_request"]'))
    .find((button) => !button.closest('#t-header, #t-footer, .t-popup, .t1036'));
  if (!primaryButton) return;

  let row = primaryButton.closest('.t997__buttons');
  if (row) {
    row.classList.add('elegso-cases-cta-row');
  } else {
    row = document.createElement('div');
    row.className = 'elegso-cases-cta-row elegso-cases-cta-row--generated';
    primaryButton.insertAdjacentElement('beforebegin', row);
    row.appendChild(primaryButton);
  }

  const button = document.createElement('a');
  button.className = 't-btn t-btnflex t-btnflex_type_button2 t-btnflex_md elegso-cases-cta';
  button.href = '/cases/';
  button.setAttribute('title', 'Посмотреть юридические проекты и решённые дела');
  button.setAttribute('aria-label', 'Наши кейсы: решённые юридические дела');
  button.innerHTML = '<span class="t-btnflex__text"><strong>Наши кейсы</strong><small>Решённые юридические дела</small></span>';
  row.appendChild(button);
}
function migrationInitCasesFooterCard() {
  migrationEnsureCasesExperienceStyles();
  if (document.querySelector('#t-footer .elegso-cases-footer-card')) return;
  const footer = document.getElementById('t-footer');
  const mount = footer && (footer.querySelector('.t344') || footer.firstElementChild);
  if (!mount) return;

  const card = document.createElement('a');
  card.className = 'elegso-cases-footer-card';
  card.href = '/cases/';
  card.setAttribute('aria-label', 'Наши кейсы: решённые юридические задачи и подтверждённые результаты');
  card.innerHTML = '<strong class="elegso-cases-footer-card__title">Наши кейсы</strong><span class="elegso-cases-footer-card__text">Решённые юридические задачи и подтверждённые результаты</span><span class="elegso-cases-footer-card__action">Смотреть дела&nbsp;→</span>';
  mount.insertAdjacentElement('afterbegin', card);
}
window.t_lazyload_update = migrationHydrateImages;
window.t_lazyload_updateResize_elem = migrationHydrateImages;
document.addEventListener('DOMContentLoaded', () => {
  migrationHydrateImages();
  migrationInitContactPopups();
  migrationInitLeaseBalanceCalculator();
  migrationInitCasesNavigation();
  migrationInitCasesHeroButton();
  migrationInitCasesFooterCard();
});
