#!/usr/bin/env node
/** Footer-only update. No article generation, metadata, dates or feeds. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { updateFooterCards, footerCardsVersion } from './footer-cards.mjs';

const args=process.argv.slice(2);
for(let i=0;i<args.length;i++){if(args[i]==='--root'){if(!args[++i])throw new Error('--root requires a web directory');}else if(!['--write','--check'].includes(args[i]))throw new Error(`Unknown argument ${args[i]}`);}
if(args.includes('--write')&&args.includes('--check'))throw new Error('Choose --write or --check');
const rootIndex=args.indexOf('--root');
const web=path.resolve(rootIndex<0?path.join(import.meta.dirname,'../www'):args[rootIndex+1]);
async function walk(dir){const out=[];for(const item of await fs.readdir(dir,{withFileTypes:true})){if(item.name.startsWith('.')||['_external','api','admin'].includes(item.name))continue;const file=path.join(dir,item.name);if(item.isDirectory())out.push(...await walk(file));else if(item.isFile()&&item.name.endsWith('.html'))out.push(file);}return out;}
const pending=[];
for(const file of await walk(web)){const before=await fs.readFile(file,'utf8');const after=updateFooterCards(before);if(before!==after)pending.push({file,before,after});}
// Discover/validate all targets before any write, and refuse to clobber a file
// changed by a parallel edit after inspection.
if(args.includes('--write'))for(const item of pending){if(await fs.readFile(item.file,'utf8')!==item.before)throw new Error(`Changed during footer update: ${item.file}`);await fs.writeFile(item.file,item.after);}
console.log(JSON.stringify({version:footerCardsVersion,mode:args.includes('--write')?'write':args.includes('--check')?'check':'dry-run',changed:pending.length,files:pending.map(item=>path.relative(web,item.file))},null,2));
if(args.includes('--check')&&pending.length)process.exitCode=1;
