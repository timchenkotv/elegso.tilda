import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const root=path.resolve(import.meta.dirname,'..');
test('SEO audit distinguishes exact server-managed cases route without exempting missing descendants or assets',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'elegso-seo-route-test-'));
  try{
    const web=path.join(tmp,'www');await fs.mkdir(web);
    await fs.writeFile(path.join(web,'index.html'),'<html lang="ru"><head><title>Test</title><meta name="description" content="Test"><link rel="canonical" href="https://elegso.ru/"></head><body><h1>Test</h1><a href="/cases/">Cases</a><a href="/cases/not-known/">Unknown case</a><a href="/missing/">Missing</a></body></html>');
    await fs.writeFile(path.join(web,'asset.html'),'<html><body><img src="/cases/" alt="test"></body></html>');
    const reportPath=path.join(tmp,'report.json');
    await run(process.execPath,[path.join(root,'scripts/audit-seo.mjs'),web,reportPath]);
    const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
    const page=report.pages.find(p=>p.route==='/');
    assert.deepEqual(page.broken,['/cases/not-known/','/missing/']);
    assert.equal(page.runtimeReferences.length,1);
    assert.equal(page.runtimeReferences[0].path,'/cases/');
    assert.equal(page.runtimeReferences[0].validation,'live-check-required');
    assert.deepEqual(report.summary.runtimeValidationRequired,['/cases/']);
    assert.equal(report.summary.runtimeReferences,1);
    assert.equal(report.runtimeReferences[0].producer,'elegso-case-publisher.service');
    assert.deepEqual(report.pages.find(p=>p.route==='/asset.html').broken,['/cases/']);
    assert.equal(report.summary.brokenLocalReferences,3);
    const service=await fs.readFile(path.join(root,page.runtimeReferences[0].configuration),'utf8');
    assert.ok(service.includes('--output-root /srv/www/elegso.ru/generated'));
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
