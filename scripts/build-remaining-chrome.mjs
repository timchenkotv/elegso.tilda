#!/usr/bin/env node
/** Keep legacy calculator/document internals intact; replace only public chrome. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {siteHeader,siteFooter,designHead,designVersion} from './site-shell.mjs';
import {loadPrivacyBuild,applyPrivacyAnalytics,publicHtmlFiles} from './privacy-analytics.mjs';
import {addRecruitmentNavigation} from './recruitment-navigation.mjs';
const arg=process.argv.indexOf('--root');
const root=path.resolve(arg<0?path.join(import.meta.dirname,'..'):process.argv[arg+1]);
const web=path.join(root,'www'),privacy=await loadPrivacyBuild(root),changed=[];
const resources=designHead({title:'',description:'',route:'/'}).match(/<link\b[^>]*rel="stylesheet"[^>]*>|<script\b[^>]*src="[^"]+"[^>]*><\/script>/g).join('');
for(const file of await publicHtmlFiles(web)){
 let html=await fs.readFile(file,'utf8');
 if(html.includes('data-elegso-modern-footer')){
  const before=html;
  html=addRecruitmentNavigation(html);
  html=html.replace(/(\/assets\/redesign\/[^"?]+\.(?:css|js)\?v=)\d{8}-emerald-\d+/g,(_m,prefix)=>prefix+designVersion);
  // Retained calculator internals need new chrome behavior without a rewrite.
  const logoAssets=resources.match(/<link\b[^>]*href="[^\"]*logo-showcase\.css[^\"]*"[^>]*>|<script\b[^>]*src="[^\"]*logo-showcase\.js[^\"]*"[^>]*><\/script>/g)||[];
  const missing=logoAssets.filter(tag=>!html.includes(tag.match(/(?:href|src)="([^"?]+)/)[1]));
  if(missing.length)html=html.replace('</head>',missing.join('')+'</head>');
  if(html!==before){await fs.writeFile(file,html);changed.push(path.relative(web,file));}
  continue;
 }
 // Redirect stubs and technical fragments remain non-indexable and retain their semantics.
 const instruction=path.relative(web,file)==='calc_nst/instruction/index.html';
 const hs=instruction?html.indexOf('<header'):html.indexOf('<!--header-->'),he=html.indexOf('</header>',hs);
 const fsx=instruction?html.indexOf('<footer',he):html.indexOf('<!--footer-->',he),fe=html.indexOf('</footer>',fsx);
 if(hs<0||he<hs||fsx<he||fe<fsx)continue;
 const originalBody=html.slice(he+9,fsx);
 html=html.slice(0,hs)+siteHeader()+originalBody+siteFooter()+html.slice(fe+9);
 if(instruction){html=html.replace(/<body\b[^>]*>/i,tag=>tag+'<div id="allrecords" class="site-shell">').replace('</body>','</div></body>');}
 html=html.replace(/<body\b([^>]*)>/i,(_,attrs)=>'<body'+(/\bclass=(["'])(.*?)\1/i.test(attrs)?attrs.replace(/\bclass=(["'])(.*?)\1/i,(_m,q,v)=>`class=${q}${v} elegso-redesign elegso-legacy-page${q}`):attrs+' class="elegso-redesign elegso-legacy-page"')+'>');
 html=html.replace(/<div\b([^>]*\bid="allrecords"[^>]*)>/i,(_,attrs)=>'<div'+(/\bclass="([^"]*)"/.test(attrs)?attrs.replace(/\bclass="([^"]*)"/,(_m,v)=>`class="${v} site-shell"`):attrs+' class="site-shell"')+'>');
 // Remove duplicate hooks before installing the same assets used by all new pages.
 html=html.replace(/<link\b[^>]*href="\/assets\/(?:contact-reveal\.css|redesign\/[^"?]+)(?:\?[^" ]*)?"[^>]*>|<script\b[^>]*src="\/assets\/(?:contact-reveal\.js|redesign\/[^"?]+)(?:\?[^" ]*)?"[^>]*><\/script>/g,'');
 html=html.replace('</head>',resources+`<meta name="elegso-design-version" content="${designVersion}"></head>`);
 html=applyPrivacyAnalytics(addRecruitmentNavigation(html),privacy);
 await fs.writeFile(file,html);changed.push(path.relative(web,file));
}
console.log(JSON.stringify({reframed:changed}));
