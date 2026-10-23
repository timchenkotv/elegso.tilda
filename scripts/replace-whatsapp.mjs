#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const headerWhatsapp = /<li class="t-sociallinks__item t-sociallinks__item_whatsapp">[\s\S]*?<\/li>(?:&nbsp;)?/gi;
const serviceWhatsapp = /<div class="t1036__item"><a\b(?=[^>]*\bt1036__btn_whatsapp\b)[\s\S]*?<\/a>\s*<style>[\s\S]*?<\/style><\/div>/gi;
const generatedWhatsapp = /else if\(item\.indexOf\('whatsapp'\)[\s\S]*?socialWrapper\.insertAdjacentHTML\('beforeend',whatsapp\);}/gi;

export function replaceWhatsapp(html) {
  html = html.replace(headerWhatsapp, '');
  html = html.replace(
    /(<ul role="list" class="t-sociallinks__wrapper" )aria-label="(?:Соц\. сети|Электронная почта)"/g,
    '$1aria-label="Способы связи"',
  );
  html = html.replace(generatedWhatsapp, '');
  html = html.replace(serviceWhatsapp, original => {
    const record = original.match(/#(rec\d+)\s+\.t1036__btn_whatsapp\b/i)?.[1];
    if (!record) throw new Error('WhatsApp button has no record-specific style');
    return `<div class="t1036__item"><a class="t-btn t-btnflex t1036__btn t1036__btn_email t1036__btn_md" data-btneffects-first="btneffects-flash" title="Написать на почту" href="mailto:mail@elegso.ru" aria-label="Написать на почту mail@elegso.ru"><svg class="t-sociallinks__svg" role="presentation" width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="23" width="80" height="54" rx="9" stroke="#ffde41" stroke-width="6"/><path d="M14 29 50 56 86 29" stroke="#ffde41" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></a> <style>#${record} .t1036__btn_email {background-color:#a04b38;border-width:0px;border-style:none !important;border-radius:6px;box-shadow:0px 2px 3px rgba(0,11,48,0.25) !important;transition-duration:0.2s;transition-property:background-color,color,border-color,box-shadow,opacity,transform,gap;transition-timing-function:ease-in-out;}</style></div>`;
  });
  if (/whatsapp|wa\.me|api\.whatsapp|web\.whatsapp/i.test(html)) {
    const remaining = html.match(/.{0,80}(?:whatsapp|wa\.me).{0,80}/i)?.[0];
    throw new Error(`An unhandled WhatsApp reference remains: ${remaining}`);
  }
  return html;
}

async function walk(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let changed = 0;
  for (const file of await walk(path.resolve('www'))) {
    const original = await fs.readFile(file, 'utf8');
    const updated = replaceWhatsapp(original);
    if (updated !== original) {
      await fs.writeFile(file, updated);
      changed++;
    }
  }
  console.log(`Updated ${changed} HTML pages`);
}
