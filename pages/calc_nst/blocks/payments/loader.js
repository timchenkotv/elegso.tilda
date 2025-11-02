// Loader для блока "Ввод оплат"
(function(){
  var CDN_BASE = "https://cdn.jsdelivr.net/gh/timchenkotv/elegso.tilda@main/pages/calc_nst/blocks/payments/v1";
  var TEMPLATE_URL = CDN_BASE + "/template.html";
  var SCRIPT_URL   = CDN_BASE + "/script.js";

  function getMount(){
    var m = document.getElementById("payments-mount");
    if (m) return m;
    var s = document.currentScript;
    if (s && s.parentElement) return s.parentElement;
    return document.body;
  }

  function loadText(url){
    return fetch(url, { credentials: "omit", cache: "no-store" }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.text();
    });
  }

  function injectHTML(html){
    var mount = getMount();
    mount.insertAdjacentHTML("beforeend", html);
  }

  function loadScriptOnce(url){
    if (window.__elegso_payments_script_loaded__) return Promise.resolve();
    return new Promise(function(resolve, reject){
      var s=document.createElement("script");
      s.src=url + "?v=" + Date.now(); // анти-кеш во время разработки
      s.async=true;
      s.onload=function(){ window.__elegso_payments_script_loaded__=true; resolve(); };
      s.onerror=function(e){ reject(e); };
      document.head.appendChild(s);
    });
  }

  loadText(TEMPLATE_URL)
    .then(function(html){ injectHTML(html); })
    .then(function(){ return loadScriptOnce(SCRIPT_URL); })
    .catch(function(err){ console.error("[ELEGSO payments loader] Error:", err); });
})();
