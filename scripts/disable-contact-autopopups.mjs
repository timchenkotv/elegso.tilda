#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const contactPopupAssetVersion = '20260913-contact-manual-1';

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'is'))?.[2] || '';
}

function contactPopupHooks(html) {
  const starts = [...html.matchAll(/<div\b(?=[^>]*\bclass\s*=\s*(["'])[^"']*\bt-popup(?=\s|["'])[^"']*\1)[^>]*>/gi)];
  return new Set(starts.filter((match, index) => {
    const contents = html.slice(match.index, starts[index + 1]?.index ?? html.length);
    return /\bclass\s*=\s*(["'])[^"']*\belegso-contact-card--popup\b[^"']*\1/i.test(contents);
  }).map((match) => attribute(match[0], 'data-tooltip-hook')).filter(Boolean));
}

// Only Tilda's hidden automatic opener is neutralized. The contact dialog,
// visible links and unrelated calculator popups remain byte-for-byte intact.
export function disableAutomaticContactPopups(html) {
  const hooks = contactPopupHooks(html);
  const records = [...html.matchAll(/<div\b(?=[^>]*\bid\s*=\s*(["'])rec(\d+)\1)[^>]*>/gi)];
  const disabledRecords = new Set();
  const inertOpeners = html.replace(/<a\b(?=[^>]*\bclass\s*=\s*(["'])[^"']*\bt724__opener\b[^"']*\1)[^>]*>/gi, (opener, _quote, offset) => {
    const hook = attribute(opener, 'href') || attribute(opener, 'data-elegso-disabled-popup-hook');
    if (!hooks.has(hook)) return opener;
    const record = records.findLast((match) => match.index < offset);
    if (record && attribute(record[0], 'data-record-type') === '724') disabledRecords.add(record[2]);
    if (attribute(opener, 'data-elegso-contact-auto-disabled') === 'true') return opener;
    return opener.replace(/\bhref\s*=\s*(["'])(.*?)\1/i, 'data-elegso-disabled-popup-hook="$2"')
      .replace(/>$/, ' data-elegso-contact-auto-disabled="true">');
  });
  return inertOpeners.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (script) => script.replace(
    /\bt724_init\s*\(\s*(["'])(\d+)\1\s*\)\s*;?/g,
    (call, _quote, recordId) => disabledRecords.has(recordId)
      ? '/* elegso-contact-auto-disabled: explicit clicks only */'
      : call,
  ));
}

export function prepareManualContactPopups(html) {
  return disableAutomaticContactPopups(html).replace(
    /(<script\b[^>]*\bsrc\s*=\s*["'])\/assets\/migration\.js(?:\?[^"']*)?(?=["'])/gi,
    `$1/assets/migration.js?v=${contactPopupAssetVersion}`,
  );
}

async function htmlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['_external', 'api', 'admin'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(filename));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(filename);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootFlag = process.argv.indexOf('--root');
  const web = path.resolve(rootFlag < 0 ? 'www' : process.argv[rootFlag + 1]);
  const changes = [];
  for (const filename of await htmlFiles(web)) {
    const original = await fs.readFile(filename, 'utf8');
    const updated = prepareManualContactPopups(original);
    if (updated === original) continue;
    await fs.writeFile(filename, updated);
    changes.push(path.relative(web, filename));
  }
  console.log(JSON.stringify({ assetVersion: contactPopupAssetVersion, changed: changes.length, files: changes }, null, 2));
}
