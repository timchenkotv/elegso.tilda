import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../www/assets/cases.js',import.meta.url),'utf8');
const strip=source.slice(source.indexOf('  function initCaseStrip('),source.indexOf('  function initCarousel('));
const mod=(n,p)=>((n%p)+p)%p;
const near=(a,b)=>assert.ok(Math.abs(a-b)<.001,`${a} != ${b}`);

function fixture({widths=[218,257.25,218],width=580,reduced=false}={}){
  let now=100, frame, resize;
  class Element{
    constructor(width=0){this.width=width;this.attrs={};this.children=[];this.listeners={};this.classList={add(){},remove(){}};}
    addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    emit(type,fields={}){const e={type,button:0,pointerId:1,pointerType:'mouse',clientX:0,clientY:0,isPrimary:true,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...fields};for(const fn of this.listeners[type]??[])fn(e);return e;}
    setAttribute(k,v){this.attrs[k]=v;}
    removeAttribute(k){delete this.attrs[k];}
    cloneNode(){const e=new Element(this.width);e.attrs={...this.attrs};return e;}
    appendChild(e){if(e.fragment){for(const c of [...e.children])this.appendChild(c);}else{e.parent=this;this.children.push(e);}return e;}
    insertBefore(e,before){const children=e.fragment?e.children:[e];for(const c of children)c.parent=this;this.children.splice(this.children.indexOf(before),0,...children);}
    remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);}
    querySelectorAll(s){return this.children.filter(c=>s==='[data-case-jump]'||s==='[data-case-strip-copy]'&&'data-case-strip-copy' in c.attrs);}
    contains(e){return e===this||this.children.some(c=>c.contains(e));}
    setPointerCapture(id){this.capture=id;}
    hasPointerCapture(id){return this.capture===id;}
    releasePointerCapture(){this.capture=null;}
    blur(){document.activeElement=null;}
  }
  const track=new Element();
  const originals=widths.map(w=>{const e=new Element(w);e.attrs['data-case-jump']='';track.appendChild(e);return e;});
  const viewport=new Element();viewport.clientWidth=width;viewport.appendChild(track);
  viewport.querySelector=()=>track;
  let left=0;
  Object.defineProperty(viewport,'scrollWidth',{get:()=>track.children.reduce((n,e)=>n+e.width+12,6)-12});
  Object.defineProperty(viewport,'scrollLeft',{get:()=>left,set:n=>{left=Math.max(0,Math.min(viewport.scrollWidth-viewport.clientWidth,n));}});
  const pause=new Element(),prev=new Element(),next=new Element(),controls=new Element(),media=new Element();
  media.matches=reduced;
  const root={querySelector:s=>({'[data-case-strip]':viewport,'[data-case-strip-controls]':controls,'[data-case-strip-pause]':pause,'[data-case-strip-prev]':prev,'[data-case-strip-next]':next})[s]};
  const document={hidden:false,activeElement:null,createDocumentFragment(){const e=new Element();e.fragment=true;return e;}};
  const window=new Element();
  window.matchMedia=()=>media;
  window.getComputedStyle=e=>({columnGap:'12px',width:`${e.width}px`});
  window.requestAnimationFrame=fn=>{frame=fn;};
  const ResizeObserver=class{constructor(fn){resize=fn;}observe(){}};
  window.ResizeObserver=ResizeObserver;
  vm.runInNewContext(strip+';initCaseStrip(root)',{root,window,document,ResizeObserver,performance:{now:()=>now}});
  const tick=(ms=16)=>{now+=ms;frame(now);};
  const advance=ms=>{now+=ms;};
  const period=()=>originals.reduce((n,e)=>n+e.width+12,0);
  return {viewport,track,originals,pause,prev,next,media,window,document,tick,advance,resize:()=>resize(),period};
}

test('autoplay loops forward across multiple seams without reaching an edge',()=>{
  const f=fixture(),p=f.period();
  const origin=f.viewport.scrollLeft;
  f.tick();
  for(let i=0;i<16000;i++){
    const before=f.viewport.scrollLeft;f.tick();
    near(mod(f.viewport.scrollLeft-before,p),.288);
    assert.ok(f.viewport.scrollLeft>=origin&&f.viewport.scrollLeft<origin+p);
  }
});
test('arrows and large horizontal wheel gestures wrap in both directions',()=>{
  const f=fixture(),p=f.period(),base=f.viewport.scrollLeft;
  for(const sign of [1,-1])for(let i=0;i<30;i++){
    const before=f.viewport.scrollLeft;
    (sign>0?f.next:f.prev).emit('click');
    near(mod(f.viewport.scrollLeft-base,p),mod(before-base+sign*435,p));
  }
  const before=f.viewport.scrollLeft;
  assert.ok(f.viewport.emit('wheel',{deltaX:4*p+200,deltaY:0,deltaMode:0}).prevented);
  near(mod(f.viewport.scrollLeft-before,p),200);
  assert.ok(!f.viewport.emit('wheel',{deltaX:0,deltaY:100,deltaMode:0}).prevented);
});
test('fast drag outside viewport retains momentum even when a frame runs before release',()=>{
  const f=fixture();f.document.activeElement=f.originals[0];
  f.viewport.emit('pointerdown',{clientX:300});f.advance(20);
  f.window.emit('pointermove',{clientX:-300});
  f.tick(); // Regression: old implementation erased velocity here.
  f.window.emit('pointerup',{clientX:-300});
  assert.equal(f.document.activeElement,null);
  const before=f.viewport.scrollLeft;f.tick();
  assert.ok(mod(f.viewport.scrollLeft-before,f.period())>20);
  const click=f.viewport.emit('click');assert.ok(click.prevented&&click.stopped);
  f.viewport.emit('pointerdown',{clientX:30});f.window.emit('pointerup',{clientX:30});
  assert.ok(!f.viewport.emit('click').prevented,'fresh intentional click works immediately');
});
test('horizontal touch drag loops and vertical touch gestures remain page scrolling',()=>{
  const f=fixture(),p=f.period();let before=f.viewport.scrollLeft;
  f.viewport.emit('pointerdown',{pointerType:'touch',clientX:200,clientY:100});f.advance(20);
  assert.ok(f.window.emit('pointermove',{pointerType:'touch',clientX:-1800,clientY:101}).prevented);
  near(mod(f.viewport.scrollLeft-before,p),mod(2000,p));
  f.window.emit('pointerup',{pointerType:'touch'});
  before=f.viewport.scrollLeft;
  f.viewport.emit('pointerdown',{pointerType:'touch',clientX:200,clientY:100});
  assert.ok(!f.window.emit('pointermove',{pointerType:'touch',clientX:198,clientY:180}).prevented);
  near(f.viewport.scrollLeft,before);
});
test('pointer cancel and stale release stop momentum; reduced motion stops autoplay',()=>{
  for(const finish of ['pointercancel','lostpointercapture','stale']){
    const f=fixture();f.viewport.emit('pointerdown',{clientX:300});f.advance(20);f.window.emit('pointermove',{clientX:30});
    if(finish==='stale')f.advance(150);
    (finish==='lostpointercapture'?f.viewport:f.window).emit(finish==='stale'?'pointerup':finish);
    const before=f.viewport.scrollLeft;f.tick();f.tick();near(f.viewport.scrollLeft,before);
  }
  const f=fixture({reduced:true}),before=f.viewport.scrollLeft;
  for(let i=0;i<100;i++)f.tick();near(f.viewport.scrollLeft,before);
  f.next.emit('click');assert.notEqual(f.viewport.scrollLeft,before);
});
test('short lists fill a wide viewport and resized lists keep bounded, non-focusable copies',()=>{
  const f=fixture({widths:[218],width:900});
  assert.equal(f.track.children.length,9);
  assert.equal(f.track.querySelectorAll('[data-case-strip-copy]').filter(c=>c.attrs['tabindex']==='-1'&&c.attrs['aria-hidden']==='true').length,8);
  f.viewport.clientWidth=300;f.resize();assert.equal(f.track.children.length,5);
  f.originals[0].width=400;f.resize();assert.equal(f.track.children.length,3);
  for(let i=0;i<20;i++)f.resize();assert.equal(f.track.children.length,3);
  assert.ok(f.viewport.scrollWidth-f.viewport.scrollLeft>=f.viewport.clientWidth);
});
test('search navigation is delegated so cloned tiles reveal filtered cards',()=>{
  assert.match(source,/root\.addEventListener\("click",[\s\S]*?event\.target\.closest\("\[data-case-jump\]"\)/);
  assert.match(source,/if \(target\.hidden\) \{[\s\S]*?input\.value = "";[\s\S]*?apply\(\);/);
});
