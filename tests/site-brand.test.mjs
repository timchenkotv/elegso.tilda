import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { updateSiteBrand, currentLogo, previousLogo, brandVersion } from '../scripts/site-brand.mjs';

test('logo replacement and compact header are idempotent and preserve page copy',()=>{
  const input=`<html><head><title>Original title</title><meta name="robots" content="index,follow"></head><body><header id="t-header"><div class="tmenu-mobile__text">Company</div><img src="${previousLogo}" alt="ЮК ЭЛЕГСО"></header><main>Original article</main><footer>Original footer</footer><script src="/assets/migration.js?v=old"></script></body></html>`;
  const next=updateSiteBrand(input);
  assert.equal(updateSiteBrand(next),next);
  assert.equal((next.match(/data-elegso-brand-styles/g)||[]).length,1);
  assert.equal((next.match(/data-elegso-mobile-brand/g)||[]).length,1);
  assert.ok(next.includes(`<img src="${currentLogo}" alt="ЮК ЭЛЕГСО">`));
  assert.ok(next.includes('Company</div>'));
  assert.ok(next.includes('<main>Original article</main><footer>Original footer</footer>'));
  assert.ok(next.includes('<title>Original title</title><meta name="robots" content="index,follow">'));
  assert.ok(next.includes(`/assets/migration.js?v=${brandVersion}`));
  assert.ok(!next.includes(previousLogo));
});
test('previous and uploaded original logo files are preserved',()=>{
  const root=new URL('../www',import.meta.url);
  const old=fs.readFileSync(new URL('.'+previousLogo+'',root.href+'/'));
  const copy=fs.readFileSync(new URL('./assets/brand/elegso-logo-previous.png',root.href+'/'));
  assert.deepEqual(copy,old);
  assert.ok(fs.existsSync(new URL('./assets/brand/elegso-logo-2026-10-05-original.png',root.href+'/')));
  assert.ok(fs.statSync(new URL('.'+currentLogo,root.href+'/')).size<200000);
});
test('header dimensions preserve logo proportions and both mobile controls',()=>{
  const css=fs.readFileSync(new URL('../www/assets/site-brand.css',import.meta.url),'utf8');
  assert.match(css,/height:140px!important/);
  assert.match(css,/height:132px!important;object-fit:contain/);
  assert.match(css,/@media\(max-width:980px\)/);
  assert.match(css,/t-menuburger\{flex-shrink:0/);
  assert.doesNotMatch(css,/object-fit:cover/);
});
