import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read('config/recruitment-art-v2.json'));

test('living recruitment portraits match saved assets and all earlier artwork and copy remain intact', () => {
  for (const asset of manifest.assets) {
    const bytes = read(asset.path);
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(hash(bytes), asset.sha256, asset.path);
    if (asset.path.endsWith('.webp')) assert.ok(bytes.length < 125000, asset.path);
  }
  for (const asset of manifest.preserved) assert.equal(hash(read(asset.path)), asset.sha256, asset.path);
  assert.equal(manifest.prompts.length, 2);
  assert.ok(manifest.prompts[1].identityReference.endsWith('recruitment-hero-v2.png'));
});

test('art update changes only versioned image references and recruiting cache version, not layout or prose', () => {
  for (const baseline of manifest.layoutBaselines) {
    const normalized = read(baseline.path).toString()
      .replace(/recruitment-(hero|assessment)-v[23](?=[.-])/g, 'recruitment-$1')
      .replace(/20261104-recruitment-[23]/g, '20261104-recruitment-1');
    assert.equal(hash(normalized), baseline.sha256, baseline.path);
  }
});
