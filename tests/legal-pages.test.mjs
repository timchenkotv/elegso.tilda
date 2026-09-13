import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildLegalPages, validateLegalDocument, renderLegalBody, renderLegalHub } from '../scripts/build-legal-pages.mjs';
import { applyPrivacyAnalytics, loadPrivacyBuild } from '../scripts/privacy-analytics.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const publisher = { name: 'ООО «ЮК ЭЛЕГСО»', brand: 'ЭЛЕГСО', logo: '/logo.png' };
const sample = {
  id: 'privacy', url: '/soglashenie/', title: 'Политика обработки персональных данных',
  description: 'Порядок обработки персональных данных.', revisionDate: '2026-09-13',
  sections: [
    { id: 'general', title: 'Общие положения', clauses: [{ number: '1.1', html: '<p>Исходный текст полностью сохраняется.</p>' }] },
    { id: 'contacts', title: 'Обращения', clauses: [{ number: '2.1', html: '<p>Текст с <a href="/oferta/">внутренней ссылкой</a>.</p>' }] },
  ],
};

test('legal content is static, complete and uses shared reader, print and section anchors', () => {
  assert.equal(validateLegalDocument(sample), sample);
  const html = renderLegalBody(sample, publisher);
  assert.equal((html.match(/data-eo-section/g) || []).length, 2);
  for (const section of sample.sections) {
    assert.ok(html.includes(`href="#${section.id}"`));
    for (const clause of section.clauses) assert.ok(html.includes(clause.html));
  }
  assert.match(html, /data-eo-print hidden/);
  assert.match(html, /eo-print-heading/);
  assert.match(html, /eo-toc/);
  assert.match(html, /datetime="2026-09-13"/);
  assert.match(renderLegalBody({ ...sample, id: 'cookies' }, publisher), /data-elegso-cookie-settings/);
});

test('invalid routes, duplicate anchors and active clause HTML fail before writes', () => {
  for (const url of ['/../oferta/', '/oferta/', '/oferta/versions/2026-09-13/', 'https://elegso.ru/x/']) {
    assert.throws(() => validateLegalDocument({ ...sample, url }));
  }
  assert.throws(() => validateLegalDocument({ ...sample, revisionDate: '2026-02-31' }));
  assert.throws(() => validateLegalDocument({ ...sample, sections: [sample.sections[0], sample.sections[0]] }));
  for (const html of ['<script>alert(1)</script>', '<p onclick="x()">text</p>', '<a href="https://elegso.ru/calc_nst/">Ссылка</a>']) {
    assert.throws(() => validateLegalDocument({ ...sample, sections: [{ ...sample.sections[0], clauses: [{ number: '1.1', html }] }] }));
  }
});

test('hub links one current offer, available legal documents and existing contractor URL', () => {
  const html = renderLegalHub([sample]);
  for (const url of ['/oferta/', '/soglashenie/', '/offer_for_lawyer_20231103/']) assert.ok(html.includes(`href="${url}"`));
  assert.doesNotMatch(html, /\/oferta-fiz\//);
  assert.match(html, /data-elegso-cookie-settings/);
});

test('build is dry by default, only writes legal destinations and exact sitemap entries, then is idempotent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elegso-legal-test-'));
  try {
    await fs.mkdir(path.join(root, 'content/legal'), { recursive: true });
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    await fs.mkdir(path.join(root, 'www/mission'), { recursive: true });
    await fs.mkdir(path.join(root, 'www/assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'content/legal/privacy.json'), JSON.stringify(sample));
    await fs.writeFile(path.join(root, 'config/offers.json'), JSON.stringify({ origin: 'https://elegso.ru', publisher }));
    await fs.copyFile(path.join(repository, 'config/site-privacy.json'), path.join(root, 'config/site-privacy.json'));
    const shell = '<!doctype html><html lang="ru"><head><title>Миссия</title><meta name="description" content="Старое"><meta name="robots" content="noindex"><link rel="canonical" href="https://elegso.ru/mission/"><script type="application/ld+json">{"name":"old"}</script></head><body><div id="allrecords"><!--header--><header id="t-header">Шапка</header><main>Другой материал</main><!--footer--><footer id="t-footer"><div>Старые ссылки</div></footer></div></body></html>';
    await fs.writeFile(path.join(root, 'www/mission/index.html'), shell);
    for (const asset of ['offers.css', 'offers.js', 'legal-pages.css', 'site-privacy.css', 'site-privacy.js', 'site-fonts.css']) await fs.copyFile(path.join(repository, 'www/assets', asset), path.join(root, 'www/assets', asset));
    const untouched = '<url><loc>https://elegso.ru/articles/example/</loc><lastmod>2025-05-05</lastmod></url>';
    const nested = '<url><loc>https://elegso.ru/soglashenie/something/</loc></url>';
    const sitemap = `<urlset>${untouched}${nested}<url><loc>https://elegso.ru/soglashenie/</loc><lastmod>2020-01-01</lastmod></url></urlset>`;
    await fs.writeFile(path.join(root, 'www/sitemap.xml'), sitemap);
    const plan = await buildLegalPages({ root });
    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.pages, 2);
    await assert.rejects(fs.access(path.join(root, 'www/soglashenie/index.html')));
    await buildLegalPages({ root, write: true });
    const html = await fs.readFile(path.join(root, 'www/soglashenie/index.html'), 'utf8');
    assert.match(html, /<title>Политика обработки персональных данных — ЭЛЕГСО<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/elegso.ru\/soglashenie\/">/);
    assert.match(html, /content="index, follow/);
    assert.equal((html.match(/application\/ld\+json/g) || []).length, 1);
    assert.doesNotMatch(html, /"name":"old"|Другой материал/);
    assert.match(html, /data-elegso-legal-schema/);
    assert.match(html, /Шапка/);
    assert.match(html, /data-tilda-cookie="no"/);
    const privacyBuild = await loadPrivacyBuild(root);
    for (const route of ['soglashenie', 'documents']) {
      const generated = await fs.readFile(path.join(root, 'www', route, 'index.html'), 'utf8');
      assert.equal(applyPrivacyAnalytics(generated, privacyBuild), generated, 'A subsequent privacy apply must be byte-idempotent');
      assert.equal((generated.match(/data-elegso-privacy-config/g) || []).length, 1);
    }
    const next = await fs.readFile(path.join(root, 'www/sitemap.xml'), 'utf8');
    assert.ok(next.includes(untouched)); assert.ok(next.includes(nested));
    assert.equal((next.match(/<loc>https:\/\/elegso.ru\/soglashenie\/<\/loc>/g) || []).length, 1);
    assert.equal(await fs.readFile(path.join(root, 'www/mission/index.html'), 'utf8'), shell);
    assert.equal((await buildLegalPages({ root })).changed.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
