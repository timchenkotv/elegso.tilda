#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {publicHtmlFiles} from './privacy-analytics.mjs';
const arg=process.argv.indexOf('--root');
const root=path.resolve(arg<0?path.join(import.meta.dirname,'..'):process.argv[arg+1]);
const web=path.join(root,'www'),rows=new Map();
for(const file of await publicHtmlFiles(web)){
 const html=await fs.readFile(file,'utf8');
 if(/<meta\b(?=[^>]*\bname=["']robots["'])(?=[^>]*\bcontent=["'][^"']*noindex)[^>]*>/i.test(html))continue;
 const canonical=html.match(/<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["']/i)?.[1];
 if(!canonical||!canonical.startsWith('https://elegso.ru/'))continue;
 const rel=path.relative(web,file),expected=rel==='index.html'?'https://elegso.ru/':'https://elegso.ru/'+rel.replace(/index\.html$/,'');
 if(canonical!==expected)continue;
 const modified=html.match(/<meta\b(?=[^>]*property=["']article:modified_time["'])[^>]*content=["'](\d{4}-\d{2}-\d{2})/i)?.[1];
 rows.set(canonical,`<url><loc>${canonical}</loc>${modified?`<lastmod>${modified}</lastmod>`:''}</url>`);
}
const xml='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+[...rows].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v).join('\n')+'\n</urlset>\n';
await fs.writeFile(path.join(web,'sitemap.xml'),xml);
if(await fs.stat(path.join(web,'sitemap.base.xml')).catch(()=>false))await fs.writeFile(path.join(web,'sitemap.base.xml'),xml);
console.log(JSON.stringify({indexedRoutes:rows.size}));
