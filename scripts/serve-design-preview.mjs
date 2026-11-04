#!/usr/bin/env node
/** Loopback-only review server. Does not proxy ERP or production APIs. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),web=path.join(root,'www');
const generated=path.join(root,'work/redesign-2026-11-04/generated/current');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8','.ico':'image/x-icon','.pdf':'application/pdf'};
const port=Number(process.env.PORT||4180);
const server=http.createServer((req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(503,{'Content-Type':'application/json'}).end('{"error":"Local visual preview: production APIs are disabled"}');return;}
  const url=new URL(req.url,'http://127.0.0.1'),pathname=decodeURIComponent(url.pathname);
  const base=pathname.startsWith('/cases/')?generated:web;
  let file=path.resolve(base,'.'+pathname);
  if(file!==base&&!file.startsWith(base+path.sep)){res.writeHead(403).end();return;}
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('Страница не найдена');return;}
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'});
  if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
 }catch{res.writeHead(400).end();}
});
server.listen(port,'127.0.0.1',()=>console.log(`Review only: http://127.0.0.1:${port}/leasing_lawyer/`));
