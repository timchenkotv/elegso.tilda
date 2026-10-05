/** Shared logo/header presentation. Original and previous image files are retained. */
export const previousLogo = '/_external/static.tildacdn.com/tild6636-3836-4134-b236-373062316464/_v6_.png';
export const alternateLogo = '/assets/brand/elegso-logo-2026-10-05.png';
export const currentLogo = previousLogo;
export const brandVersion = '20261005-logo-2';

export function updateSiteBrand(html) {
  html = html.replaceAll(alternateLogo, currentLogo);
  html = html.replace(/(src="\/assets\/migration\.js)(?:\?[^"\s]*)?/g, `$1?v=${brandVersion}`);
  if (!/<header\b[^>]*\bid="t-header"/.test(html)) return html;
  const styles = `<link rel="stylesheet" href="/assets/site-brand.css?v=${brandVersion}" data-elegso-brand-styles>`;
  html = html.replace(/<link\b[^>]*\bdata-elegso-brand-styles[^>]*>/g, '');
  html = html.replace('</head>', styles + '</head>');
  // Keep the mobile company name and menu button; add a compact home link.
  if (!html.includes('data-elegso-mobile-brand')) {
    html = html.replace('<div class="tmenu-mobile__text', `<a class="elegso-mobile-brand" data-elegso-mobile-brand href="/" aria-label="ЭЛЕГСО — главная"><img src="${currentLogo}" alt="" width="38" height="48" decoding="async"></a><div class="tmenu-mobile__text`);
  }
  return html;
}
