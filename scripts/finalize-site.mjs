#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('www');
const assetVersion = '20260719-2';
const cbrImporterVersion = '20260723-1';
const calcReportCutoffVersion = '20260723-1';
const calcPrintDocumentVersion = '20260724-1';

const brandFooter = `
<div class="elegso-site-signature" data-elegso-site-signature aria-label="Юридическая компания ЭЛЕГСО">
  <div class="elegso-site-signature__inner">
    <span class="elegso-site-signature__brand">ЮК «ЭЛЕГСО»</span>
    <span class="elegso-site-signature__tagline">Мы — опора для тех, кто ведёт бизнес в сложной реальности.</span>
  </div>
</div>`;

function replaceTildaLabel(html) {
  return html.replace(
    /\s*<!--\s*Tilda copyright\.[\s\S]*?(?=\s*<!--\s*Stat\s*-->)/gi,
    `${brandFooter} `,
  );
}

function contactPanel({ popup = false, calculator = false } = {}) {
  const modifiers = [
    popup ? 'elegso-contact-card--popup' : '',
    calculator ? 'elegso-contact-card--calculator' : '',
  ].filter(Boolean).join(' ');

  return `
<section class="elegso-contact-card ${modifiers}" data-elegso-contact-panel aria-label="Контакты юридической компании ЭЛЕГСО">
  <div class="elegso-contact-card__eyebrow">Прямая связь с юристом</div>
  <div class="elegso-contact-card__title">Свяжитесь удобным способом</div>
  <p class="elegso-contact-card__lead">Свяжитесь напрямую: напишите нам на электронную почту или позвоните. Мы ответим в рабочее время.</p>
  <div class="elegso-contact-card__actions">
    <a class="elegso-contact-card__action elegso-contact-card__action--mail" href="mailto:mail@elegso.ru" aria-label="Написать на почту mail@elegso.ru">
      <span class="elegso-contact-card__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3.75 6.75h16.5v10.5H3.75z"/><path d="m4.5 7.5 7.5 5.25 7.5-5.25"/></svg></span>
      <span><small>Электронная почта</small><strong>mail@elegso.ru</strong></span>
      <span class="elegso-contact-card__arrow" aria-hidden="true">→</span>
    </a>
    <a class="elegso-contact-card__action elegso-contact-card__action--phone" href="tel:+74956460002" aria-label="Позвонить по номеру +7 495 646-00-02">
      <span class="elegso-contact-card__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7.1 3.75 4.5 5.25c-.9.52-.96 2.1-.15 4.06a19.6 19.6 0 0 0 10.34 10.34c1.96.81 3.54.75 4.06-.15l1.5-2.6-4.35-2.5-1.15 1.65c-.37.53-1.12.67-1.7.37a12.18 12.18 0 0 1-5.52-5.52c-.3-.58-.16-1.33.37-1.7L9.6 8.1z"/></svg></span>
      <span><small>Телефон</small><strong>+7 (495) 646-00-02</strong></span>
      <span class="elegso-contact-card__arrow" aria-hidden="true">→</span>
    </a>
  </div>
  <div class="elegso-contact-card__details">
    <div><strong>ООО «ЮК ЭЛЕГСО»</strong><span>ИНН 7733472977 · ОГРН 1257700349004</span></div>
    <address>Москва, ул. Бутлерова, 17, БЦ Neo Geo, блок С, коворкинг Workki, этаж 4, оф. С01</address>
  </div>
</section>`;
}

function replaceCalculatorSubmission(form) {
  const contactFieldMarker = 'data-input-lid="4877625993121"';
  const markerIndex = form.indexOf(contactFieldMarker);
  if (markerIndex === -1) return contactPanel();

  const contactGroupStart = form.lastIndexOf('<div', markerIndex);
  let calculator = form.slice(0, contactGroupStart);
  calculator = calculator
    .replace(/^<form\b([^>]*)>/i, (_match, attributes) => {
      const safeAttributes = attributes
        .replace(/\s+(?:name|action|method|data-formactiontype|data-success-callback)=(?:"[^"]*"|'[^']*')/gi, '')
        .replace(/\s+role=(?:"form"|'form')/i, '')
        .replace(/\bjs-form-proccess\b/g, '')
        .replace(/\s{2,}/g, ' ');
      return `<div${safeAttributes} role="group" aria-label="Калькулятор сальдо встречных обязательств" data-elegso-calculator>`;
    })
    .replace(/\s*<input\b[^>]*\bname=["']formservices\[\]["'][^>]*>/gi, '')
    .replace(/\s*<!-- @classes[^>]*-->\s*<div class="js-successbox[\s\S]*?<\/div>/i, '');

  // The first closing div completes t-form__inputsbox; the second one closes
  // the former form container. The calculator inputs and tcalc initializers
  // keep their original record id and therefore continue to work.
  return `${calculator}</div>${contactPanel({ calculator: true })}</div>`;
}

function replaceSubmissionForms(html) {
  return html.replace(/<form\b[\s\S]*?<\/form>/gi, (form) => {
    if (/id=["']form1164640016["']/i.test(form)) {
      return replaceCalculatorSubmission(form);
    }
    return contactPanel({ popup: /t702_onSuccess/i.test(form) });
  });
}

function updateContactCopy(html) {
  const replacements = [
    [
      'Мы не используем формы и не собираем через сайт персональные данные. Напишите нам или позвоните напрямую.',
      'Свяжитесь напрямую: напишите нам на электронную почту или позвоните. Мы ответим в рабочее время.',
    ],
    ['Отправьте заявку на юридическую консультацию', 'Свяжитесь с профильным юристом'],
    ['Пока не поздно!', 'Свяжитесь с юристом'],
    [
      'Быстрый совет или бесплатная консультация — и всё станет яснее. Оставьте контакты, мы свяжемся и поможем вам.',
      'Быстрый совет или бесплатная консультация — выберите удобный способ прямой связи с юристом.',
    ],
    [
      'Вы можете позвонить нам по телефону, отправить заявку в форме или написать на электронную почту.',
      'Вы можете позвонить нам по телефону или написать на электронную почту.',
    ],
    [
      'Оставьте заявку через форму, позвоните нам или напишите на электронную почту.',
      'Позвоните нам или напишите на электронную почту.',
    ],
    [
      'Для связи с нами, Вы можете позвонить по телефону, отправить заявку в форме или написать на электронную почту.',
      'Для связи с нами позвоните по телефону или напишите на электронную почту.',
    ],
    [
      'просто оставьте заявку или свяжитесь с нами.',
      'напишите нам на электронную почту или позвоните.',
    ],
    [
      'Быстрая связь через форму и мессенджеры.',
      'Прямая связь по телефону и электронной почте.',
    ],
    [
      'Защитите свои права после ДТП — заполните форму, и мы свяжемся с вами для бесплатной консультации.',
      'Защитите свои права после ДТП — напишите нам или позвоните для бесплатной консультации.',
    ],
    [
      'Оставьте заявку и доверьте защиту своих интересов профессионалам!',
      'Свяжитесь с нами и доверьте защиту своих интересов профессионалам!',
    ],
    [
      'Получите консультацию по изменению вашего договора лизинга — оставьте заявку!',
      'Получите консультацию по изменению вашего договора лизинга — свяжитесь с юристом!',
    ],
    [
      'Получите профессиональную поддержку арбитражного юриста — оставьте заявку на бесплатную консультацию',
      'Получите профессиональную поддержку арбитражного юриста — свяжитесь с нами для бесплатной консультации',
    ],
    [
      'Хотите расторгнуть договор без рисков? Оставьте заявку!',
      'Хотите расторгнуть договор без рисков? Свяжитесь с юристом!',
    ],
    [
      'Оператор обрабатывает персональные данные Пользователя только в случае их заполнения и/или отправки Пользователем самостоятельно через специальные формы, расположенные на сайте: elegso.ru или направленны Оператору посредством электронной почты. Заполняя соответствующие формы и/или отправляя свои персональные данные Оператору, Пользователь выражает свое согласие с данной Политикой.',
      'Оператор обрабатывает персональные данные Пользователя только в случае их сообщения Пользователем самостоятельно по телефону или направления Оператору посредством электронной почты. Сообщая или направляя свои персональные данные Оператору, Пользователь выражает свое согласие с данной Политикой.',
    ],
  ];
  for (const [from, to] of replacements) html = html.replaceAll(from, to);

  return html
    .replace(
      /<a href="#send_a_request" style="color: rgb\(160, 75, 56\);">Или оставить заявку в форме<\/a>/g,
      '<a href="mailto:mail@elegso.ru" style="color: rgb(160, 75, 56);">Или написать на электронную почту</a>',
    )
    .replace(
      /<a href="" class="t824__phone t-name t-name_lg">\+7 \(495\) 646-00-02<\/a>/g,
      '<a href="tel:+74956460002" class="t824__phone t-name t-name_lg">+7 (495) 646-00-02</a>',
    )
    .replace(/>Отправить заявку</g, '>Связаться с юристом<')
    .replaceAll('mailto:mailto:mail@elegso.ru', 'mailto:mail@elegso.ru')
    .replaceAll('href="tel: +7(495)646-00-02"', 'href="tel:+74956460002"')
    .replaceAll('href="tel: +7 (495) 646-00-02"', 'href="tel:+74956460002"')
    .replaceAll('href="tel:+7 (495) 646-00-02"', 'href="tel:+74956460002"');
}

async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result;
}

for (const file of await walk(root)) {
  if (!file.endsWith('.html')) continue;
  const rel = path.relative(root, file).split(path.sep).join('/');
  const route = rel === 'index.html'
    ? '/'
    : rel.endsWith('/index.html')
      ? `/${rel.slice(0, -'/index.html'.length)}`
      : `/${rel}`;
  const canonical = `https://elegso.ru${route}`;
  let html = await fs.readFile(file, 'utf8');

  html = html.replace(
    /(<link\s+rel=["']canonical["']\s+href=)["'][^"']*["']/i,
    `$1"${canonical}"`,
  );
  html = html.replace(
    /(<meta\s+property=["']og:url["']\s+content=)["'][^"']*["']/i,
    `$1"${canonical}"`,
  );

  // Tilda's CDN failover loader constructs regular expressions from absolute
  // CDN URLs. All required assets are local after migration, so the loader is
  // both unnecessary and incompatible with root-relative asset paths.
  html = html.replace(
    /\s*<script\s+src=["']\/_external\/neo\.tildacdn\.com\/js\/tilda-fallback-1\.0\.min\.js["'][^>]*><\/script>/gi,
    '',
  );
  html = html
    .replace(
      /\s*<script\s+[^>]*src=["'][^"']*\/tilda-(?:forms|lazyload|upwidget)-[^"']+\.js["'][^>]*><\/script>/gi,
      '',
    )
    .replace(
      /\s*<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?tilda-phone-mask-1\.1\.min\.js(?:(?!<\/script>)[\s\S])*?<\/script>/gi,
      '',
    );

  // Analytics must load current vendor code; local snapshots would silently
  // stop receiving fixes and can break dynamic query-string construction.
  html = html
    .replaceAll('/_external/mc.yandex.ru/metrika/tag.js', 'https://mc.yandex.ru/metrika/tag.js')
    .replaceAll('/_external/top-fwz1.mail.ru/js/code.js', 'https://top-fwz1.mail.ru/js/code.js')
    .replace(
      /\/_external\/www\.googletagmanager\.com\/gtm__q_[a-f0-9]+\.js/g,
      'https://www.googletagmanager.com/gtm.js?id=',
    )
    .replace(
      /\/_external\/www\.googletagmanager\.com\/ns__q_[a-f0-9]+\.html/g,
      'https://www.googletagmanager.com/ns.html?id=GTM-PBV2TC8',
    )
    .replace(
      /\/_external\/static\.tildacdn\.com\/js\/tilda-feed-1\.1\.min\.js(?:\?v=[^"']*)?/g,
      '/_external/static.tildacdn.com/js/tilda-feed-1.1.min.js?v=20260712-3',
    );

  html = replaceSubmissionForms(html)
    .replace(/\s*<div class="t702__form-bottom-text\b[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/\s*<div class="t712__form-bottom-text\b[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/\s*<div class="t678__form-bottom-text\b[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/\sdata-tilda-formskey=(?:"[^"]*"|'[^']*')/gi, '');
  html = updateContactCopy(html);
  html = replaceTildaLabel(html);

  html = html.replace(
    /\s*<link\s+rel="stylesheet"\s+href="\/assets\/footer-brand\.css(?:\?v=[^"]*)?"\s*\/?>/gi,
    '',
  );
  if (html.includes('data-elegso-site-signature')) {
    html = html.replace(
      /<\/head>/i,
      `<link rel="stylesheet" href="/assets/footer-brand.css?v=${assetVersion}">\n</head>`,
    );
  }

  html = html.replace(
    /\s*<link\s+rel="stylesheet"\s+href="\/assets\/contact-block\.css(?:\?v=[^"]*)?"\s*\/?>/gi,
    '',
  );
  if (html.includes('data-elegso-contact-panel')) {
    html = html.replace(
      /<\/head>/i,
      `<link rel="stylesheet" href="/assets/contact-block.css?v=${assetVersion}">\n</head>`,
    );
  }

  // The CBR key-rate importer belongs only to the penalty calculator. Keeping
  // this wiring in the finalizer makes the integration survive future mirrors
  // of the original Tilda export without leaking calculator assets elsewhere.
  html = html.replace(
    /\s*<link\s+rel="stylesheet"\s+href="\/assets\/cbr-key-rate-import\.css(?:\?v=[^"]*)?"\s*\/?>/gi,
    '',
  );
  if (route === '/calc_nst') {
    html = html.replace(
      /<\/head>/i,
      `<link rel="stylesheet" href="/assets/cbr-key-rate-import.css?v=${cbrImporterVersion}">\n</head>`,
    );
  }

  // The optional indicator calculation cutoff is shared by the on-page and
  // printable penalty reports. Keep its controller external so both fields
  // stay synchronized and the integration survives a future Tilda remirror.
  html = html.replace(
    /\s*<link\s+rel="stylesheet"\s+href="\/assets\/calc-report-cutoff\.css(?:\?v=[^"]*)?"\s*\/?>/gi,
    '',
  );
  if (route === '/calc_nst') {
    html = html.replace(
      /<\/head>/i,
      `<link rel="stylesheet" href="/assets/calc-report-cutoff.css?v=${calcReportCutoffVersion}">\n</head>`,
    );
  }

  // Editable print-document metadata (title and compact period summary) is
  // scoped to the penalty calculator and is kept external for remirror safety.
  html = html.replace(
    /\s*<link\s+rel="stylesheet"\s+href="\/assets\/calc-print-document\.css(?:\?v=[^"]*)?"\s*\/?>/gi,
    '',
  );
  if (route === '/calc_nst') {
    html = html.replace(
      /<\/head>/i,
      `<link rel="stylesheet" href="/assets/calc-print-document.css?v=${calcPrintDocumentVersion}">\n</head>`,
    );
  }

  // Some calculator scripts contain a literal </body> inside a printable HTML
  // template. Always target the final closing body tag, never the first one.
  html = html.replace(/<script src="\/assets\/migration\.js(?:\?v=[^"]*)?" defer><\/script>/g, '');
  html = html.replace(
    /<script src="\/assets\/cbr-key-rate-import\.js(?:\?v=[^"]*)?" defer><\/script>/g,
    '',
  );
  html = html.replace(
    /<script src="\/assets\/calc-report-cutoff\.js(?:\?v=[^"]*)?" defer><\/script>/g,
    '',
  );
  html = html.replace(
    /<script src="\/assets\/calc-print-document\.js(?:\?v=[^"]*)?" defer><\/script>/g,
    '',
  );
  const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
  if (bodyEnd !== -1) {
    const cbrImporter = route === '/calc_nst'
      ? `<script src="/assets/cbr-key-rate-import.js?v=${cbrImporterVersion}" defer></script>`
      : '';
    const calcReportCutoff = route === '/calc_nst'
      ? `<script src="/assets/calc-report-cutoff.js?v=${calcReportCutoffVersion}" defer></script>`
      : '';
    const calcPrintDocument = route === '/calc_nst'
      ? `<script src="/assets/calc-print-document.js?v=${calcPrintDocumentVersion}" defer></script>`
      : '';
    html = `${html.slice(0, bodyEnd)}${cbrImporter}${calcReportCutoff}${calcPrintDocument}<script src="/assets/migration.js?v=${assetVersion}" defer></script>${html.slice(bodyEnd)}`;
  }
  html = html.replace(/[ \t]+$/gm, '');
  await fs.writeFile(file, html);
}

await fs.mkdir(path.join(root, 'assets'), { recursive: true });
await fs.writeFile(path.join(root, 'assets/contact-block.css'), `
.elegso-contact-card {
  --elegso-green: #355a56;
  --elegso-sand: #e5dcd0;
  --elegso-yellow: #ffde41;
  box-sizing: border-box;
  position: relative;
  z-index: 2;
  width: 100%;
  overflow: hidden;
  padding: 28px;
  border: 1px solid rgba(53, 90, 86, 0.2);
  border-radius: 16px;
  background: linear-gradient(145deg, #fff 0%, #f6f1ea 100%);
  box-shadow: 0 14px 36px rgba(0, 11, 48, 0.14);
  color: #333;
  font-family: Ubuntu, Arial, sans-serif;
  text-align: left;
}
.elegso-contact-card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 5px;
  background: var(--elegso-green);
}
.elegso-contact-card *,
.elegso-contact-card *::before,
.elegso-contact-card *::after { box-sizing: border-box; }
.elegso-contact-card__eyebrow {
  margin: 0 0 8px;
  color: var(--elegso-green);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.elegso-contact-card__title {
  color: #252d2b;
  font-size: clamp(24px, 3vw, 32px);
  font-weight: 500;
  line-height: 1.12;
}
.elegso-contact-card__lead {
  max-width: 680px;
  margin: 11px 0 20px;
  color: #5d625f;
  font-size: 14px;
  line-height: 1.5;
}
.elegso-contact-card__actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 11px;
}
.elegso-contact-card__action {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 9px;
  align-items: center;
  min-height: 76px;
  padding: 11px 12px;
  border-radius: 10px;
  text-decoration: none !important;
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}
.elegso-contact-card__action--mail {
  background: var(--elegso-green);
  box-shadow: 0 10px 20px rgba(53, 90, 86, 0.22);
  color: #fff !important;
}
.elegso-contact-card__action--phone {
  border: 1px solid rgba(53, 90, 86, 0.28);
  background: #fff;
  color: var(--elegso-green) !important;
}
.elegso-contact-card__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
}
.elegso-contact-card__action--phone .elegso-contact-card__icon {
  background: rgba(53, 90, 86, 0.09);
}
.elegso-contact-card__icon svg {
  width: 21px;
  height: 21px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.elegso-contact-card__action small,
.elegso-contact-card__action strong {
  display: block;
  overflow-wrap: anywhere;
}
.elegso-contact-card__action small {
  margin-bottom: 3px;
  font-size: 11px;
  line-height: 1.2;
  opacity: 0.76;
}
.elegso-contact-card__action strong {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.25;
  white-space: nowrap;
}
.elegso-contact-card__action--phone strong {
  font-size: 13px;
  letter-spacing: -0.01em;
}
.elegso-contact-card__arrow { display: none; }
.elegso-contact-card__details {
  display: grid;
  grid-template-columns: minmax(205px, 0.7fr) minmax(250px, 1.3fr);
  gap: 15px;
  margin-top: 17px;
  padding-top: 15px;
  border-top: 1px solid rgba(53, 90, 86, 0.16);
  color: #646966;
  font-size: 11px;
  line-height: 1.45;
}
.elegso-contact-card__details strong,
.elegso-contact-card__details span { display: block; }
.elegso-contact-card__details address {
  font: inherit;
  font-style: normal;
}
.elegso-contact-card__action:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 20px rgba(0, 11, 48, 0.16);
}
.elegso-contact-card__action:focus-visible {
  outline: 3px solid var(--elegso-yellow);
  outline-offset: 3px;
}
.elegso-contact-card--popup {
  padding: 22px;
  border-radius: 12px;
  box-shadow: none;
}
.elegso-contact-card--popup .elegso-contact-card__title { font-size: 25px; }
.elegso-contact-card--popup .elegso-contact-card__actions,
.elegso-contact-card--popup .elegso-contact-card__details { grid-template-columns: 1fr; }
.elegso-contact-card--calculator { margin-top: 28px; }
.t-popup.elegso-contact-popup--visible {
  display: block !important;
  opacity: 1 !important;
}
body.elegso-contact-popup-open { overflow: hidden; }
@media (max-width: 680px) {
  .elegso-contact-card { padding: 21px 17px; }
  .elegso-contact-card__actions,
  .elegso-contact-card__details { grid-template-columns: 1fr; }
  .elegso-contact-card__action { min-height: 72px; }
  .elegso-contact-card__title { font-size: 24px; }
  .elegso-contact-card__lead { font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .elegso-contact-card__action { transition: none; }
}
`, 'utf8');
await fs.writeFile(path.join(root, 'assets/footer-brand.css'), `
.elegso-site-signature {
  box-sizing: border-box;
  width: 100%;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  background: #2f504c;
  color: #fff;
  font-family: Ubuntu, Arial, sans-serif;
}
.elegso-site-signature *,
.elegso-site-signature *::before,
.elegso-site-signature *::after { box-sizing: border-box; }
.elegso-site-signature__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  width: min(1160px, calc(100% - 48px));
  min-height: 76px;
  margin: 0 auto;
  padding: 18px 0 18px 76px;
}
.elegso-site-signature__brand {
  flex: 0 0 auto;
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.25;
}
.elegso-site-signature__tagline {
  max-width: 650px;
  color: rgba(255, 255, 255, 0.84);
  font-size: 14px;
  font-weight: 300;
  line-height: 1.5;
  text-align: right;
}
@media (max-width: 680px) {
  .elegso-site-signature__inner {
    display: block;
    width: min(100% - 34px, 1160px);
    min-height: 0;
    padding: 20px 0 22px 76px;
  }
  .elegso-site-signature__brand,
  .elegso-site-signature__tagline { display: block; }
  .elegso-site-signature__tagline {
    margin-top: 7px;
    font-size: 13px;
    text-align: left;
  }
}
`, 'utf8');
await fs.writeFile(path.join(root, 'assets/migration.js'), `
function migrationHydrateImages() {
  document.querySelectorAll('img[data-original]').forEach((image) => {
    const source = image.getAttribute('data-original');
    if (source) image.src = source;
  });
  document.querySelectorAll('[data-original]:not(img)').forEach((element) => {
    const source = element.getAttribute('data-original');
    if (source) element.style.backgroundImage = 'url("' + source + '")';
  });
  document.querySelectorAll('[data-content-cover-bg]').forEach((element) => {
    const source = element.getAttribute('data-content-cover-bg');
    if (source) element.style.backgroundImage = 'url("' + source + '")';
  });
}
function migrationInitContactPopups() {
  const popups = Array.from(document.querySelectorAll('.t-popup')).filter((popup) => (
    popup.querySelector('.elegso-contact-card--popup')
  ));
  if (!popups.length) return;

  const popupByHook = (hook) => popups.find((popup) => popup.getAttribute('data-tooltip-hook') === hook);
  const storageKeyFor = (popup) => 'elegso-contact-popup-shown:' + popup.getAttribute('data-tooltip-hook');
  const wasShown = (popup) => {
    try { return window.sessionStorage.getItem(storageKeyFor(popup)) === '1'; } catch { return false; }
  };
  const markShown = (popup) => {
    try { window.sessionStorage.setItem(storageKeyFor(popup), '1'); } catch {}
  };
  const closePopup = (popup) => {
    popup.classList.remove('t-popup_show', 'elegso-contact-popup--visible');
    popup.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.elegso-contact-popup--visible')) {
      document.body.classList.remove('t-body_popupshowed', 'elegso-contact-popup-open');
    }
  };
  const openPopup = (popup) => {
    if (!popup) return;
    popup.classList.add('t-popup_show', 'elegso-contact-popup--visible');
    popup.setAttribute('aria-hidden', 'false');
    document.body.classList.add('t-body_popupshowed', 'elegso-contact-popup-open');
    markShown(popup);
    window.setTimeout(() => {
      const closeButton = popup.querySelector('.t-popup__close-wrapper');
      if (closeButton) closeButton.focus({ preventScroll: true });
    }, 0);
  };

  document.querySelectorAll('a[href^="#popup:"]').forEach((trigger) => {
    const popup = popupByHook(trigger.getAttribute('href'));
    if (!popup) return;
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      openPopup(popup);
    });
  });

  popups.forEach((popup) => {
    popup.setAttribute('aria-hidden', 'true');
    popup.querySelectorAll('.t-popup__close, .t-popup__close-wrapper').forEach((button) => {
      button.addEventListener('click', () => closePopup(popup));
    });
    popup.addEventListener('click', (event) => {
      if (event.target === popup) closePopup(popup);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    popups.filter((popup) => popup.classList.contains('elegso-contact-popup--visible'))
      .forEach(closePopup);
  });

  const hashPopup = popupByHook(window.location.hash);
  if (hashPopup) openPopup(hashPopup);

  document.querySelectorAll('.t724__opener[href^="#popup:"]').forEach((opener) => {
    const popup = popupByHook(opener.getAttribute('href'));
    if (!popup) return;
    const delay = Math.max(0, Number(opener.getAttribute('data-timeout') || 0) * 1000);
    if (wasShown(popup)) return;
    window.setTimeout(() => {
      if (wasShown(popup)) return;
      openPopup(popup);
    }, delay);
  });
}
function migrationInitLeaseBalanceCalculator() {
  const page = document.querySelector('[data-tilda-page-alias="calculator_of_the_balance_of_counter_obligations_in_leasing"]');
  const host = document.getElementById('rec1164640016');
  if (!page || !host || host.dataset.elegsoLeaseLoader === 'ready') return;
  host.dataset.elegsoLeaseLoader = 'ready';

  if (!document.querySelector('link[data-elegso-lease-styles]')) {
    const styles = document.createElement('link');
    styles.rel = 'stylesheet';
    styles.href = '/assets/lease-balance-calculator.css?v=20260719-4';
    styles.dataset.elegsoLeaseStyles = 'true';
    document.head.appendChild(styles);
  }

  if (!document.querySelector('script[data-elegso-lease-script]')) {
    const script = document.createElement('script');
    script.src = '/assets/lease-balance-calculator.js?v=20260719-4';
    script.defer = true;
    script.dataset.elegsoLeaseScript = 'true';
    document.body.appendChild(script);
  }
}
window.t_lazyload_update = migrationHydrateImages;
window.t_lazyload_updateResize_elem = migrationHydrateImages;
document.addEventListener('DOMContentLoaded', () => {
  migrationHydrateImages();
  migrationInitContactPopups();
  migrationInitLeaseBalanceCalculator();
});
`, 'utf8');

const liveRobots = await fetch('https://elegso.ru/robots.txt').then((r) => {
  if (!r.ok) throw new Error(`robots.txt: HTTP ${r.status}`);
  return r.text();
});
const liveSitemap = await fetch('https://elegso.ru/sitemap.xml').then((r) => {
  if (!r.ok) throw new Error(`sitemap.xml: HTTP ${r.status}`);
  return r.text();
});

const feedUrl = 'https://feeds.tildaapi.com/api/getfeed/?feeduid=944414567261&recid=1282040271&size=&slice=1&sort%5Bdate%5D=desc&filters%5Bdate%5D=&getparts=true';
const feed = await fetch(feedUrl).then((r) => {
  if (!r.ok) throw new Error(`feed: HTTP ${r.status}`);
  return r.json();
});
const feedAssetMap = new Map();
async function localizeFeedValue(value) {
  if (typeof value === 'string' && /^https:\/\/[^/]*tildacdn\.com\//i.test(value)) {
    if (feedAssetMap.has(value)) return feedAssetMap.get(value);
    const url = new URL(value);
    const localUrl = `/_external/${url.host}${url.pathname}`;
    const destination = path.join(root, localUrl.slice(1));
    const response = await fetch(value);
    if (!response.ok) throw new Error(`feed asset ${value}: HTTP ${response.status}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    feedAssetMap.set(value, localUrl);
    return localUrl;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = await localizeFeedValue(value[i]);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = await localizeFeedValue(value[key]);
  }
  return value;
}
await localizeFeedValue(feed);
await fs.mkdir(path.join(root, 'api/getfeed'), { recursive: true });
await fs.writeFile(path.join(root, 'api/getfeed/index.html'), JSON.stringify(feed), 'utf8');

const feedScript = path.join(root, '_external/static.tildacdn.com/js/tilda-feed-1.1.min.js');
try {
  let source = await fs.readFile(feedScript, 'utf8');
  source = source.replaceAll(
    '"https://"+window.t_feeds_endpoint',
    'window.location.protocol+"//"+window.location.host',
  );
  await fs.writeFile(feedScript, source, 'utf8');
} catch {
  // Pages without a feed do not download this optional module.
}
await fs.writeFile(path.join(root, 'robots.production.txt'), liveRobots, 'utf8');
await fs.writeFile(path.join(root, 'sitemap.xml'), liveSitemap, 'utf8');

// The staging hostname must never compete with production in search results.
await fs.writeFile(path.join(root, 'robots.txt'), [
  'User-agent: *',
  'Disallow: /',
  '',
].join('\n'), 'utf8');

// Reapply canonical URLs, indexing rules and the complete production sitemap
// after each fresh mirror so SEO settings cannot regress to Tilda defaults.
await import('./prepare-seo.mjs');

console.log('Finalized HTML metadata, branded footer and contact-only communication.');
