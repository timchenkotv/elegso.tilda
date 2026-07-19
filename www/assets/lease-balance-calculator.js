(function () {
  'use strict';

  const host = document.getElementById('rec1164640016');
  if (!host || host.dataset.elegsoLeaseMounted === 'true') return;
  host.dataset.elegsoLeaseMounted = 'true';
  host.classList.add('elegso-lease-host');

  const oldCalculator = host.querySelector('.t678');
  if (!oldCalculator) return;
  const preservedContact = oldCalculator.querySelector('[data-elegso-contact-panel]');
  if (preservedContact) preservedContact.remove();

  const shell = document.createElement('div');
  shell.className = 'elegso-lease-shell';
  shell.innerHTML = `
    <section class="elegso-lease-app" aria-labelledby="elegso-lease-title">
      <header class="elegso-lease-head">
        <div class="elegso-lease-title">
          <p class="elegso-lease-eyebrow">Онлайн-калькулятор ЭЛЕГСО</p>
          <h2 id="elegso-lease-title">Сальдо встречных обязательств</h2>
          <p>Расчёт завершающей обязанности сторон по договору выкупного лизинга. Все введённые данные обрабатываются только в вашем браузере.</p>
        </div>
        <div class="elegso-lease-toolbar" aria-label="Действия с расчётом">
          <input data-import-file type="file" accept="application/json,.json" hidden>
          <button class="elegso-lease-btn" type="button" data-action="save">Сохранить JSON</button>
          <button class="elegso-lease-btn" type="button" data-action="load">Загрузить JSON</button>
          <button class="elegso-lease-btn is-danger" type="button" data-action="reset">Сбросить</button>
          <button class="elegso-lease-btn is-primary" type="button" data-action="print">Печать расчёта</button>
        </div>
      </header>

      <div class="elegso-lease-grid">
        <section class="elegso-lease-card is-wide">
          <h3>Участники расчёта и договор</h3>
          <p class="elegso-lease-card-intro">Эти сведения не влияют на формулу, но попадут в печатный документ. Поля можно оставить пустыми.</p>
          <div class="elegso-lease-contract-fields">
            <label class="elegso-lease-field" title="Номер договора лизинга">
              <span>Договор лизинга №</span>
              <input data-field="leaseContractNumber" type="text" placeholder="Например: Л-001/2025" autocomplete="off">
            </label>
            <label class="elegso-lease-field" title="Наименование предмета лизинга">
              <span>Предмет лизинга</span>
              <input data-field="leaseSubject" type="text" placeholder="Например: автомобиль, оборудование" autocomplete="off">
            </label>
          </div>
          <div class="elegso-lease-fields is-parties">
            ${partyFields('Лизингодатель', 'lessorName', 'lessorDetails', 'Наименование организации или ФИО')}
            ${partyFields('Лизингополучатель', 'lesseeName', 'lesseeDetails', 'Наименование организации или ФИО')}
            ${partyFields('Поставщик', 'supplierName', 'supplierDetails', 'Если известен')}
            ${partyFields('Конечный покупатель', 'finalBuyerName', 'finalBuyerDetails', 'Если известен')}
          </div>
        </section>

        <section class="elegso-lease-card is-wide">
          <h3>1. Срок и платежи договора</h3>
          <div class="elegso-lease-fields">
            ${dateField('Дата начала договора', 'leaseStartDate', 'Дата включается в календарный срок договора')}
            ${dateField('Дата окончания договора', 'leaseEndDate', 'Дата включается в календарный срок договора')}
            ${numberField('Срок договора', 'leaseTermDays', 'дн.', 'При изменении срока дата окончания пересчитывается автоматически')}
            ${moneyField('Авансовый платёж', 'advanceAmount', 'А — сумма аванса по договору лизинга')}
            ${moneyField('Платежи с авансом', 'leasePaymentsTotal', 'Сумма платежей с авансом, без отдельной выкупной стоимости')}
            ${moneyField('Платежи без аванса', 'leasePaymentsWithoutAdvance', 'Сумма платежей за вычетом авансового платежа')}
            ${moneyField('Выкупная стоимость', 'buyoutValue', 'Выкупная стоимость предмета по договору')}
          </div>
          <div class="elegso-lease-results">
            ${resultLine('P — общий размер платежей', 'allPaymentsP', 'P = платежи с авансом + выкупная стоимость')}
            ${resultLine('P − A', 'paymentsTotalWithoutAdvanceAndWithBuyout', '(P − A) = платежи без аванса + выкупная стоимость')}
          </div>
        </section>

        <section class="elegso-lease-card">
          <h3>2. Размер предоставленного финансирования</h3>
          <div class="elegso-lease-fields">
            ${moneyField('Закупочная цена предмета', 'purchasePrice', 'Стоимость приобретения предмета лизингодателем')}
            ${moneyField('КАСКО при приобретении', 'acquisitionCasco', 'Доказанные страховые расходы при приобретении')}
            ${moneyField('Иные расходы приобретения', 'acquisitionOther', 'Доставка, ремонт, передача и другие расходы приобретения')}
          </div>
          <div class="elegso-lease-results">
            ${resultLine('Расходы приобретения', 'acquisitionExpenses', 'Рпр = КАСКО + иные расходы')}
            ${resultLine('Ф — размер финансирования', 'financingAmount', 'Ф = закупочная цена + расходы приобретения − аванс', 'good')}
          </div>
        </section>

        <section class="elegso-lease-card">
          <h3>3. Плата за финансирование</h3>
          <div class="elegso-lease-formula">ПФ = ((P − A) − Ф) / (Ф × C/дн) × 365 × 100</div>
          <div class="elegso-lease-results is-dense">
            ${resultLine('Срок договора', 'leaseTermDays', 'Количество календарных дней договора')}
            ${resultLine('Проценты всего', 'financingInterestTotal', '(P − A) − Ф')}
            ${resultLine('Годовая ставка', 'annualRate', 'Расчётная плата за финансирование по формуле Пленума №17', 'good')}
            ${resultLine('Проценты в день', 'dailyInterestAmount', 'Плата за финансирование за весь срок / срок договора')}
          </div>
        </section>

        <section class="elegso-lease-card">
          <h3>4. Фактическое пользование финансированием</h3>
          <div class="elegso-lease-fields">
            ${dateField('Дата реализации / оценки предмета', 'realizationDate', 'Дата продажи, возврата, изъятия или доказанной оценки предмета')}
            ${moneyField('Сумма реализации предмета', 'realizationValue', 'Цена продажи либо доказанная оценочная стоимость')}
          </div>
          <div class="elegso-lease-results">
            ${resultLine('Срок пользования финансированием', 'financingUseDays', 'От начала договора до даты реализации / оценки включительно')}
            ${resultLine('Проценты за фактический срок', 'financingInterestForUse', 'Проценты в день × фактический срок')}
          </div>
        </section>

        <section class="elegso-lease-card">
          <h3>5. Убытки и расходы при расторжении</h3>
          <div class="elegso-lease-fields">
            ${moneyField('Убытки / неустойка', 'penaltyLosses', 'Санкции и доказанные убытки лизингодателя')}
            ${moneyField('КАСКО после расторжения', 'additionalCasco', 'Дополнительные страховые расходы')}
            ${moneyField('Расходы на изъятие', 'seizureExpenses', 'Демонтаж, возврат, транспортировка, изъятие')}
            ${moneyField('Расходы на хранение', 'storageExpenses', 'Хранение предмета после возврата или изъятия')}
            ${moneyField('Иные расходы', 'otherTerminationExpenses', 'Ремонт, реализация и иные доказанные расходы')}
          </div>
          <div class="elegso-lease-results">
            ${resultLine('Итого убытки и расходы', 'terminationLosses', 'Сумма всех расходов при расторжении', 'warn')}
          </div>
        </section>

        <section class="elegso-lease-card is-summary">
          <h3>6. Предоставления сторон и итоговое сальдо</h3>
          <div class="elegso-lease-summary">
            <div class="elegso-lease-summary-left">
              <div class="elegso-lease-fields">
                ${moneyField('Выплаты без аванса', 'paidWithoutAdvance', 'Фактические выплаты лизингополучателя без авансового платежа')}
              </div>
              <div class="elegso-lease-results">
                ${resultLine('Предоставление лизингополучателя', 'lesseePerformance', 'Выплаты без аванса + стоимость реализации предмета')}
                ${resultLine('Предоставление лизингодателя', 'lessorPerformance', 'Финансирование + проценты за фактический срок + убытки')}
              </div>
            </div>
            <div class="elegso-lease-final is-zero" data-final>
              <span>Сальдо встречных обязательств</span>
              <strong data-final-value>0,00 руб.</strong>
              <p data-final-text>Сальдо равно нулю: завершающая обязанность сторон не определяется.</p>
            </div>
          </div>
        </section>
      </div>

      <p class="elegso-lease-footer-note"><strong>Правовое основание.</strong> Расчёт выполняется по логике пунктов 3.2–3.6 Постановления Пленума Высшего Арбитражного Суда Российской Федерации от 14.03.2014 №17 «Об отдельных вопросах, связанных с договором выкупного лизинга». Полученный результат следует проверять по документам конкретного дела.</p>
      <div class="elegso-lease-save-status" data-save-status aria-live="polite"></div>
    </section>
  `;

  oldCalculator.replaceWith(shell);
  if (preservedContact) shell.appendChild(preservedContact);

  const root = shell.querySelector('.elegso-lease-app');
  const storageKey = 'elegso:lease-balance-calculator:v1';
  const moneyFields = new Set([
    'advanceAmount', 'leasePaymentsTotal', 'leasePaymentsWithoutAdvance', 'buyoutValue',
    'purchasePrice', 'acquisitionCasco', 'acquisitionOther', 'realizationValue',
    'paidWithoutAdvance', 'penaltyLosses', 'additionalCasco', 'seizureExpenses',
    'storageExpenses', 'otherTerminationExpenses'
  ]);
  const defaults = {
    lessorName: '', lessorDetails: '', lesseeName: '', lesseeDetails: '',
    supplierName: '', supplierDetails: '', finalBuyerName: '', finalBuyerDetails: '',
    leaseContractNumber: '', leaseSubject: '', leaseStartDate: '', leaseEndDate: '', leaseTermDays: '',
    advanceAmount: '0.00', leasePaymentsTotal: '0.00', leasePaymentsWithoutAdvance: '0.00',
    buyoutValue: '0.00', purchasePrice: '0.00', acquisitionCasco: '0.00', acquisitionOther: '0.00',
    realizationDate: '', realizationValue: '0.00', paidWithoutAdvance: '0.00', penaltyLosses: '0.00',
    additionalCasco: '0.00', seizureExpenses: '0.00', storageExpenses: '0.00', otherTerminationExpenses: '0.00'
  };
  let state = loadDraft();
  let saveStatusTimer = 0;

  function partyFields(label, nameKey, detailsKey, placeholder) {
    return `
      <div class="elegso-lease-party">
        <label class="elegso-lease-field">
          <span>${label}</span>
          <input data-field="${nameKey}" type="text" placeholder="${placeholder}" autocomplete="organization">
        </label>
        <label class="elegso-lease-field">
          <span>Реквизиты для печати</span>
          <textarea data-field="${detailsKey}" placeholder="ИНН, КПП, ОГРН, адрес, банковские реквизиты"></textarea>
        </label>
      </div>
    `;
  }

  function dateField(label, key, title) {
    return `<label class="elegso-lease-field" title="${title}"><span>${label}</span><input data-field="${key}" type="date"></label>`;
  }

  function numberField(label, key, unit, title) {
    return `<label class="elegso-lease-field" title="${title}"><span>${label}</span><span class="elegso-lease-input-unit"><input data-field="${key}" type="number" min="0" step="1"><em class="elegso-lease-unit">${unit}</em></span></label>`;
  }

  function moneyField(label, key, title) {
    return `<label class="elegso-lease-field" title="${title}"><span>${label}</span><span class="elegso-lease-input-unit"><input data-field="${key}" type="text" inputmode="decimal" autocomplete="off"><em class="elegso-lease-unit">руб.</em></span></label>`;
  }

  function resultLine(label, key, title, tone) {
    return `<div class="elegso-lease-result${tone ? ` is-${tone}` : ''}" title="${title}"><span>${label}</span><strong data-result="${key}">0,00 руб.</strong></div>`;
  }

  function parseMoney(value) {
    const normalized = String(value == null ? '' : value).replace(/\s/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parsePositiveInteger(value) {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function formatNumber(value, digits) {
    return new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(Number.isFinite(value) ? value : 0);
  }

  function formatMoney(value) {
    return `${formatNumber(value, 2)} руб.`;
  }

  function formatMoneyInput(value) {
    return formatNumber(value, 2);
  }

  function formatInteger(value) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
  }

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDateRu(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value || '');
  }

  function dateToIso(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function inclusiveDaysBetween(startValue, endValue) {
    const start = parseDate(startValue);
    const end = parseDate(endValue);
    if (!start || !end) return 0;
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  }

  function calculateEndDate(startValue, daysValue) {
    const start = parseDate(startValue);
    const days = parsePositiveInteger(daysValue);
    if (!start || !days) return '';
    start.setUTCDate(start.getUTCDate() + days - 1);
    return dateToIso(start);
  }

  function calculate(form) {
    const leaseTermDays = parsePositiveInteger(form.leaseTermDays) || inclusiveDaysBetween(form.leaseStartDate, form.leaseEndDate);
    const advanceAmount = parseMoney(form.advanceAmount);
    const leasePaymentsTotal = parseMoney(form.leasePaymentsTotal);
    const leasePaymentsWithoutAdvance = parseMoney(form.leasePaymentsWithoutAdvance);
    const buyoutValue = parseMoney(form.buyoutValue);
    const purchasePrice = parseMoney(form.purchasePrice);
    const acquisitionCasco = parseMoney(form.acquisitionCasco);
    const acquisitionOther = parseMoney(form.acquisitionOther);
    const realizationValue = parseMoney(form.realizationValue);
    const paidWithoutAdvance = parseMoney(form.paidWithoutAdvance);
    const acquisitionExpenses = acquisitionCasco + acquisitionOther;
    const financingAmount = purchasePrice + acquisitionExpenses - advanceAmount;
    const allPaymentsP = leasePaymentsTotal + buyoutValue;
    const paymentsTotalWithoutAdvanceAndWithBuyout = leasePaymentsWithoutAdvance + buyoutValue;
    const financingInterestTotal = Math.max(0, paymentsTotalWithoutAdvanceAndWithBuyout - financingAmount);
    const annualRate = financingAmount > 0 && leaseTermDays > 0
      ? (financingInterestTotal / (financingAmount * leaseTermDays)) * 365 * 100
      : 0;
    const dailyInterestAmount = leaseTermDays > 0 ? financingInterestTotal / leaseTermDays : 0;
    const financingUseDays = inclusiveDaysBetween(form.leaseStartDate, form.realizationDate);
    const financingInterestForUse = dailyInterestAmount * financingUseDays;
    const terminationLosses = parseMoney(form.penaltyLosses) + parseMoney(form.additionalCasco) +
      parseMoney(form.seizureExpenses) + parseMoney(form.storageExpenses) + parseMoney(form.otherTerminationExpenses);
    const lesseePerformance = paidWithoutAdvance + realizationValue;
    const lessorPerformance = financingAmount + financingInterestForUse + terminationLosses;
    const balance = lessorPerformance - lesseePerformance;
    return {
      leaseTermDays,
      paymentsTotalWithoutAdvanceAndWithBuyout,
      allPaymentsP,
      acquisitionExpenses,
      financingAmount,
      financingInterestTotal,
      annualRate,
      dailyInterestAmount,
      financingUseDays,
      financingInterestForUse,
      terminationLosses,
      lesseePerformance,
      lessorPerformance,
      balance,
      balanceAbs: Math.abs(balance),
      resultSide: Math.abs(balance) < 0.005 ? 'zero' : balance > 0 ? 'lessor' : 'lessee'
    };
  }

  function normalizeSource(source) {
    const next = { ...defaults };
    Object.keys(defaults).forEach((key) => {
      if (typeof source[key] === 'string') next[key] = source[key];
    });
    const legacyParties = {
      lessorName: source.lessorQuery,
      lesseeName: source.lesseeQuery,
      supplierName: source.supplierQuery,
      finalBuyerName: source.finalBuyerQuery
    };
    Object.entries(legacyParties).forEach(([key, value]) => {
      if (!next[key] && typeof value === 'string') next[key] = value;
    });
    moneyFields.forEach((key) => { next[key] = formatMoneyInput(parseMoney(next[key])); });
    return next;
  }

  function loadDraft() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || 'null');
      const source = parsed && typeof parsed === 'object' ? (parsed.form || parsed) : {};
      return normalizeSource(source);
    } catch {
      return normalizeSource({});
    }
  }

  function saveDraft(showStatus) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), form: state }));
      if (showStatus) {
        const status = root.querySelector('[data-save-status]');
        status.textContent = 'Черновик сохранён на этом устройстве';
        window.clearTimeout(saveStatusTimer);
        saveStatusTimer = window.setTimeout(() => { status.textContent = ''; }, 1800);
      }
    } catch {
      // The calculator remains fully functional when browser storage is disabled.
    }
  }

  function syncInputs(keys) {
    const names = keys || Object.keys(defaults);
    names.forEach((key) => {
      const input = root.querySelector(`[data-field="${key}"]`);
      if (input && input.value !== state[key]) input.value = state[key];
    });
  }

  function renderResults() {
    const calc = calculate(state);
    const moneyResults = [
      'allPaymentsP', 'paymentsTotalWithoutAdvanceAndWithBuyout', 'acquisitionExpenses', 'financingAmount',
      'financingInterestTotal', 'dailyInterestAmount', 'financingInterestForUse', 'terminationLosses',
      'lesseePerformance', 'lessorPerformance'
    ];
    moneyResults.forEach((key) => setResult(key, formatMoney(calc[key])));
    setResult('leaseTermDays', `${formatInteger(calc.leaseTermDays)} дн.`);
    setResult('annualRate', `${formatNumber(calc.annualRate, 2)} %`);
    setResult('financingUseDays', `${formatInteger(calc.financingUseDays)} дн.`);

    const final = root.querySelector('[data-final]');
    final.className = `elegso-lease-final is-${calc.resultSide}`;
    root.querySelector('[data-final-value]').textContent = formatMoney(calc.balanceAbs);
    root.querySelector('[data-final-text]').textContent = resultText(calc);
  }

  function setResult(key, value) {
    const element = root.querySelector(`[data-result="${key}"]`);
    if (element) element.textContent = value;
  }

  function resultText(calc) {
    if (calc.resultSide === 'zero') return 'Сальдо равно нулю: завершающая обязанность сторон не определяется.';
    if (calc.resultSide === 'lessor') return 'В пользу лизингодателя: лизингополучатель обязан уплатить указанную сумму.';
    return 'В пользу лизингополучателя: лизингодатель обязан возвратить указанную сумму.';
  }

  function applyLinkedChanges(field) {
    const changed = [];
    if (field === 'leaseStartDate') {
      if (state.leaseTermDays) {
        state.leaseEndDate = calculateEndDate(state.leaseStartDate, state.leaseTermDays);
        changed.push('leaseEndDate');
      } else if (state.leaseEndDate) {
        state.leaseTermDays = String(inclusiveDaysBetween(state.leaseStartDate, state.leaseEndDate) || '');
        changed.push('leaseTermDays');
      }
    }
    if (field === 'leaseEndDate') {
      state.leaseTermDays = state.leaseStartDate && state.leaseEndDate
        ? String(inclusiveDaysBetween(state.leaseStartDate, state.leaseEndDate) || '')
        : state.leaseTermDays;
      changed.push('leaseTermDays');
    }
    if (field === 'leaseTermDays' && state.leaseStartDate) {
      state.leaseEndDate = calculateEndDate(state.leaseStartDate, state.leaseTermDays);
      changed.push('leaseEndDate');
    }
    if (field === 'advanceAmount') {
      const total = parseMoney(state.leasePaymentsTotal);
      if (total) {
        state.leasePaymentsWithoutAdvance = formatMoneyInput(Math.max(0, total - parseMoney(state.advanceAmount)));
        changed.push('leasePaymentsWithoutAdvance');
      }
    }
    if (field === 'leasePaymentsTotal') {
      const total = parseMoney(state.leasePaymentsTotal);
      if (total) {
        state.leasePaymentsWithoutAdvance = formatMoneyInput(Math.max(0, total - parseMoney(state.advanceAmount)));
        changed.push('leasePaymentsWithoutAdvance');
      }
    }
    if (field === 'leasePaymentsWithoutAdvance') {
      state.leasePaymentsTotal = formatMoneyInput(parseMoney(state.leasePaymentsWithoutAdvance) + parseMoney(state.advanceAmount));
      changed.push('leasePaymentsTotal');
    }
    syncInputs(changed);
  }

  function saveJson() {
    const payload = {
      kind: 'elegso.lease-balance-calculator',
      compatible_with: 'law-inelsibi.lease-balance-calculator',
      version: 1,
      saved_at: new Date().toISOString(),
      form: state,
      calculated: calculate(state)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `saldo_lizing_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function loadJson(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const source = parsed && typeof parsed === 'object' ? (parsed.form || parsed) : {};
      state = normalizeSource(source);
      syncInputs();
      renderResults();
      saveDraft(true);
    } catch (error) {
      window.alert(`Не удалось загрузить JSON: ${error instanceof Error ? error.message : 'неверный формат файла'}`);
    }
  }

  function resetCalculator() {
    if (!window.confirm('Сбросить все введённые сведения и результаты расчёта?')) return;
    state = normalizeSource({});
    syncInputs();
    renderResults();
    try { localStorage.removeItem(storageKey); } catch {}
    const status = root.querySelector('[data-save-status]');
    status.textContent = 'Расчёт сброшен';
    window.clearTimeout(saveStatusTimer);
    saveStatusTimer = window.setTimeout(() => { status.textContent = ''; }, 1800);
  }

  function printReport() {
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      window.alert('Браузер заблокировал печатную форму. Разрешите всплывающие окна для сайта.');
      return;
    }
    reportWindow.document.open();
    reportWindow.document.write(buildPrintHtml());
    reportWindow.document.close();
  }

  function buildPrintHtml() {
    const calc = calculate(state);
    const sourceRows = [];
    const addGroup = (group) => sourceRows.push({ group });
    const addRow = (symbol, title, value, formula) => sourceRows.push({ symbol, title, value, formula });
    const addDate = (symbol, title, key, formula) => { if (state[key]) addRow(symbol, title, formatDateRu(state[key]), formula); };
    const addDays = (symbol, title, value, formula, required) => { if (required || value > 0) addRow(symbol, title, `${formatInteger(value)} дн.`, formula); };
    const addMoneyInput = (symbol, title, key, formula) => { if (Math.abs(parseMoney(state[key])) >= 0.005) addRow(symbol, title, formatMoney(parseMoney(state[key])), formula); };
    const addMoneyCalc = (symbol, title, value, formula, required = true) => { if (required || Math.abs(value) >= 0.005) addRow(symbol, title, formatMoney(value), formula); };

    addGroup('1. Срок и платежи договора');
    addDate('Дн', 'Дата начала договора', 'leaseStartDate', 'Вводится по договору; дата включается в срок');
    addDate('До', 'Дата окончания договора', 'leaseEndDate', 'Вводится по договору; дата включается в срок');
    addDays('C/дн', 'Срок договора лизинга в календарных днях', calc.leaseTermDays, 'Количество календарных дней от даты начала до даты окончания включительно', true);
    addMoneyInput('A', 'Авансовый платёж', 'advanceAmount', 'Вводится по договору лизинга');
    addMoneyInput('ЛП', 'Лизинговые платежи с авансом', 'leasePaymentsTotal', 'Сумма платежей по договору с учётом аванса, без отдельной выкупной цены');
    addMoneyInput('ЛП−A', 'Лизинговые платежи без аванса', 'leasePaymentsWithoutAdvance', 'ЛП−A = лизинговые платежи с авансом − A');
    addMoneyInput('Вц', 'Выкупная стоимость', 'buyoutValue', 'Включается в общий размер платежей по выкупному лизингу');
    addMoneyCalc('P', 'Общий размер платежей по договору', calc.allPaymentsP, 'P = лизинговые платежи с авансом + выкупная стоимость');
    addMoneyCalc('P−A', 'Платежи без аванса с выкупной стоимостью', calc.paymentsTotalWithoutAdvanceAndWithBuyout, '(P−A) = платежи без аванса + выкупная стоимость');

    addGroup('2. Размер предоставленного финансирования');
    addMoneyInput('Цз', 'Закупочная цена предмета лизинга', 'purchasePrice', 'Вводится по доказанным документам лизингодателя');
    addMoneyInput('Кп', 'КАСКО при приобретении', 'acquisitionCasco', 'Доказанные расходы при приобретении/передаче предмета');
    addMoneyInput('Ип', 'Иные расходы приобретения', 'acquisitionOther', 'Доставка, ремонт, передача и иные расходы приобретения');
    addMoneyCalc('Рпр', 'Расходы при приобретении предмета лизинга', calc.acquisitionExpenses, 'Рпр = Кп + Ип');
    addMoneyCalc('Ф', 'Размер предоставленного финансирования', calc.financingAmount, 'Ф = Цз + Рпр − A');

    addGroup('3. Плата за финансирование');
    addMoneyCalc('%%', 'Плата за финансирование за весь срок', calc.financingInterestTotal, '%% = (P−A) − Ф');
    addRow('ПФ', 'Расчётная плата за финансирование, годовых', `${formatNumber(calc.annualRate, 2)} %`, 'ПФ = ((P−A) − Ф) / (Ф × C/дн) × 365 × 100');
    addMoneyCalc('%д', 'Плата за финансирование за день', calc.dailyInterestAmount, '%д = %% / C/дн');

    addGroup('4. Фактическое пользование финансированием и реализация');
    addDate('Др', 'Дата реализации / оценки предмета лизинга', 'realizationDate', 'Дата реализации предмета или его доказанной оценки');
    addMoneyInput('Реал', 'Сумма реализации предмета', 'realizationValue', 'Цена продажи или доказанная оценочная стоимость');
    addDays('Cф', 'Срок фактического пользования финансированием', calc.financingUseDays, 'От даты начала договора до даты реализации / оценки включительно', true);
    addMoneyCalc('%ф', 'Плата за финансирование за фактический срок', calc.financingInterestForUse, '%ф = %д × Cф');

    addGroup('5. Убытки и расходы при расторжении');
    addMoneyInput('Н', 'Убытки / неустойка', 'penaltyLosses', 'Санкции и доказанные убытки лизингодателя');
    addMoneyInput('Кр', 'КАСКО после расторжения', 'additionalCasco', 'Дополнительные страховые расходы');
    addMoneyInput('Из', 'Расходы на изъятие', 'seizureExpenses', 'Демонтаж, возврат, транспортировка, изъятие');
    addMoneyInput('Хр', 'Расходы на хранение', 'storageExpenses', 'Хранение предмета после возврата/изъятия');
    addMoneyInput('Ир', 'Иные расходы при расторжении', 'otherTerminationExpenses', 'Ремонт, реализация и иные доказанные расходы');
    addMoneyCalc('У', 'Итого убытки и расходы лизингодателя', calc.terminationLosses, 'У = Н + Кр + Из + Хр + Ир');

    addGroup('6. Предоставления сторон и итоговое сальдо');
    addMoneyInput('Опл', 'Фактические выплаты без аванса', 'paidWithoutAdvance', 'Сумма фактически произведённых платежей без авансового платежа');
    addMoneyCalc('Пп', 'Предоставление лизингополучателя', calc.lesseePerformance, 'Пп = Опл + Реал');
    addMoneyCalc('Пл', 'Предоставление лизингодателя', calc.lessorPerformance, 'Пл = Ф + %ф + У');
    addMoneyCalc('С', 'Сальдо встречных обязательств', calc.balance, 'С = Пл − Пп');

    let rowNumber = 0;
    const rows = sourceRows.map((row) => {
      if (row.group) return `<tr class="group-row"><td colspan="5">${escapeHtml(row.group)}</td></tr>`;
      rowNumber += 1;
      return `<tr><td>${rowNumber}</td><td>${escapeHtml(row.symbol)}</td><td>${escapeHtml(row.title)}</td><td class="num">${escapeHtml(row.value)}</td><td>${escapeHtml(row.formula)}</td></tr>`;
    }).join('');
    const parties = [
      ['Лизингодатель', state.lessorName, state.lessorDetails],
      ['Лизингополучатель', state.lesseeName, state.lesseeDetails],
      ['Поставщик', state.supplierName, state.supplierDetails],
      ['Конечный покупатель', state.finalBuyerName, state.finalBuyerDetails]
    ].filter((item) => item[1] || item[2]).map((item) => `
      <section class="party"><span>${escapeHtml(item[0])}</span>${item[1] ? `<strong>${escapeHtml(item[1])}</strong>` : ''}${item[2] ? `<p>${escapeHtml(item[2]).replace(/\n/g, '<br>')}</p>` : ''}</section>
    `).join('');
    const contractMeta = [
      state.leaseContractNumber ? `<section><span>Договор лизинга</span><strong>№ ${escapeHtml(state.leaseContractNumber)}</strong></section>` : '',
      state.leaseSubject ? `<section><span>Предмет лизинга</span><strong>${escapeHtml(state.leaseSubject)}</strong></section>` : ''
    ].filter(Boolean).join('');
    const finalText = calc.resultSide === 'zero'
      ? 'Сальдо равно нулю: завершающая обязанность сторон не определяется.'
      : calc.resultSide === 'lessor'
        ? `В пользу лизингодателя: лизингополучатель обязан уплатить ${formatMoney(calc.balanceAbs)}`
        : `В пользу лизингополучателя: лизингодатель обязан возвратить ${formatMoney(calc.balanceAbs)}`;
    const logoUrl = new URL('/_external/static.tildacdn.com/tild6636-3836-4134-b236-373062316464/_v6_.png', location.origin).href;

    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Расчёт сальдо встречных обязательств</title><style>
      @page { size: A4; margin: 1cm 1cm 1cm 2cm; @bottom-right { content: "стр. " counter(page) " из " counter(pages); color:#355a56; font:8pt Arial,sans-serif; } }
      *{box-sizing:border-box} body{margin:0;color:#1d2926;background:#f3eee7;font-family:Arial,sans-serif;font-size:11px}.page{padding:24px}.head{display:flex;justify-content:space-between;gap:18px;padding:18px;border:1px solid #d5cec2;border-radius:16px;background:linear-gradient(135deg,#fffdf8,#e8e0d3)}.brand{display:flex;align-items:center;gap:12px}.brand img{width:104px;height:auto;object-fit:contain}.company{color:#355a56;font-size:10px;font-weight:700;line-height:1.45}.company strong{display:block;font-size:13px}h1{margin:13px 0 5px;font-size:22px;line-height:1.15}.note{max-width:720px;color:#59645f;line-height:1.45}.actions{display:flex;gap:7px;align-items:flex-start}.actions button{padding:8px 11px;border:1px solid #355a56;border-radius:8px;color:#fff;background:#355a56;font-weight:700;cursor:pointer}.parties{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:12px 0}.party{padding:10px;border:1px solid #ddd5ca;border-radius:11px;background:#fff;break-inside:avoid}.party span,.meta span{display:block;color:#66716c;font-size:8px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.party strong,.meta strong{display:block;margin-top:4px;font-size:11px}.party p{margin:5px 0 0;color:#4f5d58;font-size:9px;line-height:1.4}.result-strip{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(220px,.65fr);gap:10px;margin:12px 0}.result-strip.is-single{grid-template-columns:1fr}.result{padding:15px;border:1px solid #b6cab9;border-radius:13px;background:#e9f5e8;font-size:14px;font-weight:700;line-height:1.35}.result.is-lessor{border-color:#ddb1a8;background:#fff0ed}.meta{display:grid;gap:6px}.meta section{padding:9px;border:1px solid #d9d2c7;border-radius:10px;background:#fffdf8}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:6px;border:1px solid #d9d4ca;vertical-align:top;line-height:1.3}th{color:#fff;background:#355a56;font-size:8px;letter-spacing:.04em;text-transform:uppercase}td.num{text-align:right;font-weight:700;white-space:nowrap}.group-row td{color:#294b47;background:#e5ece8;font-weight:700}.legal{margin:11px 0 0;padding:10px;border-left:3px solid #ffde41;color:#5b6662;background:#fffdf7;line-height:1.45}.generated{margin-top:8px;color:#737c78;font-size:8px;text-align:right}
      @media print{body{background:#fff}.page{padding:0}.actions{display:none}.head,.party,.result,.meta section{break-inside:avoid}}
    </style></head><body><main class="page"><header class="head"><div><div class="brand"><img src="${escapeHtml(logoUrl)}" alt="ЮК ЭЛЕГСО"><div class="company"><strong>ООО «ЮК ЭЛЕГСО»</strong>ИНН 7733472977 · ОГРН 1257700349004<br>mail@elegso.ru · +7 (495) 646-00-02</div></div><h1>Расчёт сальдо встречных обязательств по договору выкупного лизинга</h1><div class="note">Расчёт выполнен по логике пунктов 3.2–3.6 Постановления Пленума ВАС РФ от 14.03.2014 №17.</div></div><div class="actions"><button onclick="window.print()">Печать</button><button onclick="window.close()">Закрыть</button></div></header>${parties ? `<div class="parties">${parties}</div>` : ''}<div class="result-strip ${contractMeta ? '' : 'is-single'}"><section class="result ${calc.resultSide === 'lessor' ? 'is-lessor' : ''}">${escapeHtml(finalText)}</section>${contractMeta ? `<div class="meta">${contractMeta}</div>` : ''}</div><table><thead><tr><th>№</th><th>Обозначение</th><th>Показатель</th><th>Значение</th><th>Формула / источник</th></tr></thead><tbody>${rows}</tbody></table><p class="legal">Расчёт носит информационный характер. Итоговое требование необходимо проверять по условиям договора и доказательствам конкретного дела.</p><p class="generated">Сформировано ${escapeHtml(new Date().toLocaleString('ru-RU'))} · site.elegso.ru</p></main></body></html>`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[char]);
  }

  root.addEventListener('input', (event) => {
    const input = event.target.closest('[data-field]');
    if (!input) return;
    const field = input.dataset.field;
    state[field] = input.value;
    applyLinkedChanges(field);
    renderResults();
    saveDraft(false);
  });

  root.addEventListener('blur', (event) => {
    const input = event.target.closest('[data-field]');
    if (!input || !moneyFields.has(input.dataset.field)) return;
    state[input.dataset.field] = formatMoneyInput(parseMoney(input.value));
    applyLinkedChanges(input.dataset.field);
    syncInputs();
    renderResults();
    saveDraft(true);
  }, true);

  root.querySelector('[data-action="save"]').addEventListener('click', saveJson);
  root.querySelector('[data-action="load"]').addEventListener('click', () => root.querySelector('[data-import-file]').click());
  root.querySelector('[data-action="reset"]').addEventListener('click', resetCalculator);
  root.querySelector('[data-action="print"]').addEventListener('click', printReport);
  root.querySelector('[data-import-file]').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    loadJson(file);
  });

  syncInputs();
  renderResults();
})();
