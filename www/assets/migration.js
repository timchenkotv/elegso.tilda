
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
    styles.href = '/assets/lease-balance-calculator.css?v=20260719-1';
    styles.dataset.elegsoLeaseStyles = 'true';
    document.head.appendChild(styles);
  }

  if (!document.querySelector('script[data-elegso-lease-script]')) {
    const script = document.createElement('script');
    script.src = '/assets/lease-balance-calculator.js?v=20260719-1';
    script.defer = true;
    script.dataset.elegsoLeaseScript = 'true';
    document.body.appendChild(script);
  }
}
window.t_lazyload_update = migrationHydrateImages;
document.addEventListener('DOMContentLoaded', () => {
  migrationHydrateImages();
  migrationInitContactPopups();
  migrationInitLeaseBalanceCalculator();
});
