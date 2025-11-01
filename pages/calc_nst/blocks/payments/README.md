# Ввод оплат (payments)

## Файлы
- `v1/styles.css` — стили
- `v1/script.js` — логика (IIFE)
- `v1/template.html` — разметка
- `v1/loader.js` — загрузчик (вставляет template → подключает script)

## Подключение в Tilda (временно с ветки main)
```html
<div id="payments-mount"></div>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/timchenkotv/elegso.tilda@main/pages/calc_nst/blocks/payments/v1/styles.css">
<script src="https://cdn.jsdelivr.net/gh/timchenkotv/elegso.tilda@main/pages/calc_nst/blocks/payments/v1/loader.js"></script>
