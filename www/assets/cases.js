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
    root.querySelectorAll("[data-case-jump]").forEach(function (link) {
      link.addEventListener("click", function (event) {
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
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      });
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
    var controls = root.querySelector("[data-case-strip-controls]");
    var pause = root.querySelector("[data-case-strip-pause]");
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    var paused = reduced.matches;
    var hovering = false;
    var visible = true;
    var pointer = null;
    var touching = false;
    var draggedAt = -Infinity;
    var idleUntil = 0;
    var position = viewport.scrollLeft;
    var direction = 1;
    var velocity = 0;
    var lastFrame = 0;
    controls.hidden = false;

    function label() {
      pause.textContent = paused ? "Пуск" : "Пауза";
      pause.setAttribute("aria-pressed", String(paused));
      pause.setAttribute("aria-label", paused ? "Включить движение номеров дел" : "Приостановить движение номеров дел");
    }
    function rest() { idleUntil = performance.now() + 6000; }
    function move(delta) {
      var max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      position = Math.max(0, Math.min(max, position + delta));
      viewport.scrollLeft = position;
      if (position >= max) direction = -1;
      if (position <= 0) direction = 1;
      return position > 0 && position < max;
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
    viewport.addEventListener("wheel", rest, { passive: true });
    viewport.addEventListener("dragstart", function (event) { event.preventDefault(); });
    viewport.addEventListener("pointerdown", function (event) {
      rest();
      velocity = 0;
      if (event.pointerType !== "mouse") { touching = true; return; }
      if (event.button !== 0) return;
      pointer = { id: event.pointerId, start: event.clientX, x: event.clientX, at: performance.now(), dragging: false };
      position = viewport.scrollLeft;
    });
    viewport.addEventListener("pointermove", function (event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (!pointer.dragging && Math.abs(event.clientX - pointer.start) < 5) return;
      if (!pointer.dragging) {
        pointer.dragging = true;
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add("is-dragging");
      }
      event.preventDefault();
      var now = performance.now();
      var delta = pointer.x - event.clientX;
      velocity = Math.max(-2.5, Math.min(2.5, delta / Math.max(8, now - pointer.at)));
      move(delta);
      pointer.x = event.clientX;
      pointer.at = now;
      rest();
    });
    function release(event) {
      if (event.pointerType !== "mouse") { touching = false; rest(); }
      if (!pointer || event.pointerId !== pointer.id) return;
      if (pointer.dragging) {
        draggedAt = performance.now();
        if (draggedAt - pointer.at > 100 || reduced.matches || event.type === "pointercancel") velocity = 0;
      }
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      pointer = null;
      viewport.classList.remove("is-dragging");
      rest();
    }
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
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
    function frame(now) {
      var elapsed = Math.min(40, now - (lastFrame || now));
      lastFrame = now;
      if (visible && !document.hidden && !pointer && !touching) {
        if (Math.abs(velocity) > 0.02) {
          if (!move(velocity * elapsed)) velocity = 0;
          velocity *= Math.pow(0.92, elapsed / 16.7);
        } else if (!paused && !hovering && !viewport.contains(document.activeElement) && now > idleUntil) {
          move(direction * elapsed * 0.018);
        } else {
          position = viewport.scrollLeft;
        }
      } else {
        position = viewport.scrollLeft;
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
