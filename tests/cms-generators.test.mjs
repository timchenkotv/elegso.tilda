import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  DEFAULT_LEGAL_PRESENTATION, defaultLegalHubCards, normalizeLegalPresentation,
  loadLegalPresentation, renderLegalBody, renderLegalHub, buildLegalPages,
} from '../scripts/build-legal-pages.mjs';

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const version = '2026-09-13';
const publisher = { name: 'ООО «ЮК ЭЛЕГСО»', brand: 'ЭЛЕГСО', logo: '/logo.png' };
const legalDocument = {
  id: 'privacy', url: '/soglashenie/', title: 'Политика', description: 'Порядок обработки данных.', revisionDate: version,
  sections: [{ id: 'general', title: '1. Общие положения', clauses: [{ number: '1.1', html: '<p>Полный исходный текст.</p>' }] }],
};
const offerDocument = id => ({
  id, version, title: 'Договор оказания услуг', description: 'Условия оказания услуг.', audience: 'Заказчики', lead: 'Исходное введение.',
  revisionDate: version, effectiveDate: version, publishedAt: version + 'T15:00:00+03:00', baseApprovalDate: null,
  sections: [{ id: 'terms', title: '1. Общие условия', clauses: [{ number: '1.1', html: '<p>Полный неизменяемый текст договора.</p>' }] }],
});
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
const digest = value => createHash('sha256').update(stable(value)).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elegso-cms-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['config', 'content/legal', 'content/offers/business', 'content/offers/individual', 'www/mission', 'www/assets']) await fs.mkdir(path.join(root, directory), { recursive: true });
  const write = async (relative, value) => fs.writeFile(path.join(root, relative), JSON.stringify(value));
  const config = {
    schemaVersion: 1, origin: 'https://elegso.ru', publisher,
    offers: [
      { id: 'business', url: '/oferta/', historyUrl: '/oferta/history/', currentVersion: version, label: 'Заказчики' },
      { id: 'individual', url: '/oferta-fiz/', historyUrl: '/oferta-fiz/history/', currentVersion: version, label: 'Архив', retired: true, replacedBy: '/oferta/' },
    ],
  };
  await write('config/offers.json', config);
  await write('content/legal/privacy.json', legalDocument);
  for (const id of ['business', 'individual']) await write(`content/offers/${id}/${version}.json`, offerDocument(id));
  await fs.copyFile(path.join(repository, 'config/site-privacy.json'), path.join(root, 'config/site-privacy.json'));
  for (const asset of ['offers.css', 'offers.js', 'legal-pages.css', 'site-privacy.css', 'site-privacy.js', 'site-fonts.css']) await fs.copyFile(path.join(repository, 'www/assets', asset), path.join(root, 'www/assets', asset));
  await fs.writeFile(path.join(root, 'www/mission/index.html'), '<!doctype html><html lang="ru"><head><title>Миссия</title><meta name="description" content="Исходная"><meta name="robots" content="index, follow"></head><body><div id="allrecords"><!--header--><header id="t-header">Шапка</header><main><h1>Миссия</h1></main><!--footer--><footer id="t-footer"><div id="rec1169591771">Подвал</div></footer></div></body></html>');
  await fs.writeFile(path.join(root, 'www/sitemap.xml'), '<urlset><url><loc>https://elegso.ru/mission/</loc><lastmod>2020-01-02</lastmod></url></urlset>');
  return {
    root, config, write,
    build: (...args) => run(process.execPath, [path.join(repository, 'scripts/build-offers.mjs'), '--root', root, ...args]),
    page: route => fs.readFile(path.join(root, 'www', route, 'index.html'), 'utf8'),
    registry: () => fs.readFile(path.join(root, 'config/offer-version-hashes.json'), 'utf8'),
  };
}

test('explicit default presentation produces byte-identical legal HTML and is exported for CMS seeding', async t => {
  const f = await fixture(t);
  const settings = { schemaVersion: 1, ...DEFAULT_LEGAL_PRESENTATION, hubCards: defaultLegalHubCards([legalDocument]) };
  assert.equal(renderLegalBody(legalDocument, publisher), renderLegalBody(legalDocument, publisher, [legalDocument], settings));
  assert.equal(renderLegalHub([legalDocument]), renderLegalHub([legalDocument], settings));
  assert.deepEqual(await loadLegalPresentation(f.root), normalizeLegalPresentation());
  await buildLegalPages({ root: f.root, write: true });
  await f.write('config/legal-presentation.json', settings);
  assert.deepEqual((await buildLegalPages({ root: f.root })).changed, []);
});

test('explicit default presentation leaves all offer outputs and sealed hashes unchanged', async t => {
  const f = await fixture(t);
  await f.build('--seal');
  const routes = ['/oferta/', '/oferta/history/', `/oferta/versions/${version}/`, '/oferta-fiz/', '/oferta-fiz/history/', `/oferta-fiz/versions/${version}/`];
  const before = await Promise.all(routes.map(route => f.page(route)));
  const registry = await f.registry();
  await f.write('config/legal-presentation.json', { schemaVersion: 1, ...DEFAULT_LEGAL_PRESENTATION });
  await f.build();
  assert.deepEqual(await Promise.all(routes.map(route => f.page(route))), before);
  assert.equal(await f.registry(), registry);
  assert.match(before[0], /<strong>Идентификатор редакции:<\/strong> business\/2026-09-13/);
  assert.match(before[0], /<strong>Контрольная сумма текста и реквизитов редакции \(SHA-256\):<\/strong>/);
});

test('nested publication metadata supports independent safe slug, permanent route, display identifier and labels', async t => {
  const f = await fixture(t);
  const document = {
    ...offerDocument('business'), version: 'release-autumn',
    publication: {
      permanentUrl: '/oferta/versions/contract-01/', identifier: 'Договор № 17 <осень>',
      identifierLabel: 'Обозначение:', permanentUrlLabel: 'Адрес редакции:',
      checksumLabel: 'Проверка SHA-256:', checksumNote: 'Примечание & условия проверки.',
    },
  };
  f.config.offers[0].currentVersion = document.version;
  f.config.offers[0].pageTitle = 'Новый заголовок документа';
  f.config.offers[0].pageDescription = 'Новое описание условий.';
  f.config.offers[0].seoTitle = 'Договор юридических услуг — ЭЛЕГСО';
  await f.write('config/offers.json', f.config);
  await f.write(`content/offers/business/${document.version}.json`, document);
  await f.build('--seal');
  const current = await f.page('/oferta/');
  const archived = await f.page(document.publication.permanentUrl);
  const history = await f.page('/oferta/history/');
  assert.match(current, /<title>Договор юридических услуг — ЭЛЕГСО<\/title>/);
  assert.match(current, /<h1>Новый заголовок документа<\/h1>/);
  assert.match(current, /name="description" content="Новое описание условий\."/);
  assert.match(current, /<strong>Обозначение:<\/strong> Договор № 17 &lt;осень&gt;/);
  assert.match(current, /<strong>Адрес редакции:<\/strong> <a href="\/oferta\/versions\/contract-01\/">/);
  assert.match(current, /eo-proof-note">Примечание &amp; условия проверки\./);
  assert.match(history, /<dt>Обозначение<\/dt><dd>Договор № 17 &lt;осень&gt;<\/dd>/);
  assert.match(history, /href="\/oferta\/versions\/contract-01\/"/);
  assert.match(archived, /rel="canonical" href="https:\/\/elegso.ru\/oferta\/versions\/contract-01\/"/);
  assert.match(archived, /content="noindex, follow"/);
  assert.match(history, /content="index, follow/);
  assert.match(await f.page('/oferta-fiz/history/'), /content="noindex, follow"/);
  const schema = JSON.parse(current.match(/<script type="application\/ld\+json" data-elegso-offers-schema>([\s\S]*?)<\/script>/)[1]);
  const entity = schema['@graph'].find(node => node['@type'] === 'WebPage').mainEntity;
  assert.equal(entity.identifier, document.publication.identifier);
  assert.equal(entity.version, document.version);
  assert.equal(entity.url, 'https://elegso.ru' + document.publication.permanentUrl);
  assert.equal(entity.datePublished, document.publishedAt);
  assert.equal(entity.dateModified, document.publishedAt);
  assert.ok(current.includes(document.sections[0].clauses[0].html));
  assert.match(current, new RegExp(`data-offer-sha256="${digest(document)}"`));
  const sitemap = await fs.readFile(path.join(f.root, 'www/sitemap.xml'), 'utf8');
  assert.doesNotMatch(sitemap, /\/versions\//);
  assert.match(sitemap, /<loc>https:\/\/elegso.ru\/mission\/<\/loc><lastmod>2020-01-02<\/lastmod>/);
  assert.match(sitemap, /<loc>https:\/\/elegso.ru\/oferta\/<\/loc><lastmod>2026-09-13<\/lastmod>/);
  const registry = await f.registry();
  document.publication.identifier = 'Подмена опубликованного идентификатора';
  await f.write(`content/offers/business/${document.version}.json`, document);
  await assert.rejects(f.build('--seal'), /IMMUTABLE VERSION CHANGED/);
  assert.equal(await f.registry(), registry);
  assert.equal(await f.page('/oferta/'), current);
  assert.equal(await f.page(document.publication.permanentUrl), archived);
});

test('duplicate permanent URL fails before any output or integrity registry is written', async t => {
  const f = await fixture(t);
  await f.write('content/offers/business/release-2.json', {
    ...offerDocument('business'), version: 'release-2', publication: { permanentUrl: `/oferta/versions/${version}/` },
  });
  await assert.rejects(f.build('--seal'), /Duplicate offer publication URL/);
  await assert.rejects(f.registry(), { code: 'ENOENT' });
  await assert.rejects(f.page('/oferta/'), { code: 'ENOENT' });
});

test('publication routes, metadata containers and top-level aliases reject traversal and guard bypasses', async t => {
  const f = await fixture(t);
  const invalid = [
    ...['https://elegso.ru/oferta/versions/x/', '//evil.test/x/', '/oferta/history/', '/oferta-fiz/versions/x/', '/oferta/versions/../x/', '/oferta/versions/%2e%2e/', '/oferta/versions/x/?y=1', '/oferta/versions/x/#fragment', '/oferta/versions/has_underscore/', '/oferta/versions/nested/slug/'].map(permanentUrl => ({ publication: { permanentUrl } })),
    { publication: null }, { publication: [] }, { publication: 'metadata' }, { publication: { unexpected: 'x' } },
    { publication: { identifier: '' } }, { publication: { checksumNote: 'line\nbreak' } },
    ...['permanentUrl', 'identifier', 'identifierLabel', 'permanentUrlLabel', 'checksumLabel', 'checksumNote'].map(field => ({ [field]: 'top-level bypass' })),
    { version: 'has_underscore' },
  ];
  for (const change of invalid) {
    await f.write(`content/offers/business/${version}.json`, { ...offerDocument('business'), ...change });
    await assert.rejects(f.build('--seal'), /Invalid|nested|Unknown/);
    await assert.rejects(f.registry(), { code: 'ENOENT' });
    await assert.rejects(f.page('/oferta/'), { code: 'ENOENT' });
  }
});

test('editable hub cards and button text are escaped, static, and reflected in SEO metadata', async t => {
  const f = await fixture(t);
  const settings = {
    hubTitle: 'Документы & условия', hubDescription: 'Проверенные <условия> и документы.',
    printLabel: 'Распечатать документ', offerPrintLabel: 'Печать договора', allDocumentsLabel: 'К документам',
    relatedAllDocumentsLabel: 'Список документов', openDocumentLabel: 'Открыть условия', cookieSettingsLabel: 'Выбор аналитики',
    hubCards: [{ url: '/soglashenie/', title: 'Данные <посетителей>', description: 'Правила & сроки.', date: '2026-09-14', privacy: true }],
    offerProof: { checksumNote: 'Редактируемое пояснение о проверке.' },
  };
  await f.write('config/legal-presentation.json', settings);
  await buildLegalPages({ root: f.root, write: true });
  const hub = await f.page('/documents/');
  const legal = await f.page('/soglashenie/');
  assert.match(hub, /<title>Документы &amp; условия — ЭЛЕГСО<\/title>/);
  assert.match(hub, /name="description" content="Проверенные &lt;условия&gt; и документы\."/);
  assert.match(hub, /<h1>Документы &amp; условия<\/h1>/);
  assert.match(hub, /Данные &lt;посетителей&gt;/);
  assert.match(hub, /Открыть условия <span/);
  assert.match(hub, /data-elegso-cookie-settings>Выбор аналитики/);
  assert.equal((hub.match(/class="el-document-card"/g) || []).length, 1);
  assert.match(legal, /Распечатать документ<\/button>/);
  assert.match(legal, />К документам<\/a>/);
  assert.match(legal, />Список документов →<\/a>/);
  assert.ok(legal.includes(legalDocument.sections[0].clauses[0].html));
  assert.match(renderLegalBody({ ...legalDocument, id: 'cookies' }, publisher, [], settings), /data-elegso-cookie-settings>Выбор аналитики/);
  await f.build('--seal');
  assert.match(await f.page('/oferta/'), /<span>Печать договора<\/span>/);
  assert.match(await f.page('/oferta/'), /eo-proof-note">Редактируемое пояснение о проверке\./);
});

test('invalid presentation cannot silently drop cards or cause active HTML or URL writes', async t => {
  const f = await fixture(t);
  for (const value of [null, [], { schemaVersion: 2 }, { unknown: 'ignored' }, { printLabel: '' }, { offerProof: { unexpected: 'x' } },
    { hubCards: [] }, { hubCards: [{ url: '//evil.test/', title: 'x', description: 'x' }] },
    { hubCards: [{ url: '/documents/', title: 'x', description: 'x', date: '2026-02-31' }] },
    { hubCards: [{ url: '/documents/', title: 'x', description: 'x' }, { url: '/documents/', title: 'y', description: 'y' }] }]) {
    await f.write('config/legal-presentation.json', value);
    await assert.rejects(buildLegalPages({ root: f.root, write: true }), /Invalid|Unknown|Unsupported/);
    await assert.rejects(f.build('--seal'), /Invalid|Unknown|Unsupported/);
    await assert.rejects(f.page('/documents/'), { code: 'ENOENT' });
    await assert.rejects(f.registry(), { code: 'ENOENT' });
  }
});
