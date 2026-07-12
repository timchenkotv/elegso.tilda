#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('www');

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const htmlFiles = (await walk(root)).filter((file) => (
  file.endsWith('.html')
  && !file.includes(`${path.sep}_external${path.sep}`)
  && !file.includes(`${path.sep}api${path.sep}getfeed${path.sep}`)
));

const totals = {
  pages: htmlFiles.length,
  forms: 0,
  panels: 0,
  popupPanels: 0,
  calculatorContainers: 0,
  submissionMarkers: 0,
  personalFields: 0,
  malformedContactLinks: 0,
};
const staleCopyFiles = [];
const staleCopy = /Или оставить заявку в форме|Отправьте заявку на юридическую консультацию|Оставьте контакты, мы свяжемся|через специальные формы|Заполняя соответствующие формы|заполните форму|отправить заявку в форме|оставьте заявку/i;

for (const file of htmlFiles) {
  const html = await fs.readFile(file, 'utf8');
  totals.forms += (html.match(/<form\b/gi) || []).length;
  totals.panels += (html.match(/data-elegso-contact-panel/g) || []).length;
  totals.popupPanels += (html.match(/elegso-contact-card--popup/g) || []).length;
  totals.calculatorContainers += (html.match(/data-elegso-calculator/g) || []).length;
  totals.submissionMarkers += (
    html.match(/formservices\[\]|data-tilda-formskey|data-formactiontype=|type=["']submit["']/gi) || []
  ).length;
  totals.personalFields += (
    html.match(/name=["'](?:Name|email|phone|problem)["']/gi) || []
  ).length;
  totals.malformedContactLinks += (
    html.match(/mailto:mailto:|href=["']tel:\s+/gi) || []
  ).length;
  if (staleCopy.test(html)) staleCopyFiles.push(path.relative(root, file));
}

const expected = {
  pages: 33,
  panels: 51,
  popupPanels: 24,
  calculatorContainers: 2,
};
const failures = [];
for (const [key, value] of Object.entries(expected)) {
  if (totals[key] !== value) failures.push(`${key}: expected ${value}, got ${totals[key]}`);
}
for (const key of ['forms', 'submissionMarkers', 'personalFields', 'malformedContactLinks']) {
  if (totals[key] !== 0) failures.push(`${key}: expected 0, got ${totals[key]}`);
}
if (staleCopyFiles.length) failures.push(`stale form copy: ${staleCopyFiles.join(', ')}`);

console.log(JSON.stringify({ ...totals, staleCopyFiles }, null, 2));
if (failures.length) {
  console.error(`Contact-only audit failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Contact-only audit passed.');
}
