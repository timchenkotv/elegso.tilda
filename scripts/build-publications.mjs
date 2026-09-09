#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = path.join(root, 'www');
const origin = 'https://elegso.ru';
const config = JSON.parse(await fs.readFile(path.join(root, 'config/publications.json'), 'utf8'));
const esc = (s='') => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const plain = s => String(s).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const json = o => JSON.stringify(o).replaceAll('<','\\u003c');
const cdata = s => '<![CDATA[' + String(s).replaceAll(']]>',']]]]><![CDATA[>') + ']]>';
function responsive(html) {
  return html.replace(/<img\b(?=[^>]*src="\/assets\/publications\/)[^>]*>/g, tag => {
    if (tag.includes('srcset=')) return tag;
    const src = tag.match(/src="([^"]+)"/)[1];
    return tag.replace('<img ', `<img srcset="${src.replace('.webp','-600.webp')} 600w, ${src} 1200w" sizes="(max-width: 680px) calc(100vw - 40px), (max-width: 980px) 50vw, 600px" `);
  });
}
const date = iso => new Date(iso).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Moscow'});
const files = (await fs.readdir(path.join(root, 'content/publications'))).filter(f=>f.endsWith('.json')).sort();
const content = (await Promise.all(files.map(async f=>JSON.parse(await fs.readFile(path.join(root,'content/publications',f),'utf8'))))).flat();
const articles = config.publications.map(meta => {
  const item = content.find(a=>a.slug===meta.slug);
  if (!item) throw new Error('Missing article '+meta.slug);
  if (!item.sections?.length || !item.sources?.length) throw new Error('Incomplete article '+meta.slug);
  const text = plain(item.lead+' '+item.sections.map(s=>s.html).join(' '));
  return {...meta,...item,words:text.split(/\s+/).length,minutes:Math.max(3,Math.ceil(text.split(/\s+/).length/180))};
});
if(new Set(articles.map(a=>a.slug)).size!==articles.length || content.length!==articles.length) throw new Error('Duplicate or extra articles');

function nav(html) {
  html=html.replace(/<li class="t228__list_item" style="padding:0 15px;"><a class="t-menu__link-item" href="\/articles\/" data-elegso-articles-nav>Статьи<\/a><\/li>/g,'');
  if(html.includes('data-elegso-articles-nav')) return html;
  return html.replace(/(<div id="nav1210506996"[\s\S]*?<ul\b[^>]*>)([\s\S]*?)(<\/ul>)/, (_match,start,items,end)=>{
    const source=items.match(/<li\b[^>]*>(?:(?!<\/li>)[\s\S])*?href="\/mission\/"(?:(?!<\/li>)[\s\S])*?<\/li>/)?.[0];
    if(!source) throw new Error('About menu template missing');
    const item=source.replace('href="/mission/"','href="/articles/" data-elegso-articles-nav').replace('Наша миссия','Статьи');
    return start+items+item+' '+end;
  });
}
function footerNav(html) {
  if(html.includes('data-elegso-articles-footer')) return html;
  return html.replace('<div id="rec1169591771"','<div class="r t-rec" data-elegso-articles-footer style="background-color:#e5dcd0;"><div class="t-container"><div class="t-col t-col_12"><p style="margin:0;padding:0 0 25px;font-family:Ubuntu,Arial,sans-serif;font-size:16px;line-height:1.5;"><a href="/articles/" style="color:#355a56;">Статьи и практика</a></p></div></div></div> <div id="rec1169591771"');
}
if(process.argv.includes('--navigation-only')) {
  let changed=0;
  for(const file of await walk(web)){const old=await fs.readFile(file,'utf8');const updated=footerNav(nav(old));if(updated!==old){await fs.writeFile(file,updated);changed++;}}
  console.log(JSON.stringify({navigationOnly:true,changed}));
  process.exit(0);
}
const template = await fs.readFile(path.join(web,'mission/index.html'),'utf8');
const bodyStart = template.search(/<body\b/i);
const headerStart = template.indexOf('<!--header-->');
const headerEnd = template.indexOf('</header>',headerStart)+9;
const footerStart = template.indexOf('<!--footer-->',headerEnd);
if(bodyStart<0 || headerStart<0 || footerStart<0) throw new Error('Site template markers missing');
const header = nav(template.slice(headerStart,headerEnd));
const tail = footerNav(template.slice(footerStart));
const organisation = {'@type':'Organization','@id':origin+'/#organization',name:'Юридическая компания «ЭЛЕГСО»',url:origin+'/',logo:origin+'/_external/static.tildacdn.com/tild6636-3836-4134-b236-373062316464/_v6_.png'};
function meta(head,attribute,name,value) {
  const tag=`<meta ${attribute}="${name}" content="${esc(value)}">`;
  const re=new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${name}["'])[^>]*>`,'i');
  return re.test(head)?head.replace(re,tag):head.replace('</head>',tag+'\n</head>');
}
function shell(title,description,url,body,item=null) {
  let head=template.slice(0,bodyStart).replace(/<title\b[^>]*>[\s\S]*?<\/title>/i,`<title>${esc(title)}</title>`)
    .replace(/<link\b(?=[^>]*(?:application\/rss\+xml|\/assets\/publications\.css))[^>]*>/gi,'')
    .replace(/<script\b[^>]*src=["']\/assets\/publications\.js[^"']*["'][^>]*><\/script>/gi,'')
    .replace(/<link\b(?=[^>]*rel=["']canonical["'])[^>]*>/i,`<link rel="canonical" href="${origin}${url}">`)
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,'');
  for(const [attr,name,value] of [['name','description',description],['property','og:title',title],['property','og:description',description],['property','og:url',origin+url],['property','og:type',item?'article':'website'],['property','og:image',origin+(item?.image||articles[0].image)],['name','robots','index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1']]) head=meta(head,attr,name,value);
  if(item){head=meta(head,'property','article:published_time',config.section.publishedAt);head=meta(head,'property','article:modified_time',config.section.modifiedAt);}
  const crumbs=[{'@type':'ListItem',position:1,name:'Главная',item:origin+'/'},{'@type':'ListItem',position:2,name:config.section.title,item:origin+'/articles/'}];
  if(item) crumbs.push({'@type':'ListItem',position:3,name:item.title,item:origin+url});
  const graph=[organisation,{'@type':'WebSite','@id':origin+'/#website',name:'ЭЛЕГСО',url:origin+'/',publisher:{'@id':origin+'/#organization'}},{'@type':'BreadcrumbList',itemListElement:crumbs}];
  graph.push(item?{'@type':'Article','@id':origin+url+'#article',headline:item.title,description,mainEntityOfPage:origin+url,url:origin+url,inLanguage:'ru-RU',datePublished:config.section.publishedAt,dateModified:config.section.modifiedAt,image:[origin+item.image],author:{'@type':'Organization',name:config.section.publisher,url:origin+'/our_team/'},publisher:{'@id':origin+'/#organization'},articleSection:item.category,wordCount:item.words,citation:item.sources.map(s=>s.url)}:{'@type':'CollectionPage',name:title,url:origin+url,description,inLanguage:'ru-RU',mainEntity:{'@type':'ItemList',itemListElement:articles.map((a,i)=>({'@type':'ListItem',position:i+1,url:origin+a.url,name:a.title}))}});
  head=head.replace('</head>',`<link rel="stylesheet" href="/assets/publications.css?v=20260909-1"><script src="/assets/publications.js?v=20260909-1" defer></script><link rel="alternate" type="application/rss+xml" title="Статьи и практика ЭЛЕГСО" href="/articles/rss.xml"><script type="application/ld+json" data-elegso-publications-schema>${json({'@context':'https://schema.org','@graph':graph})}</script></head>`);
  return head+`<body class="t-body elegso-publications-page" style="margin:0"><a class="ep-skip" href="#publication-content">К содержанию</a><div id="allrecords" class="t-records" data-tilda-project-id="3964517" data-tilda-lazy="yes" data-tilda-root-zone="com">${header}${body}${tail}`;
}
function card(a,{featured=false}={}) {return `<article class="ep-card${featured?' ep-card--featured':''}" data-category="${esc(a.category)}" data-search="${esc((a.title+' '+a.description).toLocaleLowerCase('ru'))}"><a href="${a.url}" class="ep-card-image" tabindex="-1" aria-hidden="true"><img src="${a.image}" alt="" width="1200" height="800" loading="lazy" decoding="async"></a><div class="ep-card-copy"><div class="ep-meta"><span>${esc(a.category)}</span><span>${a.minutes} мин чтения</span></div><h3><a href="${a.url}">${esc(a.title)}</a></h3><p>${esc(a.description)}</p><a class="ep-read" href="${a.url}" aria-label="${esc('Читать: '+a.title)}">Читать разбор <span aria-hidden="true">↗</span></a></div></article>`;}
function block(selected=articles.slice(0,3)) {return `<!--elegso-publications:start--><section class="ep-preview" aria-labelledby="ep-preview-title"><div class="ep-wrap"><div class="ep-section-head"><div><span class="ep-kicker">Право в деловой практике</span><h2 id="ep-preview-title">Статьи и практика</h2><p>Разбираем сложные ситуации, проверяем расчёты и объясняем, какие документы помогут защитить бизнес.</p></div><a class="ep-button ep-button--outline" href="/articles/">Все материалы <span aria-hidden="true">↗</span></a></div><div class="ep-grid">${selected.map(a=>card(a)).join('')}</div></div></section><!--elegso-publications:end-->`;}
const catalogue=`<main class="ep-main" id="publication-content"><section class="ep-hero"><div class="ep-wrap ep-hero-grid"><div><nav class="ep-crumbs" aria-label="Хлебные крошки"><a href="/">Главная</a><span aria-hidden="true">/</span><span>Статьи и практика</span></nav><span class="ep-kicker">Юридическая компания «ЭЛЕГСО»</span><h1>Право, которое<br>помогает <em>бизнесу.</em></h1><p class="ep-lead">Лизинг, договоры, судебные доказательства и ответственность руководителя. Подробные разборы с понятным порядком действий и ссылками на правовые источники.</p><div class="ep-actions"><a class="ep-button" href="#materials">Выбрать материал <span aria-hidden="true">↓</span></a><a class="ep-text-link" href="/articles/rss.xml">Лента публикаций</a></div></div><figure class="ep-hero-art"><img src="${articles[0].image}" alt="${esc(articles[0].imageAlt)}" width="1200" height="800" fetchpriority="high"><figcaption><span>От вопроса — к позиции</span><strong>Документы. Расчёт. Защита.</strong></figcaption></figure></div></section><section class="ep-catalog ep-wrap" id="materials"><div class="ep-section-head"><div><span class="ep-kicker">Библиотека решений</span><h2>Материалы для руководителей и юристов</h2></div></div><div class="ep-tools" data-ep-tools hidden><div class="ep-filters" role="group" aria-label="Тематика статей">${['Все','Лизинг','Защита бизнеса','Доказательства'].map((s,i)=>`<button type="button" data-filter="${s}" aria-pressed="${i===0}">${s}</button>`).join('')}</div><label class="ep-search"><span class="ep-sr">Поиск по статьям</span><input type="search" placeholder="Найти нужную тему" data-ep-search></label></div><p class="ep-results ep-sr" aria-live="polite" data-ep-results></p><div class="ep-grid ep-grid--catalog">${articles.map(a=>card(a)).join('')}</div><p class="ep-empty" data-ep-empty hidden>По этому запросу материалов пока нет. Попробуйте другое слово или выберите все темы.</p></section><section class="ep-wrap ep-editorial"><div><span class="ep-kicker">Основа каждой публикации</span><h2>Сначала факты.<br>Затем выводы.</h2></div><div><p>Опираемся на документы, разъяснения Верховного суда и официальные источники. В каждом материале — дата актуализации и перечень использованных правовых источников.</p><p>Подход к конкретному спору зависит от договора, дат, расчётов и доказательств. Для проверки вашей ситуации соберите документы по предложенному в статье списку.</p><a class="ep-text-link" href="/our_team/">Наша команда <span aria-hidden="true">↗</span></a></div></section>${contact()}</main>`;
function contact(){return `<section class="ep-contact ep-wrap"><div><span class="ep-kicker">Разберём вашу ситуацию</span><h2>Нужна правовая оценка документов?</h2><p>Свяжитесь с ЭЛЕГСО. Работаем с компаниями и предпринимателями по всей России.</p></div><div class="ep-contact-actions"><a class="ep-button" href="mailto:mail@elegso.ru">mail@elegso.ru</a><a href="tel:+74956460002">+7 (495) 646-00-02</a></div></section>`;}
function articleBody(a){const related=articles.filter(b=>b.slug!==a.slug).sort((b,c)=>Number(c.category===a.category)-Number(b.category===a.category)).slice(0,3);return `<main class="ep-main ep-article" id="publication-content"><div class="ep-progress" aria-hidden="true"><i data-ep-progress></i></div><section class="ep-article-head ep-wrap"><nav class="ep-crumbs" aria-label="Хлебные крошки"><a href="/">Главная</a><span aria-hidden="true">/</span><a href="/articles/">Статьи и практика</a><span aria-hidden="true">/</span><span>${esc(a.category)}</span></nav><div class="ep-article-top"><div><div class="ep-meta"><span>${esc(a.category)}</span><span>${a.minutes} мин чтения</span></div><h1>${esc(a.title)}</h1><p class="ep-lead">${esc(a.lead)}</p><div class="ep-byline"><a href="/our_team/">${esc(config.section.publisher)}</a><time datetime="${config.section.modifiedAt}">Актуализировано ${date(config.section.modifiedAt)}</time></div><div class="ep-article-actions"><button type="button" data-ep-print hidden>Печать статьи</button><button type="button" data-ep-copy hidden>Скопировать ссылку</button><span class="ep-sr" aria-live="polite" data-ep-copy-status></span></div></div><figure class="ep-cover"><img src="${a.image}" alt="${esc(a.imageAlt)}" width="1200" height="800" fetchpriority="high"><figcaption>Иллюстрация к материалу</figcaption></figure></div></section><div class="ep-reading ep-wrap"><aside class="ep-toc"><details open><summary>В этой статье</summary><nav aria-label="Оглавление статьи">${a.sections.map((s,i)=>`<a href="#${s.id}"><span>${String(i+1).padStart(2,'0')}</span>${esc(s.title)}</a>`).join('')}<a href="#checklist"><span>✓</span>Что подготовить</a><a href="#sources"><span>§</span>Правовые источники</a></nav></details></aside><article class="ep-prose"><aside class="ep-takeaway"><span class="ep-kicker">Главное по теме</span><p>${esc(a.takeaway)}</p></aside>${a.sections.map((s,i)=>`<section id="${s.id}" data-ep-section><div class="ep-section-number">${String(i+1).padStart(2,'0')}</div><h2>${esc(s.title)}</h2>${s.html}</section>${i===2&&a.inlineImage?`<figure class="ep-inline-art"><img src="${a.inlineImage}" alt="${esc(a.inlineImageAlt)}" width="1200" height="800" loading="lazy" decoding="async"><figcaption>Иллюстрация к материалу</figcaption></figure>`:''}`).join('')}<section id="checklist" data-ep-section class="ep-checklist"><span class="ep-kicker">Практический список</span><h2>Что подготовить для проверки ситуации</h2><ul>${a.checklist.map(s=>`<li>${esc(s)}</li>`).join('')}</ul></section><section id="sources" data-ep-section class="ep-sources"><h2>Правовые источники</h2><p>Использованы при подготовке редакции от ${date(config.section.modifiedAt)}. Для конкретного спора учитывается редакция нормы, применимая к соответствующему периоду.</p><ol>${a.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)} <span aria-hidden="true">↗</span></a>${s.note?`<p>${esc(s.note)}</p>`:''}</li>`).join('')}</ol></section><aside class="ep-services"><h2>Помощь по этой теме</h2>${a.relatedServices.map(s=>`<a href="${esc(s.url)}">${esc(s.title)} <span aria-hidden="true">↗</span></a>`).join('')}</aside></article></div><section class="ep-related ep-wrap"><div class="ep-section-head"><div><span class="ep-kicker">Продолжить чтение</span><h2>Связанные материалы</h2></div><a class="ep-text-link" href="/articles/">Все статьи ↗</a></div><div class="ep-grid">${related.map(b=>card(b)).join('')}</div></section>${contact()}</main>`;}

await fs.mkdir(path.join(web,'articles'),{recursive:true});
await fs.writeFile(path.join(web,'articles/index.html'),shell('Статьи и судебная практика для бизнеса — ЭЛЕГСО','Экспертные статьи о лизинге, защите бизнеса и судебных доказательствах. Проверенные источники, разборы ситуаций и практические списки документов.','/articles/',responsive(catalogue)));
for(const a of articles){await fs.mkdir(path.join(web,'articles',a.slug),{recursive:true});await fs.writeFile(path.join(web,'articles',a.slug,'index.html'),shell(a.seoTitle,a.description,a.url,responsive(articleBody(a)),a));}

function rss(summary=false){const url=summary?'/articles/announcements.xml':'/articles/rss.xml';return `<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="/assets/rss.xsl"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${esc(config.section.title)} — ЭЛЕГСО${summary?' — анонсы':''}</title><link>${origin}/articles/</link><description>Лизинг, защита бизнеса и судебные доказательства: материалы юридической компании ЭЛЕГСО.</description><language>ru-RU</language><copyright>ЮК «ЭЛЕГСО»</copyright><lastBuildDate>${new Date(config.section.modifiedAt).toUTCString()}</lastBuildDate><ttl>60</ttl><atom:link href="${origin+url}" rel="self" type="application/rss+xml"/>${articles.map(a=>{const body=summary?`<p>${esc(a.lead)}</p><p>${esc(a.takeaway)}</p><p><a href="${origin+a.url}">Читать полный разбор на сайте ЭЛЕГСО</a></p>`:`<p>${esc(a.lead)}</p><h2>Главное по теме</h2><p>${esc(a.takeaway)}</p><figure><img src="${origin+a.image}" alt="${esc(a.imageAlt)}"/></figure>${a.sections.map((s,i)=>`<h2>${esc(s.title)}</h2>${s.html}${i===2&&a.inlineImage?`<figure><img src="${origin+a.inlineImage}" alt="${esc(a.inlineImageAlt)}"/></figure>`:''}`).join('')}<h2>Что подготовить</h2><ul>${a.checklist.map(t=>`<li>${esc(t)}</li>`).join('')}</ul><h2>Правовые источники</h2><ul>${a.sources.map(s=>`<li><a href="${esc(s.url)}">${esc(s.title)}</a></li>`).join('')}</ul><h2>Помощь по этой теме</h2><ul>${a.relatedServices.map(s=>`<li><a href="${origin+s.url}">${esc(s.title)}</a></li>`).join('')}</ul><p><a href="${origin+a.url}">Актуальная версия статьи на сайте ЭЛЕГСО</a></p>`;const absolute=body.replace(/(href|src)="\/(?!\/)/g,`$1="${origin}/`);return `<item><title>${esc(a.title)}</title><link>${origin+a.url}</link><guid isPermaLink="true">${origin+a.url}</guid><pubDate>${new Date(config.section.publishedAt).toUTCString()}</pubDate><dc:creator>${esc(config.section.publisher)}</dc:creator><category>${esc(a.category)}</category><description>${esc(a.description)}</description><content:encoded>${cdata(absolute)}</content:encoded></item>`;}).join('')}</channel></rss>\n`;}
await fs.writeFile(path.join(web,'articles/rss.xml'),rss());
await fs.writeFile(path.join(web,'articles/announcements.xml'),rss(true));

const feed=JSON.parse(await fs.readFile(path.join(web,'api/getfeed/index.html'),'utf8'));
feed.feedtitle=config.section.title;
feed.posts=articles.map(a=>({uid:a.source.legacyUid,title:a.title,descr:a.description,text:'',url:a.url,directlink:a.url,directtarget:'',date:config.section.publishedAt,published:config.section.publishedAt,image:a.image,imagealt:a.imageAlt,thumb:a.image,postparts:[],stats:{views:0,likes:0}}));
await fs.writeFile(path.join(web,'api/getfeed/index.html'),JSON.stringify(feed)+'\n');
for(const route of config.migration.sourcePages){const file=path.join(web,route==='/'?'index.html':route.slice(1)+'index.html');let html=await fs.readFile(file,'utf8');
  const marker=/<!--elegso-publications:start-->[\s\S]*?<!--elegso-publications:end-->/;
  const selected=route==='/'?[articles[0],articles[3],articles[5]]:articles.slice(0,3);
  if(marker.test(html)) html=html.replace(marker,responsive(block(selected)));
  else {const feedMatch=html.match(/<div id="rec(?:1282040271|1345693691|1345701461)"/);if(!feedMatch) throw new Error('Old feed block missing: '+route);const next=html.indexOf('<div id="rec',feedMatch.index+1);if(next<0) throw new Error('Next block missing: '+route);html=html.slice(0,feedMatch.index)+responsive(block(selected))+html.slice(next);}
  html=html.replace(/<script\b[^>]*src="[^"]*tilda-feed-1\.1\.min\.js"[^>]*><\/script>/g,'');
  if(!html.includes('/assets/publications.css'))html=html.replace('</head>','<link rel="stylesheet" href="/assets/publications.css?v=20260909-1"></head>');
  await fs.writeFile(file,nav(html));
}
async function walk(dir){let out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.name==='_external'||e.name==='api')continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.name.endsWith('.html'))out.push(p);}return out;}
for(const file of await walk(web)){let old=await fs.readFile(file,'utf8');let updated=footerNav(nav(old));if(!updated.includes('type="application/rss+xml"'))updated=updated.replace('</head>','<link rel="alternate" type="application/rss+xml" title="Статьи и практика ЭЛЕГСО" href="/articles/rss.xml"></head>');if(updated!==old)await fs.writeFile(file,updated);}
for(const name of ['sitemap.xml','sitemap.base.xml']){const p=path.join(web,name);let sitemap;try{sitemap=await fs.readFile(p,'utf8')}catch{continue}const rows=[...sitemap.matchAll(/<url>[\s\S]*?<\/url>/g)].map(m=>m[0]).filter(r=>!r.includes('<loc>'+origin+'/articles/'));
  const changed=new Set(config.migration.sourcePages.map(p=>origin+p));
  for(let i=0;i<rows.length;i++){if([...changed].some(url=>rows[i].includes('<loc>'+url+'</loc>')))rows[i]=rows[i].replace(/<lastmod>[^<]+<\/lastmod>/,`<lastmod>${config.section.modifiedAt.slice(0,10)}</lastmod>`);}
  for(const url of ['/articles/',...articles.map(a=>a.url)]) rows.push(`<url><loc>${origin+url}</loc><lastmod>${config.section.modifiedAt.slice(0,10)}</lastmod></url>`);
  await fs.writeFile(p,'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+rows.join('\n')+'\n</urlset>\n');}
console.log(JSON.stringify({articles:articles.map(a=>({url:a.url,words:a.words,minutes:a.minutes})),rss:config.section.rss,sourceRegistry:'config/publications.json'},null,2));
