#!/usr/bin/env node
/** Reproducible public source build. Live ERP/legal projections are separate. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const steps=[['build-site-design.mjs'],['build-new-services.mjs'],['build-publications.mjs'],['build-offers.mjs'],['build-legal-pages.mjs','--write'],['build-remaining-chrome.mjs'],['build-public-sitemap.mjs'],['privacy-analytics.mjs','--apply']];
for(const [script,...args]of steps){
 const result=spawnSync(process.execPath,[path.join(root,'scripts',script),...args],{cwd:root,stdio:'inherit'});
 if(result.status!==0)process.exit(result.status||1);
}
const reportFile=path.join(root,'reports/redesign-build.json');
const report=JSON.parse(await fs.readFile(reportFile,'utf8'));
for(const p of report.pages){
 const html=await fs.readFile(path.join(root,'www',p.file),'utf8');
 p.finalHtmlSha256=createHash('sha256').update(html).digest('hex');
 p.finalHtmlBytes=Buffer.byteLength(html);
}
report.completedAt=new Date().toISOString();
report.newServices=JSON.parse(await fs.readFile(path.join(root,'content/new-service-pages.json'),'utf8')).pages.map(p=>p.route);
await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
