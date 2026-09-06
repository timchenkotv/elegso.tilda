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
    if (index) initSearch(index);
    document.querySelectorAll("[data-case-carousel]").forEach(initCarousel);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
