set -e

# 0) в корень репо
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

# 1) Перезаписываем лоадеры на tag-aware (без жёстких @main/старых путей)

cat > pages/calc_nst/v1/blocks/accruals/loader.js <<'JS'
// Loader для блока "Ввод начислений" (tag-aware: база берётся из собственного src)
(function(){
  var self = document.currentScript || (function(){var s=document.getElementsByTagName('script');return s[s.length-1];})();
  var src  = self && self.src ? self.src : '';
  // base = .../pages/calc_nst/v1/blocks/accruals
  var base = src.replace(/\/loader\.js(?:\?.*)?$/, '');
  var TEMPLATE_URL = base + "/template.html";
  var SCRIPT_URL   = base + "/script.js";

  function getMount(){
    var m = document.getElementById("accruals-mount");
    if (m) return m;
    return (self && self.parentElement) ? self.parentElement : document.body;
  }
  function loadText(url){
    return fetch(url, { credentials: "omit" }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.text();
    });
  }
  function injectHTML(html){ getMount().insertAdjacentHTML("beforeend", html); }
  function loadScriptOnce(url){
    if (window.__elegso_accruals_script_loaded__) return Promise.resolve();
    return new Promise(function(resolve, reject){
      var s=document.createElement("script");
      s.src=url; s.async=true;
      s.onload=function(){ window.__elegso_accruals_script_loaded__=true; resolve(); };
      s.onerror=function(e){ reject(e); };
      document.head.appendChild(s);
    });
  }
  loadText(TEMPLATE_URL).then(injectHTML).then(function(){ return loadScriptOnce(SCRIPT_URL); })
    .catch(function(err){ console.error("[ELEGSO accruals loader] Error:", err); });
})();
JS

cat > pages/calc_nst/v1/blocks/payments/loader.js <<'JS'
// Loader для блока "Ввод оплат" (tag-aware: база берётся из собственного src)
(function(){
  var self = document.currentScript || (function(){var s=document.getElementsByTagName('script');return s[s.length-1];})();
  var src  = self && self.src ? self.src : '';
  // base = .../pages/calc_nst/v1/blocks/payments
  var base = src.replace(/\/loader\.js(?:\?.*)?$/, '');
  var TEMPLATE_URL = base + "/template.html";
  var SCRIPT_URL   = base + "/script.js";

  function getMount(){
    var m = document.getElementById("payments-mount");
    if (m) return m;
    return (self && self.parentElement) ? self.parentElement : document.body;
  }
  function loadText(url){
    return fetch(url, { credentials: "omit" }).then(function(r){
      if(!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.text();
    });
  }
  function injectHTML(html){ getMount().insertAdjacentHTML("beforeend", html); }
  function loadScriptOnce(url){
    if (window.__elegso_payments_script_loaded__) return Promise.resolve();
    return new Promise(function(resolve, reject){
      var s=document.createElement("script");
      s.src=url; s.async=true;
      s.onload=function(){ window.__elegso_payments_script_loaded__=true; resolve(); };
      s.onerror=function(e){ reject(e); };
      document.head.appendChild(s);
    });
  }
  loadText(TEMPLATE_URL).then(injectHTML).then(function(){ return loadScriptOnce(SCRIPT_URL); })
    .catch(function(err){ console.error("[ELEGSO payments loader] Error:", err); });
})();
JS

# 2) Если вдруг локально остались конфликтные маркеры в penalties — забираем чистые версии из origin/main
git fetch origin
if grep -q '<<<<<' pages/calc_nst/v1/blocks/penalties/template.html 2>/dev/null; then
  git checkout origin/main -- pages/calc_nst/v1/blocks/penalties/template.html
fi
if grep -q '<<<<<' pages/calc_nst/v1/blocks/penalties/styles.css 2>/dev/null; then
  git checkout origin/main -- pages/calc_nst/v1/blocks/penalties/styles.css
fi
if grep -q '<<<<<' pages/calc_nst/v1/blocks/penalties/script.js 2>/dev/null; then
  git checkout origin/main -- pages/calc_nst/v1/blocks/penalties/script.js
fi

# 3) Коммитим и пушим изменения в main
git add pages/calc_nst/v1/blocks/{accruals,payments}/loader.js \
        pages/calc_nst/v1/blocks/penalties/{template.html,styles.css,script.js} 2>/dev/null || true
git commit -m "fix(calc_nst): tag-aware loaders (accruals/payments) + resolve penalties files if conflicted" || true
git pull --rebase origin main
git push

# 4) Выпускаем новый единый тег страницы
NEW_TAG="calc_nst-v1.0.3"
git tag -a "$NEW_TAG" -m "calc_nst page $NEW_TAG: unified tag-aware loaders for all blocks"
git push origin "$NEW_TAG"

echo "DONE. New tag: $NEW_TAG"
