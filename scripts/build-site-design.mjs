import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {siteHeader, siteFooter, designHead, experienceBlock, directionCards, expertBlock, serviceGroups} from './site-shell.mjs';
import {loadPrivacyBuild, applyPrivacyAnalytics} from './privacy-analytics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const e = s => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const plain = html => String(html ?? '').replace(/<!--[^]*?-->/g,' ').replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|ndash|mdash|hellip|copy|reg|laquo|raquo|shy);/gi,(all,n)=>n[0]==='#'?(n[1].toLowerCase()==='x'?String.fromCodePoint(parseInt(n.slice(2),16)):String.fromCodePoint(parseInt(n.slice(1),10))):({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',hellip:'…',copy:'©',reg:'®',laquo:'«',raquo:'»',shy:''}[n.toLowerCase()]??all));
const textKey = value => plain(value).replace(/[\s\u200b\u00ad]+/gu,'');
const compactNames = {
 leasing_lawyer:'Юрист по лизингу', termination_of_the_lease_agreement:'Расторжение лизинга',
 contract_modification:'Изменение договора', reduction_of_the_penalty_amount:'Снижение неустойки',
 refund_of_the_penalty:'Возврат неустойки', restoring_the_contract:'Восстановление договора',
 representation_in_the_arbitration_court:'Представительство в суде',
 calculator_of_the_balance_of_counter_obligations_in_leasing:'Калькулятор сальдо',
 home:'Юридическое сопровождение бизнеса', arbitration_lawyer:'Арбитражный юрист', trial_lawyer:'Юрист в арбитражный суд',
 judicial_protection:'Судебная защита', appeal_of_judicial_acts:'Обжалование судебных актов', cancellation_of_the_court_order:'Отмена судебного приказа',
 collect_the_debt:'Взыскание задолженности', contract_drafting_service:'Юрист по договорам', drafting_an_agreement:'Составление договора',
 termination_and_restoration_of_contracts:'Расторжение и восстановление договоров', property_law:'Имущественные споры', accident_lawyer:'Юрист по ДТП',
 mission:'О компании', our_team:'Команда и правовая стратегия', contacts:'Контакты',
};
const briefs = {
 leasing_lawyer:{tagline:'Защищаем ваши деньги\nи предмет лизинга',lead:'Снижаем завышенные требования. Возвращаем причитающиеся платежи и изъятую технику. Выстраиваем правовую стратегию на основе экономики вашего договора.',image:'leasing-hero'},
 termination_of_the_lease_agreement:{tagline:'Расторгнуть договор.\nУменьшить финансовые последствия.',lead:'Применяем нашу методику выхода из лизинга: готовим правовую позицию, порядок действий и взаиморасчёты, чтобы максимально уменьшить финансовые последствия расторжения.',image:'leasing-balance'},
 contract_modification:{tagline:'Меняем условия.\nСохраняем возможности бизнеса.',lead:'Готовим предложения по графику и размеру платежей, ведём переговоры с лизингодателем и юридически оформляем согласованные изменения.',image:'leasing-hero'},
 reduction_of_the_penalty_amount:{tagline:'Не каждое начисление\nнужно принимать.',lead:'Проверяем неустойку, штрафы и расчёт требований. Формируем доказательную позицию для снижения финансовой нагрузки.',image:'leasing-balance'},
 refund_of_the_penalty:{tagline:'Переплату можно\nоспорить и вернуть.',lead:'Анализируем основания начисления и оплаты неустойки, собираем доказательства и представляем ваши интересы.',image:'leasing-balance'},
 restoring_the_contract:{tagline:'Защищаем договорные\nотношения.',lead:'Проверяем обстоятельства прекращения договора, правовые основания восстановления и способы защиты ваших интересов.',image:'leasing-hero'},
 representation_in_the_arbitration_court:{tagline:'От доказательств —\nк правовой стратегии.',lead:'Документы, экономический анализ, процессуальная позиция и представительство интересов бизнеса в арбитражном суде.',image:'leasing-balance'},
 calculator_of_the_balance_of_counter_obligations_in_leasing:{tagline:'Сначала точный расчёт.\nЗатем сильная позиция.',lead:'Оцените взаимные предоставления сторон и завершающую обязанность по договору выкупного лизинга. Данные остаются в вашем браузере.',image:'leasing-balance'},
};
const contextual = {
 home:['Сложные споры. Сильная правовая стратегия.','Юридический анализ, экономический расчёт и судебная защита бизнеса.','architecture-hero'],
 arbitration_lawyer:['Экономический спор требует точной стратегии.','Изучаем документы, восстанавливаем расчёты и выстраиваем доказательную позицию в арбитражном процессе.','contract-card'],
 trial_lawyer:['Сильная позиция — в доказанных деталях.','Готовим процессуальные документы и представляем интересы в экономических спорах.','architecture-hero'],
 judicial_protection:['Защита имущественных интересов на каждом этапе.','От анализа требований до представительства в суде и работы с судебными актами.','architecture-hero'],
 appeal_of_judicial_acts:['Проверяем решение. Определяем основания обжалования.','Разбираем мотивировку судебного акта, процессуальные обстоятельства и допустимые доводы жалобы.','contract-card'],
 cancellation_of_the_court_order:['Своевременная реакция на судебное взыскание.','Исследуем приказ, извещение и обстоятельства обращения за судебной защитой.','contract-card'],
 collect_the_debt:['Доказываем происхождение долга, а не только остаток.','Восстанавливаем начисления и оплаты, проверяем основания требований и готовим правовую позицию.','leasing-balance'],
 contract_drafting_service:['Условия, которые работают в реальной сделке.','Подготовка, проверка и сопровождение договоров с учётом денег, исполнения и юридических рисков.','contract-card'],
 drafting_an_agreement:['Точные обязательства. Понятный порядок исполнения.','Связываем условия договора с действительной целью сделки и фактической работой сторон.','contract-card'],
 termination_and_restoration_of_contracts:['Управляем правовыми последствиями изменения отношений.','Исследуем основания прекращения обязательств, взаиморасчёты и доступные способы защиты.','leasing-balance'],
 property_law:['Правовая защита того, что имеет ценность.','Исследуем права на имущество, обстоятельства владения, расчёты и доказательства нарушения.','architecture-hero'],
 accident_lawyer:['После аварии важны документы и точный расчёт.','Правовая помощь при спорах об ущербе, страховом возмещении и ответственности участников ДТП.','leasing-assets'],
 mission:['Право. Экономика. Стратегия.','Принципы, на которых строится работа юридической компании ЭЛЕГСО.','architecture-hero'],
 our_team:['За позицией — личная ответственность и работа команды.','Правовой, экономический, технический и процессуальный подходы к сложным спорам.','architecture-hero'],
 contacts:['Обсудим вашу задачу.','Выберите удобный способ связи, расскажите о споре и ближайших процессуальных сроках.','contract-card'],
};
export function renderPage(page, privacyBuild) {
 page={...page,records:page.records||[],hero:{cards:[],...(page.hero||{})}};
 page.hero.cards=page.hero.cards||[];
 const local=route=>String(route||'/').replace(/^https?:\/\/(?:www\.)?elegso\.ru(?=\/|$)/i,'')||'/';
 const asset = name=>'/assets/redesign/'+name;
 const used=new Set();
 const wholerecords=new Set();
 const sourceKey=(r,i)=>r.id+':'+i;
 function field(r,f,tag='div',cls=''){
  if(!f)return '';
  if(tag==='p'&&/<(?:div|p|ul|ol|h[1-6])\b/i.test(f.html))tag='div';
  let i=r.fields.findIndex((v,j)=>v.field===f.field&&v.text===f.text&&!used.has(sourceKey(r,j)));
  if(i<0)i=r.fields.findIndex(v=>v.field===f.field&&v.text===f.text);
  if(i<0)throw Error('Unknown source field '+r.id+' '+f.text);
  const key=sourceKey(r,i);used.add(key);
  return `<${tag} class="source-field ${e(f.kind==='button'?'source-button':f.kind)} ${e(cls)}" data-source-key="${e(key)}">${remap(f.html ?? e(f.text))}</${tag}>`;
 }
 function remaining(r){return r.fields.map((f,i)=>used.has(sourceKey(r,i))?'':field(r,f)).join('');}
 function extra(r){return r.uncovered?.length?`<div class="source-extra">${r.uncovered.map(s=>`<span data-source-extra>${e(s)}</span>`).join(' ')}</div>`:'';}
 function remap(html){
  return html.replace(/href="([^"]*)"/g,(all,raw)=>{
   let href=local(raw.replaceAll('&amp;','&'));
   if(href.startsWith('#popup:')){
    const target=page.records.find(r=>r.popupHook===href);
    href=target?'#'+target.id:'#contact';
   }else if(/^#(?:rec\d+|elegso-contact)/.test(href)){
    if(!page.records.some(r=>href==='#'+r.id))href='#contact';
   }else if(href==='#submenu:service')href='#services';
   else if(['#order','#zakhvat','#popup:zakhvat','#send_a_request'].includes(href))href='#contact';
   else if(href.startsWith('/'))href=local(href);
   else if(href.startsWith('https://elegso.ru/'))href=local(href.slice('https://elegso.ru'.length));
   return `href="${e(href)}"${/^https?:/.test(href)?' target="_blank" rel="noopener"':''}`;
  });
 }
 function whole(r){
  wholerecords.add(r.id);
  let html=remap(r.html||'');
  if(r.type==='publications'){
   for(const img of r.images||[]){
    if(!img.src||html.includes(img.src))continue;
    html=html.replace(/(<a\b[^>]*>)\s*<\/a>/i,`$1<img src="${e(img.src)}" alt="${e(img.alt||'Иллюстрация к юридическому разбору')}" width="${e(img.width||1200)}" height="${e(img.height||800)}" loading="lazy"></a>`);
   }
  }
  const originalText=textKey(html);
  const supplements=r.fields.filter(f=>textKey(f.text)&&!originalText.includes(textKey(f.text))).map(f=>field(r,f)).join('')
   +(r.uncovered||[]).filter(s=>textKey(s)&&!originalText.includes(textKey(s))).map(s=>`<span data-source-extra>${e(s)}</span>`).join(' ');
  return `<div class="source-fragment" data-source-whole="${e(r.id)}">${html}${supplements}</div>`;
 }
 function recordRest(r){return `<div class="record-rest">${remaining(r)}${extra(r)}</div>`;}
 const arrow='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7"/></svg>';
 const phoneIcon='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 3-3 2c-2 2 1 7 4 10s8 6 10 4l2-3-5-3-2 2-4-4 2-2z"/></svg>';
 const mailIcon='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v12H3zM3 6l9 7 9-7"/></svg>';
 const main=page.slug==='leasing_lawyer';
 const isLeasing=Object.hasOwn(briefs,page.slug);
 const serviceGroup=serviceGroups.find(g=>g.url===page.route||g.items.some(([,url])=>url===page.route));
 const calc=page.slug==='calculator_of_the_balance_of_counter_obligations_in_leasing';
 const context=contextual[page.slug]||['Правовая позиция начинается с анализа.',page.description||'Исследуем документы и выстраиваем стратегию защиты.',serviceGroup?.image||'architecture-hero'];
 const brief=briefs[page.slug]||{tagline:context[0],lead:context[1],image:context[2]};
 const heroRecord=page.records.find(r=>r.id===page.hero.recordId)||page.records.find(r=>r.fields.some(f=>f.kind==='heading'))||page.records.find(r=>r.type!=='702')||{id:'page-hero',fields:[],uncovered:[],items:[],images:[]};
 const heroTitle=heroRecord.fields.find(f=>f.kind==='heading');
 const heroIntro=heroRecord.fields.find(f=>page.hero.intro&&f.field===page.hero.intro.field&&f.text===page.hero.intro.text&&f!==heroTitle);
 const heroButtons=heroRecord.fields.filter(f=>f.kind==='button');
 const header=siteHeader();
 const hero=`<section class="hero" id="${heroRecord.id}"><div class="hero-scene" data-hero-scene aria-hidden="true"><div class="hero-scene__image"></div><div class="hero-scene__light"></div><canvas class="hero-scene__dust"></canvas></div><div class="container"><div class="breadcrumb"><a href="/">Главная</a><span>/</span><span>${e(compactNames[page.slug]||page.heading||page.title)}</span></div><div class="hero-grid"><div class="hero-copy"><p class="hero-kicker">Право · Экономика · Стратегия</p>${heroTitle?field(heroRecord,heroTitle,'h1'):`<h1>${e(page.heading||page.hero.heading||compactNames[page.slug]||page.title)}</h1>`}<p class="hero-tagline">${brief.tagline.replace('\n',' ')}</p><p class="hero-lead">${e(brief.lead)}</p><div class="hero-actions"><a class="button button--wine" href="#contact">${heroButtons[0]?field(heroRecord,heroButtons[0],'span'):'Обсудить задачу'} ${arrow}</a><a class="text-link" href="${isLeasing?(calc?'#rec1164640016':'/calculator_of_the_balance_of_counter_obligations_in_leasing/'):'/cases/'}">${heroButtons[1]?field(heroRecord,heroButtons[1],'span'):isLeasing?'Рассчитать сальдо':'Успешный опыт'} ${arrow}</a></div><ul class="hero-benefits">${isLeasing?'<li>Для лизингополучателей</li><li>По всей России</li><li>Первая консультация бесплатно</li>':'<li>Правовая стратегия</li><li>Экономический анализ</li><li>Судебная защита</li>'}</ul><p class="hero-caption">Продуманные решения<br>для устойчивого результата</p></div><aside class="hero-rail" aria-hidden="true"><span>Право</span><span>Экономика</span><span>Стратегия</span><span>Результат</span></aside><button class="motion-toggle" data-motion-toggle aria-pressed="true" title="Включить или выключить движение сцены"><span data-motion-label>Движение: вкл.</span><span aria-hidden="true">Ⅱ</span></button><div class="hero-art"><picture><source media="(max-width:767px)" srcset="${asset(brief.image+'-720.webp')}"><img src="${asset(brief.image+'.webp')}" alt="${brief.image==='leasing-hero'?'Автомобиль и грузовой тягач на архитектурных платформах из зелёного камня':'Архитектура правовой стратегии ЭЛЕГСО: зелёный камень, металл и свет'}" width="${brief.image==='leasing-hero'?'1122':'1672'}" height="${brief.image==='leasing-hero'?'1402':'941'}" fetchpriority="high"></picture><span class="art-label">ЭЛЕГСО / Архитектура правовой стратегии</span></div></div><div class="hero-bottom"><span>Сложные споры. Сильная правовая стратегия.</span><span>Защита имущественных интересов бизнеса</span></div></div></section>`;
 const tabs=`<nav class="page-tabs" aria-label="Разделы страницы"><div class="container page-tabs__inner"><a href="#outcomes">Ваш результат</a><a href="#services">Услуги</a><a href="#experience">Успешный опыт</a><a href="#approach">Наш подход</a>${page.records.some(r=>r.type==='576')?'<a href="#process">Порядок работы</a>':''}${page.records.some(r=>r.type==='681')?'<a href="#prices">Стоимость</a>':''}${page.records.some(r=>r.type==='665')?'<a href="#questions">Вопросы и ответы</a>':''}<a class="tabs-action" href="#contact">Связаться ${arrow}</a></div></nav>`;
 const outcomes=[
  ['Помогаем расторгнуть договор лизинга','Применяем нашу методику выхода из договора и добиваемся максимально возможного уменьшения финансовых последствий.','/termination_of_the_lease_agreement/','Расторгнуть договор'],
  ['Снижаем неустойку и штрафы','Проверяем начисления, оспариваем завышенные санкции и добиваемся снижения финансовой нагрузки.','/reduction_of_the_penalty_amount/','Снизить неустойку'],
  ['Уменьшаем сумму требований','Пересчитываем взаимные обязательства, проверяем расходы и стоимость возвращённой техники.','/representation_in_the_arbitration_court/','Оспорить расчёт'],
  ['Возвращаем аванс и платежи','Взыскиваем сумму, причитающуюся вам по расчёту сальдо после расторжения лизинга.','/leasing_lawyer/#rec1166269041','Вернуть деньги'],
  ['Возвращаем изъятую технику','Оспариваем неправомерное изъятие и расторжение. Защищаем возможность вернуть предмет лизинга.','/leasing_lawyer/#asset-return','Вернуть предмет лизинга'],
  ['Добиваемся уменьшения платежей','По нашей методике готовим предложения лизингодателю об изменении финансовых условий и графика.','/contract_modification/','Изменить условия'],
 ];
 const results=`<section class="section section--paper" id="outcomes"><div class="container"><div class="split-heading"><div class="section-heading"><p class="eyebrow">Начнём с вашей задачи</p><h2 class="section-title">Выберите вашу задачу.</h2></div><p class="section-intro">У лизингового спора есть экономическая цель. Выберите вашу — покажем, как строится защита и на чём основана позиция.</p></div><div class="outcome-grid">${outcomes.map((v,i)=>`<article class="outcome-card"><a class="outcome-media" href="${local(v[2])}" aria-label="${e(v[0])}"><img src="${asset(['contract-card','reduction-card','architecture-hero','leasing-balance','leasing-hero','leasing-assets'][i]+'-720.webp')}" alt="" width="720" height="450" loading="lazy"></a><span class="outcome-number">0${i+1}</span><h3 class="outcome-title">${e(v[0])}</h3><details class="outcome-details"><summary>Подробнее о задаче</summary><p class="outcome-copy">${e(v[1])}</p></details><a class="outcome-link" href="${local(v[2])}">${e(v[3])} ${arrow}</a></article>`).join('')}</div><p class="outcomes-note">Возврат денег определяется итоговым сальдо. Изменение платежей согласовывается с лизингодателем.</p></div></section>`;
 const proof=experienceBlock('all');
 const related=isLeasing?Object.keys(briefs).filter(slug=>slug!=='leasing_lawyer').map(slug=>[compactNames[slug],'/'+slug+'/']):serviceGroup?.items||serviceGroups.map(g=>[g.title,g.url]);
 const servicesNav=`<section class="section section--white" id="services"><div class="container"><div class="split-heading"><div class="section-heading"><p class="eyebrow">${isLeasing?'Лизинговая практика':e(serviceGroup?.title||'Юридическая помощь')}</p><h2 class="section-title">Выберите следующий шаг.</h2></div><p class="section-intro">${isLeasing?'Каждая задача — отдельный маршрут: от анализа договора и расчёта до переговоров и судебной защиты.':'Подробные направления работы, способы защиты и правовая информация — на отдельных страницах.'}</p></div>${isLeasing?`<img class="services-illustration" src="${asset('leasing-assets.webp')}" alt="Легковой автомобиль, грузовой тягач и спецтехника под защитой правовой стратегии" width="1672" height="941" loading="lazy">`:''}<div class="route-grid">${related.map(([title,url],i)=>`<a class="route-card ${url===page.route?'is-active':''}" href="${e(url)}"><img class="route-card-art" src="${asset((isLeasing?['contract-card','leasing-assets','reduction-card','leasing-balance','architecture-hero','contract-card','leasing-balance'][i%7]:serviceGroup?.image||serviceGroups[i%serviceGroups.length].image)+'-720.webp')}" alt="" width="720" height="450" loading="lazy"><span class="route-number">${String(i+1).padStart(2,'0')}</span><span>${e(title)}</span>${arrow}</a>`).join('')}</div></div></section>`;
 const intro=`<section class="section section--paper" id="approach"><div class="container"><div class="original-intro"><div class="section-heading"><p class="eyebrow">${isLeasing?'Ваш договор — в деталях':'Содержание и детали'}</p><h2 class="section-title">${main?'Знаем логику спора.<br>Видим экономику сделки.':page.slug==='contacts'?'Адрес, связь<br>и реквизиты.':page.slug==='mission'?'Принципы нашей работы.':page.slug==='our_team'?'Стратегия и личное участие.':'Правовая позиция<br>начинается с анализа.'}</h2><div class="expand-toolbar"><button class="text-link" type="button" data-expand-all>Развернуть все подробности</button><button class="text-link" type="button" data-print>Распечатать страницу</button></div></div><div class="prose">${heroIntro?field(heroRecord,heroIntro):''}</div></div>${page.hero.cards.map(c=>c.text.match(/Внимание:[\s\S]*/)?.[0]).filter(Boolean).map(t=>`<aside class="warning-note">${e(t)}</aside>`).join('')}<div class="services-grid hero-original-cards">${page.hero.cards.map((c,i)=>{const h=c.fields.find(f=>f.kind==='heading'||f.kind==='subheading');const b=c.fields.filter(f=>f!==h);return `<article class="service-card" ${main&&i===0?'id="asset-return"':''}><div class="service-card__top"><span class="service-card__number">${String(i+1).padStart(2,'0')}</span>${h?field(heroRecord,h,'h3'):''}</div><div class="service-card__body">${i>=4?b.map(f=>field(heroRecord,f)).join(''):`<details ${i===0?'open':''}><summary>Развернуть полное описание</summary><div class="source-fragment">${b.map(f=>field(heroRecord,f)).join('')}</div></details>`}</div></article>`}).join('')}</div>${recordRest(heroRecord)}</div></section>`;
 let pending='';let originals='';
 const section=(r,body,cls='section--white',id='')=>`<section class="section record-section ${cls}" ${id?'id="'+id+'"':''}><div class="container"><div class="source-record" id="${r.id}" data-record-type="${r.type}">${pending}${body}</div></div></section>`;
 for(const r of page.records){
  if(r===heroRecord||r.type==='702')continue;
  if(r.type==='795'){
   pending+=`<div class="section-heading" id="${r.id}">${r.fields.map(f=>field(r,f,'h2','section-title')).join('')}${extra(r)}</div>`;continue;
  }
  let body='',theme='section--white',id='';
  if(r.type==='665'){
   id='questions';theme='section--paper';
   body=`<div class="faq-list">${r.items.map((item,i)=>`<details class="faq-item" ${i===0?'open':''}><summary><span class="faq-speaker">${field(r,item.fields[0],'span')}</span>${field(r,item.fields[1],'span')}</summary><div class="disclosure-content">${item.fields.slice(2).map(f=>field(r,f)).join('')}</div></details>`).join('')}</div>${recordRest(r)}`;
  }else if(r.type==='681'){
   id='prices';
   body=`<div class="price-grid">${r.items.map((item,i)=>`<article class="price-card">${item.fields.filter(f=>f.kind==='heading'||f.kind==='subheading').map(f=>field(r,f,'h3')).join('')}${item.fields.filter(f=>f.kind==='price').map(f=>field(r,f,'div','price-card__price'))}<details><summary>Что входит в услугу</summary><div class="source-fragment">${item.fields.filter(f=>!['heading','subheading','price'].includes(f.kind)).map(f=>field(r,f)).join('')}</div></details></article>`).join('')}</div>${recordRest(r)}`;
  }else if(r.type==='576'){
   id='process';theme='section--paper';
   body=`<div class="steps-grid">${r.items.map((item,i)=>`<article class="step-card"><span class="step-number">${String(i+1).padStart(2,'0')}</span>${item.fields.filter(f=>f.kind!=='body').map(f=>field(r,f,'h3')).join('')}<details ${i===0?'open':''}><summary>Подробнее об этапе</summary><div class="source-fragment">${item.fields.filter(f=>f.kind==='body').map(f=>field(r,f)).join('')}</div></details></article>`).join('')}</div>${recordRest(r)}`;
  }else if(r.type==='938'){
   theme='section--white';
   const heading=r.fields.find(f=>f.kind==='heading');
   body=`${heading?field(r,heading,'h2','section-title'):''}<div class="record-grid">${r.items.map(item=>`<article class="record-card">${item.fields.filter(f=>f.kind==='heading'||f.kind==='subheading').map(f=>field(r,f,'h3')).join('')}<details class="disclosure"><summary>Развернуть подробности<span class="disclosure-label">Полный текст о нашем подходе</span></summary><div class="disclosure-content source-fragment">${item.fields.filter(f=>f.kind==='body').map(f=>field(r,f)).join('')}</div></details></article>`).join('')}</div>${recordRest(r)}`;
  }else if(r.type==='856'){
   const buttons=r.fields.filter(f=>f.kind==='button');
   body=`<div class="record-grid">${r.items.map((item,i)=>`<article class="record-card">${item.fields.filter(f=>f.kind!=='body').map(f=>field(r,f,'h3')).join('')}<div class="source-fragment">${item.fields.filter(f=>f.kind==='body').map(f=>field(r,f)).join('')}</div>${buttons[i]?`<a class="text-link" href="${remap('<a href="'+(item.link||'#contact')+'">').match(/href="([^"]+)/)?.[1]||'#contact'}">${field(r,buttons[i],'span')} ${arrow}</a>`:''}</article>`).join('')}</div>${recordRest(r)}`;
  }else if(r.type==='750'){
   const heading=r.fields[0];
   body=`<details class="detail-service disclosure"><summary>${field(r,heading,'span')}<span class="disclosure-label">Развернуть описание услуги</span></summary><div class="disclosure-content prose">${r.fields.slice(1).filter(f=>f.kind!=='button').map(f=>field(r,f)).join('')}<div class="detail-service-actions">${r.fields.filter(f=>f.kind==='button').map(f=>`<a class="text-link" href="${f.text==='Назад'?'#services':'#contact'}">${field(r,f,'span')}</a>`).join('')}</div></div></details>${extra(r)}`;
  }else if(r.type==='1051'){
   theme='section--paper';
   body=`<div class="stats-grid">${r.items.map(item=>`<div class="stat">${item.fields.map((f,i)=>field(r,f,'div',i===0?'stat-value':'stat-label')).join('')}</div>`).join('')}</div>${recordRest(r)}`;
  }else if(r.type==='595'){
   body=`<div class="section-heading">${r.fields.map(f=>field(r,f,f.kind==='heading'?'h2':'p',f.kind==='heading'?'section-title':'section-intro')).join('')}</div><div class="practice-logos">${(r.images||[]).filter(img=>img.src).map(img=>`<img src="${e(img.src)}" loading="lazy" alt="${e(img.alt||'Компания — участник практики')}" width="${e(img.width||160)}" height="${e(img.height||70)}">`).join('')}</div>${recordRest(r)}`;
  }else if(r.type==='677'){
   theme='section--paper';
   body=`<div class="prose">${r.fields.map(f=>field(r,f,f.kind==='heading'?'h2':'div',f.kind==='heading'?'section-title':'')).join('')}</div>${extra(r)}`;
  }else if(r.type==='publications'){
   theme='section--paper';
   // Keep the complete original article preview, including descriptions and reading times.
   body=`<!--elegso-publications:start-->${whole(r)}<!--elegso-publications:end-->`;
  }else if(r.type==='678'&&calc){
   body=`<div class="calculator-wrap"><div class="calculator-preview"><div class="t678"></div></div><details class="disclosure"><summary>Развернуть исходные пояснения к калькулятору</summary><div class="disclosure-content">${whole(r)}</div></details></div>`;
  }else body=whole(r);
  originals+=section(r,body,theme,id);pending='';
 }
 if(pending)originals+=`<section class="section section--paper"><div class="container">${pending}</div></section>`;
 const band=`<section class="illustrated-band section--green"><div class="container band-grid"><div class="band-copy"><p class="eyebrow">Экономика лизинга</p><h2>Чей расчёт точнее —<br>у того сильнее позиция.</h2><p>Проверьте взаимные предоставления сторон. Калькулятор помогает увидеть структуру сальдо и подготовить данные для профессионального анализа.</p><a class="button button--light" href="${local('/calculator_of_the_balance_of_counter_obligations_in_leasing/')}">Открыть калькулятор ${arrow}</a></div><div class="band-art"><img src="${asset('leasing-balance.webp')}" alt="Баланс документов и стоимости имущества на весах" width="1672" height="941" loading="lazy"></div></div></section>`;
 const expert=page.slug==='our_team'?'':expertBlock();
 const originalContact=page.records.filter(r=>r.type==='702').map(r=>`<div id="${e(r.id)}" data-record-type="702">${whole(r)}</div>`).join('');
 const footer=siteFooter({originalContact});
 const missing=[];
 for(const r of page.records){if(wholerecords.has(r.id))continue;for(let i=0;i<r.fields.length;i++)if(!used.has(sourceKey(r,i)))missing.push(sourceKey(r,i));}
 if(missing.length)throw Error('Unrendered original fields '+page.slug+': '+missing.join(','));
 const body=`<body class="t-body elegso-redesign" data-page="${e(page.slug)}"><a class="skip-link" href="#main">К содержанию</a><div id="allrecords" class="t-records site-shell" data-tilda-project-id="3964517" data-tilda-cookie="no">${header}<main id="main">${hero}${tabs}${isLeasing?results:directionCards()}${proof}${servicesNav}${intro}${isLeasing&&!calc?band:''}${originals}${expert}</main>${footer}</div></body></html>`;
 const calculatorAssets=calc?'<link rel="stylesheet" href="/assets/lease-balance-calculator.css"><script src="/assets/lease-balance-calculator.js" defer></script>':'';
 let html=designHead({title:page.title,description:page.description,route:page.route,schemas:page.schemas||[],verification:page.verification||[],extras:calculatorAssets})+body;
 if(privacyBuild)html=applyPrivacyAnalytics(html,privacyBuild);
 const renderedText=textKey(html),missingText=[],missingExtras=[];
 for(const r of page.records){
  for(const [i,f]of r.fields.entries())if(textKey(f.text)&&!renderedText.includes(textKey(f.text)))missingText.push(sourceKey(r,i));
  for(const [i,value]of(r.uncovered||[]).entries())if(textKey(value)&&!renderedText.includes(textKey(value)))missingExtras.push(r.id+':'+i);
 }
 if(missingText.length||missingExtras.length)throw Error('Missing original text '+page.route+': '+JSON.stringify({missingText,missingExtras}));
 const h1Count=(html.match(/<h1\b/gi)||[]).length;
 if(h1Count!==1)throw Error('Expected one H1 on '+page.route+'; found '+h1Count);
 const originalFields=page.records.reduce((sum,r)=>sum+r.fields.length,0);
 const renderedFields=page.records.reduce((sum,r)=>sum+(wholerecords.has(r.id)?r.fields.length:r.fields.filter((f,i)=>used.has(sourceKey(r,i))).length),0);
 return {html,audit:{route:page.route,file:page.route==='/'?'index.html':page.route.replace(/^\//,'')+'index.html',sourceHtmlSha256:page.sourceHtmlSha256,sourceContentSha256:page.sourceContent?.sha256,originalFields,renderedFields,wholeRecords:[...wholerecords],missingFields:missing,missingText,missingExtras,h1Count,htmlSha256:hash(html),htmlBytes:Buffer.byteLength(html)}};
}
export async function buildSite(root=projectRoot){
 const out=path.join(root,'www');
 const content=JSON.parse(fs.readFileSync(path.join(root,'content/site-pages.json'),'utf8'));
 if(!Array.isArray(content.pages)||!content.pages.length)throw Error('No source pages in content/site-pages.json');
 const privacyBuild=await loadPrivacyBuild(root);
 // Complete render and source-content audit before writing the first page.
 const rendered=content.pages.map(page=>renderPage(page,privacyBuild));
 for(const {html,audit}of rendered){
  const filename=path.join(out,audit.file);
  if(!filename.startsWith(out+path.sep))throw Error('Unsafe output route: '+audit.route);
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  fs.writeFileSync(filename,html);
 }
 const report={format:'elegso-redesign-content-audit-v1',generatedAt:new Date().toISOString(),source:'content/site-pages.json',pageCount:rendered.length,sourceContentPreserved:true,analytics:'existing-consent-based-yandex',pages:rendered.map(p=>p.audit)};
 fs.mkdirSync(path.join(root,'reports'),{recursive:true});
 fs.writeFileSync(path.join(root,'reports/redesign-build.json'),JSON.stringify(report,null,2)+'\n');
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const index=process.argv.indexOf('--root');
 if(index>=0&&(!process.argv[index+1]||process.argv[index+1].startsWith('--')))throw Error('--root requires a directory');
 const report=await buildSite(path.resolve(index>=0?process.argv[index+1]:projectRoot));
 console.log(JSON.stringify({pages:report.pageCount,report:'reports/redesign-build.json',originalFields:report.pages.reduce((sum,p)=>sum+p.originalFields,0),sourceContentPreserved:true},null,2));
}
