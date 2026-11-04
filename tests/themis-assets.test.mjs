import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { designHead, designVersion } from '../scripts/site-shell.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(read('config/architecture-themis-v1.json'));
const sha256 = data => createHash('sha256').update(data).digest('hex');

test('Themis artwork and optimized derivatives match the saved generation manifest', () => {
  for (const asset of [manifest.original, ...manifest.derivatives]) {
    const bytes = read(asset.path);
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(sha256(bytes), asset.sha256, asset.path);
  }
  assert.ok(manifest.derivatives[0].bytes < 120000);
  assert.ok(manifest.derivatives[1].bytes < 32000);
  assert.equal(sha256(read(manifest.editTarget.path)), manifest.editTarget.sha256);
  assert.ok(manifest.prompt.length > 2000);
});

test('shared backgrounds use Themis with separate mobile artwork and tablet focal point', () => {
  const reference = read('www/assets/redesign/reference.css').toString();
  const editorial = read('www/assets/redesign/editorial-theme.css').toString();
  assert.match(reference, /architecture-themis-v1\.webp/);
  assert.match(reference, /architecture-themis-v1-720\.webp/);
  assert.match(reference, /min-width:768px\) and \(max-width:1023px\).*background-position:80% center/);
  assert.match(reference, /background-position:80% bottom/);
  assert.match(editorial, /architecture-themis-v1\.webp/);
  assert.doesNotMatch(editorial, /architecture-hero\.webp/);
});

test('shared assets are cache-busted and social previews use the new scene', () => {
  assert.equal(designVersion, '20261104-emerald-2');
  const head = designHead({ title: 'ЭЛЕГСО', description: '', route: '/' });
  assert.match(head, /architecture-themis-v1\.webp/);
  assert.match(head, /motion\.js\?v=20261104-emerald-2/);
  for (const route of ['leasing_lawyer/index.html', 'calc_nst/index.html', 'oferta/index.html']) {
    assert.match(read(`www/${route}`).toString(), /reference\.css\?v=20261104-emerald-2/, route);
  }
});
