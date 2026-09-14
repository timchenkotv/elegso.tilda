(() => {
  'use strict';
  if (window.__elegsoPrivacyInitialized) return;
  const source = document.querySelector('[data-elegso-privacy-config]');
  if (!source) return;
  let config;
  try { config = JSON.parse(source.textContent); } catch { return; }
  if (config.schemaVersion !== 1 || config.analytics?.provider !== 'yandex-metrika' || config.analytics.counterId !== 87831358
    || ['defaultEnabled', 'webvisor', 'clickmap', 'trackLinks', 'accurateTrackBounce', 'ecommerce', 'trackHash'].some(key => config.analytics[key] !== false)
    || !config.consentVersion || !config.storageKey || config.receiptUrl !== '/api/privacy/consent') return;
  window.__elegsoPrivacyInitialized = true;
  const counter = config.analytics.counterId;
  const maxAge = Math.min(365, Math.max(1, config.maxAgeDays || 180)) * 86400000;
  let preferences = null;
  let loader = null;
  let active = false;
  let loading = false;
  let generation = 0;
  let returnFocus = null;
  let expiryTimer = 0;
  let choiceGeneration = 0;
  let pendingChoiceId = null;
  let pendingRequest = null;

  function validReceipt(receipt, choiceId, analytics) {
    const at = Date.parse(receipt?.recorded_at);
    const expires = Date.parse(receipt?.expires_at);
    return typeof choiceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(choiceId)
      && receipt?.choice_id === choiceId && receipt?.version === config.consentVersion && receipt?.analytics === analytics
      && Number.isFinite(at) && at <= Date.now() + 60000 && expires > Date.now() && expires <= at + maxAge + 60000;
  }

  function parsePreferences(raw) {
    try {
      const value = JSON.parse(raw);
      const expires = Date.parse(value?.expiresAt);
      const updated = Date.parse(value?.updatedAt);
      return value?.version === config.consentVersion && value.necessary === true && typeof value.analytics === 'boolean'
        && Number.isFinite(updated) && updated <= Date.now() + 60000 && Number.isFinite(expires) && expires > Date.now()
        && expires <= updated + maxAge + 60000
        && (!value.analytics || validReceipt(value.receipt, value.choiceId, true)) ? value : null;
    } catch { return null; }
  }
  function readPreferences() {
    try { return parsePreferences(window.localStorage.getItem(config.storageKey)); } catch { return null; }
  }
  function scheduleExpiration() {
    window.clearTimeout(expiryTimer);
    if (!preferences) return;
    const remaining = Date.parse(preferences.expiresAt) - Date.now();
    expiryTimer = window.setTimeout(() => {
      if (preferences && Date.parse(preferences.expiresAt) <= Date.now()) {
        preferences = null;
        stopAnalytics();
        showPanel();
      } else scheduleExpiration();
    }, Math.max(1, Math.min(remaining, 2147483647)));
  }
  function permitted() { return preferences?.analytics === true && validReceipt(preferences.receipt, preferences.choiceId, true) && Date.parse(preferences.expiresAt) > Date.now(); }
  function cleanUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : '';
    } catch { return ''; }
  }
  function removeAccessibleAnalyticsCookies(includeYandex = true) {
    const names = document.cookie.split(';').map(item => item.trim().split('=')[0]).filter(name => (
      /^(?:_ga(?:_|$)|_gid$|_gat(?:_|$)|_gcl_|tmr_)/.test(name)
      || (includeYandex && /^(?:_ym(?:_|$)|_yasc$)/.test(name))
    ));
    const hostname = window.location.hostname;
    const domains = ['', hostname, `.${hostname}`];
    if (hostname === 'elegso.ru' || hostname.endsWith('.elegso.ru')) domains.push('elegso.ru', '.elegso.ru');
    const paths = new Set(['/']);
    let current = '';
    for (const part of window.location.pathname.split('/').filter(Boolean)) {
      current += `/${part}`; paths.add(current); paths.add(`${current}/`);
    }
    for (const name of names) for (const domain of new Set(domains)) for (const cookiePath of paths) {
      document.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${cookiePath}${domain ? `; domain=${domain}` : ''}; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
    }
    // Only vendor-owned analytics keys; never clear all browser storage or
    // touch calculator sessions, drafts, settings or the consent receipt.
    for (const storeName of ['localStorage', 'sessionStorage']) {
      try {
        const store = window[storeName];
        const keys = [];
        for (let index = 0; index < store.length; index++) keys.push(store.key(index));
        for (const key of keys) {
          if (typeof key === 'string' && (/^(?:_ga(?:_|$)|_gcl_|tmr_)/.test(key) || (includeYandex && /^_ym(?:_|$)/.test(key)))) store.removeItem(key);
        }
      } catch {}
    }
    // This cannot erase HttpOnly cookies, cookies on third-party domains, or
    // data already sent to a provider. The interface explicitly says so.
  }
  function stopAnalytics() {
    generation += 1;
    if (active && typeof window.ym === 'function') {
      try { window.ym(counter, 'destruct'); } catch {}
    }
    active = false;
    loading = false;
    if (loader) { loader.onload = null; loader.onerror = null; loader.remove(); loader = null; }
    if (window.ym?.a) window.ym.a.length = 0;
    removeAccessibleAnalyticsCookies(true);
  }
  function startAnalytics() {
    if (!permitted() || active || loading) return;
    loading = true;
    const ownGeneration = ++generation;
    if (typeof window.ym !== 'function') {
      window.ym = function () { (window.ym.a = window.ym.a || []).push(arguments); };
      window.ym.l = Date.now();
    }
    const initialize = () => {
      if (ownGeneration !== generation || !permitted()) return;
      loading = false;
      active = true;
      // Basic page statistics only. Never send calculator field values,
      // contacts, custom user identifiers, link/click maps or session replay.
      window.ym(counter, 'init', {
        defer: true, webvisor: false, clickmap: false, trackLinks: false,
        accurateTrackBounce: false, ecommerce: false, trackHash: false,
        childIframe: false, triggerEvent: false, sendTitle: false,
      });
      window.ym(counter, 'hit', cleanUrl(window.location.href), {
        title: document.title, referer: document.referrer ? cleanUrl(document.referrer) : '',
      });
    };
    loader = document.createElement('script');
    loader.async = true;
    loader.src = 'https://mc.yandex.ru/metrika/tag.js';
    loader.setAttribute('data-elegso-consented-metrika', String(counter));
    loader.referrerPolicy = 'strict-origin-when-cross-origin';
    loader.onload = initialize;
    loader.onerror = () => {
      if (ownGeneration !== generation) return;
      loading = false;
      status.textContent = 'Выбор сохранён, но сервис статистики сейчас недоступен. Сайт продолжает работать.';
    };
    document.head.appendChild(loader);
  }

  const panel = document.createElement('section');
  panel.className = 'esp-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'esp-title');
  panel.setAttribute('tabindex', '-1');
  panel.innerHTML = `<h2 id="esp-title">Файлы cookie</h2><button type="button" class="esp-close" data-esp-close aria-label="Закрыть уведомление без изменения выбора">×</button>
    <p class="esp-intro">Разрешить cookie для статистики сайта? <a href="/consent/">Подробнее</a></p>
    <div class="esp-actions"><button type="button" data-esp-accept>Разрешить</button><button type="button" data-esp-reject>Отклонить</button><button type="button" class="esp-settings-button" data-esp-settings aria-expanded="false" aria-controls="esp-options">Настройки</button></div>
    <div class="esp-options" id="esp-options" hidden><p><strong>Необходимые cookie</strong> сохраняют настройки и работу калькуляторов. Они остаются включёнными.</p>
      <label class="esp-choice"><input type="checkbox" data-esp-analytics><span><strong>Статистика посещений</strong><span>Помогает улучшать сайт. Без записи полей и содержимого расчётов.</span></span></label>
      <p class="esp-note">Чтобы отозвать согласие, снимите отметку и сохраните выбор. Данные калькуляторов останутся. Удаление ранее переданных данных — по обращению к нам.</p>
      <button type="button" class="esp-save" data-esp-save>Сохранить выбор</button>
      <div class="esp-links"><a href="/cookies/">О файлах cookie</a><a href="/soglashenie/">Политика обработки данных</a></div></div>
    <p class="esp-status" data-esp-status role="status" aria-live="polite"></p>`;
  document.body.appendChild(panel);
  const checkbox = panel.querySelector('[data-esp-analytics]');
  const options = panel.querySelector('[id="esp-options"]');
  const settingsButton = panel.querySelector('[data-esp-settings]');
  const status = panel.querySelector('[data-esp-status]');

  function hidePanel() {
    panel.hidden = true;
    if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function showPanel(settings = false, trigger = null) {
    returnFocus = trigger;
    if (!pendingRequest) status.textContent = '';
    checkbox.checked = permitted();
    options.hidden = !settings;
    settingsButton.setAttribute('aria-expanded', String(settings));
    panel.hidden = false;
    if (trigger) panel.focus({ preventScroll: true });
  }
  function newChoiceId() {
    if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
    if (!window.crypto?.getRandomValues) throw new Error('secure_random_unavailable');
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function persistChoice(analytics, choiceId, receipt = null) {
    const now = Date.now();
    let saved = true;
    preferences = { version: config.consentVersion, necessary: true, analytics, choiceId, receipt,
      updatedAt: receipt?.recorded_at || new Date(now).toISOString(), expiresAt: receipt?.expires_at || new Date(now + maxAge).toISOString() };
    try { window.localStorage.setItem(config.storageKey, JSON.stringify(preferences)); } catch {
      saved = false;
      status.textContent = 'Браузер не разрешил сохранить настройку. Выбор действует для открытой страницы; при следующем посещении мы спросим снова.';
    }
    scheduleExpiration();
    return saved;
  }
  async function saveChoice(analytics) {
    analytics = analytics === true;
    if (analytics && permitted() && !pendingRequest) { status.textContent = ''; hidePanel(); return; }
    if (analytics && pendingRequest) return; // Double-click is not another grant.
    const action = ++choiceGeneration;
    const priorId = pendingChoiceId || preferences?.choiceId;
    if (pendingRequest) { pendingRequest.abort(); pendingRequest = null; }
    let choiceId;
    try { choiceId = analytics ? newChoiceId() : (priorId || newChoiceId()); }
    catch {
      stopAnalytics();
      persistChoice(false, null);
      panel.hidden = false;
      status.textContent = 'Аналитика выключена. Браузер не позволяет безопасно сохранить подтверждение согласия.';
      return;
    }
    pendingChoiceId = choiceId;
    // Revocation takes effect before any request or receipt acknowledgement.
    // Keep the old UUID to link this refusal to the earlier grant, if present.
    if (!analytics) { stopAnalytics(); persistChoice(false, choiceId); checkbox.checked = false; }
    status.textContent = analytics ? 'Сохраняем ваше согласие. Аналитика пока выключена…' : 'Аналитика выключена. Сохраняем подтверждение выбора…';
    panel.hidden = false;
    const controller = new AbortController();
    pendingRequest = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await window.fetch(config.receiptUrl, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice_id: choiceId, version: config.consentVersion, analytics }), signal: controller.signal,
      });
      if (!response.ok) throw new Error('receipt_unavailable');
      const result = await response.json();
      if (action !== choiceGeneration) return;
      if (!validReceipt(result.receipt, choiceId, analytics)) throw new Error('invalid_receipt');
      status.textContent = '';
      const saved = persistChoice(analytics, choiceId, result.receipt);
      if (permitted()) startAnalytics();
      if (saved) hidePanel();
      else { checkbox.checked = permitted(); panel.hidden = false; }
    } catch {
      if (action !== choiceGeneration) return;
      stopAnalytics();
      // Never assume a grant when the acknowledgement is absent. A refusal
      // remains valid locally even if our server cannot receive its receipt.
      persistChoice(false, choiceId);
      checkbox.checked = false;
      panel.hidden = false;
      status.textContent = analytics
        ? 'Не удалось сохранить подтверждение согласия. Аналитика не включена. Можно повторить попытку или продолжить без аналитики.'
        : 'Аналитика выключена. Серверное подтверждение пока не доставлено; это не мешает отзыву согласия и работе сайта.';
    } finally {
      window.clearTimeout(timeout);
      if (action === choiceGeneration) { pendingRequest = null; pendingChoiceId = null; }
    }
  }
  panel.querySelector('[data-esp-accept]').addEventListener('click', () => saveChoice(true));
  panel.querySelector('[data-esp-reject]').addEventListener('click', () => saveChoice(false));
  panel.querySelector('[data-esp-save]').addEventListener('click', () => saveChoice(checkbox.checked));
  panel.querySelector('[data-esp-close]').addEventListener('click', hidePanel);
  settingsButton.addEventListener('click', () => {
    options.hidden = !options.hidden;
    settingsButton.setAttribute('aria-expanded', String(!options.hidden));
  });
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-elegso-cookie-settings]');
    if (!trigger) return;
    event.preventDefault();
    showPanel(true, trigger);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) hidePanel(); });
  window.addEventListener('storage', event => {
    if (event.key !== config.storageKey && event.key !== null) return;
    choiceGeneration += 1;
    if (pendingRequest) pendingRequest.abort();
    pendingRequest = null;
    pendingChoiceId = null;
    preferences = readPreferences();
    if (permitted()) startAnalytics(); else stopAnalytics();
    scheduleExpiration();
    if (preferences) hidePanel(); else showPanel();
  });
  // The receipt records a random browser choice, not a person's identity or
  // electronic signature. Clearing/changing the local record asks again.
  preferences = readPreferences();
  removeAccessibleAnalyticsCookies(!permitted());
  if (permitted()) startAnalytics();
  scheduleExpiration();
  if (!preferences) showPanel();
})();
