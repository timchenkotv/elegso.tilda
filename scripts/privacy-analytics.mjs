#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trackingPattern = /(?:googletagmanager\.com|google-analytics\.com|gtagTrackerID|GTM-PBV2TC8|\bgtag\s*\(\s*['"](?:js|config)['"]|top-fwz1\.mail\.ru|\b_tmr\s*\.\s*push|mainMailruId|mc\.yandex\.(?:ru|com)|\bym\s*\(\s*87831358\s*,|tildastatscript|tilda-stat-[\d.]+\.min\.js)/i;
const resourceTagPattern = /<(script|link|iframe|img|source|video|audio|embed|object)\b[^>]*>/gi;
const configMarker = 'data-elegso-privacy-config';
const assetMarker = 'data-elegso-privacy-asset';

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'is'))?.[2] || '';
const remoteUrl = value => { try { return /^(?:https?:)?\/\//i.test(value) ? new URL(value.replace(/^\/\//, 'https://').replaceAll('&amp;', '&')) : null; } catch { return null; } };
const googleHost = host => /(^|\.)(?:google\.[a-z.]+|googleapis\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com|youtube\.com|youtube-nocookie\.com)$/.test(host);
const unneededConnection = host => googleHost(host) || /(^|\.)(?:mail\.ru|tildacdn\.com)$/.test(host);

export function validatePrivacyConfig(config) {
  if (config.schemaVersion !== 1 || typeof config.consentVersion !== 'string' || !config.consentVersion || config.storageKey !== 'elegso.cookie-preferences.v1'
    || !Number.isInteger(config.maxAgeDays) || config.maxAgeDays < 1 || config.maxAgeDays > 365
    || config.receiptUrl !== '/api/privacy/consent' || config.receiptRetentionDays !== 365
    || config.policyUrl !== '/soglashenie/' || config.cookiesUrl !== '/cookies/' || config.consentUrl !== '/consent/'
    || config.analytics?.provider !== 'yandex-metrika' || config.analytics.counterId !== 87831358
    || ['defaultEnabled', 'webvisor', 'clickmap', 'trackLinks', 'accurateTrackBounce', 'ecommerce', 'trackHash'].some(key => config.analytics[key] !== false)) {
    throw new Error('Privacy configuration must be opt-in, Yandex-only and without behavioral/form/advertising analytics');
  }
  return config;
}

export async function loadPrivacyBuild(root = projectRoot) {
  const config = validatePrivacyConfig(JSON.parse(await fs.readFile(path.join(root, 'config/site-privacy.json'), 'utf8')));
  const assets = ['site-privacy.css', 'site-privacy.js', 'site-fonts.css'];
  const hash = createHash('sha256').update(JSON.stringify(config));
  for (const asset of assets) hash.update(await fs.readFile(path.join(root, 'www/assets', asset)));
  return { config, assetVersion: hash.digest('hex').slice(0, 12) };
}

export function privacyInventory(html) {
  const resources = [];
  for (const match of html.matchAll(resourceTagPattern)) {
    for (const name of ['src', 'href', 'poster', 'data-src', 'data-original']) {
      const value = attr(match[0], name);
      const url = remoteUrl(value);
      if (url && !['elegso.ru', 'www.elegso.ru'].includes(url.hostname)) resources.push({ tag: match[1].toLowerCase(), attribute: name, host: url.hostname, url: url.href });
    }
  }
  const inlineTrackers = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\btype\s*=\s*["']application\/(?:ld\+)?json["']/i.test(match[1]) && trackingPattern.test(match[0]))
    .map(match => ({ google: /googletagmanager|gtag|google-analytics/i.test(match[0]), mailRu: /mail\.ru|_tmr|mainMailruId/i.test(match[0]), yandex: /mc\.yandex|\bym\(/i.test(match[0]), tilda: /tildastat|tilda-stat/i.test(match[0]) }));
  return { resources, inlineTrackers };
}

export function applyPrivacyAnalytics(original, build) {
  validatePrivacyConfig(build.config);
  let html = original.replace(/<!--elegso-site-privacy:start-->[\s\S]*?<!--elegso-site-privacy:end-->\n?/g, '');
  // Tilda's bundled event helpers also save UTM cookies automatically. Keep
  // the UI helpers but use their supported switch to disable that storage.
  html = html.replace(/<[^!][^>]*\bid=["']allrecords["'][^>]*>/gi, tag => {
    const clean = tag.replace(/\s+data-tilda-cookie\s*=\s*(["']).*?\1/gi, '');
    return clean.replace(/>$/, ' data-tilda-cookie="no">');
  });
  html = html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (script, attributes) => {
    if (attributes.includes(configMarker) || attributes.includes(assetMarker)) return '';
    if (/\btype\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attributes)) return script;
    if (trackingPattern.test(script) || /^<script\b[^>]*>\s*window\.dataLayer\s*=\s*window\.dataLayer\s*\|\|\s*\[\]\s*;?\s*<\/script>$/i.test(script)) return '';
    return script;
  });
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, block => {
    if (!trackingPattern.test(block)) return block;
    const cleaned = block.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>|<img\b[^>]*>/gi, tag => trackingPattern.test(tag) ? '' : tag);
    return cleaned.replace(/<[^>]*>/g, '').trim() || /<(?:img|iframe|link)\b/i.test(cleaned) ? cleaned : '';
  });
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>|<img\b[^>]*>/gi, tag => trackingPattern.test(tag) ? '' : tag);
  html = html.replace(/<link\b[^>]*>/gi, tag => {
    if (tag.includes(assetMarker)) return '';
    const url = remoteUrl(attr(tag, 'href'));
    if (!url) return tag;
    const rel = attr(tag, 'rel').toLowerCase();
    if (googleHost(url.hostname) && ['stylesheet', 'preconnect', 'dns-prefetch', 'preload'].some(value => rel.split(/\s+/).includes(value))) return '';
    if (['preconnect', 'dns-prefetch'].includes(rel) && unneededConnection(url.hostname)) return '';
    return tag;
  });
  // Comments are not loading resources, but remove obsolete tracker labels so
  // source audits describe the new consent-based installation unambiguously.
  html = html.replace(/<!--\s*(?:\/?\s*(?:Yandex[ .]Metrika counter|Yandex Metrica tag|Top\.Mail\.Ru counter)|(?:End )?Google Tag Manager(?: \(noscript\))?|Google tag \(gtag\.js\)|Global Site Tag \(gtag\.js\) - Google Analytics|Rating Mail\.ru counter|Stat)\s*-->/gi, '');
  // Removing legacy head tags must not accumulate empty/trailing lines on
  // repeated generation. Do not reformat legal/article/body prose.
  html = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, head => head.replace(/[\t ]+\r?\n/g, '\n').replace(/(?:\r?\n){3,}/g, '\n\n'));
  const encodedConfig = JSON.stringify(build.config).replaceAll('<', '\\u003c');
  const tags = `<!--elegso-site-privacy:start--><link rel="stylesheet" href="/assets/site-fonts.css?v=${build.assetVersion}" ${assetMarker}>\n<link rel="stylesheet" href="/assets/site-privacy.css?v=${build.assetVersion}" ${assetMarker}>\n<script type="application/json" ${configMarker}>${encodedConfig}</script>\n<script src="/assets/site-privacy.js?v=${build.assetVersion}" defer ${assetMarker}></script><!--elegso-site-privacy:end-->`;
  if (!/<\/head>/i.test(html)) return html;
  return html.replace(/<\/head>/i, `${tags}\n</head>`);
}

export async function publicHtmlFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['_external', 'api', 'admin'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await publicHtmlFiles(filename));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(filename);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const value = flag => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : null; };
  const root = path.resolve(value('--root') || projectRoot);
  const web = path.join(root, 'www');
  const apply = process.argv.includes('--apply');
  const build = apply ? await loadPrivacyBuild(root) : null;
  const report = { mode: apply ? 'apply' : 'inventory', generatedAt: new Date().toISOString(), pages: [], changed: [] };
  for (const filename of await publicHtmlFiles(web)) {
    const html = await fs.readFile(filename, 'utf8');
    const rel = path.relative(web, filename);
    report.pages.push({ file: rel, ...privacyInventory(html) });
    if (apply) {
      const updated = applyPrivacyAnalytics(html, build);
      if (updated !== html) { await fs.writeFile(filename, updated); report.changed.push(rel); }
    }
  }
  if (value('--report')) await fs.writeFile(path.resolve(value('--report')), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ mode: report.mode, pages: report.pages.length, changed: report.changed, externalResources: report.pages.reduce((sum, page) => sum + page.resources.length, 0), inlineTrackers: report.pages.reduce((sum, page) => sum + page.inlineTrackers.length, 0) }, null, 2));
}
