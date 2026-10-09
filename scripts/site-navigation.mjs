/** Crawlable primary navigation, shared by mirrored and generated pages. */
export function ensureSiteNavigation(html) {
  return html.replace(/<header\b[^>]*\bid="t-header"[\s\S]*?<\/header>/, header => {
    header = header.replace(/(<a\b[^>]*href="\/cases\/"[^>]*>)\s*(?:Кейсы|Наша практика)\s*(<\/a>)/g, '$1Успешный опыт$2');
    const item = /<li\b[^>]*class="[^"]*t228__list_item[^"]*"[^>]*>(?:(?!<\/li>)[\s\S])*?<\/li>/g;
    const items = [...header.matchAll(item)];
    if (items.some(match => match[0].includes('href="/cases/"'))) return header;
    const contacts = items.find(match => match[0].includes('href="/contacts/"'));
    if (!contacts) return header;
    const cases = contacts[0]
      .replace('href="/contacts/"', 'href="/cases/"')
      .replace(/>\s*Контакты\s*<\/a>/, '>Успешный опыт</a>')
      .replace('data-menu-submenu-hook=""', '')
      .replace('class="t228__list_item"', 'class="t228__list_item elegso-cases-nav-item"')
      .replace('class="t-menu__link-item"', 'class="t-menu__link-item elegso-cases-nav-link"')
      .replace('href="/cases/"', 'href="/cases/" data-elegso-cases-nav="true" title="Юридические проекты и решённые дела"');
    return header.slice(0, contacts.index) + cases + contacts[0].replace('data-menu-item-number="3"', 'data-menu-item-number="4"') + header.slice(contacts.index + contacts[0].length);
  });
}
