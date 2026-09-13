/** Shared footer presentation only; never authors article or contract content. */
export const footerCardsVersion = '20260913-unified-1';
export const footerStylesHref = `/assets/footer-cards.css?v=${footerCardsVersion}`;
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const defaultOffers = [{id:'business',url:'/oferta/'},{id:'individual',url:'/oferta-fiz/'}];

export function footerCard(kind, offers = defaultOffers) {
  const data = {
    cases: {title:'Наши кейсы',description:'Решённые юридические задачи и подтверждённые результаты',image:'leasing-lawyer-when-to-contact',action:'Смотреть дела',url:'/cases/'},
    articles: {title:'Статьи',description:'Юридические разборы и рекомендации для бизнеса',image:'electronic-documents-court-evidence',action:'Читать статьи',url:'/articles/'},
    offers: {title:'Условия сотрудничества',description:'Порядок работы, условия оказания услуг и действующие оферты',image:'cooperation-terms'},
  }[kind];
  if (!data) throw new Error(`Unknown footer card: ${kind}`);
  const prefix = kind === 'offers' ? 'eo-footer' : `elegso-${kind}-footer-card`;
  const image = `<img class="${prefix}__image" src="/assets/publications/${data.image}-600.webp" alt="" width="96" height="96" loading="lazy" decoding="async">`;
  const copy = `<span class="elegso-footer-tile__copy"><strong class="${prefix}__title">${data.title}</strong><span class="${prefix}__text">${data.description}</span></span>`;
  const content = kind === 'offers'
    ? `<nav class="eo-footer elegso-footer-tile elegso-footer-tile--offers" aria-label="Условия сотрудничества">${image}${copy}<span class="elegso-footer-tile__actions eo-footer__links">${offers.map(offer => {
      if (!/^\/(?!\/)[a-z0-9_/-]*\/$/.test(offer.url)) throw new Error('Unsafe footer offer URL');
      return `<a class="elegso-footer-tile__button" href="${esc(offer.url)}">${offer.id === 'business' ? 'Оферта для бизнеса' : 'Оферта для физических лиц'}<span aria-hidden="true">→</span></a>`;
    }).join('')}</span></nav>`
    : `<a class="${prefix} elegso-footer-tile" href="${data.url}">${image}${copy}<span class="${prefix}__action elegso-footer-tile__button" aria-hidden="true">${data.action}<span>→</span></span></a>`;
  return `<!--elegso-${kind}-footer:start--><div class="r t-rec elegso-footer-tile-wrap" data-elegso-${kind}-footer><link rel="stylesheet" href="${footerStylesHref}" data-elegso-footer-styles>${content}</div><!--elegso-${kind}-footer:end-->`;
}

export function replaceFooterCard(html, kind, offers = defaultOffers) {
  const marker = new RegExp(`<!--elegso-${kind}-footer:start-->[\\s\\S]*?<!--elegso-${kind}-footer:end-->`, 'g');
  return html.replace(marker, footerCard(kind, offers));
}

export function casesFooterRuntime() {
  return `function migrationInitCasesFooterCard() {
  const footer = document.getElementById('t-footer');
  if (!footer || footer.querySelector('.elegso-cases-footer-card')) return;
  footer.insertAdjacentHTML('afterbegin', ${JSON.stringify(footerCard('cases'))});
}`;
}

export function enhanceFooterDetails(body) {
  const paths = {
    title: '<path d="M8 23 24 10l16 13M12 21v19h24V21M21 40V29h8v11M7 40h34"/><path d="M18 21h2m8 0h2"/>',
    title2: '<path d="M5 13h24v23H5zM29 22h8l6 8v6H29M29 30h14"/><circle cx="13" cy="37" r="4"/><circle cx="36" cy="37" r="4"/><path d="M11 20h12M11 26h8"/>',
    title3: '<path d="M10 6h19l9 9v26H10zM28 6v10h10M16 23h15M16 29h15M16 35h9"/><path d="m30 36 10-10 4 4-10 10-6 2z"/>',
    title4: '<path d="m11 10 5-5 17 17-5 5zM8 13l5-5m15 17 5-5M23 21l-9 9m8-10 18 18M7 37h18v6H7zM4 43h24"/>',
  };
  body = body.replace(/<!--elegso-footer-icon:start-->[\s\S]*?<!--elegso-footer-icon:end-->/g, '');
  body = body.replace(/<div\b(?=[^>]*\bclass="[^"]*\bt344__title\b)[^>]*\bfield="(title[234]?)"[^>]*>/g, (tag, field) => {
    const drawing = paths[field];
    return drawing ? tag + `<!--elegso-footer-icon:start--><span class="elegso-footer-service-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">${drawing}</svg></span><!--elegso-footer-icon:end-->` : tag;
  });
  body = body.replace(/<div\b(?=[^>]*\bid="rec1169360821")[^>]*>/, tag => tag.includes('data-elegso-footer-services') ? tag : tag.replace(/>$/, ' data-elegso-footer-services>'));
  body = body.replace(/<div\b(?=[^>]*\bid="rec1169591771")[^>]*>/, tag => tag.includes('data-elegso-footer-legal') ? tag : tag.replace(/>$/, ' data-elegso-footer-legal>'));
  // The one requested label correction retains the original href and styling.
  body = body.replace(/(<a\b[^>]*href="\/offer_for_lawyer_20231103\/"[^>]*>)Информация<\/a>\s*для исполнителей\./g, '$1Присоединение исполнителей</a>');
  return body;
}

export function updateFooterCards(html, offers = defaultOffers) {
  const start = html.search(/<footer\b[^>]*\bid=["']t-footer["'][^>]*>/i);
  if (start < 0) return html;
  const openEnd = html.indexOf('>', start) + 1;
  const end = html.indexOf('</footer>', openEnd);
  if (end < 0) throw new Error('Unclosed site footer');
  let body = html.slice(openEnd, end);
  body = body.replace(/<!--elegso-footer-featured:start--><div class="elegso-footer-featured">([\s\S]*?)<\/div><!--elegso-footer-featured:end-->/g, '$1');
  for (const kind of ['cases', 'articles', 'offers']) {
    const marker = new RegExp(`<!--elegso-${kind}-footer:start-->[\\s\\S]*?<!--elegso-${kind}-footer:end-->`, 'g');
    const count = [...body.matchAll(marker)].length;
    if (count > 1) throw new Error(`Duplicate ${kind} footer cards`);
    body = body.replace(marker, '');
    if (body.includes(`data-elegso-${kind}-footer`)) throw new Error(`Unmarked legacy ${kind} footer; inspect before replacement`);
  }
  body = enhanceFooterDetails(body);
  // Keep service/link content intact. All three cards have a
  // predictable order, independently of which generator last touched a page.
  const cards = '<!--elegso-footer-featured:start--><div class="elegso-footer-featured">' + ['cases', 'articles', 'offers'].map(kind => footerCard(kind, offers)).join('') + '</div><!--elegso-footer-featured:end-->';
  return html.slice(0, openEnd) + cards + body + html.slice(end);
}
