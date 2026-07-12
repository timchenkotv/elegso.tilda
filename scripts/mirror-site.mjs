#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = new URL('https://elegso.ru/');
const ROOT_HOST = ROOT.host;
const BASE_DIR = path.resolve(process.cwd());
const OUT_DIR = path.join(BASE_DIR, 'www');
const WORK_DIR = path.join(BASE_DIR, 'work');
const REPORT_DIR = path.join(BASE_DIR, 'reports');

const MAX_PAGES = 5000;
const MAX_ASSETS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X) CodexMirror/1.0';

const pageVisited = new Set();
const assetVisited = new Set();
const pageQueue = [];
const assetQueue = [];
const downloaded = new Map(); // absolute URL -> local web path
const fileMeta = []; // {filePath, url, type}

function ensureUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    u.hash = '';
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

function extnameFromPathname(pathname) {
  const ext = path.extname(pathname.toLowerCase());
  return ext;
}

function isLikelyPage(u) {
  const ext = extnameFromPathname(u.pathname);
  if (!ext) return true;
  return ['.html', '.htm', '.php', '.asp', '.aspx'].includes(ext);
}

function sanitizeSegment(seg) {
  return seg
    .replace(/[\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashText(v) {
  return crypto.createHash('sha1').update(v).digest('hex').slice(0, 10);
}

function toLocalWebPath(u, kind = 'asset') {
  const host = u.host.toLowerCase();
  const rawParts = u.pathname.split('/').filter(Boolean);
  const parts = rawParts.map((p) => sanitizeSegment(decodeURIComponent(p)));

  const ext = extnameFromPathname(u.pathname);
  const isPage = kind === 'page' || (!ext && host === ROOT_HOST);

  let filename;
  let dirParts;

  if (u.pathname === '/' || u.pathname === '') {
    dirParts = [];
    filename = 'index.html';
  } else if (u.pathname.endsWith('/')) {
    dirParts = parts;
    filename = isPage ? 'index.html' : 'index.bin';
  } else if (isPage && !ext) {
    dirParts = parts;
    filename = 'index.html';
  } else {
    dirParts = parts.slice(0, -1);
    filename = parts.at(-1) || 'index.bin';
  }

  if (u.search) {
    const e = path.extname(filename);
    const b = e ? filename.slice(0, -e.length) : filename;
    filename = `${b}__q_${hashText(u.search)}${e}`;
  }

  const baseParts = host === ROOT_HOST ? [] : ['_external', host];
  const rel = '/' + [...baseParts, ...dirParts, filename].filter(Boolean).join('/');
  return rel;
}

function toDiskPath(webPath) {
  return path.join(OUT_DIR, webPath.replace(/^\//, ''));
}

function prettyPageLink(webPath) {
  if (!webPath.endsWith('.html')) return webPath;
  if (webPath === '/index.html') return '/';
  if (webPath.endsWith('/index.html')) return webPath.slice(0, -'index.html'.length);
  return webPath;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractLocsFromXml(xmlText) {
  const out = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    out.push(decodeHtmlEntities(m[1].trim()));
  }
  return out;
}

function extractUrlsFromHtml(html) {
  const out = [];
  const attrRe = /\b(?:href|src|poster|data-src|data-original|data-content-cover-bg)\s*=\s*(["'])(.*?)\1/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    out.push(m[2].trim());
  }

  const srcsetRe = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;
  while ((m = srcsetRe.exec(html)) !== null) {
    const items = m[2].split(',');
    for (const item of items) {
      const u = item.trim().split(/\s+/)[0];
      if (u) out.push(u);
    }
  }

  const styleUrlRe = /url\(([^)]+)\)/gi;
  while ((m = styleUrlRe.exec(html)) !== null) {
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (raw) out.push(raw);
  }

  // Inline Tilda scripts load optional modules and full-size cover images from
  // quoted absolute URLs rather than from src/data-src attributes.
  const absoluteUrlRe = /https?:\/\/[^\s"'<>\\)]+/gi;
  while ((m = absoluteUrlRe.exec(html)) !== null) out.push(m[0]);

  return out;
}

function extractUrlsFromCss(css) {
  const out = [];
  const importRe = /@import\s+(?:url\()?['"]?([^'"\)\s]+)['"]?\)?/gi;
  let m;
  while ((m = importRe.exec(css)) !== null) {
    out.push(m[1].trim());
  }
  const urlRe = /url\(([^)]+)\)/gi;
  while ((m = urlRe.exec(css)) !== null) {
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (raw) out.push(raw);
  }
  return out;
}

function shouldIgnoreLink(raw) {
  if (!raw) return true;
  const v = raw.trim().toLowerCase();
  return (
    v.startsWith('#') ||
    v.startsWith('javascript:') ||
    v.startsWith('mailto:') ||
    v.startsWith('tel:') ||
    v.startsWith('data:')
  );
}

async function fetchUrl(u) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(u, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*',
      },
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function saveFile(webPath, bytes) {
  const disk = toDiskPath(webPath);
  await fs.mkdir(path.dirname(disk), { recursive: true });
  await fs.writeFile(disk, bytes);
  return disk;
}

function enqueuePage(u) {
  const key = u.toString();
  if (pageVisited.has(key)) return;
  if (pageVisited.size + pageQueue.length >= MAX_PAGES) return;
  pageQueue.push(u);
}

function enqueueAsset(u) {
  const key = u.toString();
  if (assetVisited.has(key)) return;
  if (assetVisited.size + assetQueue.length >= MAX_ASSETS) return;
  assetQueue.push(u);
}

async function loadSitemaps() {
  const sitemapQueue = [
    new URL('/sitemap.xml', ROOT),
    new URL('/sitemap-feeds.xml', ROOT),
  ];
  const seen = new Set();

  while (sitemapQueue.length) {
    const sm = sitemapQueue.shift();
    const key = sm.toString();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const res = await fetchUrl(sm);
      if (!res.ok) continue;
      const text = await res.text();
      const locs = extractLocsFromXml(text);
      for (const locRaw of locs) {
        const u = ensureUrl(locRaw);
        if (!u) continue;
        if (u.host !== ROOT_HOST) continue;
        if (u.pathname.endsWith('.xml') || /sitemap/i.test(u.pathname)) {
          sitemapQueue.push(u);
        } else {
          enqueuePage(u);
        }
      }
    } catch {
      // ignore sitemap errors, fallback to root URL below
    }
  }

  if (!pageQueue.length) enqueuePage(new URL('/', ROOT));

  // Tilda keeps some public service/landing pages out of the sitemap. They
  // still have to be preserved for a complete migration, so seed them from
  // robots.txt as well and let the normal crawler verify whether they exist.
  try {
    const robots = await fetchUrl(new URL('/robots.txt', ROOT));
    if (robots.ok) {
      const text = await robots.text();
      for (const match of text.matchAll(/^Disallow:\s*(\/[^*\s]+)\s*$/gmi)) {
        const u = ensureUrl(match[1], ROOT);
        if (
          u &&
          u.host === ROOT_HOST &&
          isLikelyPage(u) &&
          !u.pathname.startsWith('/members/') &&
          !u.pathname.startsWith('/tilda/')
        ) enqueuePage(u);
      }
    }
  } catch {
    // Sitemap and link discovery remain the primary sources.
  }
}

async function crawlPages() {
  while (pageQueue.length) {
    const u = pageQueue.shift();
    const key = u.toString();
    if (pageVisited.has(key)) continue;
    pageVisited.add(key);

    try {
      const res = await fetchUrl(u);
      if (!res.ok) continue;

      const finalUrl = ensureUrl(res.url) || u;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const text = await res.text();

      const webPath = toLocalWebPath(finalUrl, 'page');
      await saveFile(webPath, text);
      downloaded.set(finalUrl.toString(), webPath);
      fileMeta.push({ filePath: toDiskPath(webPath), url: finalUrl.toString(), type: 'html' });

      const urls = extractUrlsFromHtml(text);
      for (const raw of urls) {
        if (shouldIgnoreLink(raw)) continue;
        const ru = ensureUrl(raw, finalUrl);
        if (!ru) continue;

        const sameHost = ru.host === ROOT_HOST;
        if (sameHost && isLikelyPage(ru)) {
          enqueuePage(ru);
        } else {
          const ext = extnameFromPathname(ru.pathname);
          if (sameHost || ext) enqueueAsset(ru);
        }
      }

      if (!ct.includes('text/html')) {
        // Some sitemap URLs may resolve to files; download as asset too.
        enqueueAsset(finalUrl);
      }
    } catch {
      // skip bad page
    }
  }
}

async function crawlAssets() {
  while (assetQueue.length) {
    const u = assetQueue.shift();
    const key = u.toString();
    if (assetVisited.has(key)) continue;
    assetVisited.add(key);

    try {
      const res = await fetchUrl(u);
      if (!res.ok) continue;

      const finalUrl = ensureUrl(res.url) || u;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const ab = await res.arrayBuffer();
      const bytes = Buffer.from(ab);

      const kind = isLikelyPage(finalUrl) && ct.includes('text/html') ? 'page' : 'asset';
      const webPath = toLocalWebPath(finalUrl, kind);

      if (ct.includes('text/css') || finalUrl.pathname.toLowerCase().endsWith('.css')) {
        let css = bytes.toString('utf8');
        const refs = extractUrlsFromCss(css);
        for (const raw of refs) {
          if (shouldIgnoreLink(raw)) continue;
          const ru = ensureUrl(raw, finalUrl);
          if (!ru) continue;
          enqueueAsset(ru);
        }
      }

      await saveFile(webPath, bytes);
      downloaded.set(finalUrl.toString(), webPath);
      fileMeta.push({
        filePath: toDiskPath(webPath),
        url: finalUrl.toString(),
        type: ct.includes('text/css') || finalUrl.pathname.toLowerCase().endsWith('.css') ? 'css' : 'asset',
      });
    } catch {
      // skip bad asset
    }
  }
}

function resolveLocalLink(raw, fromUrl) {
  const u = ensureUrl(raw, fromUrl);
  if (!u) return null;

  const mapped = downloaded.get(u.toString());
  if (mapped) {
    if (isLikelyPage(u)) return prettyPageLink(mapped);
    return mapped;
  }

  if (u.host === ROOT_HOST) {
    const fallback = toLocalWebPath(u, isLikelyPage(u) ? 'page' : 'asset');
    return isLikelyPage(u) ? prettyPageLink(fallback) : fallback;
  }

  const ext = extnameFromPathname(u.pathname);
  if (ext) return toLocalWebPath(u, 'asset');
  return null;
}

function rewriteTextContent(content, fromUrl, isCss = false) {
  let out = content;

  const replaceGenericUrl = (match, p1, p2) => {
    const quote = p1 || '';
    const raw = (p2 || '').trim();
    if (shouldIgnoreLink(raw)) return match;
    const next = resolveLocalLink(raw, fromUrl);
    if (!next) return match;
    return match.replace(raw, next);
  };

  out = out.replace(/\b(?:href|src|poster|data-src|data-original|data-content-cover-bg)\s*=\s*(["'])(.*?)\1/gi, replaceGenericUrl);

  out = out.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (match, quote, val) => {
    const items = val.split(',').map((item) => {
      const parts = item.trim().split(/\s+/);
      const raw = parts[0];
      if (!raw || shouldIgnoreLink(raw)) return item.trim();
      const next = resolveLocalLink(raw, fromUrl);
      if (!next) return item.trim();
      parts[0] = next;
      return parts.join(' ');
    });
    return `srcset=${quote}${items.join(', ')}${quote}`;
  });

  out = out.replace(/url\(([^)]+)\)/gi, (m, val) => {
    const raw = val.trim().replace(/^['"]|['"]$/g, '');
    if (!raw || shouldIgnoreLink(raw)) return m;
    const next = resolveLocalLink(raw, fromUrl);
    if (!next) return m;
    return `url(${next})`;
  });

  if (isCss) {
    out = out.replace(/@import\s+(?:url\()?['"]?([^'"\)\s]+)['"]?\)?/gi, (m, raw) => {
      if (!raw || shouldIgnoreLink(raw)) return m;
      const next = resolveLocalLink(raw, fromUrl);
      if (!next) return m;
      return m.replace(raw, next);
    });
  }

  // Final pass for absolute site URLs.
  out = out.replace(/https?:\/\/elegso\.ru\//gi, '/');

  // Rewrite quoted absolute resource URLs used by inline Tilda loaders when a
  // verified local copy was downloaded. External analytics and social links
  // remain external because they intentionally have no local mapping.
  out = out.replace(/https?:\/\/[^\s"'<>\\)]+/gi, (raw) => {
    const next = resolveLocalLink(raw, fromUrl);
    return next || raw;
  });
  return out;
}

async function rewriteDownloadedFiles() {
  for (const meta of fileMeta) {
    if (!['html', 'css'].includes(meta.type)) continue;

    try {
      const raw = await fs.readFile(meta.filePath, 'utf8');
      const next = rewriteTextContent(raw, meta.url, meta.type === 'css');
      if (next !== raw) {
        await fs.writeFile(meta.filePath, next, 'utf8');
      }
    } catch {
      // ignore unreadable text files
    }
  }
}

async function writeReports() {
  const summary = {
    generatedAt: new Date().toISOString(),
    root: ROOT.toString(),
    pagesDownloaded: pageVisited.size,
    assetsDownloaded: assetVisited.size,
    filesWritten: fileMeta.length,
  };

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(path.join(REPORT_DIR, 'mirror-summary.json'), JSON.stringify(summary, null, 2));

  const mapLines = [...downloaded.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([u, p]) => `${u}\t${p}`)
    .join('\n');
  await fs.writeFile(path.join(REPORT_DIR, 'url-map.tsv'), mapLines + (mapLines ? '\n' : ''));
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  await fs.mkdir(REPORT_DIR, { recursive: true });

  await loadSitemaps();
  await crawlPages();
  await crawlAssets();
  await rewriteDownloadedFiles();
  await writeReports();

  console.log(`Done: pages=${pageVisited.size}, assets=${assetVisited.size}, files=${fileMeta.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
