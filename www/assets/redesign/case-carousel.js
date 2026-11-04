(function (window, document) {
  'use strict';
  if (window.ElegsoCaseCarousel) return;

  var ROOT = '[data-elegso-case-carousel]';
  var FALLBACK = '/assets/redesign/leasing-balance.webp';
  var feeds = new Map();
  var controllers = new WeakMap();
  var serial = 0;
  var labels = {
    won: 'Победа', partial_win: 'Успех', settlement: 'Мировое соглашение',
    pretrial_success: 'Досудебный успех', in_progress: 'Работа продолжается',
    dismissed: 'Требования прекращены', refused: 'В иске отказано',
    lost: 'Неблагоприятный результат', other: 'Результат в истории дела'
  };

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function localURL(value, kind, slug) {
    if (typeof value !== 'string' || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      var url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.username || url.password) return null;
      if (kind === 'feed' && !/^\/cases\/[a-z0-9][a-z0-9._-]*\.json$/.test(url.pathname)) return null;
      if (kind === 'case' && url.pathname !== '/cases/' + slug + '/') return null;
      if (kind === 'image' && !new RegExp('^/cases/' + slug + '/illustration-[a-f0-9]{64}\\.(?:webp|png|jpg|jpeg)$').test(url.pathname)) return null;
      url.hash = kind === 'case' ? url.hash : '';
      return url.pathname + url.search + url.hash;
    } catch (_) { return null; }
  }
  function count(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }
  function normaliseFeed(feed) {
    if (!feed || feed.version !== 1 || !Array.isArray(feed.items) || feed.items.length > 10000) throw new Error('Invalid case feed');
    var seen = new Set();
    return feed.items.reduce(function (items, item) {
      if (!item || typeof item !== 'object') return items;
      var slug = cleanText(item.slug);
      var title = cleanText(item.title);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !title || seen.has(slug)) return items;
      seen.add(slug);
      var image = item.illustration && localURL(item.illustration.url, 'image', slug);
      var outcome = Object.prototype.hasOwnProperty.call(labels, item.outcome_kind) ? item.outcome_kind : 'other';
      var amount = Number(item.protected_interest_amount);
      var protectedAmount = Number.isFinite(amount) && amount > 0 ? amount : null;
      var date = cleanText(item.document_date);
      var validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date));
      items.push({
        code: cleanText(item.code) || slug, slug: slug,
        url: localURL(item.url, 'case', slug) || '/cases/' + slug + '/',
        title: title, excerpt: cleanText(item.excerpt),
        outcome_kind: outcome, outcome_label: cleanText(item.outcome_label) || labels[outcome],
        document_date: validDate ? date : '',
        formatted_date: cleanText(item.formatted_date) || (validDate ? date.split('-').reverse().join('.') : ''),
        case_number: cleanText(item.case_number), category: cleanText(item.category),
        protected_interest_amount: protectedAmount,
        protected_interest_label: protectedAmount ? cleanText(item.protected_interest_label) || new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(protectedAmount) + ' ₽' : '',
        duration_days: count(item.duration_days), duration_label: cleanText(item.duration_label),
        court_instance_count: count(item.court_instance_count),
        illustration: image ? { url: image, alt: cleanText(item.illustration.alt) || title } : null
      });
      return items;
    }, []);
  }
  function categoryMatches(item, category) {
    var text = (item.category + ' ' + item.title + ' ' + item.excerpt).toLocaleLowerCase('ru-RU');
    if (category === 'leasing') return /лизинг|leasing/.test(text);
    if (category === 'bankruptcy') return /банкрот|несостоятельн|конкурсн|арбитражн.{0,12}управляющ/.test(text);
    if (category === 'international') return /международ|иностран|трансгран|экзекватур|international|exequatur/.test(text);
    return true;
  }
  function getFeed(source) {
    var key = new URL(source, window.location.origin).href;
    if (!feeds.has(key)) {
      feeds.set(key, (async function () {
        var abort = typeof window.AbortController === 'function' ? new window.AbortController() : null;
        var timer = abort ? window.setTimeout(function () { abort.abort(); }, 15000) : null;
        try {
          var response = await window.fetch(source, { credentials: 'omit', mode: 'same-origin', cache: 'no-cache', headers: { Accept: 'application/json' }, signal: abort ? abort.signal : undefined });
          if (!response.ok || (response.url && new URL(response.url).origin !== window.location.origin)) throw new Error('Case feed unavailable');
          var body = await response.text();
          if (body.length > 4 * 1024 * 1024) throw new Error('Case feed too large');
          return normaliseFeed(JSON.parse(body));
        } finally { if (timer !== null) window.clearTimeout(timer); }
      })());
    }
    return feeds.get(key);
  }
  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function mark(element, name) { element.setAttribute(name, ''); return element; }
  function ensure(parent, selector, tag, className, attribute) {
    var element = parent.querySelector(selector);
    if (!element) { element = mark(node(tag, className), attribute); parent.appendChild(element); }
    return element;
  }
  function plural(number, forms) {
    var mod100 = number % 100, mod10 = number % 10;
    return number + ' ' + forms[mod100 >= 11 && mod100 <= 14 ? 2 : mod10 === 1 ? 0 : mod10 >= 2 && mod10 <= 4 ? 1 : 2];
  }
  function metric(label, value, className) {
    var element = node('div', 'ecc__metric' + (className ? ' ' + className : ''));
    element.appendChild(node('small', '', label));
    element.appendChild(node('strong', '', value));
    return element;
  }
  function renderCard(item, instance, index) {
    var card = mark(node('article', 'ecc__card proof-card'), 'data-case-carousel-card');
    card.setAttribute('role', 'listitem');
    card.setAttribute('data-case-code', item.code);
    var link = node('a', 'ecc__surface');
    link.href = item.url;
    link.draggable = false;
    link.setAttribute('aria-labelledby', 'ecc-' + instance + '-' + index);
    var media = node('div', 'ecc__media proof-media');
    var image = node('img');
    image.src = item.illustration ? item.illustration.url : FALLBACK;
    image.alt = item.illustration ? item.illustration.alt : 'Иллюстрация юридической практики';
    image.width = 1600; image.height = 900;
    image.loading = 'lazy'; image.decoding = 'async'; image.draggable = false;
    media.appendChild(image);
    media.appendChild(node('span', 'ecc__number proof-case-badge', item.case_number ? 'Дело № ' + item.case_number.replace(/^№\s*/, '') : 'Практика ЭЛЕГСО'));
    var top = node('div', 'ecc__top proof-top');
    top.appendChild(node('span', 'ecc__outcome ecc__outcome--' + item.outcome_kind + ' proof-tag', item.outcome_label));
    if (item.formatted_date) {
      var date = node('time', 'ecc__date proof-date', item.formatted_date);
      if (item.document_date) date.dateTime = item.document_date;
      top.appendChild(date);
    }
    var title = node('h3', 'ecc__title', item.title);
    title.id = 'ecc-' + instance + '-' + index;
    var excerpt = node('p', 'ecc__excerpt', item.excerpt);
    var metrics = node('div', 'ecc__metrics');
    if (item.protected_interest_amount) {
      var protectedMetric = metric('Защищено', item.protected_interest_label, 'ecc__metric--protected');
      protectedMetric.title = 'Защищённый имущественный интерес — ' + item.protected_interest_label;
      metrics.appendChild(protectedMetric);
    }
    if (item.duration_days !== null) metrics.appendChild(metric('Длительность', item.duration_label || plural(item.duration_days, ['день', 'дня', 'дней'])));
    if (item.court_instance_count !== null) metrics.appendChild(metric('Инстанции', String(item.court_instance_count)));
    if (!metrics.children.length) metrics.appendChild(metric('Результат', 'В истории дела'));
    var foot = node('span', 'ecc__foot');
    foot.appendChild(node('span', '', 'Читать историю'));
    var arrow = node('span', 'ecc__link-arrow', '→'); arrow.setAttribute('aria-hidden', 'true'); foot.appendChild(arrow);
    [media, top, title, excerpt, metrics, foot].forEach(function (element) { link.appendChild(element); });
    card.appendChild(link);
    return card;
  }

  function initMotion(root, shell, cards) {
    var viewport = shell.viewport, track = shell.track;
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    var paused = reduced.matches || root.getAttribute('data-case-autoplay') === 'false';
    var hover = false, focused = false, visible = true, pointer = null, draggedAt = -Infinity;
    var period = 0, origin = 0, position = 0, copies = 0, velocity = 0, last = 0, idleUntil = 0, raf = 0;
    var destroyed = false, listeners = [], observers = [];
    var speed = Number(root.getAttribute('data-case-speed') || 18);
    speed = Number.isFinite(speed) ? Math.max(0, Math.min(80, speed)) : 18;
    function on(element, type, handler, options) {
      element.addEventListener(type, handler, options);
      listeners.push(function () { element.removeEventListener(type, handler, options); });
    }
    function modulo(value, size) { return ((value % size) + size) % size; }
    function rest() { idleUntil = window.performance.now() + 5000; }
    function settle() {
      if (!period) return;
      position = origin + modulo(position - origin, period);
      viewport.scrollLeft = position;
    }
    function move(delta) { position += delta; settle(); }
    function label() {
      shell.pause.textContent = paused ? 'Пуск' : 'Пауза';
      shell.pause.setAttribute('aria-pressed', String(paused));
      shell.pause.setAttribute('aria-label', paused ? 'Включить автоматическое движение дел' : 'Приостановить автоматическое движение дел');
      root.setAttribute('data-case-motion', paused ? 'paused' : 'playing');
    }
    function clone(card) {
      var copy = card.cloneNode(true);
      mark(copy, 'data-case-carousel-copy'); copy.setAttribute('aria-hidden', 'true'); copy.removeAttribute('id');
      copy.querySelectorAll('[id]').forEach(function (element) { element.removeAttribute('id'); });
      copy.querySelectorAll('a,button,input,select,textarea,[tabindex]').forEach(function (element) { element.setAttribute('tabindex', '-1'); element.removeAttribute('aria-labelledby'); });
      return copy;
    }
    function rebuild() {
      if (destroyed) return;
      var gap = parseFloat(window.getComputedStyle(track).columnGap) || 0;
      var nextPeriod = cards.reduce(function (sum, card) { return sum + card.getBoundingClientRect().width + gap; }, 0);
      if (!nextPeriod || !viewport.clientWidth) return;
      var nextCopies = Math.max(1, Math.ceil(viewport.clientWidth / nextPeriod));
      if (Math.abs(nextPeriod - period) < 0.1 && nextCopies === copies) return;
      var phase = period ? modulo(position - origin, period) / period : 0;
      track.querySelectorAll('[data-case-carousel-copy]').forEach(function (copy) { copy.remove(); });
      var before = document.createDocumentFragment(), after = document.createDocumentFragment();
      for (var i = 0; i < nextCopies; i += 1) cards.forEach(function (card) { before.appendChild(clone(card)); after.appendChild(clone(card)); });
      track.insertBefore(before, cards[0]); track.appendChild(after);
      period = nextPeriod; copies = nextCopies; origin = period * copies; position = origin + phase * period;
      settle(); start();
    }
    function announce() {
      if (!period) return;
      var offset = modulo(position - origin, period), gap = parseFloat(window.getComputedStyle(track).columnGap) || 0;
      var index = 0;
      while (index < cards.length - 1 && offset >= cards[index].getBoundingClientRect().width + gap) { offset -= cards[index].getBoundingClientRect().width + gap; index += 1; }
      shell.status.textContent = plural(cards.length, ['дело', 'дела', 'дел']) + '. ' + (index + 1) + ' из ' + cards.length;
    }
    function step(direction) {
      velocity = 0; rest(); position = viewport.scrollLeft;
      move(direction * (cards[0].getBoundingClientRect().width + (parseFloat(window.getComputedStyle(track).columnGap) || 0)));
      announce();
    }
    function frame(now) {
      raf = 0;
      if (destroyed || !visible || document.hidden) { last = 0; return; }
      if (!last) last = now;
      var elapsed = now - last;
      if (elapsed >= 30) {
        last = now; elapsed = Math.min(80, elapsed);
        if (!pointer) {
          if (Math.abs(velocity) > 0.02) { move(velocity * elapsed); velocity *= Math.pow(0.91, elapsed / 16.7); }
          else if (!paused && !hover && !focused && now > idleUntil) move(elapsed * speed / 1000);
        }
      }
      start();
    }
    function start() { if (!destroyed && visible && !document.hidden && period && !raf) raf = window.requestAnimationFrame(frame); }
    function stop() { if (raf) window.cancelAnimationFrame(raf); raf = 0; last = 0; velocity = 0; }
    on(shell.prev, 'click', function () { step(-1); });
    on(shell.next, 'click', function () { step(1); });
    on(shell.pause, 'click', function () { paused = !paused; velocity = 0; idleUntil = 0; label(); start(); });
    on(reduced, 'change', function () { paused = reduced.matches; velocity = 0; label(); start(); });
    on(viewport, 'pointerenter', function (event) { if (event.pointerType === 'mouse') hover = true; });
    on(viewport, 'pointerleave', function () { hover = false; });
    on(viewport, 'focusin', function () { focused = true; });
    on(viewport, 'focusout', function () { focused = false; rest(); });
    on(viewport, 'dragstart', function (event) { event.preventDefault(); });
    on(viewport, 'wheel', function (event) {
      var delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
      if (!delta) return;
      event.preventDefault(); velocity = 0; rest();
      move(delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1));
    }, { passive: false });
    on(viewport, 'pointerdown', function (event) {
      if (event.isPrimary === false || event.button !== 0 || pointer) return;
      rest(); velocity = 0; draggedAt = -Infinity; position = viewport.scrollLeft;
      var now = window.performance.now();
      pointer = { id: event.pointerId, x: event.clientX, start: event.clientX, startY: event.clientY, at: now, dragging: false, samples: [{ x: event.clientX, at: now }] };
    });
    on(window, 'pointermove', function (event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (!pointer.dragging && event.pointerType !== 'mouse' && Math.abs(event.clientY - pointer.startY) > Math.max(6, Math.abs(event.clientX - pointer.start))) { pointer = null; velocity = 0; return; }
      if (!pointer.dragging && Math.abs(event.clientX - pointer.start) < 6) return;
      if (!pointer.dragging) {
        pointer.dragging = true; viewport.classList.add('is-dragging');
        try { viewport.setPointerCapture(event.pointerId); } catch (_) { /* Window handlers retain the drag. */ }
      }
      event.preventDefault();
      var now = window.performance.now();
      pointer.samples.push({ x: event.clientX, at: now });
      while (pointer.samples.length > 2 && now - pointer.samples[0].at > 100) pointer.samples.shift();
      var sample = pointer.samples[0];
      velocity = Math.max(-2.5, Math.min(2.5, (sample.x - event.clientX) / Math.max(8, now - sample.at)));
      move(pointer.x - event.clientX); pointer.x = event.clientX; pointer.at = now; rest();
    }, { passive: false });
    function release(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      var capture = pointer.id;
      if (pointer.dragging) {
        draggedAt = window.performance.now();
        if (draggedAt - pointer.at > 100 || reduced.matches || event.type !== 'pointerup') velocity = 0;
        if (viewport.contains(document.activeElement) && document.activeElement.blur) document.activeElement.blur();
        focused = false;
      }
      pointer = null; viewport.classList.remove('is-dragging');
      if (viewport.hasPointerCapture && viewport.hasPointerCapture(capture)) viewport.releasePointerCapture(capture);
      rest(); start();
    }
    on(window, 'pointerup', release); on(window, 'pointercancel', release); on(viewport, 'lostpointercapture', release);
    on(window, 'blur', function () { if (pointer) release({ pointerId: pointer.id, type: 'blur' }); velocity = 0; });
    on(viewport, 'click', function (event) {
      if (window.performance.now() - draggedAt < 350) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    on(viewport, 'keydown', function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1); }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); rest(); velocity = 0;
        position = origin + (event.key === 'End' ? period - cards[cards.length - 1].getBoundingClientRect().width - (parseFloat(window.getComputedStyle(track).columnGap) || 0) : 0);
        settle(); announce();
      }
    });
    on(viewport, 'scroll', function () {
      if (Math.abs(viewport.scrollLeft - position) > 1) { position = viewport.scrollLeft; settle(); }
    }, { passive: true });
    on(document, 'visibilitychange', function () { if (document.hidden) stop(); else start(); });
    if (typeof window.IntersectionObserver === 'function') {
      var intersection = new window.IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; if (visible) start(); else stop(); }, { threshold: 0.01 });
      intersection.observe(viewport); observers.push(intersection);
    }
    if (typeof window.ResizeObserver === 'function') {
      var resize = new window.ResizeObserver(rebuild); resize.observe(viewport); cards.forEach(function (card) { resize.observe(card); }); observers.push(resize);
    } else on(window, 'resize', rebuild);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(rebuild);
    rebuild(); label();
    return {
      previous: function () { step(-1); }, next: function () { step(1); },
      pause: function () { paused = true; velocity = 0; label(); },
      play: function () { paused = false; idleUntil = 0; label(); start(); },
      state: function () { return { paused: paused, count: cards.length, period: period, position: position, origin: origin, visible: visible }; },
      destroy: function () { destroyed = true; stop(); listeners.forEach(function (off) { off(); }); observers.forEach(function (observer) { observer.disconnect(); }); track.querySelectorAll('[data-case-carousel-copy]').forEach(function (copy) { copy.remove(); }); }
    };
  }

  async function init(root) {
    if (!root || !root.querySelector) return null;
    if (controllers.has(root)) return controllers.get(root);
    var promise = (async function () {
      var id = ++serial, disposed = false, items = [], motion = null, rememberedPause = null, listeners = [];
      root.classList.add('elegso-case-carousel');
      root.setAttribute('aria-roledescription', 'карусель');
      if (!root.getAttribute('aria-label') && !root.getAttribute('aria-labelledby')) root.setAttribute('aria-label', 'Успешный опыт ЭЛЕГСО');
      var viewport = ensure(root, '[data-case-carousel-viewport]', 'div', 'ecc__viewport', 'data-case-carousel-viewport');
      viewport.classList.add('ecc__viewport'); viewport.tabIndex = 0;
      viewport.setAttribute('aria-label', 'Дела. Перетаскивайте или используйте стрелки влево и вправо');
      var track = viewport.querySelector('[data-case-carousel-track]') || root.querySelector('[data-case-carousel-track]');
      if (!track) track = mark(node('div', 'ecc__track'), 'data-case-carousel-track');
      track.classList.add('ecc__track'); if (track.parentElement !== viewport) viewport.appendChild(track);
      track.setAttribute('role', 'list'); track.setAttribute('aria-live', 'off');
      var toolbar = ensure(root, '[data-case-carousel-toolbar]', 'div', 'ecc__toolbar', 'data-case-carousel-toolbar');
      toolbar.classList.add('ecc__toolbar');
      var hint = ensure(toolbar, '[data-case-carousel-hint]', 'p', 'ecc__hint', 'data-case-carousel-hint');
      hint.textContent = '← Листайте или перетаскивайте →';
      var controls = ensure(toolbar, '[data-case-carousel-controls]', 'div', 'ecc__controls', 'data-case-carousel-controls');
      controls.classList.add('ecc__controls'); controls.hidden = false;
      function button(attribute, title, text) {
        var element = root.querySelector('[' + attribute + ']');
        if (!element) { element = mark(node('button', 'ecc__control', text), attribute); controls.appendChild(element); }
        element.classList.add('ecc__control'); element.type = 'button'; element.hidden = false; element.setAttribute('aria-label', title);
        if (!element.textContent.trim()) element.textContent = text;
        return element;
      }
      var shell = { viewport: viewport, track: track,
        prev: button('data-case-carousel-prev', 'Предыдущее дело', '←'),
        next: button('data-case-carousel-next', 'Следующее дело', '→'),
        pause: button('data-case-carousel-pause', 'Приостановить автоматическое движение дел', 'Пауза'),
        status: ensure(root, '[data-case-carousel-status]', 'p', 'ecc__status', 'data-case-carousel-status') };
      shell.status.classList.add('ecc__status'); shell.status.setAttribute('role', 'status'); shell.status.setAttribute('aria-live', 'polite');
      var category = ensure(toolbar, '[data-case-carousel-category]', 'select', 'ecc__category', 'data-case-carousel-category');
      category.classList.add('ecc__category'); category.setAttribute('aria-label', 'Направление судебной практики');
      if (!category.children.length) [['all', 'Все дела'], ['leasing', 'Лизинг'], ['bankruptcy', 'Банкротство'], ['international', 'Международные споры']].forEach(function (row) { var option = node('option', '', row[1]); option.value = row[0]; category.appendChild(option); });
      var initial = root.getAttribute('data-case-category') || 'all';
      category.value = ['all', 'leasing', 'bankruptcy', 'international'].indexOf(initial) >= 0 ? initial : 'all';
      function on(element, type, handler, options) { element.addEventListener(type, handler, options); listeners.push(function () { element.removeEventListener(type, handler, options); }); }
      function showLink(message) {
        shell.status.replaceChildren(node('span', '', message + ' '));
        var link = node('a', 'ecc__fallback-link', 'Смотреть все дела →'); link.href = '/cases/'; shell.status.appendChild(link);
      }
      function render() {
        if (disposed) return;
        if (motion) { rememberedPause = motion.state().paused; motion.destroy(); motion = null; }
        var selected = items.filter(function (item) { return categoryMatches(item, category.value); });
        track.replaceChildren();
        var cards = selected.map(function (item, index) { var card = renderCard(item, id, index); track.appendChild(card); return card; });
        root.setAttribute('data-case-count', String(selected.length)); root.setAttribute('data-case-total', String(items.length));
        root.setAttribute('data-case-category', category.value);
        [shell.prev, shell.next, shell.pause].forEach(function (control) { control.disabled = cards.length < 2; });
        if (!cards.length) { root.setAttribute('data-case-state', 'empty'); showLink(items.length ? 'По выбранному направлению пока нет опубликованных дел.' : 'Опубликованные дела появятся здесь.'); return; }
        root.setAttribute('data-case-state', 'ready'); shell.status.textContent = plural(cards.length, ['опубликованное дело', 'опубликованных дела', 'опубликованных дел']);
        if (cards.length > 1) {
          motion = initMotion(root, shell, cards);
          if (rememberedPause !== null) { if (rememberedPause) motion.pause(); else motion.play(); }
        }
        else { root.setAttribute('data-case-motion', 'paused'); shell.pause.textContent = 'Пауза'; shell.pause.setAttribute('aria-pressed', 'true'); }
        if (typeof window.CustomEvent === 'function') root.dispatchEvent(new window.CustomEvent('elegso:case-carousel-ready', { detail: { count: selected.length, total: items.length, category: category.value } }));
      }
      on(category, 'change', render);
      on(root, 'error', function (event) {
        var image = event.target;
        if (!image || image.tagName !== 'IMG') return;
        if (image.getAttribute('src') !== FALLBACK) { image.src = FALLBACK; image.alt = 'Иллюстрация юридической практики'; }
        else { image.hidden = true; if (image.parentElement) image.parentElement.classList.add('ecc__media--unavailable'); }
      }, true);
      var controller = {
        next: function () { if (motion) motion.next(); }, previous: function () { if (motion) motion.previous(); },
        pause: function () { if (motion) motion.pause(); }, play: function () { if (motion) motion.play(); },
        setCategory: function (value) { if (['all', 'leasing', 'bankruptcy', 'international'].indexOf(value) >= 0) { category.value = value; render(); } },
        refresh: render,
        getState: function () { return Object.assign({ state: root.getAttribute('data-case-state'), category: category.value, total: items.length }, motion ? motion.state() : { count: Number(root.getAttribute('data-case-count') || 0), paused: true }); },
        destroy: function () { disposed = true; if (motion) motion.destroy(); listeners.forEach(function (off) { off(); }); controllers.delete(root); root.removeAttribute('data-case-state'); root.removeAttribute('data-case-motion'); }
      };
      root.setAttribute('data-case-state', 'loading'); root.setAttribute('aria-busy', 'true'); shell.status.textContent = 'Загружаем опубликованные дела…';
      [shell.prev, shell.next, shell.pause].forEach(function (control) { control.disabled = true; });
      var source = localURL(root.getAttribute('data-case-source') || '/cases/carousel.json', 'feed');
      try {
        if (!source) throw new Error('Invalid case feed URL');
        items = await getFeed(source); render();
      } catch (_) {
        root.setAttribute('data-case-state', 'error');
        [shell.prev, shell.next, shell.pause].forEach(function (control) { control.disabled = true; });
        showLink('Не удалось загрузить дела.');
      } finally { root.setAttribute('aria-busy', 'false'); }
      return controller;
    })();
    controllers.set(root, promise); return promise;
  }
  function initAll(parent) { return Promise.all(Array.prototype.map.call((parent || document).querySelectorAll(ROOT), init)); }
  window.ElegsoCaseCarousel = Object.freeze({ version: '1.0.0', init: init, initAll: initAll });
  if (typeof module === 'object' && module.exports) module.exports = { cleanText: cleanText, localURL: localURL, normaliseFeed: normaliseFeed, categoryMatches: categoryMatches, initMotion: initMotion, renderCard: renderCard, init: init, initAll: initAll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { initAll(); });
  else initAll();
})(window, document);
