import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { footerCard, updateFooterCards, casesFooterRuntime, enhanceFooterDetails } from '../scripts/footer-cards.mjs';

const root=path.resolve(import.meta.dirname,'..');
test('three footer tiles share styles, grouped copy, local art and real actions',()=>{
  for(const kind of ['cases','articles','offers']){
    const html=footerCard(kind);
    assert.equal((html.match(new RegExp(`<!--elegso-${kind}-footer:start-->`,'g'))||[]).length,1);
    assert.match(html,/class="elegso-footer-tile__copy"><strong[^>]*>[^<]+<\/strong><span[^>]*>[^<]+<\/span><\/span>/);
    assert.match(html,/footer-cards\.css\?v=/);
    assert.match(html,/width="96" height="96"/);
    const image=html.match(/<img[^>]+src="([^"]+)"/)[1];
    assert.ok(fs.existsSync(path.join(root,'www',image)));
    assert.doesNotMatch(html,/href="https?:/);
  }
  assert.match(footerCard('cases'),/Смотреть дела/);
  assert.match(footerCard('articles'),/Читать статьи/);
  const offer=footerCard('offers');
  assert.equal((offer.match(/class="elegso-footer-tile__button"/g)||[]).length,2);
  assert.match(offer,/href="\/oferta\/">Оферта для бизнеса/);
  assert.match(offer,/href="\/oferta-fiz\/">Оферта для физических лиц/);
});
test('footer-only update preserves all surrounding bytes and is idempotent',()=>{
  const head='<html><head><meta property="article:modified_time" content="2020-01-01"><title>Текст</title></head><body><main>Текст статьи <footer>Подпись автора</footer></main>';
  const oldBody='<div id="rec1169591771">Старый текст и навигация</div>';
  const tail='<script>const x=1;</script></body></html>';
  const old=head+'<footer id="t-footer">'+footerCard('offers')+footerCard('articles')+oldBody+'</footer>'+tail;
  const next=updateFooterCards(old);
  assert.ok(next.startsWith(head));assert.ok(next.endsWith(tail));
  const withoutLegalMarker=next.replaceAll(' data-elegso-footer-legal','');
  assert.ok(withoutLegalMarker.includes(oldBody));
  const cleaned=withoutLegalMarker.replace(/<!--elegso-(?:cases|articles|offers)-footer:start-->[\s\S]*?<!--elegso-(?:cases|articles|offers)-footer:end-->/g,'').replace('<!--elegso-footer-featured:start--><div class="elegso-footer-featured"></div><!--elegso-footer-featured:end-->','');
  assert.equal(cleaned,head+'<footer id="t-footer">'+oldBody+'</footer>'+tail);
  assert.equal(updateFooterCards(next),next);
  assert.ok(next.indexOf('elegso-cases-footer:start')<next.indexOf('elegso-articles-footer:start'));
  assert.ok(next.indexOf('elegso-articles-footer:start')<next.indexOf('elegso-offers-footer:start'));
  for(const kind of ['cases','articles','offers'])assert.equal((next.match(new RegExp(`data-elegso-${kind}-footer`,'g'))||[]).length,1);
  assert.equal(updateFooterCards(head+tail),head+tail);
});
test('unknown or duplicate footer blocks fail closed',()=>{
  assert.throws(()=>updateFooterCards('<footer id="t-footer">'+footerCard('cases')+footerCard('cases')+'</footer>'),/Duplicate/);
  assert.throws(()=>updateFooterCards('<footer id="t-footer"><div data-elegso-articles-footer>legacy</div></footer>'),/Unmarked legacy/);
  assert.throws(()=>footerCard('offers',[{id:'business',url:'https://example.org/'}]),/Unsafe/);
});
test('service decoration preserves all service labels and URLs; legal label changes only at its known href',()=>{
  const sample='<div id="rec1169360821">'+['title','title2','title3','title4'].map((field,i)=>`<div class="t344__title t-name" field="${field}"><div>ГРУППА ${i}</div></div><ul><li><a href="/service-${i}/">Услуга ${i}</a></li></ul>`).join('')+'</div><div id="rec1169591771"><p>Юридический текст</p><a href="/offer_for_lawyer_20231103/">Информация</a> для исполнителей.</div>';
  const next=enhanceFooterDetails(sample);
  assert.equal((next.match(/class="elegso-footer-service-icon"/g)||[]).length,4);
  assert.equal(enhanceFooterDetails(next),next);
  for(let i=0;i<4;i++)assert.ok(next.includes(`<a href="/service-${i}/">Услуга ${i}</a>`));
  assert.match(next,/<p>Юридический текст<\/p>/);
  assert.match(next,/href="\/offer_for_lawyer_20231103\/">Присоединение исполнителей<\/a>/);
  assert.match(next,/data-elegso-footer-services/);assert.match(next,/data-elegso-footer-legal/);
});
test('runtime fallback matches static cards and does not duplicate an existing card',()=>{
  const migration=fs.readFileSync(path.join(root,'www/assets/migration.js'),'utf8');
  assert.ok(migration.includes(casesFooterRuntime()));
  let inserted='';let exists=false;
  const document={getElementById:()=>({querySelector:()=>exists,insertAdjacentHTML:(where,html)=>{assert.equal(where,'afterbegin');inserted=html;exists=true;}})};
  const run=new Function('document',casesFooterRuntime()+'; migrationInitCasesFooterCard();');
  run(document);assert.equal(inserted,footerCard('cases'));
  inserted='';run(document);assert.equal(inserted,'');
  const finalize=fs.readFileSync(path.join(root,'scripts/finalize-site.mjs'),'utf8');
  assert.ok(finalize.includes('${casesFooterRuntime()}'));
});
test('mobile actions remain visible and styles respect reduced motion and print',()=>{
  const css=fs.readFileSync(path.join(root,'www/assets/footer-cards.css'),'utf8');
  assert.match(css,/@media\(max-width:640px\)/);
  assert.match(css,/flex-direction:column/);
  assert.match(css,/background:#a04b38/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/@media print/);
  assert.doesNotMatch(css,/action-label[^}]*display:none/);
});
