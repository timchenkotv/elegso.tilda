(function () {
  'use strict';

  const API_URL = '/calc_nst/service/cbr/key-rate/import';
  const SOURCE_URL = 'https://www.cbr.ru/hd_base/KeyRate/';
  const MIN_DATE = '2013-09-17';

  function localISODate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function plural(number, one, few, many) {
    const absolute = Math.abs(Number(number)) % 100;
    const last = absolute % 10;
    if (absolute > 10 && absolute < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  }

  function init() {
    const root = document.getElementById('elegso-indicators');
    if (!root || root.dataset.cbrImportReady === 'true') return;

    const actions = root.querySelector('.elegso-actions');
    const cbRateTab = root.querySelector('#tabbtn-cb_rate');
    if (!actions || !cbRateTab) return;

    root.dataset.cbrImportReady = 'true';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'elegso-cbr-import-button';
    trigger.hidden = true;
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', 'elegso-cbr-import-modal');
    trigger.innerHTML = [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      '<path d="M12 3v11m0 0 4-4m-4 4-4-4M5 14v5h14v-5"/>',
      '</svg>',
      '<span>Загрузить ставки ЦБ РФ</span>',
    ].join('');
    actions.prepend(trigger);

    const modal = document.createElement('div');
    modal.id = 'elegso-cbr-import-modal';
    modal.className = 'elegso-cbr-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="elegso-cbr-modal__backdrop" data-cbr-close aria-hidden="true"></div>
      <section class="elegso-cbr-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="elegso-cbr-modal-title"
        aria-describedby="elegso-cbr-modal-description">
        <button class="elegso-cbr-modal__close" type="button" data-cbr-close
          aria-label="Закрыть окно">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18"/>
          </svg>
        </button>

        <div class="elegso-cbr-modal__eyebrow">Официальные данные</div>
        <h3 id="elegso-cbr-modal-title">Загрузка ключевой ставки ЦБ РФ</h3>
        <p id="elegso-cbr-modal-description" class="elegso-cbr-modal__lead">
          Выберите период. Калькулятор загрузит ставку на начало периода и
          только даты её изменений — одинаковые значения за каждый день
          добавляться не будут.
        </p>

        <form class="elegso-cbr-modal__form" novalidate>
          <div class="elegso-cbr-modal__period">
            <label>
              <span>Начало периода</span>
              <input name="from" type="date" min="${MIN_DATE}" required>
            </label>
            <label>
              <span>Конец периода</span>
              <input name="to" type="date" min="${MIN_DATE}" required>
            </label>
          </div>

          <div class="elegso-cbr-modal__notice">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v5m0 3v.01"/>
            </svg>
            <p>
              <strong>Повторная загрузка безопасна.</strong>
              Совпадающие данные не дублируются. Если период пересекается с
              уже загруженным, строки ключевой ставки внутри выбранного
              периода будут приведены к официальным данным Банка России.
              Строки вне выбранного периода не изменяются.
            </p>
          </div>

          <a class="elegso-cbr-modal__source" href="${SOURCE_URL}"
            target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 5h5v5m0-5-8 8M19 14v5H5V5h5"/>
            </svg>
            Источник: Банк России — ключевая ставка
          </a>

          <div class="elegso-cbr-modal__status" role="status" aria-live="polite" hidden></div>

          <div class="elegso-cbr-modal__actions">
            <button class="elegso-cbr-modal__cancel" type="button" data-cbr-close>
              Отмена
            </button>
            <button class="elegso-cbr-modal__submit" type="submit">
              <span class="elegso-cbr-modal__submit-label">Загрузить ставки</span>
              <span class="elegso-cbr-modal__spinner" aria-hidden="true"></span>
            </button>
          </div>
        </form>
      </section>`;
    document.body.append(modal);

    const form = modal.querySelector('form');
    const dateFrom = form.elements.from;
    const dateTo = form.elements.to;
    const submit = modal.querySelector('.elegso-cbr-modal__submit');
    const status = modal.querySelector('.elegso-cbr-modal__status');
    const sourceLink = modal.querySelector('.elegso-cbr-modal__source');
    const dialog = modal.querySelector('.elegso-cbr-modal__dialog');
    const closeButtons = modal.querySelectorAll('[data-cbr-close]');
    let previouslyFocused = null;
    let loading = false;

    const today = new Date();
    const todayISO = localISODate(today);
    dateFrom.value = `${today.getFullYear()}-01-01`;
    dateTo.value = todayISO;
    dateFrom.max = todayISO;
    dateTo.max = todayISO;

    function updateSourceLink() {
      const url = new URL(SOURCE_URL);
      const format = (value) => value
        ? value.split('-').reverse().join('.')
        : '';
      if (dateFrom.value && dateTo.value) {
        url.searchParams.set('UniDbQuery.Posted', 'True');
        url.searchParams.set('UniDbQuery.From', format(dateFrom.value));
        url.searchParams.set('UniDbQuery.To', format(dateTo.value));
      }
      sourceLink.href = url.toString();
    }

    function setStatus(message, type) {
      status.className = `elegso-cbr-modal__status elegso-cbr-modal__status--${type}`;
      status.textContent = message;
      status.hidden = false;
    }

    function clearStatus() {
      status.hidden = true;
      status.textContent = '';
      status.className = 'elegso-cbr-modal__status';
    }

    function setLoading(value) {
      loading = value;
      submit.disabled = value;
      dateFrom.disabled = value;
      dateTo.disabled = value;
      submit.classList.toggle('is-loading', value);
      submit.setAttribute('aria-busy', value ? 'true' : 'false');
    }

    function openModal() {
      previouslyFocused = document.activeElement;
      if (!loading) clearStatus();
      updateSourceLink();
      modal.hidden = false;
      document.body.classList.add('elegso-cbr-modal-open');
      window.requestAnimationFrame(() => {
        modal.classList.add('is-open');
        dateFrom.focus();
      });
    }

    function closeModal() {
      modal.classList.remove('is-open');
      document.body.classList.remove('elegso-cbr-modal-open');
      window.setTimeout(() => {
        modal.hidden = true;
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
      }, 180);
    }

    function syncTriggerVisibility() {
      trigger.hidden = cbRateTab.getAttribute('aria-selected') !== 'true';
    }

    function summaryText(data) {
      const summary = data && data.summary ? data.summary : {};
      const daily = Number(summary.official_daily_rows || 0);
      const points = Number(summary.change_points || 0);
      const added = Number(summary.inserted || 0);
      const updated = Number(summary.updated || 0);
      const skipped = Number(summary.skipped || 0);
      const duplicateRows = Number(summary.removed_same_date_duplicates || 0);
      const placeholders = Number(summary.removed_placeholders || 0);
      const obsolete = Number(summary.removed_obsolete_points || 0);
      const redundant = Number(summary.removed_redundant_points || 0);

      const parts = [
        `В официальной выборке: ${daily} ${plural(daily, 'ежедневная запись', 'ежедневные записи', 'ежедневных записей')}; сохранено ${points} ${plural(points, 'точка изменения', 'точки изменения', 'точек изменения')}.`,
        `Добавлено: ${added}, обновлено: ${updated}, уже было: ${skipped}.`,
      ];
      const removed = duplicateRows + placeholders + obsolete + redundant;
      if (removed) {
        parts.push(`Удалено служебных или повторных строк: ${removed}.`);
      }
      return parts.join(' ');
    }

    trigger.addEventListener('click', openModal);
    closeButtons.forEach((button) => button.addEventListener('click', closeModal));
    dateFrom.addEventListener('change', () => {
      if (dateTo.value && dateFrom.value > dateTo.value) dateTo.value = dateFrom.value;
      updateSourceLink();
    });
    dateTo.addEventListener('change', updateSourceLink);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) {
        event.preventDefault();
        closeModal();
      }
    });

    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), a[href]',
      )).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearStatus();

      if (!dateFrom.value || !dateTo.value) {
        setStatus('Укажите начало и конец периода.', 'error');
        return;
      }
      if (dateFrom.value > dateTo.value) {
        setStatus('Дата начала периода не может быть позже даты окончания.', 'error');
        dateFrom.focus();
        return;
      }

      const sessionId = window.ELEGSO
        && typeof window.ELEGSO.getSessionId === 'function'
        ? window.ELEGSO.getSessionId()
        : '';
      if (!sessionId) {
        setStatus('Не удалось определить сеанс калькулятора. Обновите страницу и повторите попытку.', 'error');
        return;
      }

      setLoading(true);
      setStatus('Получаем официальные данные Банка России…', 'progress');

      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            session_id: sessionId,
            from: dateFrom.value,
            to: dateTo.value,
          }),
        });
        const raw = await response.text();
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (_error) {
          data = { error: raw };
        }
        if (!response.ok) {
          throw new Error(data.error || 'Не удалось загрузить ключевую ставку.');
        }

        setStatus(summaryText(data), 'success');
        if (data.source_url) sourceLink.href = data.source_url;

        // The existing calculator owns table rendering and data reads. A click
        // on the active tab invokes its regular refresh path without coupling
        // this importer to the editor's private implementation.
        cbRateTab.click();
      } catch (error) {
        setStatus(
          error && error.message
            ? error.message
            : 'Не удалось загрузить ключевую ставку. Попробуйте ещё раз.',
          'error',
        );
      } finally {
        setLoading(false);
      }
    });

    root.querySelectorAll('.elegso-tabs [role="tab"]').forEach((tab) => {
      tab.addEventListener('click', () => window.setTimeout(syncTriggerVisibility, 0));
    });
    new MutationObserver(syncTriggerVisibility).observe(cbRateTab, {
      attributes: true,
      attributeFilter: ['aria-selected'],
    });
    syncTriggerVisibility();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
