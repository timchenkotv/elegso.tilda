import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../www/calc_nst/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('window.ELEGSO = window.ELEGSO || {};'), html.indexOf('// ====== Supabase (client-side minimal REST)'));
const legacyId = 'fd2e1956-5503-40b5-ae28-b4fb48b12c7e';

function fixture(hostname = 'elegso.ru') {
  const writes = [];
  const storage = new Map([['elegso_session_id', '501ea311-3811-4b05-b53b-f3619e5217bf']]);
  const document = {};
  Object.defineProperty(document, 'cookie', {
    get: () => `elegso_session_id=${legacyId}`,
    set: value => writes.push(value),
  });
  const context = { window: {}, document, location: {hostname},
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    crypto: {getRandomValues: () => {throw new Error('Existing session must not be regenerated');}},
  };
  vm.runInNewContext(source, context);
  return {context, writes, storage};
}

test('narrowing cookie scope preserves the prior calculation identifier', () => {
  const {context, writes, storage} = fixture();
  assert.equal(context.window.ELEGSO.getSessionId(), legacyId);
  assert.equal(storage.get('elegso_session_id'), legacyId);
  assert.equal(writes.length, 2);
  assert.match(writes[0], /Max-Age=0.*Domain=\.elegso\.ru/);
  assert.match(writes[1], new RegExp(`^elegso_session_id=${legacyId};`));
  assert.match(writes[1], /Max-Age=31536000;/);
  assert.match(writes[1], /SameSite=Lax; Secure/);
  assert.doesNotMatch(writes[1], /Domain=/i);
});

test('preview host only writes its own one-year cookie', () => {
  const {context, writes} = fixture('127.0.0.1');
  assert.equal(context.window.ELEGSO.getSessionId(), legacyId);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /Domain=/i);
});

test('main server diagnostics omit URL parameters but retain request metadata', () => {
  const nginx = fs.readFileSync(new URL('../ops/nginx/elegso.conf', import.meta.url), 'utf8');
  const format = nginx.match(/log_format elegso_private([\s\S]*?);/)[1];
  assert.match(format, /\$request_method \$uri \$server_protocol/);
  assert.doesNotMatch(format, /\$request_uri|\$args|\$http_referer\b/);
  assert.match(format, /\$elegso_referrer_origin/);
  assert.match(nginx, /access_log \/var\/log\/nginx\/elegso\.access\.log elegso_private;/);
});
