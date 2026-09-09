#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const config=JSON.parse(await fs.readFile(path.join(root,'config/publications.json'),'utf8'));
const content=(await Promise.all((await fs.readdir(path.join(root,'content/publications'))).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await fs.readFile(path.join(root,'content/publications',f),'utf8'))))).flat();
const sources=process.argv.includes('--sources');
const urls=sources?[...new Set(content.flatMap(a=>a.sources.map(s=>s.url)))]:[
  'https://elegso.ru/articles/',...config.publications.map(a=>'https://elegso.ru'+a.url),
  'https://elegso.ru/articles/rss.xml','https://elegso.ru/articles/announcements.xml',
  ...config.migration.sourcePages.map(u=>'https://elegso.ru'+u),
  'https://elegso.ru/sitemap.xml',...config.publications.map(a=>'https://elegso.ru'+a.image)
];
const queue=urls.map((url,index)=>({url,index}));
const results=[];
await Promise.all(Array.from({length:4},async()=>{while(queue.length){const {url,index}=queue.shift();const start=Date.now();try{const r=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Elegso-Publication-Link-Check/1.0'}});const body=await r.arrayBuffer();results[index]={url,status:r.status,finalUrl:r.url,type:r.headers.get('content-type'),robots:r.headers.get('x-robots-tag'),ms:Date.now()-start,bytes:body.byteLength,ok:r.ok};}catch(e){results[index]={url,ok:false,error:e.message};}}}));
const report={checkedAt:new Date().toISOString(),kind:sources?'legal-sources':'live-publications',total:results.length,failed:results.filter(r=>!r.ok).length,results};
const file=path.join(root,'reports',sources?'publication-source-links-2026-09-09.json':'publications-live-check-2026-09-09.json');
await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.failed)process.exitCode=1;
