import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scriptPath=path.join(root,'www/assets/redesign/logo-showcase.js');
const cssPath=path.join(root,'www/assets/redesign/logo-showcase.css');

function harness({fine=true,reduced=false,brandPresent=true,width=1440,height=900}={}){
 let now=0,nextId=1;
 const timers=new Map(),frames=new Map(),created=[];
 let document;
 class El {
  constructor(tag='div'){
   this.tagName=tag.toUpperCase();this.attrs={};this.children=[];this.parentElement=null;this.listeners=new Map();this.hidden=false;this.inert=false;this._text='';this._class='';this.isConnected=false;
   const names=new Set();
   this.classList={add:(...xs)=>{xs.forEach(x=>names.add(x));this._class=[...names].join(' ');},remove:(...xs)=>{xs.forEach(x=>names.delete(x));this._class=[...names].join(' ');},contains:x=>names.has(x),toggle:(x,force)=>{const on=force===undefined?!names.has(x):force;on?this.classList.add(x):this.classList.remove(x);return on;},_set:v=>{names.clear();String(v).split(/\s+/).filter(Boolean).forEach(x=>names.add(x));this._class=[...names].join(' ');}};
   const style={setProperty:(k,v)=>{style[k]=String(v);},getPropertyValue:k=>style[k]||'',removeProperty:k=>{delete style[k];}};this.style=style;
   this.dataset=new Proxy({}, {get:(_t,k)=>this.getAttribute('data-'+String(k).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()))??undefined,set:(_t,k,v)=>{this.setAttribute('data-'+String(k).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),v);return true;}});
  }
  set className(v){this.classList._set(v);}get className(){return this._class;}
  set id(v){this.attrs.id=String(v);}get id(){return this.attrs.id||'';}
  set href(v){this.attrs.href=String(v);}get href(){return this.attrs.href?new URL(this.attrs.href,'https://elegso.ru/leasing_lawyer/').href:'';}
  set src(v){this.attrs.src=String(v);}get src(){return this.attrs.src?new URL(this.attrs.src,'https://elegso.ru/leasing_lawyer/').href:'';}
  set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set innerHTML(html){
   this.children=[];this._text='';let parent=this;const stack=[this];let cursor=0;
   for(const m of html.matchAll(/<\/?[a-z][^>]*>/gi)){
    parent._text+=html.slice(cursor,m.index).replace(/&(?:times|times;)/g,'×');cursor=m.index+m[0].length;
    if(m[0].startsWith('</')){if(stack.length>1)stack.pop();parent=stack.at(-1);continue;}
    const tag=m[0].match(/^<([a-z0-9-]+)/i)[1],el=new El(tag);
    for(const a of m[0].matchAll(/\s([a-z][a-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi))el.setAttribute(a[1],a[2]??a[3]??a[4]??'');
    parent.appendChild(el);
    if(!/^(?:img|input|br|hr|meta|link|source)$/i.test(tag)&&!m[0].endsWith('/>')){stack.push(el);parent=el;}
   }
   parent._text+=html.slice(cursor);
  }
  setAttribute(k,v){if(k==='class')this.className=v;else this.attrs[k]=String(v);if(k==='inert')this.inert=true;}
  getAttribute(k){return k==='class'?this.className:(this.attrs[k]??null);}
  hasAttribute(k){return k==='class'?Boolean(this.className):Object.hasOwn(this.attrs,k);}
  removeAttribute(k){delete this.attrs[k];if(k==='inert')this.inert=false;}
  toggleAttribute(k,force){const on=force===undefined?!this.hasAttribute(k):force;on?this.setAttribute(k,''):this.removeAttribute(k);return on;}
  addEventListener(k,fn){this.listeners.set(k,[...(this.listeners.get(k)||[]),fn]);}
  removeEventListener(k,fn){this.listeners.set(k,(this.listeners.get(k)||[]).filter(v=>v!==fn));}
  emit(k,event={}){event.target??=this;event.currentTarget=this;event.preventDefault??=()=>{event.defaultPrevented=true;};event.stopPropagation??=()=>{};(this.listeners.get(k)||[]).forEach(fn=>fn(event));return event;}
  appendChild(el){this.children.push(el);el.parentElement=this;el.isConnected=this.isConnected;return el;}
  append(...els){els.forEach(e=>this.appendChild(e));}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(e=>e!==this);this.isConnected=false;}
  contains(el){return el===this||this.children.some(c=>c.contains(el));}
  matches(selector){
   if(selector.includes(','))return selector.split(',').some(s=>this.matches(s.trim()));
   const parts=selector.replace(/^:scope\s*>\s*/,'').trim().split(/\s+/);
   const part=parts.pop();if(!part)return false;
   const tag=part.match(/^[a-z][\w-]*/i)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;
   const id=part.match(/#([\w-]+)/)?.[1];if(id&&this.id!==id)return false;
   for(const c of part.matchAll(/\.([\w-]+)/g))if(!this.classList.contains(c[1]))return false;
   for(const a of part.matchAll(/\[([\w:-]+)(?:=["']?([^\]"']*)["']?)?\]/g))if(!this.hasAttribute(a[1])||(a[2]!==undefined&&this.getAttribute(a[1])!==a[2]))return false;
   if(parts.length){let p=this.parentElement;while(p&&!p.matches(parts.join(' ')))p=p.parentElement;if(!p)return false;}
   return true;
  }
  closest(selector){let p=this;while(p){if(p.matches(selector))return p;p=p.parentElement;}return null;}
  querySelectorAll(selector){return this.children.flatMap(c=>[...(c.matches(selector)?[c]:[]),...c.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  focus(){document.activeElement=this;}
  getBoundingClientRect(){const left=parseFloat(this.style.left)||80,top=parseFloat(this.style.top)||32,w=parseFloat(this.style.width)||(this===brand?200:300),h=parseFloat(this.style.height)||(this===brand?44:400);return {x:left,y:top,left,top,width:w,height:h,right:left+w,bottom:top+h};}
  get offsetWidth(){return this.getBoundingClientRect().width;}
  get offsetHeight(){return this.getBoundingClientRect().height;}
 }
 document=new El('document');document.readyState='complete';document.documentElement=new El('html');document.documentElement.clientWidth=width;document.documentElement.clientHeight=height;
 document.body=new El('body');document.body.isConnected=true;document.appendChild(document.body);document.activeElement=document.body;
 document.createElement=tag=>{created.push(tag);return new El(tag);};document.createDocumentFragment=()=>new El('fragment');document.getElementById=id=>document.querySelector('#'+id);
 const header=new El('header');header.className='site-header';document.body.appendChild(header);
 const brand=new El('a');brand.className='brand';brand.href='/';
 const image=new El('img');image.src='/assets/redesign/logo.png';brand.appendChild(image);const word=new El('span');word.className='brand-word';word.textContent='ЭЛЕГСО';brand.appendChild(word);
 if(brandPresent)header.appendChild(brand);
 const menu=new El('button');menu.className='menu-toggle';header.appendChild(menu);
 const outside=new El('main');document.body.appendChild(outside);
 const window=new El('window');window.innerWidth=width;window.innerHeight=height;window.scrollX=0;window.scrollY=0;window.location={origin:'https://elegso.ru',href:'https://elegso.ru/leasing_lawyer/'};
 window.matchMedia=query=>({matches:query.includes('prefers-reduced-motion')?reduced:query.includes('hover')?fine:false,addEventListener(){},removeEventListener(){}});
 const setTimeout=(fn,delay=0)=>{const id=nextId++;timers.set(id,{fn,at:now+delay,delay});return id;};
 const clearTimeout=id=>timers.delete(id);const requestAnimationFrame=fn=>{const id=nextId++;frames.set(id,fn);return id;};const cancelAnimationFrame=id=>frames.delete(id);
 Object.assign(window,{setTimeout,clearTimeout,requestAnimationFrame,cancelAnimationFrame});
 const source=fs.readFileSync(scriptPath,'utf8');
 vm.runInNewContext(source,{document,window,location:window.location,URL,Element:El,HTMLElement:El,Node:El,Image:function(){return new El('img');},setTimeout,clearTimeout,requestAnimationFrame,cancelAnimationFrame,performance:{now:()=>now},console},{timeout:1000});
 const advance=ms=>{const end=now+ms;let guard=0;while(true){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;if(++guard>1000)throw Error('Timer loop');now=due[1].at;timers.delete(due[0]);due[1].fn();}now=end;};
 const flushFrames=()=>{const work=[...frames.values()];frames.clear();work.forEach(fn=>fn(now));};
 const panel=document.querySelector('.els-showcase');
 return {document,window,brand,image,word,menu,outside,panel,timers,frames,created,advance,flushFrames,click:(el,event={})=>el.emit('click',{button:0,detail:1,...event})};
}

const isOpen=s=>s.panel?.getAttribute('data-open')==='true';

test('logo enhancement is closed on load, accessible, and preserves the native home destination',()=>{
 const s=harness();
 assert.ok(s.panel);assert.equal(isOpen(s),false);assert.equal(s.panel.getAttribute('aria-hidden'),'true');assert.equal(s.panel.inert,true);
 assert.equal(s.brand.getAttribute('href'),'/');assert.equal(s.brand.getAttribute('aria-expanded'),'false');assert.equal(s.brand.getAttribute('aria-controls'),s.panel.id);
 assert.equal(s.panel.getAttribute('role'),'dialog');assert.equal(s.panel.getAttribute('aria-modal'),'false');
 assert.equal(s.panel.querySelector('.els-showcase__home').getAttribute('href'),'/');
 assert.equal(s.timers.size,0,'No automatic reveal timer at startup');
});

test('hover covers emblem and wording, waits 900 ms, and cancels a short accidental pass',()=>{
 const s=harness();s.brand.emit('pointerenter',{pointerType:'mouse',target:s.image});s.advance(899);assert.equal(isOpen(s),false);s.advance(1);assert.equal(isOpen(s),true);
 s.brand.emit('pointerleave',{pointerType:'mouse',relatedTarget:s.outside});s.advance(150);assert.equal(isOpen(s),false);
 s.brand.emit('pointerenter',{pointerType:'mouse',target:s.word});s.advance(300);s.brand.emit('pointerleave',{pointerType:'mouse',relatedTarget:s.outside});s.advance(1000);assert.equal(isOpen(s),false);
});

test('desktop clicks reveal immediately and keep it open; modified clicks retain native navigation',()=>{
 const s=harness();const e=s.click(s.brand);assert.equal(e.defaultPrevented,true);assert.equal(isOpen(s),true);s.click(s.brand);assert.equal(isOpen(s),true,'A mouse click must not dismiss the logo already revealed by hover or a previous click');
 for(const variant of [{metaKey:true},{ctrlKey:true},{shiftKey:true},{altKey:true},{button:1}]){const e=s.click(s.brand,variant);assert.notEqual(e.defaultPrevented,true);assert.equal(isOpen(s),true);}
 s.click(s.panel.querySelector('.els-showcase__close'));assert.equal(isOpen(s),false);
 for(const variant of [{metaKey:true},{ctrlKey:true},{shiftKey:true},{altKey:true},{button:1}]){const e=s.click(s.brand,variant);assert.notEqual(e.defaultPrevented,true);assert.equal(isOpen(s),false);}
});

test('pointer bridge permits entering the logo surface and leaving it closes cleanly',()=>{
 const s=harness();s.brand.emit('pointerenter',{pointerType:'mouse'});s.advance(900);s.brand.emit('pointerleave',{pointerType:'mouse',relatedTarget:s.panel});s.advance(60);s.panel.emit('pointerenter',{pointerType:'mouse',relatedTarget:s.brand});s.advance(500);assert.equal(isOpen(s),true);
 s.panel.emit('pointerleave',{pointerType:'mouse',relatedTarget:s.outside});s.advance(150);assert.equal(isOpen(s),false);assert.equal(s.panel.getAttribute('aria-hidden'),'true');assert.equal(s.panel.inert,true);
});

test('touch does not schedule hover and taps toggle the same accessible surface',()=>{
 const s=harness({fine:false});s.brand.emit('pointerenter',{pointerType:'touch'});s.advance(1000);assert.equal(isOpen(s),false);assert.equal(s.timers.size,0);
 s.click(s.brand,{pointerType:'touch'});assert.equal(isOpen(s),true);s.click(s.brand,{pointerType:'touch'});assert.equal(isOpen(s),false);
 const hybrid=harness({fine:true});hybrid.click(hybrid.brand,{pointerType:'touch'});assert.equal(isOpen(hybrid),true);hybrid.click(hybrid.brand,{pointerType:'touch'});assert.equal(isOpen(hybrid),false,'Touch still toggles on a hybrid device with a fine pointer');
});

test('keyboard reveals, Escape closes and returns focus from within the surface',()=>{
 const s=harness();const e=s.brand.emit('keydown',{key:'Enter'});assert.equal(e.defaultPrevented,true);s.flushFrames();assert.equal(isOpen(s),true);assert.equal(s.document.activeElement,s.panel.querySelector('.els-showcase__close'));
 s.document.emit('keydown',{key:'Escape'});assert.equal(isOpen(s),false);assert.equal(s.document.activeElement,s.brand);
 const space=s.brand.emit('keydown',{key:' '});assert.equal(space.defaultPrevented,true);assert.equal(isOpen(s),true);
 s.brand.emit('keydown',{key:' '});assert.equal(isOpen(s),false);
 s.click(s.brand,{detail:0});s.flushFrames();assert.equal(isOpen(s),true);assert.equal(s.document.activeElement,s.panel.querySelector('.els-showcase__close'));
 s.click(s.brand,{detail:0});assert.equal(isOpen(s),false);assert.equal(s.document.activeElement,s.brand);
});

test('outside input, scrolling, resizing, menu action and explicit close dismiss the reveal',()=>{
 for(const action of ['outside','scroll','resize','menu','close']){
  const s=harness();s.click(s.brand);assert.equal(isOpen(s),true);
  if(action==='outside')s.document.emit('pointerdown',{target:s.outside});
  if(action==='scroll')s.window.emit('scroll',{target:s.document});
  if(action==='resize')s.window.emit('resize');
  if(action==='menu')s.document.emit('click',{target:s.menu});
  if(action==='close')s.click(s.panel.querySelector('.els-showcase__close'));
  assert.equal(isOpen(s),false,action);assert.equal(s.brand.getAttribute('aria-expanded'),'false',action);
 }
});

test('a pending hover cannot reopen after outside dismissal or scroll',()=>{
 for(const action of ['outside','scroll']){
  const s=harness();s.brand.emit('pointerenter',{pointerType:'mouse'});s.advance(400);
  if(action==='outside')s.document.emit('pointerdown',{target:s.outside});else s.window.emit('scroll',{target:s.document});
  s.advance(1000);assert.equal(isOpen(s),false,action);
 }
});

test('no header brand leaves the page untouched, with no disclosure, events or timers',()=>{
 const s=harness({brandPresent:false});assert.equal(s.panel,null);assert.equal(s.timers.size,0);assert.equal(s.created.length,0);
});

test('effect assets respect reduced motion and print and contain no network or tracking implementation',()=>{
 const source=fs.readFileSync(scriptPath,'utf8'),css=fs.readFileSync(cssPath,'utf8');
 assert.doesNotMatch(source,/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|ym|gtag)\s*\(/);
 assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);assert.match(css,/@media\s+print/);
 const s=harness({reduced:true});s.click(s.brand);s.advance(1000);assert.equal(isOpen(s),true);s.document.emit('keydown',{key:'Escape'});assert.equal(isOpen(s),false);
});
