/** Static shared contact section, used by every public-page footer. */
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const contactMarker = /<!--elegso-contact-footer:start-->[\s\S]*?<!--elegso-contact-footer:end-->/g;

// Exported Tilda records contain nested divs, scripts and comments. Balance
// actual div tags instead of stopping at the first closing tag or next record.
function divEnd(html, start) {
  const tokens = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<\/?div\b[^>]*>/gi;
  tokens.lastIndex = start;
  let depth = 0;
  for (let match; (match = tokens.exec(html));) {
    if (!/^<\/?div\b/i.test(match[0])) continue;
    depth += /^<\//.test(match[0]) ? -1 : 1;
    if (depth === 0) return tokens.lastIndex;
  }
  throw new Error('Unclosed legacy contact record');
}

export function prepareContactFooter(html) {
  const existing = [...html.matchAll(contactMarker)];
  if (existing.length > 1) throw new Error('Duplicate shared contact footers');
  let context = existing[0]?.[0].match(/<!--elegso-contact-context:start-->([\s\S]*?)<!--elegso-contact-context:end-->/)?.[1] || '';
  let aliases = [...(existing[0]?.[0] || '').matchAll(/data-elegso-contact-alias id="(rec\d+)"/g)].map(m => m[1]);
  html = html.replace(contactMarker, '');
  const records = [...html.matchAll(/<div\b(?=[^>]*\bid="rec\d+")(?=[^>]*\bdata-record-type="712")[^>]*>/g)];
  const replacements = [];
  for (const record of records) {
    const end = divEnd(html, record.index);
    const block = html.slice(record.index, end);
    if (!block.includes('data-elegso-contact-panel')) continue;
    const title = block.match(/<(div|h[1-6])\b[^>]*\bclass="[^"]*\bt712__title(?=[\s"])[^>]*>/);
    if (!title) throw new Error('Missing legacy contact title');
    const endTitle = title[1] === 'div' ? divEnd(block, title.index) - 6 : block.indexOf(`</${title[1]}>`, title.index);
    if (endTitle < 0) throw new Error('Unclosed legacy contact title');
    const text = block.slice(title.index + title[0].length, endTitle)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Keep each service's existing, indexed call to action. Generic headings
    // are already covered by the shared heading and need no second copy.
    if (text && !/^(?:Защитите свои права — начните|Получите профессиональную поддержку арбитражного юриста)/.test(text)) {
      context += `<p class="elegso-contact-footer__context">${text}</p>`;
    }
    aliases.push(record[0].match(/\bid="(rec\d+)"/)[1]);
    replacements.push({start: record.index, end});
  }
  if (replacements.length > 1) throw new Error('Multiple legacy contact sections; inspect before replacing');
  for (const {start, end} of replacements.reverse()) html = html.slice(0, start) + html.slice(end);
  return {html, context, aliases: [...new Set(aliases)]};
}

export function contactFooter({context = '', aliases = []} = {}) {
  return `<!--elegso-contact-footer:start--><section id="elegso-contact" class="elegso-contact-footer" aria-labelledby="elegso-contact-title" tabindex="-1">
${aliases.map(id => `<span data-elegso-contact-alias id="${escape(id)}"></span>`).join('')}
<div class="elegso-contact-footer__inner">
  <div class="elegso-contact-footer__intro">
    <p class="elegso-contact-footer__eyebrow">Современная юридическая помощь</p>
    <h2 id="elegso-contact-title">Получите профессиональную поддержку арбитражного юриста</h2>
    <p class="elegso-contact-footer__lead">Свяжитесь с нами для бесплатной консультации.</p>
    <!--elegso-contact-context:start-->${context}<!--elegso-contact-context:end-->
    <p class="elegso-contact-footer__text">Расскажите о вашей ситуации. Поможем определить следующий шаг и обсудим, какие документы понадобятся для разбора.</p>
    <div class="elegso-contact-footer__address"><strong>ООО «ЮК ЭЛЕГСО»</strong><span>ИНН 7733472977 · ОГРН 1257700349004</span><address>Москва, ул. Бутлерова, 17, БЦ «Нео Гео», блок С, коворкинг «Ворки», этаж 4, офис С01</address></div>
  </div>
  <div class="elegso-contact-footer__panel" data-elegso-contact-panel>
    <p class="elegso-contact-footer__eyebrow">Свяжитесь с профильным юристом</p>
    <h3>Свяжитесь удобным способом</h3>
    <p>Напишите на электронную почту или позвоните. Мы ответим в рабочее время.</p>
    <a class="elegso-contact-footer__action" href="mailto:mail@elegso.ru"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18v12H3zM3 6l9 7 9-7"/></svg><span><small>Написать юристу</small><strong>mail@elegso.ru</strong></span><b aria-hidden="true">↗</b></a>
    <a class="elegso-contact-footer__action" href="tel:+74956460002"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3 4 5c-2 2 1 7 4 10s8 6 10 4l2-3-5-3-2 2-4-4 2-2z"/></svg><span><small>Позвонить</small><strong>+7 (495) 646-00-02</strong></span><b aria-hidden="true">↗</b></a>
    <a class="elegso-contact-footer__details" href="/contacts/">Контакты и схема проезда <span aria-hidden="true">→</span></a>
  </div>
</div></section><!--elegso-contact-footer:end-->`;
}
