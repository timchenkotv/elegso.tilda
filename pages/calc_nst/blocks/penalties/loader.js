// Loader «Ввод неустойки»: берет template/script рядом со своим src
(function(){
  var self = document.currentScript || (function(){var s=document.getElementsByTagName('script');return s[s.length-1];})();
  var src  = (self && self.src) ? self.src : '';
  var base = src.replace(/\/loader\.js(?:\?.*)?$/, '');
  var TEMPLATE_URL = base + "/template.html";
  var SCRIPT_URL   = base + "/script.js";
  function getMount(){ var m=document.getElementById("penalties-mount"); return m ? m : (self && self.parentElement) ? self.parentElement : document.body; }
  function loadText(u){ return fetch(u,{credentials:"omit"}).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status+" for "+u); return r.text(); }); }
  function injectHTML(h){ getMount().insertAdjacentHTML("beforeend", h); }
  function loadScriptOnce(u){
    if(window.__elegso_penalties_script_loaded__) return Promise.resolve();
    return new Promise(function(res,rej){ var s=document.createElement("script"); s.src=u; s.async=true;
      s.onload=function(){ window.__elegso_penalties_script_loaded__=true; res(); };
      s.onerror=function(e){ rej(e); }; document.head.appendChild(s); });
  }
  loadText(TEMPLATE_URL).then(injectHTML).then(function(){return loadScriptOnce(SCRIPT_URL);})
    .catch(function(err){ console.error("[ELEGSO penalties loader] Error:", err); });
})();
