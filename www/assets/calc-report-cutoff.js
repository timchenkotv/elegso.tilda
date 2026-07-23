(function () {
  'use strict';

  const API_URL = '/calc_nst/service/report/settings';
  const FIELD_NAME = 'indicator_cutoff_date';
  const MIN_YEAR = 1900;
  const MAX_YEAR = 2200;
  const fieldInstances = [];

  let displayValue = '';
  let lastPersistedISO;
  let settingLoadError = null;
  let persistenceQueue = Promise.resolve();
  let resolveReady;

  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const publicApi = {
    ready,
    getISO,
    getDisplayValue: () => displayValue,
    setISO,
    clear: () => setISO(null, { persist: true, source: 'clear' }),
  };

  window.ELEGSO_REPORT_CUTOFF = publicApi;

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function parseDisplayDate(value) {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || '').trim());
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (
      year < MIN_YEAR
      || year > MAX_YEAR
      || month < 1
      || month > 12
      || day < 1
      || day > daysInMonth(year, month)
    ) {
      return null;
    }

    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function parseISODate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      year < MIN_YEAR
      || year > MAX_YEAR
      || month < 1
      || month > 12
      || day < 1
      || day > daysInMonth(year, month)
    ) {
      return null;
    }

    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function isoToDisplay(value) {
    const iso = parseISODate(value);
    if (!iso) return '';
    const [year, month, day] = iso.split('-');
    return `${day}.${month}.${year}`;
  }

  function maskDisplayDate(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
    return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
  }

  function getSessionId() {
    if (!window.ELEGSO || typeof window.ELEGSO.getSessionId !== 'function') {
      throw new Error('Не удалось определить ID текущего сеанса.');
    }
    const sessionId = window.ELEGSO.getSessionId();
    if (!sessionId) throw new Error('Не удалось определить ID текущего сеанса.');
    return sessionId;
  }

  function getISO() {
    if (settingLoadError) {
      throw new Error(
        'Не удалось загрузить сохранённую дату расчёта показателей. '
        + 'Обновите страницу или задайте дату повторно.'
      );
    }
    const value = String(displayValue || '').trim();
    if (!value) return null;

    const iso = parseDisplayDate(value);
    if (!iso) {
      throw new RangeError('Укажите корректную дату в формате ДД.ММ.ГГГГ.');
    }
    return iso;
  }

  function setBusy(isBusy) {
    fieldInstances.forEach((instance) => {
      instance.field.setAttribute('aria-busy', String(isBusy));
      instance.input.disabled = isBusy;
      instance.calendarButton.disabled = isBusy;
      instance.clearButton.disabled = isBusy;
    });
  }

  function setStatus(message, kind) {
    fieldInstances.forEach((instance) => {
      instance.status.textContent = message || '';
      instance.status.dataset.kind = kind || '';
      instance.status.hidden = !message;
      instance.help.hidden = Boolean(message) || !instance.error.hidden;
    });
  }

  function setValidationError(message) {
    fieldInstances.forEach((instance) => {
      instance.input.setAttribute('aria-invalid', 'true');
      instance.error.textContent = message;
      instance.error.hidden = false;
      instance.help.hidden = true;
      instance.status.hidden = true;
    });
  }

  function clearValidationError() {
    fieldInstances.forEach((instance) => {
      instance.input.setAttribute('aria-invalid', 'false');
      instance.error.textContent = '';
      instance.error.hidden = true;
      instance.status.hidden = !instance.status.textContent;
      instance.help.hidden = Boolean(instance.status.textContent);
    });
  }

  function updateFields(nextDisplayValue) {
    displayValue = nextDisplayValue;
    const iso = parseDisplayDate(nextDisplayValue);

    fieldInstances.forEach((instance) => {
      if (instance.input.value !== nextDisplayValue) {
        instance.input.value = nextDisplayValue;
      }
      instance.nativeInput.value = iso || '';
      instance.clearButton.hidden = !nextDisplayValue;
    });
  }

  function dispatchChanged(iso, source, persisted) {
    document.dispatchEvent(new CustomEvent('elegso:indicator-cutoff:changed', {
      detail: {
        indicator_cutoff_date: iso,
        displayValue,
        persisted: Boolean(persisted),
        source: source || 'api',
      },
    }));
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
    const url = new URL(API_URL, window.location.origin);
    url.searchParams.set('session_id', getSessionId());

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(extractError(payload, `Не удалось загрузить дату (${response.status}).`));
    }

    const rawValue = payload[FIELD_NAME]
      ?? payload.cutoff_date
      ?? payload.calculation_cutoff_date
      ?? null;
    const iso = rawValue === null || rawValue === '' ? null : parseISODate(rawValue);
    if (rawValue && !iso) {
      throw new Error('Сервер вернул некорректную дату окончания расчёта.');
    }

    updateFields(isoToDisplay(iso));
    clearValidationError();
    lastPersistedISO = iso;
    settingLoadError = null;
    dispatchChanged(iso, 'load', true);
    return iso;
  }

  async function persistSettingNow(iso) {
    if (lastPersistedISO === iso) return false;

    setStatus('Сохранение…', 'pending');

    const response = await fetch(API_URL, {
      method: 'PUT',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: getSessionId(),
        [FIELD_NAME]: iso,
      }),
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(extractError(payload, `Не удалось сохранить дату (${response.status}).`));
    }

    lastPersistedISO = iso;
    settingLoadError = null;
    setStatus('Сохранено', 'success');
    return true;
  }

  function persistSetting(iso) {
    const operation = persistenceQueue
      .catch(() => undefined)
      .then(() => persistSettingNow(iso));
    persistenceQueue = operation;
    return operation;
  }

  async function setISO(value, options) {
    const config = options || {};
    const shouldPersist = config.persist !== false;
    const source = config.source || 'api';
    let iso = null;

    if (value !== null && value !== undefined && value !== '') {
      iso = parseISODate(value);
      if (!iso) {
        const message = 'Укажите корректную дату в формате ДД.ММ.ГГГГ.';
        setValidationError(message);
        throw new RangeError(message);
      }
    }

    updateFields(isoToDisplay(iso));
    clearValidationError();

    let persisted = false;
    if (shouldPersist) {
      try {
        persisted = await persistSetting(iso);
      } catch (error) {
        setStatus(error.message || 'Не удалось сохранить дату.', 'error');
        dispatchChanged(iso, source, false);
        throw error;
      }
    }

    dispatchChanged(iso, source, shouldPersist ? (persisted || lastPersistedISO === iso) : false);
    return iso;
  }

  async function commitDisplayValue(source) {
    const rawValue = String(displayValue || '').trim();
    if (!rawValue) {
      try {
        await setISO(null, { persist: true, source });
      } catch (_) {
        // The visible status already explains a network or server-side failure.
      }
      return;
    }

    const iso = parseDisplayDate(rawValue);
    if (!iso) {
      setValidationError('Укажите существующую дату в формате ДД.ММ.ГГГГ.');
      setStatus('', '');
      return;
    }

    try {
      await setISO(iso, { persist: true, source });
    } catch (_) {
      // The visible status already explains a network or server-side failure.
    }
  }

  function createField(locationName) {
    const field = document.createElement('div');
    const idSuffix = locationName === 'report' ? 'report' : 'print';
    const errorLiveAttributes = locationName === 'report' ? ' role="alert"' : '';
    const statusLiveAttributes = locationName === 'report'
      ? ' role="status" aria-live="polite"'
      : '';
    const inputId = `elegso-indicator-cutoff-${idSuffix}`;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;

    field.className = 'field elegso-cutoff-field';
    field.dataset.elegsoCutoffField = locationName;
    field.innerHTML = `
      <span class="elegso-cutoff-label">
        <label for="${inputId}">Показатели рассчитать по</label>
        <span class="elegso-cutoff-badge">необязательно</span>
      </span>
      <span class="elegso-cutoff-date-wrap">
        <input
          id="${inputId}"
          class="elegso-cutoff-input"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          maxlength="10"
          placeholder="ДД.ММ.ГГГГ"
          aria-describedby="${helpId} ${errorId}"
          aria-invalid="false"
        >
        <button
          class="elegso-cutoff-icon-button elegso-cutoff-calendar"
          type="button"
          aria-label="Выбрать дату окончания расчёта"
          title="Выбрать дату"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/>
          </svg>
        </button>
        <button
          class="elegso-cutoff-icon-button elegso-cutoff-clear"
          type="button"
          aria-label="Очистить дату окончания расчёта"
          title="Очистить дату"
          hidden
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17"/>
          </svg>
        </button>
        <input
          class="elegso-cutoff-native-date"
          type="date"
          min="${MIN_YEAR}-01-01"
          max="${MAX_YEAR}-12-31"
          tabindex="-1"
          aria-hidden="true"
        >
      </span>
      <span id="${helpId}" class="elegso-cutoff-help">По эту дату включительно рассчитываются неустойка и процентные показатели. Она не может быть позже даты отчёта. Пустое поле — текущий порядок.</span>
      <span id="${errorId}" class="elegso-cutoff-error"${errorLiveAttributes} hidden></span>
      <span class="elegso-cutoff-status"${statusLiveAttributes} hidden></span>
    `;

    const instance = {
      field,
      input: field.querySelector('.elegso-cutoff-input'),
      nativeInput: field.querySelector('.elegso-cutoff-native-date'),
      calendarButton: field.querySelector('.elegso-cutoff-calendar'),
      clearButton: field.querySelector('.elegso-cutoff-clear'),
      help: field.querySelector('.elegso-cutoff-help'),
      error: field.querySelector('.elegso-cutoff-error'),
      status: field.querySelector('.elegso-cutoff-status'),
    };
    fieldInstances.push(instance);

    instance.input.addEventListener('input', (event) => {
      const masked = maskDisplayDate(event.target.value);
      updateFields(masked);
      setStatus('', '');
      if (!masked || parseDisplayDate(masked)) clearValidationError();
    });
    instance.input.addEventListener('change', () => commitDisplayValue('text-change'));
    instance.input.addEventListener('blur', () => commitDisplayValue('text-blur'));

    instance.calendarButton.addEventListener('click', () => {
      const currentISO = parseDisplayDate(displayValue);
      instance.nativeInput.value = currentISO || '';
      try {
        if (typeof instance.nativeInput.showPicker === 'function') {
          instance.nativeInput.showPicker();
        } else {
          instance.nativeInput.click();
        }
      } catch (_) {
        instance.nativeInput.click();
      }
    });

    instance.nativeInput.addEventListener('change', async () => {
      if (!instance.nativeInput.value) return;
      try {
        await setISO(instance.nativeInput.value, {
          persist: true,
          source: 'calendar',
        });
      } catch (_) {
        // The visible status already explains a network or server-side failure.
      }
    });

    instance.clearButton.addEventListener('click', async () => {
      try {
        await publicApi.clear();
        instance.input.focus();
      } catch (_) {
        // The visible status already explains a network or server-side failure.
      }
    });

    return field;
  }

  function insertFields() {
    const reportControls = document.querySelector('#elegso-saldo-ab .ctrls');
    const reportDateField = reportControls
      ? reportControls.querySelector('#repDate')?.closest('label.field')
      : null;
    if (reportDateField && !reportControls.querySelector('[data-elegso-cutoff-field="report"]')) {
      reportDateField.insertAdjacentElement('afterend', createField('report'));
    }

    const printRow = document.querySelector('#elegso-saldo-print .row');
    const printDateField = printRow
      ? printRow.querySelector('#repDate')?.closest('label.field')
      : null;
    if (printDateField && !printRow.querySelector('[data-elegso-cutoff-field="print"]')) {
      printDateField.insertAdjacentElement('afterend', createField('print'));
    }
  }

  async function init() {
    insertFields();
    if (!fieldInstances.length) {
      resolveReady(publicApi);
      return;
    }

    setBusy(true);
    setStatus('Загрузка…', 'pending');
    try {
      await loadSetting();
      setStatus('', '');
    } catch (error) {
      settingLoadError = error;
      updateFields('');
      clearValidationError();
      setStatus(error.message || 'Не удалось загрузить сохранённую дату.', 'error');
      dispatchChanged(null, 'load-error', false);
    } finally {
      setBusy(false);
      resolveReady(publicApi);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
