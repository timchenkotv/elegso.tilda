import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read('config/recruitment-art-v3.json'));
const expectedAssets = [
  'assets-source/redesign/recruitment-hero-v3.png',
  'assets-source/redesign/recruitment-assessment-v3.png',
  'www/assets/redesign/recruitment-hero-v3.webp',
  'www/assets/redesign/recruitment-hero-v3-720.webp',
  'www/assets/redesign/recruitment-assessment-v3.webp',
  'www/assets/redesign/recruitment-assessment-v3-720.webp',
];

test('approved car and workplace previews are published without regenerating their source pixels', () => {
  assert.deepEqual(manifest.assets.map(asset => asset.path).sort(), [...expectedAssets].sort());
  for (const asset of manifest.assets) {
    const bytes = read(asset.path);
    assert.ok(bytes.length > 0, asset.path);
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(hash(bytes), asset.sha256, asset.path);
    if (asset.path.endsWith('.webp')) assert.ok(bytes.length <= 150000, asset.path);
  }
  for (const role of ['hero', 'assessment']) {
    const approved = manifest.approvalSourceHashes[role];
    assert.match(approved, /^[a-f0-9]{64}$/);
    assert.equal(hash(read(`assets-source/redesign/recruitment-${role}-v3.png`)), approved, role);
  }
});

test('v3 preserves prior approved artwork and content while changing only image URLs and cache version', () => {
  const expectedPreserved = ['content/recruitment-pages.json', ...['hero', 'assessment'].flatMap(role => [
    `assets-source/redesign/recruitment-${role}-v2.png`,
    `www/assets/redesign/recruitment-${role}-v2.webp`,
    `www/assets/redesign/recruitment-${role}-v2-720.webp`,
  ])];
  assert.deepEqual(manifest.preserved.map(asset => asset.path).sort(), expectedPreserved.sort());
  for (const asset of manifest.preserved) assert.equal(hash(read(asset.path)), asset.sha256, asset.path);
  assert.equal(manifest.layoutBaselines.length, 2);
  for (const baseline of manifest.layoutBaselines) {
    const normalized = read(baseline.path).toString()
      .replaceAll('recruitment-hero-v3', 'recruitment-hero-v2')
      .replaceAll('recruitment-assessment-v3', 'recruitment-assessment-v2')
      .replaceAll('20261104-recruitment-3', '20261104-recruitment-2');
    assert.equal(hash(normalized), baseline.sha256, baseline.path);
  }
  assert.equal(manifest.cacheVersion, '20261104-recruitment-3');
});
