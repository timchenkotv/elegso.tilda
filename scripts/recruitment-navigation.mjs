/** Add a separate business service without turning it into a legal-practice card. */
export function addRecruitmentNavigation(html) {
  if (html.includes('data-recruitment-footer')) return html;
  const start = html.indexOf('<!--header-->');
  const end = html.indexOf('</header>', start);
  if (start < 0 || end < start) return html;
  let header = html.slice(start, end + 9);
  if (!header.includes('data-recruitment-desktop-link')) {
    header = header.replace(/(<div class="mega-calculators">)([\s\S]*?)(<\/div>)/,
      '$1$2<a data-recruitment-desktop-link href="/recruitment/">Подбор персонала →</a>$3');
  }
  if (!header.includes('data-recruitment-mobile-link')) {
    header = header.replace(/(<div class="mobile-menu__inner">)/,
      '$1<a data-recruitment-mobile-link href="/recruitment/">Подбор персонала →</a>');
  }
  html = html.slice(0, start) + header + html.slice(end + 9);
  const footerStart = html.indexOf('<!--footer-->');
  if (footerStart < 0) return html;
  let footer = html.slice(footerStart);
  if (!footer.includes('data-recruitment-footer-link')) {
    footer = footer.replace(/(<nav class="footer-tools"[^>]*>)/,
      '$1<a data-recruitment-footer-link href="/recruitment/">Подбор персонала</a>');
  }
  return html.slice(0, footerStart) + footer;
}
