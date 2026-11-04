/* Recruiting budget estimate. Local-only: no storage, network or analytics. */
(() => {
  'use strict';
  const format = amount => amount.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
  document.querySelectorAll('[data-recruitment-calculator]').forEach(calculator => {
    const salary = calculator.querySelector('[data-recruitment-salary]');
    const plan = calculator.querySelector('[data-recruitment-plan]');
    const fee = calculator.querySelector('[data-recruitment-fee]');
    const formula = calculator.querySelector('[data-recruitment-formula]');
    const status = calculator.querySelector('[data-recruitment-calculator-status]');
    if (!salary || !plan || !fee || !formula || !status) return;
    const recalculate = () => {
      const monthly = Number(salary.value);
      const option = plan.selectedOptions[0];
      const percent = Number(option?.dataset.percent);
      const minimum = Number(option?.dataset.minimum);
      const valid = salary.value.trim() !== '' && Number.isFinite(monthly) && monthly > 0 && monthly <= 10000000 && Number.isFinite(percent) && percent > 0 && Number.isFinite(minimum) && minimum >= 0;
      salary.setAttribute('aria-invalid', String(!valid));
      if (!valid) {
        fee.textContent = '—';
        formula.textContent = '';
        status.textContent = 'Укажите месячный доход от 1 до 10 000 000 ₽.';
        return;
      }
      const amount = Math.max(monthly * 12 * percent / 100, minimum);
      fee.textContent = format(amount);
      formula.textContent = `${format(monthly)} × 12 × ${percent}%, минимум ${format(minimum)}.`;
      status.textContent = '';
    };
    salary.addEventListener('input', recalculate);
    plan.addEventListener('change', recalculate);
    recalculate();
  });
})();
