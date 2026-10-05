#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { updateSiteBrand } from './site-brand.mjs';

const args=process.argv.slice(2);
for(let i=0;i<args.length;i++){if(args[i]==='--root'){if(!args[++i])throw new Error('Missing root');}else if(!['--write','--check'].includes(args[i]))throw new Error('Unknown argument');}
if(args.includes('--write')&&args.includes('--check'))throw new Error('Choose one mode');
const index=args.indexOf('--root');
const root=path.resolve(index<0?path.join(import.meta.dirname,'../www'):args[index+1]);
async function walk(dir){const out=[];for(const item of await fs.readdir(dir,{withFileTypes:true})){if(item.name.startsWith('.')||['_external','admin','api'].includes(item.name))continue;const p=path.join(dir,item.name);if(item.isDirectory())out.push(...await walk(p));else if(item.name.endsWith('.html'))out.push(p);}return out;}
const changes=[];
for(const file of await walk(root)){const before=await fs.readFile(file,'utf8');const after=updateSiteBrand(before);if(before!==after)changes.push({file,before,after});}
if(args.includes('--write'))for(const item of changes){if(await fs.readFile(item.file,'utf8')!==item.before)throw new Error('Concurrent file edit: '+item.file);await fs.writeFile(item.file,item.after);}
console.log(JSON.stringify({changed:changes.length,files:changes.map(item=>path.relative(root,item.file))},null,2));
if(args.includes('--check')&&changes.length)process.exitCode=1;
