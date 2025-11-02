// Loader «Ввод неустойки»: берет template/script рядом со своим src
(function(){
  var self = document.currentScript || (function(){var s=document.getElementsByTagName('script');return s[s.length-1];})();
  var src  = (self && self.src) ? self.src : '';
  var base = src.replace(/\/loader\.js(?:\?.*)?$/, ''); // .../pages/calc_nst/v1/blocks/penalties
  var TEMPLATE_URL = base + "/template.html";
  var SCRIPT_URL   = base + "/script.js";

  function getMount(){
    var m = document.getElementById("penalties-mount");
    return m ? m : (self && self.parentElement ? self.parentElement : document.body);
  }
  function loadText(url){
    return fetch(url, { credentials: "omit" }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.text();
    });
  }
  function injectHTML(html){ getMount().insertAdjacentHTML("beforeend", html); }
  function loadScriptOnce(url){
    if (window.__elegso_penalties_script_loaded__) return Promise.resolve();
    return new Promise(function(resolve, reject){
      var s=document.createElement("script");
      s.src=url; s.async=true;
      s.onload=function(){ window.__elegso_penalties_script_loaded__=true; resolve(); };
      s.onerror=function(e){ reject(e); };
      document.head.appendChild(s);
    });
  }

  loadText(TEMPLATE_URL).then(injectHTML).then(function(){ return loadScriptOnce(SCRIPT_URL); })
    .catch(function(err){ console.error("[ELEGSO penalties loader] Error:", err); });
})();
