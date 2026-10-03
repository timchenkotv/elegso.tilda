(function () {
  "use strict";

  function normalize(value) {
    return String(value || "")
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9]+/gi, " ")
      .trim();
  }

  function initSearch(root) {
    var input = root.querySelector("[data-cases-search]");
    var category = root.querySelector("[data-cases-category]");
    var cards = Array.prototype.slice.call(root.querySelectorAll("[data-case-card]"));
    var found = root.querySelector("[data-cases-found]");
    var noResults = root.querySelector("[data-cases-no-results]");
    if (!input || !category) return;

    function apply() {
      var words = normalize(input.value).split(" ").filter(Boolean);
      var selected = normalize(category.value);
      var visible = 0;
      cards.forEach(function (card) {
        var haystack = normalize(card.getAttribute("data-search"));
        var cardCategory = normalize(card.getAttribute("data-category"));
        var matchesText = words.every(function (word) { return haystack.indexOf(word) !== -1; });
        var matchesCategory = !selected || cardCategory === selected;
        var show = matchesText && matchesCategory;
        card.hidden = !show;
        if (show) visible += 1;
      });
      if (found) found.textContent = String(visible);
      if (noResults) noResults.hidden = visible !== 0 || cards.length === 0;
    }

    input.addEventListener("input", apply);
    category.addEventListener("change", apply);
    // Delegate so the visual copies in the endless strip work like originals.
    root.addEventListener("click", function (event) {
      var link = event.target.closest("[data-case-jump]");
      if (!link || !root.contains(link)) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var target = document.getElementById(link.getAttribute("href").slice(1));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      // A hero shortcut must also reach a card currently excluded by search.
      if (target.hidden) {
        input.value = "";
        category.value = "";
        apply();
      }
      if (window.location.hash !== link.getAttribute("href")) {
        window.history.pushState(null, "", link.getAttribute("href"));
      }
      cards.forEach(function (card) { card.classList.toggle("is-jump-target", card === target); });
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    window.addEventListener("hashchange", function () {
      cards.forEach(function (card) { card.classList.toggle("is-jump-target", window.location.hash === "#" + card.id); });
    });
    document.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.focus();
      }
      if (event.key === "Escape" && document.activeElement === input) {
        input.value = "";
        input.blur();
        apply();
      }
    });
  }

  function initCaseStrip(root) {
    var viewport = root.querySelector("[data-case-strip]");
    if (!viewport) return;
    var track = viewport.querySelector(".cases-jump__grid");
    var originals = Array.prototype.slice.call(track.querySelectorAll("[data-case-jump]"));
    if (!originals.length) return;
    var controls = root.querySelector("[data-case-strip-controls]");
    var pause = root.querySelector("[data-case-strip-pause]");
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    var paused = reduced.matches;
    var hovering = false;
    var visible = true;
    var pointer = null;
    var draggedAt = -Infinity;
    var idleUntil = 0;
    var position = 0;
    var period = 0;
    var origin = 0;
    var copies = 0;
    var velocity = 0;
    var lastFrame = 0;
    controls.hidden = false;

    function label() {
      pause.textContent = paused ? "Пуск" : "Пауза";
      pause.setAttribute("aria-pressed", String(paused));
      pause.setAttribute("aria-label", paused ? "Включить движение номеров дел" : "Приостановить движение номеров дел");
    }
    function rest() { idleUntil = performance.now() + 6000; }
    function modulo(value, size) { return ((value % size) + size) % size; }
    function settle() {
      if (!period) return;
      // Rebase into the middle copy. The pixels on both sides are identical,
      // so crossing the seam never changes the visible order or hits an edge.
      position = origin + modulo(position - origin, period);
      viewport.scrollLeft = position;
    }
    function rebuild() {
      var gap = parseFloat(window.getComputedStyle(track).columnGap) || 0;
      var nextPeriod = originals.reduce(function (sum, tile) {
        return sum + parseFloat(window.getComputedStyle(tile).width) + gap;
      }, 0);
      if (!nextPeriod || !viewport.clientWidth) return;
      var nextCopies = Math.max(1, Math.ceil(viewport.clientWidth / nextPeriod));
      if (Math.abs(nextPeriod - period) < 0.01 && nextCopies === copies) return;
      var phase = period ? modulo(position - origin, period) / period : 0;
      track.querySelectorAll("[data-case-strip-copy]").forEach(function (copy) { copy.remove(); });
      var before = document.createDocumentFragment();
      var after = document.createDocumentFragment();
      function copyTile(tile) {
        var copy = tile.cloneNode(true);
        copy.setAttribute("data-case-strip-copy", "");
        copy.setAttribute("aria-hidden", "true");
        copy.setAttribute("tabindex", "-1");
        copy.removeAttribute("id");
        copy.draggable = false;
        return copy;
      }
      for (var i = 0; i < nextCopies; i += 1) {
        originals.forEach(function (tile) {
          before.appendChild(copyTile(tile));
          after.appendChild(copyTile(tile));
        });
      }
      track.insertBefore(before, originals[0]);
      track.appendChild(after);
      period = nextPeriod;
      copies = nextCopies;
      origin = period * copies;
      position = origin + phase * period;
      settle();
    }
    function move(delta) {
      position += delta;
      settle();
    }
    function step(direction) {
      rest();
      velocity = 0;
      position = viewport.scrollLeft;
      move(direction * viewport.clientWidth * 0.75);
    }
    root.querySelector("[data-case-strip-prev]").addEventListener("click", function () { step(-1); });
    root.querySelector("[data-case-strip-next]").addEventListener("click", function () { step(1); });
    pause.addEventListener("click", function () {
      paused = !paused;
      velocity = 0;
      idleUntil = 0;
      label();
    });
    reduced.addEventListener("change", function () {
      paused = reduced.matches;
      velocity = 0;
      label();
    });
    viewport.addEventListener("pointerenter", function (event) { if (event.pointerType === "mouse") hovering = true; });
    viewport.addEventListener("pointerleave", function () { hovering = false; });
    viewport.addEventListener("wheel", function (event) {
      rest();
      velocity = 0;
      var delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : (event.shiftKey ? event.deltaY : 0);
      if (!delta) return; // Normal vertical scrolling still scrolls the page.
      event.preventDefault();
      var unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? viewport.clientWidth : 1);
      move(delta * unit);
    }, { passive: false });
    viewport.addEventListener("dragstart", function (event) { event.preventDefault(); });
    originals.forEach(function (tile) { tile.draggable = false; });
    viewport.addEventListener("pointerdown", function (event) {
      if (event.isPrimary === false || event.button !== 0 || pointer) return;
      rest();
      velocity = 0;
      draggedAt = -Infinity;
      var now = performance.now();
      pointer = { id: event.pointerId, start: event.clientX, startY: event.clientY, x: event.clientX, at: now, dragging: false, samples: [{ x: event.clientX, at: now }] };
      position = viewport.scrollLeft;
    });
    // Listen on window from pointerdown: even a very fast first movement out
    // of the viewport is caught before pointer capture has been established.
    window.addEventListener("pointermove", function (event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (!pointer.dragging && event.pointerType !== "mouse" && Math.abs(event.clientY - pointer.startY) > Math.max(5, Math.abs(event.clientX - pointer.start))) {
        pointer = null; // Let the browser handle vertical scrolling/pinching.
        velocity = 0;
        return;
      }
      if (!pointer.dragging && Math.abs(event.clientX - pointer.start) < 5) return;
      if (!pointer.dragging) {
        pointer.dragging = true;
        try { viewport.setPointerCapture(event.pointerId); } catch (_) { /* Window handlers still own this drag. */ }
        viewport.classList.add("is-dragging");
      }
      event.preventDefault();
      var now = performance.now();
      var delta = pointer.x - event.clientX;
      pointer.samples.push({ x: event.clientX, at: now });
      while (pointer.samples.length > 2 && now - pointer.samples[0].at > 100) pointer.samples.shift();
      var sample = pointer.samples[0];
      velocity = Math.max(-2.5, Math.min(2.5, (sample.x - event.clientX) / Math.max(8, now - sample.at)));
      move(delta);
      pointer.x = event.clientX;
      pointer.at = now;
      rest();
    }, { passive: false });
    function release(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (pointer.dragging) {
        draggedAt = performance.now();
        if (draggedAt - pointer.at > 100 || reduced.matches || event.type !== "pointerup") velocity = 0;
        // A mouse-down may focus the underlying link. A completed drag is
        // not keyboard navigation and must not pause autoplay permanently.
        if (viewport.contains(document.activeElement)) document.activeElement.blur();
      }
      pointer = null;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      viewport.classList.remove("is-dragging");
      rest();
    }
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    viewport.addEventListener("lostpointercapture", release);
    window.addEventListener("blur", function () {
      if (pointer) release({ pointerId: pointer.id, type: "blur" });
      velocity = 0;
    });
    viewport.addEventListener("click", function (event) {
      if (performance.now() - draggedAt < 350) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    viewport.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      }
    });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; }).observe(viewport);
    }
    rebuild();
    if ("ResizeObserver" in window) {
      var observer = new ResizeObserver(rebuild);
      observer.observe(viewport);
      originals.forEach(function (tile) { observer.observe(tile); });
    } else {
      window.addEventListener("resize", rebuild);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(rebuild);
    viewport.addEventListener("scroll", function () {
      // Browser keyboard focus may scroll an original into view. Only adopt
      // real external scrolling; retain subpixel precision during animation.
      if (Math.abs(viewport.scrollLeft - position) > 1) {
        position = viewport.scrollLeft;
        settle();
      }
    }, { passive: true });
    function frame(now) {
      var elapsed = Math.min(40, now - (lastFrame || now));
      lastFrame = now;
      if (visible && !document.hidden && !pointer) {
        if (Math.abs(velocity) > 0.02) {
          move(velocity * elapsed);
          velocity *= Math.pow(0.92, elapsed / 16.7);
        } else if (!paused && !hovering && !viewport.contains(document.activeElement) && now > idleUntil) {
          move(elapsed * 0.018);
        }
      } else if (!visible || document.hidden) {
        velocity = 0;
      }
      window.requestAnimationFrame(frame);
    }
    label();
    window.requestAnimationFrame(frame);
  }

  function initCarousel(root) {
    var slides = Array.prototype.slice.call(root.querySelectorAll("[data-case-slide]"));
    var current = root.querySelector("[data-case-current]");
    var previous = root.querySelector("[data-case-prev]");
    var next = root.querySelector("[data-case-next]");
    var links = Array.prototype.slice.call(root.querySelectorAll("[data-case-open-material]"));
    if (!slides.length) return;
    var index = 0;

    function load(slide) {
      var media = slide.querySelector("[data-case-lazy-src]");
      if (media && !media.getAttribute("src")) {
        media.setAttribute("src", media.getAttribute("data-case-lazy-src"));
      }
    }

    function show(nextIndex, focusViewer) {
      index = (nextIndex + slides.length) % slides.length;
      slides.forEach(function (slide, slideIndex) {
        slide.hidden = slideIndex !== index;
      });
      load(slides[index]);
      var id = slides[index].getAttribute("data-material-id");
      links.forEach(function (link) {
        link.classList.toggle("is-current", link.getAttribute("data-case-open-material") === id);
      });
      if (current) current.textContent = String(index + 1);
      if (focusViewer) slides[index].scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    if (previous) previous.addEventListener("click", function () { show(index - 1, false); });
    if (next) next.addEventListener("click", function () { show(index + 1, false); });
    links.forEach(function (link) {
      link.addEventListener("click", function (event) {
        var id = link.getAttribute("data-case-open-material");
        var target = slides.findIndex(function (slide) {
          return slide.getAttribute("data-material-id") === id;
        });
        if (target >= 0) {
          event.preventDefault();
          show(target, true);
        }
      });
    });
    root.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft") show(index - 1, false);
      if (event.key === "ArrowRight") show(index + 1, false);
    });
    show(0, false);
  }

  function init() {
    var index = document.querySelector("[data-cases-index]");
    if (index) {
      initSearch(index);
      initCaseStrip(index);
    }
    document.querySelectorAll("[data-case-carousel]").forEach(initCarousel);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
