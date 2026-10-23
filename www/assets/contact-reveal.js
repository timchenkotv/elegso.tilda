(() => {
  'use strict';

  const oldNumber = /(?:\+7\s*\(?495\)?[\s-]*646[\s-]*00[\s-]*02)/g;
  const contact = /mail@elegso\.ru|\+7\s*\(?495\)?[\s-]*822[\s-]*19[\s-]*20/g;
  const oldDigits = /(?:\+?7[\s()-]*495[\s()-]*646[\s()-]*00[\s()-]*02)/g;
  const excluded = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'OPTION']);
  const archivedOffer = /^\/oferta(?:-fiz)?\/versions\//.test(location.pathname);

  function decorate(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !/mail@elegso\.ru|495/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || excluded.has(parent.tagName) || parent.closest('.elegso-contact-reveal')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const preserveArchive = archivedOffer && node.parentElement.closest('.eo-document');
      const text = preserveArchive ? node.nodeValue : node.nodeValue.replace(oldNumber, '+7 (495) 822-19-20');
      const matches = [...text.matchAll(contact)];
      if (!matches.length) {
        if (text !== node.nodeValue) node.nodeValue = text;
        continue;
      }
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of matches) {
        if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
        const span = document.createElement('span');
        span.className = 'elegso-contact-reveal';
        if (!node.parentElement.closest('a')) span.tabIndex = 0;
        span.textContent = match[0];
        fragment.append(span);
        cursor = match.index + match[0].length;
      }
      if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
      node.replaceWith(fragment);
    }
  }

  function updateLinks(root) {
    root.querySelectorAll('a[href^="tel:"]').forEach(link => {
      if (archivedOffer && link.closest('.eo-document')) return;
      const href = link.getAttribute('href');
      if (oldDigits.test(href)) link.setAttribute('href', 'tel:+74958221920');
      oldDigits.lastIndex = 0;
      if (link.getAttribute('aria-label')) link.setAttribute('aria-label', link.getAttribute('aria-label').replace(oldNumber, '+7 (495) 822-19-20'));
    });
  }

  function init() {
    if (!document.body) return;
    updateLinks(document.body);
    decorate(document.body);
    document.body.addEventListener('click', event => {
      const target = event.target.closest?.('.elegso-contact-reveal');
      if (!target || !window.matchMedia('(hover: none)').matches || target.classList.contains('is-revealed')) return;
      event.preventDefault();
      target.classList.add('is-revealed');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
