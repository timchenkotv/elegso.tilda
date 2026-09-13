import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectStructuredData } from '../scripts/structured-data.mjs';

const root = path.resolve(import.meta.dirname, '..');
const script = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const graph = types => ({ '@context': 'https://schema.org', '@graph': types.map(type => ({ '@type': type, name: 'ЭЛЕГСО' })) });

test('four actual public builders pass without depending on their private markers', () => {
  for (const [filename, expectedType] of [
    ['www/index.html', 'WebPage'],
    ['www/articles/debt-recovery-reconciliation/index.html', 'Article'],
    ['www/oferta/index.html', 'WebPage'],
    ['www/soglashenie/index.html', 'WebPage'],
  ]) {
    const html = fs.readFileSync(path.join(root, filename), 'utf8').replace(/\sdata-elegso-[\w-]+(?:=(?:"[^"]*"|'[^']*'))?/g, '');
    const result = inspectStructuredData(html);
    assert.equal(result.validCount, 1, filename);
    assert.deepEqual(result.errors, [], filename);
    assert.ok(result.types.includes(expectedType), filename);
  }
});

test('case-publisher style graph, simple nodes and typed arrays all work', () => {
  for (const value of [graph(['Organization', 'CollectionPage', 'BreadcrumbList']),
    { '@context': 'https://schema.org', '@type': 'LegalService' },
    [{ '@context': 'https://schema.org', '@type': ['Organization', 'LegalService'] }],
    { '@context': { '@vocab': 'https://schema.org/' }, '@graph': [{ '@type': 'Article' }] },
    { '@context': { schema: 'https://schema.org/' }, '@type': 'schema:Article' }]) {
    assert.deepEqual(inspectStructuredData(script(value)).errors, []);
  }
});

test('script type parsing accepts attribute order, quotes and whitespace; ordinary JSON does not count', () => {
  const body = JSON.stringify(graph(['WebPage']));
  for (const tag of [`<script nonce="x" TYPE = 'application/ld+json'>${body}</script>`, `<SCRIPT type=application/ld+json>${body}</SCRIPT>`]) {
    assert.equal(inspectStructuredData(tag).validCount, 1);
  }
  assert.equal(inspectStructuredData(`<script type="application/json">${body}</script>`).count, 0);
  assert.equal(inspectStructuredData(`<script data-type="application/ld+json">${body}</script>`).count, 0);
});

test('old arbitrary markers, comments and templates cannot produce false success', () => {
  for (const html of ['<div data-elegso-seo-schema>Nothing</div>', '<script data-elegso-cases-schema>{}</script>',
    `<!--${script(graph(['WebPage']))}-->`, `<template>${script(graph(['WebPage']))}</template>`]) {
    assert.equal(inspectStructuredData(html).validCount, 0);
    assert.ok(inspectStructuredData(html).errors.includes('missing-structured-data'));
  }
});

test('invalid JSON remains a reported error even when another block is valid', () => {
  const malformed = '<script type="application/ld+json">{"@context":"https://schema.org",}</script>';
  assert.deepEqual(inspectStructuredData(malformed).errors, ['missing-structured-data', 'invalid-structured-data:1:invalid-json']);
  const combined = inspectStructuredData(script(graph(['WebPage'])) + malformed);
  assert.equal(combined.validCount, 1);
  assert.deepEqual(combined.errors, ['invalid-structured-data:2:invalid-json']);
});

test('valid JSON without meaningful context and typed node is insufficient', () => {
  for (const value of [null, [], {}, 'Article', { '@type': 'Article' }, { '@context': '', '@type': 'Article' },
    { '@context': 'https://schema.org', '@graph': [] }, { '@context': 'https://schema.org', '@type': '' },
    { '@context': {}, '@type': 'Article' }, { '@context': 'https://schema.org', '@graph': [{ name: 'Untyped' }] }]) {
    const result = inspectStructuredData(script(value));
    assert.equal(result.validCount, 0, JSON.stringify(value));
    assert.ok(result.errors.includes('invalid-structured-data:1:missing-context-or-typed-node'));
  }
});

test('both live and local audits use the same content inspector', () => {
  for (const filename of ['audit-live-site.mjs', 'audit-seo.mjs']) {
    const source = fs.readFileSync(path.join(root, 'scripts', filename), 'utf8');
    assert.ok(source.includes('inspectStructuredData(html)'), filename);
    assert.ok(!source.includes("!html.includes('data-elegso-seo-schema')"));
  }
});
