import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderPage} from '../scripts/build-site-design.mjs';

const root = path.resolve(process.env.ELEGSO_TEST_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const web = path.join(root, 'www');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = file => JSON.parse(read(file));
const original = json('content/site-pages.json');
const newServices = json('content/new-service-pages.json');
const manifest = json('reports/redesign-build.json');
const sourcePages = original.pages;
const addedPages = newServices.pages;
const publicFile = route => path.join(web, route === '/' ? 'index.html' : route.replace(/^\//, '') + 'index.html');
const pageHtml = route => fs.readFileSync(publicFile(route), 'utf8');
const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withoutScripts = html => html.replace(/<!--[^]*?-->/g, ' ').replace(/<(script|style|template)\b[^>]*>[^]*?<\/\1>/gi, ' ');
const entityMap = {amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' ', ndash:'–', mdash:'—', hellip:'…', copy:'©', reg:'®', laquo:'«', raquo:'»', shy:''};
function decode(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] !== '#') return entityMap[name.toLowerCase()] ?? all;
    const codePoint = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : all;
  });
}
const text = html => decode(withoutScripts(String(html ?? '')).replace(/<[^>]*>/g, ' '));
const textKey = html => text(html).replace(/[\s\u200b\u00ad]+/gu, '');
const bodyOf = html => html.match(/<body\b[^>]*>([^]*)<\/body>/i)?.[1] || '';
const attr = (tag, name) => decode(tag.match(new RegExp('(?:^|\\s)' + escapeRE(name) + '\\s*=\\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\\s>]+))', 'i'))?.slice(1).find(value => value !== undefined) || '');
function assertTextPresent(actualText, expected, label) {
  const expectedText = textKey(expected);
  if (expectedText) assert.ok(actualText.includes(expectedText), label);
}
function outputEntries(directory = web, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    // ERP cases are runtime-owned and may be symlinked outside this checkout.
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['_external','api','admin','cases'].includes(entry.name)) continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...outputEntries(path.join(directory, entry.name), relative + '/'));
    else if (entry.isFile() && entry.name.endsWith('.html')) {
      if (/^(?:header|footer|error404)\//.test(relative) || /^page\d+\.html$/.test(relative)) continue;
      const route = relative === 'index.html' ? '/' : '/' + relative.replace(/index\.html$/, '');
      result.push({relative, route, html:fs.readFileSync(path.join(directory, entry.name), 'utf8')});
    }
  }
  return result;
}
const expectedIndexable = new Set([
  ...sourcePages.map(page => page.route),
  ...addedPages.map(page => page.route),
  '/articles/', '/oferta/', '/soglashenie/', '/consent/', '/cookies/', '/documents/',
  '/offer_for_lawyer_20231103/', '/calc_nst/', '/calc_nst/instruction/',
]);
const isIndexableRoute = route => expectedIndexable.has(route) || /^\/articles\/[^/]+\/$/.test(route);

test('redesign manifest accounts for every original field and source fingerprint on all 23 pages', () => {
  assert.equal(sourcePages.length, 23, 'Review the migration inventory if original routes change');
  assert.equal(manifest.format, 'elegso-redesign-content-audit-v1');
  assert.equal(manifest.pageCount, sourcePages.length);
  assert.equal(manifest.sourceContentPreserved, true);
  assert.equal(manifest.pages.length, sourcePages.length);
  const auditByRoute = new Map(manifest.pages.map(page => [page.route, page]));
  assert.equal(auditByRoute.size, sourcePages.length, 'Manifest routes must be unique');
  for (const page of sourcePages) {
    const audit = auditByRoute.get(page.route);
    assert.ok(audit, 'Missing audit for ' + page.route);
    const fieldCount = page.records.reduce((sum, record) => sum + record.fields.length, 0);
    assert.equal(audit.originalFields, fieldCount, page.route + ': field inventory');
    assert.equal(audit.renderedFields, fieldCount, page.route + ': field coverage');
    assert.equal(audit.sourceHtmlSha256, page.sourceHtmlSha256, page.route + ': source HTML fingerprint');
    assert.equal(audit.sourceContentSha256, page.sourceContent.sha256, page.route + ': source content fingerprint');
    for (const name of ['missingFields','missingText','missingExtras']) assert.deepEqual(audit[name], [], page.route + ': ' + name);
    assert.equal(audit.h1Count, 1, page.route + ': H1 audit');
    assert.ok(fs.existsSync(publicFile(page.route)), 'Missing generated page ' + page.route);
  }
});

test('actual generated HTML retains every original field and additional text fragment', () => {
  for (const page of sourcePages) {
    const html = pageHtml(page.route);
    const actual = textKey(bodyOf(html));
    for (const record of page.records) {
      for (const [index, field] of record.fields.entries()) {
        assertTextPresent(actual, field.text, page.route + ': missing field ' + record.id + ':' + index);
      }
      for (const [index, fragment] of (record.uncovered || []).entries()) {
        assertTextPresent(actual, fragment, page.route + ': missing extra fragment ' + record.id + ':' + index);
      }
    }
    const h1 = text(html.match(/<h1\b[^>]*>([^]*?)<\/h1>/i)?.[1] || '');
    assert.ok(h1.trim(), page.route + ': empty H1');
    assert.ok(html.includes('data-elegso-case-carousel'), page.route + ': ERP carousel missing');
    assert.ok(html.includes('data-case-source="/cases/carousel.json"'), page.route + ': wrong carousel feed');
  }
});

test('renderer safely handles absent hero metadata without writing files', () => {
  for (const hero of [null, undefined, {recordId:'missing', cards:[]}]) {
    const page = {slug:'test_fallback', route:'/test_fallback/', title:'Fallback', description:'Description', heading:'Fallback heading', hero, schemas:[], verification:[], records:[]};
    const {html, audit} = renderPage(page);
    assert.equal(audit.h1Count, 1);
    assert.match(html, /<h1>Fallback heading<\/h1>/);
    assert.deepEqual(audit.missingFields, []);
  }
});

test('all 12 new service pages publish their substantive sections, UTPs, FAQ and primary source links', () => {
  assert.equal(addedPages.length, 12);
  assert.equal(new Set(addedPages.map(page => page.route)).size, 12);
  for (const page of addedPages) {
    const html = pageHtml(page.route);
    const actual = textKey(bodyOf(html));
    assert.equal(textKey(html.match(/<h1\b[^>]*>([^]*?)<\/h1>/i)?.[1]), textKey(page.h1), page.route + ': H1');
    assertTextPresent(actual, page.tagline, page.route + ': tagline');
    assertTextPresent(actual, page.lead, page.route + ': lead');
    for (const utp of page.utps) {
      assertTextPresent(actual, utp.title, page.route + ': UTP title');
      assertTextPresent(actual, utp.text, page.route + ': UTP text');
    }
    for (const section of page.sections) {
      assert.match(html, new RegExp('\\bid=["\x27]' + escapeRE(section.id) + '["\x27]'), page.route + ': section anchor ' + section.id);
      assertTextPresent(actual, section.title, page.route + ': section title ' + section.id);
      assertTextPresent(actual, section.html, page.route + ': full section text ' + section.id);
    }
    for (const faq of page.faq) {
      assertTextPresent(actual, faq.question, page.route + ': FAQ question');
      assertTextPresent(actual, faq.answer, page.route + ': FAQ answer');
    }
    const hrefs = [...html.matchAll(/<a\b[^>]*>/gi)].map(match => attr(match[0], 'href'));
    for (const source of page.sources) assert.ok(hrefs.includes(source.url), page.route + ': missing primary source ' + source.url);
    for (const related of page.relatedLinks) assert.ok(hrefs.includes(related.url), page.route + ': missing related link ' + related.url);
  }
});

test('bankruptcy warning is complete visible HTML, not an object or hidden disclosure', () => {
  const warning = typeof newServices.bankruptcyWarning === 'string' ? newServices.bankruptcyWarning : newServices.bankruptcyWarning.text;
  assert.ok(warning.includes('Предварительно обратитесь к своему кредитору и в МФЦ.'));
  for (const page of addedPages.filter(page => page.requiresBankruptcyWarning)) {
    const html = pageHtml(page.route);
    const body = withoutScripts(bodyOf(html));
    assert.doesNotMatch(body, /\[object Object\]/, page.route + ': warning serialization');
    const warningBlock = body.match(/<aside\b[^>]*class=["'][^"']*bankruptcy-warning[^"']*["'][^>]*>([^]*?)<\/aside>/i);
    assert.ok(warningBlock, page.route + ': missing visible warning block');
    assertTextPresent(textKey(warningBlock[1]), warning, page.route + ': incomplete warning');
    const opening = warningBlock[0].match(/^<aside[^>]*>/i)[0];
    assert.doesNotMatch(opening, /\bhidden(?:\s|=|>)|aria-hidden\s*=\s*["']true|display\s*:\s*none/i, page.route + ': hidden warning');
    const before = body.slice(0, body.indexOf(warningBlock[0]));
    assert.ok((before.match(/<details\b/gi)||[]).length <= (before.match(/<\/details>/gi)||[]).length, page.route + ': warning must not be inside a disclosure');
  }
});

test('public HTML shares semantic header/footer, one H1, consent controls and real canonical URLs', () => {
  const entries = outputEntries();
  assert.ok(entries.length >= sourcePages.length + addedPages.length, 'Public inventory is incomplete');
  for (const {relative, route, html} of entries) {
    const body = withoutScripts(bodyOf(html));
    assert.match(html, /<!--header-->/, relative + ': shared header marker');
    assert.match(html, /<!--footer-->/, relative + ': shared footer marker');
    assert.match(body, /<header\b[^>]*\bdata-elegso-design-header(?:\s|>)/i, relative + ': shared header');
    assert.match(body, /<footer\b[^>]*\bdata-elegso-modern-footer(?:\s|>)/i, relative + ': shared footer');
    assert.equal((body.match(/<h1\b/gi)||[]).length, 1, relative + ': H1 count');
    assert.ok(body.includes('id="allrecords"'), relative + ': allrecords wrapper');
    assert.ok(html.includes('elegso-redesign'), relative + ': redesign body');
    assert.ok(html.includes('data-elegso-privacy-config'), relative + ': consent configuration');
    assert.ok(body.includes('data-elegso-cookie-settings'), relative + ': cookie settings control');
    const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].find(match => attr(match[0], 'rel').split(/\s+/).includes('canonical'));
    assert.ok(canonical, relative + ': missing canonical');
    const canonicalUrl = new URL(attr(canonical[0], 'href'));
    assert.equal(canonicalUrl.origin, 'https://elegso.ru', relative + ': canonical origin');
    assert.equal(canonicalUrl.search + canonicalUrl.hash, '', relative + ': canonical must not carry query/fragment');
    if (isIndexableRoute(route)) {
      assert.equal(canonicalUrl.pathname, route, relative + ': indexable canonical route');
    } else {
      // Historical aliases may intentionally consolidate into the current offer.
      assert.ok(fs.existsSync(publicFile(canonicalUrl.pathname)), relative + ': canonical target must exist');
    }
  }
});

test('indexable pages have no prototype notices, localhost links, or accidental noindex', () => {
  for (const {relative, route, html} of outputEntries()) {
    const body = bodyOf(html);
    assert.doesNotMatch(body, /class=["'][^"']*preview-note|Локальный прототип|Для согласования дизайна|Действующий сайт не изменён/i, relative + ': prototype notice');
    assert.doesNotMatch(body, /(?:href|src)=["']https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|["'])/i, relative + ': localhost resource');
    assert.doesNotMatch(html.match(/<title\b[^>]*>([^]*?)<\/title>/i)?.[1] || '', /локальный прототип/i, relative + ': prototype title');
    if (!isIndexableRoute(route)) continue;
    const robots = [...html.matchAll(/<meta\b[^>]*>/gi)].filter(match => /^(?:robots|yandex)$/i.test(attr(match[0], 'name')));
    for (const meta of robots) assert.doesNotMatch(attr(meta[0], 'content'), /(?:^|[\s,])noindex(?:$|[\s,])/i, relative + ': accidental noindex');
    assert.doesNotMatch(html, /<noindex\b/i, relative + ': noindex wrapper');
  }
});

test('all referenced local HTML assets exist; ERP symlinks and runtime routes are not traversed', () => {
  const errors = [];
  const checked = new Set();
  for (const {relative, route, html} of outputEntries()) {
    for (const match of withoutScripts(html).matchAll(/<(?:img|source|video|audio|iframe|embed|object|link)\b[^>]*>/gi)) {
      const tag = match[0];
      const name = tag.match(/^<([a-z]+)/i)[1].toLowerCase();
      if (name === 'link' && !/(?:^|\s)(?:stylesheet|icon|preload|manifest|alternate)(?:$|\s)/i.test(attr(tag, 'rel'))) continue;
      const refs = [];
      if (name === 'link') refs.push(attr(tag, 'href'));
      else refs.push(attr(tag, 'src'), attr(tag, 'poster'), attr(tag, 'data'));
      if (attr(tag, 'srcset')) refs.push(...attr(tag, 'srcset').split(',').map(entry => entry.trim().split(/\s+/)[0]));
      for (const reference of refs) verify(reference, route, relative);
    }
    // Script bodies are ignored, but their external asset src must be checked.
    for (const match of html.matchAll(/<script\b[^>]*>/gi)) verify(attr(match[0], 'src'), route, relative);
  }
  function verify(reference, route, relative) {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return;
    let url;
    try { url = new URL(decode(reference), 'https://elegso.ru' + route); } catch { errors.push(relative + ': invalid asset ' + reference); return; }
    if (url.origin !== 'https://elegso.ru') return;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { errors.push(relative + ': invalid encoded asset ' + reference); return; }
    const absolute = path.resolve(web, '.' + pathname);
    if (!absolute.startsWith(web + path.sep)) { errors.push(relative + ': escaped web root ' + reference); return; }
    const id = relative + ':' + pathname;
    if (checked.has(id)) return;
    checked.add(id);
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) errors.push(relative + ': asset is not a file ' + pathname);
    } catch { errors.push(relative + ': missing asset ' + pathname); }
  }
  assert.deepEqual(errors, [], 'Local asset failures:\n' + errors.slice(0, 30).join('\n'));
});
