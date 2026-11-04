#!/usr/bin/env node
/** New public directions; independent of case and legal-document storage. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {siteHeader,siteFooter,designHead,experienceBlock,expertBlock,serviceGroups,esc,arrow} from './site-shell.mjs';
import {loadPrivacyBuild,applyPrivacyAnalytics} from './privacy-analytics.mjs';

const args=process.argv.slice(2),i=args.indexOf('--root');
const root=path.resolve(i<0?path.join(path.dirname(fileURLToPath(import.meta.url)),'..'):args[i+1]);
const web=path.join(root,'www');
const data=JSON.parse(await fs.readFile(path.join(root,'content/new-service-pages.json'),'utf8'));
const privacy=await loadPrivacyBuild(root),seen=new Set();
const origin='https://elegso.ru';
for(const page of data.pages){
 if(!/^\/[a-z_]+\/$/.test(page.route)||seen.has(page.route))throw Error('Invalid service route '+page.route);
 seen.add(page.route);
 if(!page.h1||!page.description||page.sections.length<4)throw Error('Incomplete service '+page.route);
 for(const s of page.sections)if(!/^[a-z][a-z0-9-]*$/.test(s.id)||/<(?:script|iframe|form|input)\b|\bon\w+=|javascript:/i.test(s.html))throw Error('Unsafe section '+page.route);
 const group=serviceGroups.find(g=>g.id===page.group);
 if(!group)throw Error('Unknown service group');
 const schema={'@context':'https://schema.org','@graph':[
  {'@type':'Organization','@id':origin+'/#organization',name:'Юридическая компания «ЭЛЕГСО»',url:origin+'/',telephone:'+7-495-822-19-20',email:'mail@elegso.ru'},
  {'@type':'Service',name:page.h1,description:page.description,url:origin+page.route,provider:{'@id':origin+'/#organization'},areaServed:{'@type':'Country',name:'Россия'}},
  {'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:'Главная',item:origin+'/'},{'@type':'ListItem',position:2,name:group.title,item:origin+group.url},...(page.route===group.url?[]:[{'@type':'ListItem',position:3,name:page.h1,item:origin+page.route}])]},
  {'@type':'FAQPage',mainEntity:page.faq.map(f=>({'@type':'Question',name:f.question,acceptedAnswer:{'@type':'Answer',text:f.answer}}))}
 ]};
 const warningText=typeof data.bankruptcyWarning==='string'?data.bankruptcyWarning:data.bankruptcyWarning.text;
 if(page.requiresBankruptcyWarning&&!warningText)throw Error('Bankruptcy warning is required');
 const warning=page.requiresBankruptcyWarning?`<aside class="bankruptcy-warning" aria-label="Обязательное предупреждение о последствиях банкротства"><p>${esc(warningText)}</p></aside>`:'';
 const hero=`<section class="hero service-hero"><div class="hero-scene" data-hero-scene aria-hidden="true"><div class="hero-scene__image"></div><div class="hero-scene__light"></div><canvas class="hero-scene__dust"></canvas></div><div class="container"><nav class="breadcrumb" aria-label="Хлебные крошки"><a href="/">Главная</a><span>/</span><a href="${group.url}">${group.title}</a></nav><div class="hero-grid"><div class="hero-copy"><p class="hero-kicker">Право · Экономика · Стратегия</p><h1 class="source-field heading">${esc(page.h1)}</h1><p class="hero-tagline">${esc(page.tagline)}</p><p class="hero-lead">${esc(page.lead)}</p><div class="hero-actions"><a class="button button--wine" href="#contact">Обсудить задачу ${arrow}</a><a class="text-link" href="#service-content">Как строим защиту ${arrow}</a></div><p class="hero-caption">Продуманные решения<br>для устойчивого результата</p></div><aside class="hero-rail" aria-hidden="true"><span>Право</span><span>Экономика</span><span>Стратегия</span><span>Результат</span></aside><button class="motion-toggle" type="button" data-motion-toggle aria-pressed="true"><span data-motion-label>Движение: вкл.</span><span aria-hidden="true">Ⅱ</span></button></div></div>${warning}</section>`;
 const intro=`<section class="section section--paper"><div class="container"><div class="split-heading"><div><p class="eyebrow">Сначала — ваша задача</p><h2 class="section-title">Сильная позиция<br>начинается с деталей.</h2></div><p class="section-intro">${esc(page.lead)}</p></div><div class="new-utp-grid">${page.utps.map((u,n)=>`<article class="new-utp"><span class="step-number">0${n+1}</span><h3>${esc(u.title)}</h3><p>${esc(u.text)}</p></article>`).join('')}</div></div></section>`;
 const contents=`<nav class="service-toc" aria-label="Содержание услуги"><strong>В этом разделе</strong>${page.sections.map(s=>`<a href="#${s.id}">${esc(s.title)}</a>`).join('')}<a class="text-link" href="#contact">Обсудить ситуацию ${arrow}</a></nav>`;
 const prose=`<section class="section section--white" id="service-content"><div class="container new-service-layout">${contents}<div class="new-service-prose prose">${page.sections.map((s,n)=>`<section id="${s.id}" class="new-service-section"><span class="eyebrow">${String(n+1).padStart(2,'0')} / ${esc(group.title)}</span><h2>${esc(s.title)}</h2>${n===0?s.html:`<details class="disclosure" open><summary>Подробности и порядок действий</summary><div class="disclosure-content">${s.html}</div></details>`}</section>`).join('')}<section class="new-service-sources"><h2>Правовая основа</h2><p>Применимые правила и порядок действий проверяем по обстоятельствам конкретного поручения.</p><ul>${page.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a></li>`).join('')}</ul></section></div></div></section>`;
 const related=`<section class="section section--paper"><div class="container"><div class="split-heading"><div><p class="eyebrow">${esc(group.title)}</p><h2 class="section-title">Другие задачи направления.</h2></div></div><div class="route-grid">${page.relatedLinks.map((r,n)=>`<a class="route-card" href="${esc(r.url)}"><img class="route-card-art" src="/assets/redesign/${group.image}-720.webp" width="720" height="405" alt="" loading="lazy"><span class="route-number">0${n+1}</span><span>${esc(r.title)}</span>${arrow}</a>`).join('')}</div></div></section>`;
 const faq=`<section class="section section--white" id="questions"><div class="container"><div class="section-heading"><p class="eyebrow">Перед началом работы</p><h2 class="section-title">Вопросы и ответы.</h2></div><div class="faq-list">${page.faq.map(f=>`<details class="faq-item"><summary>${esc(f.question)}</summary><div class="disclosure-content prose"><p>${esc(f.answer)}</p></div></details>`).join('')}</div></div></section>`;
 let html=designHead({title:page.title,description:page.description,route:page.route,schemas:[schema]})+`<body class="elegso-redesign" data-page="${page.route.slice(1,-1)}"><a class="skip-link" href="#main">К содержанию</a><div class="site-shell" id="allrecords">${siteHeader()}<main id="main">${hero}${intro}${prose}${related}${experienceBlock(page.group)}${faq}${expertBlock()}</main>${siteFooter()}</div></body></html>`;
 html=applyPrivacyAnalytics(html,privacy);
 await fs.mkdir(path.join(web,page.route),{recursive:true});
 await fs.writeFile(path.join(web,page.route,'index.html'),html);
}
console.log(JSON.stringify({newServices:seen.size,routes:[...seen]}));
