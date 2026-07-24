(function () {
  'use strict';

  const SETTINGS_URL = '/calc_nst/service/report/settings';
  const REPORT_URL = '/calc_nst/service/report/all-balance';
  const DEFAULT_TITLE = 'Расчёт сальдо исполнения обязательств';
  const MAX_TITLE_LENGTH = 160;

  let currentTitle = DEFAULT_TITLE;
  let lastPersistedTitle;
  let loadError = null;
  let persistenceQueue = Promise.resolve();
  let initialized = false;
  let refreshTimer = null;
  let refreshRevision = 0;
  let lastFocusedElement = null;
  let resolveReady;

  const metaState = {
    rows: [],
    reportISO: null,
    reportLabel: '',
    cutoffISO: null,
    cutoffLabel: '',
  };

  const elements = {
    root: null,
    printButton: null,
    editButton: null,
    summary: null,
    summaryTitle: null,
    summaryPeriod: null,
    summaryCutoffItem: null,
    summaryCutoff: null,
    modal: null,
    dialog: null,
    form: null,
    input: null,
    counter: null,
    status: null,
    saveButton: null,
    resetButton: null,
    cancelButton: null,
    closeButton: null,
  };

  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const publicApi = {
    DEFAULT_TITLE,
    MAX_TITLE_LENGTH,
    ready,
    getTitle: () => currentTitle,
    setTitle,
    resetTitle,
    updateMeta,
    refreshSummary,
  };

  window.ELEGSO_PRINT_DOCUMENT = publicApi;

  function getSessionId() {
    if (!window.ELEGSO || typeof window.ELEGSO.getSessionId !== 'function') {
      throw new Error('Не удалось определить ID текущего сеанса.');
    }
    const sessionId = String(window.ELEGSO.getSessionId() || '').trim();
    if (!sessionId) throw new Error('Не удалось определить ID текущего сеанса.');
    return sessionId;
  }

  function normalizeTitle(value) {
    const normalized = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) return DEFAULT_TITLE;
    if (Array.from(normalized).length > MAX_TITLE_LENGTH) {
      throw new RangeError(`Название должно быть не длиннее ${MAX_TITLE_LENGTH} символов.`);
    }
    return normalized;
  }

  function titleForStorage(value) {
    const normalized = normalizeTitle(value);
    return normalized === DEFAULT_TITLE ? null : normalized;
  }

  function parseISODate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(value || '').trim());
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 1900
      || year > 2200
      || candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      return null;
    }

    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  function parseDisplayDate(value) {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || '').trim());
    if (!match) return null;
    return parseISODate(`${match[3]}-${match[2]}-${match[1]}`);
  }

  function isoToDisplay(value) {
    const iso = parseISODate(value);
    if (!iso) return '';
    const [year, month, day] = iso.split('-');
    return `${day}.${month}.${year}`;
  }

  function readReportDate() {
    const input = elements.root && elements.root.querySelector('#repDate');
    const rawLabel = input ? String(input.value || '').trim() : '';
    const reportISO = parseDisplayDate(rawLabel);
    return {
      reportISO,
      reportLabel: reportISO ? rawLabel : '',
    };
  }

  function getMinimumRowISO(rows) {
    if (!Array.isArray(rows)) return null;
    return rows.reduce((minimum, row) => {
      const iso = parseISODate(row && row.dt);
      if (!iso) return minimum;
      return !minimum || iso < minimum ? iso : minimum;
    }, null);
  }

  function getPeriodText() {
    const endLabel = metaState.reportLabel || isoToDisplay(metaState.reportISO);
    const startISO = getMinimumRowISO(metaState.rows);
    const startLabel = isoToDisplay(startISO);

    if (startLabel && endLabel) return `${startLabel} — ${endLabel}`;
    if (endLabel) return `нет данных по ${endLabel}`;
    return 'будет определён после выбора даты отчёта';
  }

  function renderSummary() {
    if (!elements.summary) return;
    elements.summaryTitle.textContent = currentTitle;
    elements.summaryPeriod.textContent = getPeriodText();

    const cutoffLabel = metaState.cutoffLabel || isoToDisplay(metaState.cutoffISO);
    elements.summaryCutoffItem.hidden = !cutoffLabel;
    elements.summaryCutoff.textContent = cutoffLabel
      ? `${cutoffLabel} включительно`
      : '';
  }

  function updateCounter() {
    if (!elements.input || !elements.counter) return;
    elements.counter.textContent = `${Array.from(elements.input.value).length} / ${MAX_TITLE_LENGTH}`;
  }

  function updateTitle(nextTitle, options) {
    currentTitle = normalizeTitle(nextTitle);
    renderSummary();
    document.dispatchEvent(new CustomEvent('elegso:print-document-title:changed', {
      detail: {
        report_document_title: currentTitle,
        storedValue: titleForStorage(currentTitle),
        persisted: Boolean(options && options.persisted),
        source: options && options.source ? options.source : 'api',
      },
    }));
    return currentTitle;
  }

  async function parseResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      return {};
    }
  }

  function extractError(payload, fallback) {
    if (payload && typeof payload === 'object') {
      return payload.error || payload.message || payload.detail || fallback;
    }
    return fallback;
  }

  async function loadSetting() {
    const url = new URL(SETTINGS_URL, window.location.origin);
    url.searchParams.set('session_id', getSessionId());

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(extractError(payload, `Не удалось загрузить название (${response.status}).`));
    }

    const storedTitle = payload.report_document_title == null
      ? null
      : titleForStorage(payload.report_document_title);
    lastPersistedTitle = storedTitle;
    loadError = null;
    updateTitle(storedTitle || DEFAULT_TITLE, { persisted: true, source: 'load' });
  }

  async function persistTitleNow(storedTitle) {
    if (lastPersistedTitle === storedTitle && !loadError) return false;

    const response = await fetch(SETTINGS_URL, {
      method: 'PUT',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: getSessionId(),
        report_document_title: storedTitle,
      }),
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(extractError(payload, `Не удалось сохранить название (${response.status}).`));
    }

    lastPersistedTitle = storedTitle;
    loadError = null;
    return true;
  }

  async function setTitle(value, options) {
    if (!initialized) await ready;
    const config = options || {};
    const normalized = normalizeTitle(value);
    const storedTitle = titleForStorage(normalized);
    const shouldPersist = config.persist !== false;

    if (shouldPersist) {
      const operation = persistenceQueue
        .catch(() => undefined)
        .then(() => persistTitleNow(storedTitle));
      persistenceQueue = operation;
      await operation;
    }

    updateTitle(normalized, {
      persisted: shouldPersist,
      source: config.source || 'api',
    });
    return normalized;
  }

  function resetTitle(options) {
    const config = Object.assign({}, options, { source: (options && options.source) || 'reset' });
    return setTitle(DEFAULT_TITLE, config);
  }

  function updateMeta(metadata) {
    const next = metadata || {};
    if (Object.prototype.hasOwnProperty.call(next, 'rows')) {
      metaState.rows = Array.isArray(next.rows) ? next.rows.slice() : [];
    }
    if (Object.prototype.hasOwnProperty.call(next, 'reportISO')) {
      metaState.reportISO = parseISODate(next.reportISO);
    }
    if (Object.prototype.hasOwnProperty.call(next, 'reportLabel')) {
      metaState.reportLabel = String(next.reportLabel || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(next, 'cutoffISO')) {
      metaState.cutoffISO = parseISODate(next.cutoffISO);
    }
    if (Object.prototype.hasOwnProperty.call(next, 'cutoffLabel')) {
      metaState.cutoffLabel = String(next.cutoffLabel || '').trim();
    }

    renderSummary();
    return {
      title: currentTitle,
      periodStartISO: getMinimumRowISO(metaState.rows),
      reportISO: metaState.reportISO,
      reportLabel: metaState.reportLabel,
      cutoffISO: metaState.cutoffISO,
      cutoffLabel: metaState.cutoffLabel,
    };
  }

  async function getCutoff() {
    const controller = window.ELEGSO_REPORT_CUTOFF;
    if (!controller) return { cutoffISO: null, cutoffLabel: '' };
    if (controller.ready) await controller.ready;

    try {
      const cutoffISO = controller.getISO();
      const cutoffLabel = typeof controller.getDisplayValue === 'function'
        ? controller.getDisplayValue()
        : isoToDisplay(cutoffISO);
      return { cutoffISO, cutoffLabel };
    } catch (_) {
      return { cutoffISO: null, cutoffLabel: '' };
    }
  }

  async function refreshSummaryNow() {
    const revision = ++refreshRevision;
    const { reportISO, reportLabel } = readReportDate();
    const { cutoffISO, cutoffLabel } = await getCutoff();
    if (revision !== refreshRevision) return [];
    updateMeta({ rows: [], reportISO, reportLabel, cutoffISO, cutoffLabel });

    if (!reportISO) return [];

    const url = new URL(REPORT_URL, window.location.origin);
    url.searchParams.set('session_id', getSessionId());
    url.searchParams.set('report_date', reportISO);
    url.searchParams.set('indicator_cutoff_date', cutoffISO || '');

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(extractError(payload, `Не удалось определить период отчёта (${response.status}).`));
    }

    const rows = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload.rows) ? payload.rows : []);
    if (revision === refreshRevision) {
      updateMeta({ rows, reportISO, reportLabel, cutoffISO, cutoffLabel });
    }
    return rows;
  }

  async function refreshSummary() {
    if (!initialized) await ready;
    try {
      return await refreshSummaryNow();
    } catch (error) {
      console.warn('[elegso print document]', error);
      return [];
    }
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refreshSummary();
    }, typeof delay === 'number' ? delay : 180);
  }

  function setModalStatus(message, kind) {
    if (!elements.status) return;
    elements.status.textContent = message || '';
    elements.status.dataset.kind = kind || '';
    elements.status.hidden = !message;
  }

  function setModalBusy(isBusy) {
    [elements.input, elements.saveButton, elements.resetButton, elements.cancelButton, elements.closeButton]
      .filter(Boolean)
      .forEach((element) => {
        element.disabled = isBusy;
      });
    if (elements.form) elements.form.setAttribute('aria-busy', String(isBusy));
  }

  function getFocusableElements() {
    if (!elements.dialog) return [];
    return Array.from(elements.dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.hidden && element.offsetParent !== null);
  }

  function openModal() {
    if (!elements.modal) return;
    lastFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : elements.editButton;
    elements.input.value = currentTitle;
    updateCounter();
    setModalStatus(loadError ? 'Сохранённое название не загрузилось. Новое можно сохранить повторно.' : '', loadError ? 'warning' : '');
    elements.modal.hidden = false;
    document.body.classList.add('elegso-document-modal-open');
    window.requestAnimationFrame(() => {
      elements.input.focus();
      elements.input.select();
    });
  }

  function closeModal() {
    if (!elements.modal || elements.modal.hidden) return;
    elements.modal.hidden = true;
    document.body.classList.remove('elegso-document-modal-open');
    setModalStatus('', '');
    const focusTarget = lastFocusedElement && document.contains(lastFocusedElement)
      ? lastFocusedElement
      : elements.editButton;
    lastFocusedElement = null;
    if (focusTarget) focusTarget.focus();
  }

  function handleDialogKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      elements.dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function createInterface() {
    elements.root = document.getElementById('elegso-saldo-print');
    if (!elements.root) return false;

    const row = elements.root.querySelector(':scope > .row');
    elements.printButton = elements.root.querySelector('#btnPrint');
    if (!row || !elements.printButton) return false;

    elements.editButton = document.createElement('button');
    elements.editButton.type = 'button';
    elements.editButton.className = 'btn elegso-document-title-button';
    elements.editButton.setAttribute('aria-haspopup', 'dialog');
    elements.editButton.setAttribute('aria-controls', 'elegso-document-title-dialog');
    elements.editButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h4l10.8-10.8a2.1 2.1 0 0 0-3-3L5 17v3Z"/>
        <path d="m14.5 7.5 3 3"/>
      </svg>
      <span>Название документа</span>
    `;
    row.insertBefore(elements.editButton, elements.printButton);

    elements.summary = document.createElement('section');
    elements.summary.className = 'elegso-document-summary';
    elements.summary.setAttribute('aria-label', 'Реквизиты печатного документа');
    elements.summary.innerHTML = `
      <div class="elegso-document-summary__title">
        <span class="elegso-document-summary__label">Документ</span>
        <strong data-elegso-document-summary-title></strong>
      </div>
      <dl class="elegso-document-summary__facts">
        <div>
          <dt>Период сальдо</dt>
          <dd data-elegso-document-summary-period></dd>
        </div>
        <div data-elegso-document-summary-cutoff hidden>
          <dt>Показатели рассчитаны по</dt>
          <dd data-elegso-document-summary-cutoff-value></dd>
        </div>
      </dl>
    `;
    row.insertAdjacentElement('afterend', elements.summary);
    elements.summaryTitle = elements.summary.querySelector('[data-elegso-document-summary-title]');
    elements.summaryPeriod = elements.summary.querySelector('[data-elegso-document-summary-period]');
    elements.summaryCutoffItem = elements.summary.querySelector('[data-elegso-document-summary-cutoff]');
    elements.summaryCutoff = elements.summary.querySelector('[data-elegso-document-summary-cutoff-value]');

    elements.modal = document.createElement('div');
    elements.modal.className = 'elegso-document-modal';
    elements.modal.hidden = true;
    elements.modal.innerHTML = `
      <div class="elegso-document-modal__backdrop">
        <section
          id="elegso-document-title-dialog"
          class="elegso-document-modal__dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="elegso-document-title-heading"
          aria-describedby="elegso-document-title-help"
          tabindex="-1"
        >
          <div class="elegso-document-modal__head">
            <div>
              <span class="elegso-document-modal__eyebrow">Печатная форма</span>
              <h2 id="elegso-document-title-heading">Название документа</h2>
            </div>
            <button class="elegso-document-modal__close" type="button" aria-label="Закрыть окно">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m7 7 10 10M17 7 7 17"/>
              </svg>
            </button>
          </div>
          <form class="elegso-document-modal__form">
            <label for="elegso-document-title-input">Название в отчёте</label>
            <input
              id="elegso-document-title-input"
              type="text"
              maxlength="${MAX_TITLE_LENGTH}"
              autocomplete="off"
              aria-describedby="elegso-document-title-help elegso-document-title-counter elegso-document-title-status"
            >
            <div class="elegso-document-modal__input-meta">
              <span id="elegso-document-title-help">Название сохранится для текущего расчёта и попадёт в выгрузку данных.</span>
              <span id="elegso-document-title-counter" aria-live="polite"></span>
            </div>
            <p id="elegso-document-title-status" class="elegso-document-modal__status" role="status" aria-live="polite" hidden></p>
            <div class="elegso-document-modal__actions">
              <button class="elegso-document-modal__button elegso-document-modal__button--reset" type="button">Сбросить</button>
              <span class="elegso-document-modal__actions-spacer"></span>
              <button class="elegso-document-modal__button" type="button" data-elegso-document-cancel>Отмена</button>
              <button class="elegso-document-modal__button elegso-document-modal__button--primary" type="submit">Сохранить</button>
            </div>
          </form>
        </section>
      </div>
    `;
    document.body.appendChild(elements.modal);

    elements.dialog = elements.modal.querySelector('.elegso-document-modal__dialog');
    elements.form = elements.modal.querySelector('.elegso-document-modal__form');
    elements.input = elements.modal.querySelector('#elegso-document-title-input');
    elements.counter = elements.modal.querySelector('#elegso-document-title-counter');
    elements.status = elements.modal.querySelector('#elegso-document-title-status');
    elements.saveButton = elements.form.querySelector('[type="submit"]');
    elements.resetButton = elements.form.querySelector('.elegso-document-modal__button--reset');
    elements.cancelButton = elements.form.querySelector('[data-elegso-document-cancel]');
    elements.closeButton = elements.modal.querySelector('.elegso-document-modal__close');

    elements.editButton.addEventListener('click', openModal);
    elements.input.addEventListener('input', () => {
      updateCounter();
      setModalStatus('', '');
    });
    elements.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setModalBusy(true);
      setModalStatus('Сохранение…', 'pending');
      try {
        await setTitle(elements.input.value, { persist: true, source: 'modal' });
        closeModal();
      } catch (error) {
        setModalStatus(error.message || 'Не удалось сохранить название.', 'error');
        elements.input.focus();
      } finally {
        setModalBusy(false);
      }
    });
    elements.resetButton.addEventListener('click', async () => {
      setModalBusy(true);
      setModalStatus('Сохранение…', 'pending');
      try {
        await resetTitle({ persist: true, source: 'modal-reset' });
        closeModal();
      } catch (error) {
        setModalStatus(error.message || 'Не удалось сбросить название.', 'error');
      } finally {
        setModalBusy(false);
      }
    });
    elements.cancelButton.addEventListener('click', closeModal);
    elements.closeButton.addEventListener('click', closeModal);
    elements.modal.querySelector('.elegso-document-modal__backdrop').addEventListener('mousedown', (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (!elements.modal.hidden) handleDialogKeydown(event);
    });

    const reportDateInput = elements.root.querySelector('#repDate');
    reportDateInput.addEventListener('change', () => scheduleRefresh(0));
    reportDateInput.addEventListener('blur', () => scheduleRefresh(0));
    reportDateInput.addEventListener('input', () => scheduleRefresh(420));
    elements.root.addEventListener('click', (event) => {
      if (event.target.closest('.cal-grid button.day')) scheduleRefresh(0);
    });
    document.addEventListener('elegso:indicator-cutoff:changed', (event) => {
      const detail = event.detail || {};
      updateMeta({
        cutoffISO: detail.indicator_cutoff_date,
        cutoffLabel: detail.displayValue,
      });
      scheduleRefresh(0);
    });
    document.addEventListener('elegso:table:changed', () => scheduleRefresh(220));

    renderSummary();
    return true;
  }

  async function init() {
    const hasInterface = createInterface();
    if (hasInterface) {
      try {
        await loadSetting();
      } catch (error) {
        loadError = error;
        lastPersistedTitle = undefined;
        updateTitle(DEFAULT_TITLE, { persisted: false, source: 'load-error' });
        console.warn('[elegso print document]', error);
      }
    }

    initialized = true;
    resolveReady(publicApi);

    if (hasInterface) {
      if (document.readyState === 'complete') {
        scheduleRefresh(0);
      } else {
        window.addEventListener('load', () => scheduleRefresh(0), { once: true });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
