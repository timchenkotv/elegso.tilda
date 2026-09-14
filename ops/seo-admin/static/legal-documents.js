/* Legal document CMS. Draft editing never changes a published version. */
(function () {
  "use strict";

  const instances = new WeakMap();
  const mounted = new Set();
  const API = "api/legal-documents";
  const HASH_KEYS = new Set(["hash", "sha256", "content_sha256", "draft_sha256", "published_sha256", "baseline_sha256"]);
  const PROOF_DEFAULTS = {
    identifierLabel: "Идентификатор редакции:", permanentUrlLabel: "Постоянный адрес:",
    checksumLabel: "Контрольная сумма текста и реквизитов редакции (SHA-256):",
    checksumNote: "Контрольная сумма позволяет проверить неизменность исходного содержания редакции. Она не является электронной подписью или независимым подтверждением времени публикации."
  };
  const TAGS = new Set(["P", "BR", "STRONG", "EM", "U", "S", "A", "UL", "OL", "LI", "BLOCKQUOTE", "CODE", "SUB", "SUP"]);
  const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "IMG", "VIDEO", "AUDIO", "LINK", "META"]);
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const asText = value => value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

  function safeURL(value) {
    const raw = String(value || "").trim();
    if (!raw || /[\u0000-\u0020\u007f]/.test(raw) || raw.startsWith("//")) return "";
    try {
      const parsed = new URL(raw, location.origin + "/");
      return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol) ? raw : "";
    } catch (_) { return ""; }
  }

  function sanitizeHTML(value, preview = false) {
    const template = document.createElement("template");
    template.innerHTML = String(value || "");
    const output = document.createElement("div");
    const visit = (node, parent) => {
      if (node.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || DROP_TAGS.has(node.tagName)) return;
      let tag = node.tagName === "B" ? "STRONG" : node.tagName === "I" ? "EM" : node.tagName;
      if (!TAGS.has(tag)) {
        for (const child of node.childNodes) visit(child, parent);
        if (tag === "DIV" && parent.lastChild) parent.append(document.createElement("br"));
        return;
      }
      const element = document.createElement(preview && tag === "A" ? "span" : tag.toLowerCase());
      if (tag === "A") {
        const href = safeURL(node.getAttribute("href"));
        if (preview) element.className = "preview-link";
        else if (href) { element.setAttribute("href", href); element.setAttribute("rel", "noopener noreferrer"); }
      }
      for (const child of node.childNodes) visit(child, element);
      parent.append(element);
    };
    for (const child of template.content.childNodes) visit(child, output);
    return output.innerHTML;
  }

  function displayDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? asText(value) : date.toLocaleString("ru-RU");
  }

  function moscowDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date).replace(" ", "T");
  }

  function errorMessage(payload, status) {
    const detail = payload?.detail || payload?.error || payload?.message;
    if (typeof detail === "string") return detail;
    if (detail) return JSON.stringify(detail);
    return `Ошибка HTTP ${status}`;
  }

  async function request(path = "", options = {}) {
    const response = await fetch(API + path, {
      credentials: "same-origin", cache: "no-store", ...options,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(errorMessage(payload, response.status));
      error.status = response.status; error.payload = payload;
      throw error;
    }
    return payload;
  }

  class Editor {
    constructor(container, currentUser) {
      this.container = container;
      this.user = currentUser || {};
      this.allowed = Boolean(this.user.is_owner || ["admin", "owner"].includes(this.user.role));
      this.documents = [];
      this.presentationDefaults = { offerProof: { ...PROOF_DEFAULTS } };
      this.document = null;
      this.content = null;
      this.baseline = "";
      this.raw = null;
      this.rawBaseline = null;
      this.busy = false;
      this.destroyed = false;
      this.tab = "edit";
      this.selectedRange = null;
      this.focusedRich = null;
      this.touchedRich = new Set();
      this.job = null;
      this.pollTimer = null;
      this.loadToken = 0;
      this.beforeUnload = event => {
        if (this.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; }
      };
      window.addEventListener("beforeunload", this.beforeUnload);
      this.buildShell();
      this.ready = this.refresh();
    }

    editable() { return this.allowed && this.document?.editable !== false; }
    fixedStructure() { return this.document?.type === "legacy"; }
    hasUnsavedChanges() {
      if (!this.content) return false;
      if (this.raw !== null) return this.raw !== this.rawBaseline;
      return JSON.stringify(this.content) !== this.baseline;
    }
    confirmLeave() {
      return !this.hasUnsavedChanges() || window.confirm("В документе есть несохранённые изменения. Уйти без сохранения? Черновик на сервере останется прежним.");
    }
    $(selector) { return this.container.querySelector(selector); }
    $$(selector) { return [...this.container.querySelectorAll(selector)]; }

    buildShell() {
      this.container.classList.add("legal-documents");
      this.container.innerHTML = `
        <div class="ld-catalog"><label class="ld-field ld-grow">Документ<select data-ld="documents" aria-label="Выберите юридический документ"><option>Загрузка…</option></select></label><button class="button" type="button" data-action="refresh">Обновить</button><a class="button ld-public" data-ld="public" target="_blank" rel="noopener noreferrer" hidden>Открыть на сайте ↗</a></div>
        <div class="ld-message" data-ld="message" role="status" aria-live="polite" hidden></div>
        <div class="ld-job" data-ld="job" role="status" aria-live="polite" hidden></div>
        <div class="ld-workspace" data-ld="workspace" hidden>
          <div class="ld-summary"><div><h2 data-ld="title"></h2><p data-ld="subtitle"></p></div><span class="badge" data-ld="permission"></span></div>
          <div class="ld-actions"><div class="ld-tabs" role="tablist" aria-label="Режим документа"><button type="button" role="tab" data-tab="edit" aria-selected="true">Редактор</button><button type="button" role="tab" data-tab="preview" aria-selected="false">Предпросмотр</button><button type="button" role="tab" data-tab="history" aria-selected="false">История</button></div><div class="ld-save-actions"><span data-ld="dirty" class="ld-save-state" aria-live="polite"></span><button class="button" type="button" data-action="save">Сохранить черновик</button><button class="button accent" type="button" data-action="publish">Опубликовать</button></div></div>
          <div class="ld-panel" data-panel="edit" role="tabpanel"></div>
          <div class="ld-panel" data-panel="preview" role="tabpanel" hidden></div>
          <div class="ld-panel" data-panel="history" role="tabpanel" hidden></div>
        </div>`;
      this.container.addEventListener("click", this.handleClick = event => this.onClick(event));
      this.container.addEventListener("input", this.handleInput = event => this.onInput(event));
      this.container.addEventListener("change", this.handleChange = event => this.onChange(event));
      this.container.addEventListener("paste", this.handlePaste = event => this.onPaste(event));
      this.container.addEventListener("drop", this.handleDrop = event => {
        if (event.target.closest("[data-rich]")) event.preventDefault();
      });
      this.container.addEventListener("focusin", this.handleFocus = event => {
        if (event.target.matches("[data-rich]")) this.focusedRich = event.target;
      });
      this.container.addEventListener("keyup", this.handleSelection = () => this.rememberSelection());
      this.container.addEventListener("mouseup", this.handleSelection);
      this.container.addEventListener("mousedown", this.handleMouseDown = event => {
        if (event.target.closest("[data-command]")) { this.rememberSelection(); event.preventDefault(); }
      });
      this.container.addEventListener("keydown", this.handleKeyDown = event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault(); if (this.editable() && !this.busy && !this.job) this.save();
        }
      });
    }

    message(text, kind = "info") {
      const node = this.$('[data-ld="message"]');
      node.hidden = !text; node.className = `ld-message ld-${kind}`;
      node.replaceChildren(document.createTextNode(text || ""));
      if (kind === "conflict") {
        const button = document.createElement("button");
        button.type = "button"; button.className = "button"; button.dataset.action = "reload-document";
        button.textContent = "Загрузить актуальный черновик"; node.append(button);
        const copy = document.createElement("button");
        copy.type = "button"; copy.className = "button"; copy.dataset.action = "export";
        copy.textContent = "Скачать мои изменения"; node.append(copy);
      }
    }
    showError(error) {
      if (error.status === 409) this.message("Черновик изменён в другой сессии или его версия уже опубликована. Ваши изменения сохранены в редакторе. " + error.message, "conflict");
      else if ([401, 403].includes(error.status)) this.message("Нет доступа к операции или сессия завершена. " + error.message, "error");
      else this.message(error.message || "Не удалось выполнить операцию", "error");
    }

    async refresh() {
      if (this.busy || this.job || !this.confirmLeave()) return;
      this.busy = true; this.updateButtons();
      try {
        const payload = await request();
        if (this.destroyed) return;
        if (typeof payload.can_edit === "boolean") this.allowed = payload.can_edit;
        this.documents = payload.documents || [];
        if (this.documents.some(doc => doc.id === "document-presentation")) {
          try {
            const settingsPayload = await request("/document-presentation");
            const settings = settingsPayload.document || settingsPayload;
            this.presentationDefaults = settings.published_content || settings.draft_content || this.presentationDefaults;
          } catch (_) { /* The local fallbacks keep document editing available. */ }
        }
        if (this.destroyed) return;
        const select = this.$('[data-ld="documents"]');
        select.innerHTML = this.documents.length ? this.documents.map(doc => `<option value="${escape(doc.id)}">${escape(doc.title || doc.id)}</option>`).join("") : '<option value="">Документов пока нет</option>';
        const id = this.documents.find(doc => doc.id === this.document?.id)?.id || this.documents.find(doc => doc.id === "offer-business")?.id || this.documents[0]?.id;
        if (id) { select.value = id; await this.load(id); }
        else { this.document = null; this.content = null; this.$('[data-ld="workspace"]').hidden = true; this.message("Юридические документы ещё не подключены к редактору."); }
      } catch (error) { this.showError(error); }
      finally { this.busy = false; this.updateButtons(); }
    }

    async load(id) {
      const token = ++this.loadToken;
      const payload = await request("/" + encodeURIComponent(id));
      if (this.destroyed || token !== this.loadToken) return;
      this.acceptDocument(payload.document || payload);
      this.message("");
      if (this.document.validation_errors?.length) this.message("Проверка документа: " + this.document.validation_errors.map(asText).join("; "), "error");
      const activeJob = this.document.active_job || this.document.job;
      if (activeJob?.id && ["queued", "running", "pending"].includes(activeJob.status)) this.trackJob(activeJob);
      else if (activeJob && ["failed", "error", "cancelled"].includes(activeJob.status)) this.message("Предыдущая публикация не завершена: " + asText(activeJob.error || activeJob.message || activeJob.result?.error || "Проверьте историю документа") + ". Исправьте причину и повторите публикацию.", "error");
    }

    acceptDocument(doc) {
      this.document = doc;
      this.content = clone(doc.draft_content ?? doc.content ?? {});
      this.baseline = JSON.stringify(this.content);
      this.raw = null; this.rawBaseline = null; this.touchedRich.clear();
      this.focusedRich = null; this.selectedRange = null;
      this.$('[data-ld="workspace"]').hidden = false;
      this.$('[data-ld="title"]').textContent = doc.title || this.content.title || doc.id;
      this.$('[data-ld="subtitle"]').textContent = `Ревизия черновика: ${doc.draft_revision ?? doc.revision ?? "—"} · Опубликованное содержимое хранится отдельно`;
      this.$('[data-ld="permission"]').textContent = this.editable() ? "Редактирование" : "Только просмотр";
      this.$('[data-ld="permission"]').className = "badge " + (this.editable() ? "good" : "");
      const url = safeURL(doc.url || this.content.url);
      const link = this.$('[data-ld="public"]');
      link.hidden = !url; if (url) link.href = url;
      this.renderEditor(); this.renderHistory(); this.setTab(this.tab);
      this.updateButtons();
    }

    updateButtons() {
      if (this.destroyed) return;
      const busy = this.busy || Boolean(this.job);
      const writable = this.editable();
      const dirty = this.hasUnsavedChanges();
      this.$('[data-action="save"]').disabled = !writable || busy || !dirty;
      this.$('[data-action="publish"]').disabled = !writable || busy || (!dirty && this.document?.has_changes === false);
      this.$('[data-action="refresh"]').disabled = busy;
      this.$('[data-ld="documents"]').disabled = busy;
      this.$('[data-ld="dirty"]').textContent = dirty ? "Не сохранено" : this.document?.has_changes ? "Черновик не опубликован" : "Изменений нет";
      this.$('[data-ld="dirty"]').classList.toggle("ld-unsaved", dirty);
      this.container.setAttribute("aria-busy", this.busy ? "true" : "false");
      this.container.classList.toggle("ld-readonly", !writable);
      this.$$('[data-edit-control]').forEach(node => {
        if (node.matches('[data-rich]')) node.contentEditable = writable && !busy ? "true" : "false";
        else node.disabled = !writable || busy || node.hasAttribute("data-boundary");
      });
    }

    field(label, path, type = "text", hint = "", readOnly = false) {
      let value = path.split(".").reduce((obj, key) => obj?.[key], this.content);
      if (path.startsWith("publication.")) value = this.publicationValue(path.split(".")[1]);
      if (type === "datetime-local") value = moscowDateTime(value);
      const attr = `data-path="${escape(path)}" ${readOnly ? "readonly" : "data-edit-control"}`;
      const input = type === "textarea" ? `<textarea ${attr} rows="3">${escape(asText(value))}</textarea>` : `<input ${attr} type="${type}" ${type === "datetime-local" ? 'step="1"' : ""} value="${escape(asText(value))}">`;
      return `<label class="ld-field">${escape(label)}${input}${hint ? `<small>${escape(hint)}</small>` : ""}</label>`;
    }

    publicationValue(key) {
      const own = this.content.publication?.[key] ?? this.content[key];
      if (own !== undefined) return own;
      if (key === "identifier") return `${this.content.id || this.document.id}/${this.content.version || ""}`;
      if (key === "permanentUrl") return `${this.document.url || "/oferta/"}versions/${this.content.version || ""}/`;
      return this.presentationDefaults.offerProof?.[key] ?? PROOF_DEFAULTS[key] ?? "";
    }

    renderEditor() {
      const panel = this.$('[data-panel="edit"]');
      if (this.document.id === "document-presentation") { this.renderPresentation(); return; }
      if (!Array.isArray(this.content.sections)) {
        const editableContent = clone(this.content);
        for (const key of HASH_KEYS) delete editableContent[key];
        this.raw = JSON.stringify(editableContent, null, 2); this.rawBaseline = this.raw;
        panel.innerHTML = `<div class="ld-card"><h3>Структура документа</h3><p class="ld-help">Расширенный редактор JSON. Изменяйте только необходимые значения; структура и ссылки проверяются перед публикацией. Контрольные суммы рассчитываются системой.</p><label class="ld-field">Содержимое JSON<textarea class="ld-json" data-ld="json" data-edit-control rows="25" spellcheck="false">${escape(this.raw)}</textarea></label><p class="ld-json-state" data-ld="json-state" aria-live="polite">JSON корректен</p></div>`;
        return;
      }
      const hasOfferMetadata = this.document.type === "offer" || Object.hasOwn(this.content, "version");
      panel.innerHTML = `
        <div class="ld-card"><h3>Название и описание</h3><div class="ld-meta-grid">${this.field("Название документа", "title")}${this.field("Описание для поиска", "description", "textarea")}${this.fixedStructure() ? this.field("Ссылка на документ", "documentUrl", "url", "Адрес документа, на который ведёт кнопка на странице.") : ""}</div>
        <details class="ld-meta-details"><summary>Даты, редакция и дополнительные сведения</summary><div class="ld-meta-grid">${this.field("Дата редакции", "revisionDate", "date")}${hasOfferMetadata ? this.field("Версия", "version", "text", "Новая уникальная версия: строчные латинские буквы, цифры и дефис.") + this.field("Дата вступления в силу", "effectiveDate", "date") + this.field("Дата публикации в документе (Москва)", "publishedAt", "datetime-local", "Заявленная дата документа. Фактическое время записи сохраняется системой отдельно в истории.") + this.field("Дата первоначального утверждения", "baseApprovalDate", "date") : ""}${this.field("Для кого предназначен документ", "audience")}${this.field(hasOfferMetadata ? "Служебный вводный текст" : "Вводный текст", "lead", "textarea", hasOfferMetadata ? "На странице оферты не выводится." : "")}${this.field(hasOfferMetadata ? "Служебное примечание" : "Примечание перед условиями", "notice", "textarea", hasOfferMetadata ? "На странице оферты не выводится." : "")}</div></details>
        ${hasOfferMetadata ? `<details class="ld-meta-details"><summary>Обозначение публикации</summary><div class="ld-meta-grid">${this.field("Идентификатор публикации", "publication.identifier", "text", "Видимое обозначение, например business/2026-09-14")}${this.field("Подпись идентификатора", "publication.identifierLabel")}${this.field("Постоянный адрес редакции", "publication.permanentUrl", "text", "Для новой редакции — новый адрес. Опубликованная история не перезаписывается.")}${this.field("Подпись постоянного адреса", "publication.permanentUrlLabel")}${this.field("Подпись контрольной суммы", "publication.checksumLabel", "text", "Саму контрольную сумму рассчитывает система.")}${this.field("Примечание к контрольной сумме", "publication.checksumNote", "textarea")}</div></details>` : ""}</div>
        <div class="ld-section-tools"><label class="ld-field ld-grow">Поиск по тексту<input type="search" data-ld="search" placeholder="Номер пункта или слова"></label><button type="button" class="button" data-action="expand">Развернуть все</button><button type="button" class="button" data-action="collapse">Свернуть все</button><button type="button" class="button" data-action="add-section" data-edit-control>Добавить раздел</button></div>
        <p class="ld-help">Редактируйте текст непосредственно в пункте. Вставка из буфера — без чужого оформления. Нумерация меняется только вручную, чтобы сохранить ссылки на пункты.</p>
        <div class="ld-sections" data-ld="sections"></div><p class="ld-no-results" data-ld="no-results" hidden>По этому запросу ничего не найдено.</p>`;
      this.renderSections();
      if (this.fixedStructure()) {
        panel.querySelectorAll(".ld-meta-details, [data-action='add-section']").forEach(node => node.remove());
        panel.querySelector(".ld-help").textContent = "Редактируйте текст и ссылку на документ. Состав и порядок блоков этой страницы закреплены в её вёрстке.";
      }
    }

    renderPresentation() {
      const panel = this.$('[data-panel="edit"]');
      const labels = [
        ["Кнопка печати документа", "printLabel"], ["Кнопка печати оферты", "offerPrintLabel"],
        ["Ссылка на все правовые документы", "allDocumentsLabel"], ["Короткая ссылка на все документы", "relatedAllDocumentsLabel"],
        ["Открытие документа", "openDocumentLabel"], ["Настройки cookie", "cookieSettingsLabel"]
      ];
      panel.innerHTML = `<div class="ld-card"><h3>Страница правовых документов</h3><div class="ld-meta-grid">${this.field("Заголовок каталога", "hubTitle")}${this.field("Описание каталога", "hubDescription", "textarea")}</div><p class="ld-help">Эти поля изменяют страницу «Правовые документы». Содержимое самих оферт и политик редактируется отдельно.</p></div>
        <div class="ld-card"><h3>Подписи кнопок и ссылок</h3><div class="ld-meta-grid">${labels.map(([label, path]) => this.field(label, path)).join("")}</div></div>
        <details class="ld-card ld-presentation-proof"><summary>Подписи сведений об оферте</summary><div class="ld-meta-grid">${this.field("Подпись идентификатора", "offerProof.identifierLabel")}${this.field("Подпись постоянного адреса", "offerProof.permanentUrlLabel")}${this.field("Подпись контрольной суммы", "offerProof.checksumLabel")}${this.field("Пояснение к контрольной сумме", "offerProof.checksumNote", "textarea")}</div><p class="ld-help">Контрольную сумму рассчитывает система. Здесь меняются только её подпись и пояснение.</p></details>
        <div class="ld-section-tools"><h3 class="ld-grow">Карточки документов</h3><button class="button" type="button" data-action="add-card" data-edit-control>Добавить карточку</button></div>
        <p class="ld-help">Порядок карточек на сайте соответствует этому списку. Ссылки должны вести на существующие страницы сайта.</p><div class="ld-hub-cards">${(this.content.hubCards || []).map((card, index) => `<article class="ld-card ld-hub-card" data-card="${index}"><div class="ld-hub-card-head"><strong>Карточка ${index + 1}</strong><div class="ld-order">${this.orderButtons("card", index, null, this.content.hubCards.length)}</div></div><div class="ld-meta-grid">${this.field("Название", `hubCards.${index}.title`)}${this.field("Адрес страницы", `hubCards.${index}.url`, "text", "Относительная ссылка, например /oferta/")}${this.field("Описание", `hubCards.${index}.description`, "textarea")}${this.field("Дата на карточке (необязательно)", `hubCards.${index}.date`, "date")}<label class="ld-check"><input type="checkbox" data-path="hubCards.${index}.privacy" data-edit-control ${card.privacy ? "checked" : ""}>Иллюстрация о защите данных</label></div></article>`).join("")}</div>`;
      this.updateButtons();
    }

    renderSections(openIndexes = new Set([0])) {
      const list = this.$('[data-ld="sections"]');
      if (!list) return;
      list.innerHTML = this.content.sections.map((section, index) => `<details class="ld-section" data-section="${index}" ${openIndexes.has(index) ? "open" : ""}><summary><span class="ld-section-label">${escape(section.title || "Новый раздел")}</span><small>${(section.clauses || []).length} пунктов</small></summary><div class="ld-section-body"><div class="ld-section-heading"><label class="ld-field ld-grow">Название раздела<input data-section-title="${index}" data-edit-control value="${escape(section.title || "")}"></label><label class="ld-field ld-anchor">Якорь раздела<input data-section-id="${index}" data-edit-control value="${escape(section.id || "")}" aria-label="Якорь раздела ${index + 1}"></label><div class="ld-order">${this.orderButtons("section", index, null, this.content.sections.length)}</div></div><div class="ld-clause-list">${(section.clauses || []).map((clause, clauseIndex) => this.clauseHTML(clause, index, clauseIndex, section.clauses.length)).join("")}</div><button class="button" type="button" data-action="add-clause" data-s="${index}" data-edit-control>Добавить пункт</button></div></details>`).join("");
      if (this.fixedStructure()) {
        list.querySelectorAll(".ld-section-heading, .ld-order, [data-action='add-clause']").forEach(node => node.remove());
        list.querySelectorAll("[data-clause-number]").forEach(node => { node.readOnly = true; node.removeAttribute("data-edit-control"); });
      }
      this.updateButtons();
    }

    orderButtons(kind, index, section, count) {
      const attrs = `data-kind="${kind}" data-i="${index}" ${section === null ? "" : `data-s="${section}"`} data-edit-control`;
      const name = kind === "section" ? "раздел" : kind === "card" ? "карточку" : "пункт";
      return `<button type="button" class="ld-icon" data-action="up" ${attrs} ${index === 0 ? "data-boundary disabled" : ""} title="Переместить выше" aria-label="Переместить ${name} выше">↑</button><button type="button" class="ld-icon" data-action="down" ${attrs} ${index === count - 1 ? "data-boundary disabled" : ""} title="Переместить ниже" aria-label="Переместить ${name} ниже">↓</button><button type="button" class="ld-icon ld-danger" data-action="remove" ${attrs} title="Удалить" aria-label="Удалить ${name}">×</button>`;
    }

    clauseHTML(clause, section, index, count) {
      return `<article class="ld-clause" data-clause="${section}:${index}"><div class="ld-clause-head"><label class="ld-field ld-number">Пункт<input data-clause-number="${section}:${index}" data-edit-control value="${escape(clause.number || "")}"></label><div class="ld-format" role="toolbar" aria-label="Форматирование пункта ${escape(clause.number)}"><button type="button" data-command="bold" data-target="${section}:${index}" data-edit-control title="Полужирный"><strong>Ж</strong></button><button type="button" data-command="italic" data-target="${section}:${index}" data-edit-control title="Курсив"><em>К</em></button><button type="button" data-command="createLink" data-target="${section}:${index}" data-edit-control title="Добавить ссылку">Ссылка</button><button type="button" data-command="unlink" data-target="${section}:${index}" data-edit-control title="Убрать ссылку">Без ссылки</button><button type="button" data-command="insertUnorderedList" data-target="${section}:${index}" data-edit-control title="Маркированный список">• Список</button><button type="button" data-command="removeFormat" data-target="${section}:${index}" data-edit-control title="Убрать оформление">Текст</button></div><div class="ld-order">${this.orderButtons("clause", index, section, count)}</div></div><div class="ld-rich" data-rich="${section}:${index}" data-edit-control contenteditable="${this.editable()}" role="textbox" aria-multiline="true" aria-label="Текст пункта ${escape(clause.number)}" spellcheck="true">${sanitizeHTML(clause.html)}</div></article>`;
    }

    setValue(path, value) {
      const parts = path.split(".");
      let target = this.content;
      for (const key of parts.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== "object") target[key] = {};
        target = target[key];
      }
      const key = parts.at(-1);
      if (value === "" && (path.startsWith("publication.") || (path.startsWith("hubCards.") && key === "date"))) delete target[key];
      else if (value === "" && ["baseApprovalDate", "publishedAt", "effectiveDate"].includes(key)) target[key] = null;
      else if (key === "publishedAt" && value) target[key] = value + (value.length === 16 ? ":00" : "") + "+03:00";
      else target[key] = value;
    }

    onInput(event) {
      const node = event.target;
      if (node.matches('[data-ld="search"]')) { this.filterSections(node.value); return; }
      if (!this.editable() || this.busy || this.job) return;
      if (node.dataset.path) {
        this.setValue(node.dataset.path, node.type === "checkbox" ? node.checked : node.value);
        if (node.dataset.path === "version") {
          for (const key of ["identifier", "permanentUrl"]) {
            if (this.content.publication?.[key] === undefined && this.content[key] === undefined) {
              const field = this.$(`[data-path="publication.${key}"]`);
              if (field) field.value = this.publicationValue(key);
            }
          }
        }
      }
      else if (node.dataset.sectionTitle !== undefined) {
        this.content.sections[Number(node.dataset.sectionTitle)].title = node.value;
        node.closest("details").querySelector(".ld-section-label").textContent = node.value || "Новый раздел";
      } else if (node.dataset.sectionId !== undefined) this.content.sections[Number(node.dataset.sectionId)].id = node.value;
      else if (node.dataset.clauseNumber !== undefined) {
        const [s, c] = node.dataset.clauseNumber.split(":").map(Number);
        this.content.sections[s].clauses[c].number = node.value;
      } else if (node.dataset.rich !== undefined) this.captureRich(node);
      else if (node.matches('[data-ld="json"]')) {
        this.raw = node.value;
        const status = this.$('[data-ld="json-state"]');
        try { JSON.parse(this.raw); status.textContent = "JSON корректен"; status.classList.remove("ld-invalid"); }
        catch (error) { status.textContent = "JSON пока не завершён: " + error.message; status.classList.add("ld-invalid"); }
      }
      this.updateButtons();
    }

    async onChange(event) {
      if (!event.target.matches('[data-ld="documents"]')) return;
      const next = event.target.value;
      if (next === this.document?.id) return;
      if (!this.confirmLeave()) { event.target.value = this.document?.id || ""; return; }
      this.busy = true; this.updateButtons();
      try { await this.load(next); }
      catch (error) { event.target.value = this.document?.id || ""; this.showError(error); }
      finally { this.busy = false; this.updateButtons(); }
    }

    async onClick(event) {
      const anchor = event.target.closest('[data-rich] a');
      if (anchor) event.preventDefault();
      const tab = event.target.closest("[data-tab]");
      if (tab) { this.setTab(tab.dataset.tab); return; }
      const format = event.target.closest("[data-command]");
      if (format) { this.format(format); return; }
      const button = event.target.closest("[data-action]");
      if (!button || button.disabled) return;
      const action = button.dataset.action;
      if (action === "refresh") { this.refresh(); return; }
      if (action === "reload-document") {
        if (!this.confirmLeave() || this.busy || this.job) return;
        this.busy = true; this.updateButtons();
        try { await this.load(this.document.id); } catch (error) { this.showError(error); }
        finally { this.busy = false; this.updateButtons(); }
        return;
      }
      if (action === "export") { this.exportDraft(); return; }
      if (action === "preview-update") { this.renderPreview(); return; }
      if (action === "poll-job") { if (this.job) this.pollJob(); return; }
      if (action === "expand" || action === "collapse") {
        this.$$(".ld-section").forEach(section => { section.open = action === "expand"; }); return;
      }
      if (!this.editable() || this.busy || this.job) return;
      if (action === "save") { this.save(); return; }
      if (action === "publish") { this.publish(); return; }
      if (action === "restore") { this.restore(button.dataset.version); return; }
      if (action === "add-card" || button.dataset.kind === "card") {
        this.content.hubCards ||= [];
        const cards = this.content.hubCards;
        const index = Number(button.dataset.i);
        if (action === "add-card") cards.push({ title: "Новый документ", description: "", url: "" });
        else if (action === "remove") {
          if (!window.confirm("Удалить карточку из каталога? Сама страница документа останется на сайте.")) return;
          cards.splice(index, 1);
        } else if (action === "up" || action === "down") {
          const next = index + (action === "up" ? -1 : 1);
          if (next < 0 || next >= cards.length) return;
          [cards[index], cards[next]] = [cards[next], cards[index]];
        } else return;
        this.renderPresentation(); this.updateButtons();
        if (action === "add-card") this.$(`input[data-path="hubCards.${cards.length - 1}.title"]`).focus();
        return;
      }
      const opened = new Set(this.$$(".ld-section[open]").map(node => Number(node.dataset.section)));
      if (this.fixedStructure()) return;
      if (action === "add-section") {
        const used = new Set(this.content.sections.map(section => section.id));
        let next = this.content.sections.length + 1;
        while (used.has(`section-${next}`)) next += 1;
        this.content.sections.push({ id: `section-${next}`, title: "Новый раздел", clauses: [] });
        opened.add(this.content.sections.length - 1);
      } else if (action === "add-clause") {
        const index = Number(button.dataset.s);
        this.content.sections[index].clauses ||= [];
        this.content.sections[index].clauses.push({ number: "", html: "" }); opened.add(index);
      } else if (["up", "down", "remove"].includes(action)) {
        const isSection = button.dataset.kind === "section";
        const index = Number(button.dataset.i);
        const array = isSection ? this.content.sections : this.content.sections[Number(button.dataset.s)].clauses;
        if (action === "remove") {
          if (!window.confirm(`Удалить ${isSection ? "раздел со всеми пунктами" : "пункт"} из черновика? Опубликованная версия сохранится в истории.`)) return;
          array.splice(index, 1);
        } else {
          const target = index + (action === "up" ? -1 : 1);
          if (target < 0 || target >= array.length) return;
          [array[index], array[target]] = [array[target], array[index]];
          if (isSection) opened.add(target);
        }
      } else return;
      this.renderSections(opened); this.updateButtons();
      if (action === "add-section") this.$(`.ld-section[data-section="${this.content.sections.length - 1}"] input`).focus();
      if (action === "add-clause") this.$(`.ld-section[data-section="${button.dataset.s}"] .ld-clause:last-child input`).focus();
    }

    filterSections(value) {
      const query = value.trim().toLocaleLowerCase("ru-RU");
      let count = 0;
      this.$$(".ld-section").forEach(node => {
        const section = this.content.sections[Number(node.dataset.section)];
        const headingMatches = section.title.toLocaleLowerCase("ru-RU").includes(query);
        let found = false;
        node.querySelectorAll(".ld-clause").forEach(clauseNode => {
          const [, c] = clauseNode.dataset.clause.split(":").map(Number);
          const clause = section.clauses[c];
          const matches = !query || headingMatches || `${clause.number} ${clauseNode.querySelector('[data-rich]').textContent}`.toLocaleLowerCase("ru-RU").includes(query);
          clauseNode.hidden = !matches; found ||= matches;
        });
        node.hidden = Boolean(query) && !headingMatches && !found;
        if (!node.hidden) { count += 1; if (query) node.open = true; }
      });
      this.$('[data-ld="no-results"]').hidden = count > 0;
    }

    rememberSelection() {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      const parent = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      const editor = parent?.closest?.('[data-rich]');
      if (editor && this.container.contains(editor)) { this.selectedRange = range.cloneRange(); this.focusedRich = editor; }
    }

    restoreSelection(editor) {
      editor.focus();
      if (this.selectedRange && editor.contains(this.selectedRange.commonAncestorContainer)) {
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(this.selectedRange);
        return true;
      }
      return false;
    }

    captureRich(editor) {
      const [s, c] = editor.dataset.rich.split(":").map(Number);
      // Only an actual edit changes this HTML; opening or saving metadata keeps the original bytes.
      this.content.sections[s].clauses[c].html = sanitizeHTML(editor.innerHTML);
      this.touchedRich.add(editor.dataset.rich);
    }

    format(button) {
      if (!this.editable() || this.busy || this.job) return;
      const editor = this.$(`[data-rich="${button.dataset.target}"]`);
      if (!editor) return;
      this.restoreSelection(editor);
      let value = null;
      if (button.dataset.command === "createLink") {
        if (!window.getSelection()?.toString()) { this.message("Сначала выделите текст ссылки в пункте."); return; }
        value = window.prompt("Адрес ссылки: /страница/, https://…, mailto:… или tel:…", "https://");
        if (value === null) return;
        value = safeURL(value);
        if (!value) { this.message("Укажите безопасный адрес ссылки. Служебные javascript: и data: запрещены.", "error"); return; }
        this.restoreSelection(editor);
      }
      document.execCommand(button.dataset.command, false, value);
      this.captureRich(editor); this.rememberSelection(); this.updateButtons();
    }

    onPaste(event) {
      const editor = event.target.closest('[data-rich]');
      if (!editor) return;
      event.preventDefault();
      if (!this.editable() || this.busy || this.job) return;
      const text = event.clipboardData?.getData("text/plain") || "";
      document.execCommand("insertText", false, text);
      this.captureRich(editor); this.rememberSelection(); this.updateButtons();
    }

    collect() {
      let value;
      if (this.raw !== null) {
        try { value = JSON.parse(this.raw); } catch (error) { throw new Error("Исправьте JSON перед сохранением: " + error.message); }
        if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Корень документа должен быть объектом JSON.");
        for (const key of HASH_KEYS) {
          if (Object.hasOwn(value, key)) throw new Error("Контрольные суммы изменяет система. Уберите поле «" + key + "» из редактора.");
          if (Object.hasOwn(this.content, key)) value[key] = this.content[key];
        }
      } else {
        value = clone(this.content);
        if (this.document.id === "document-presentation") {
          if (!String(value.hubTitle || "").trim()) throw new Error("Укажите заголовок каталога.");
          if (!Array.isArray(value.hubCards) || !value.hubCards.length) throw new Error("Оставьте хотя бы одну карточку документа.");
          const urls = new Set();
          for (const card of value.hubCards) {
            if (!String(card.title || "").trim() || !String(card.description || "").trim()) throw new Error("Укажите название и описание каждой карточки.");
            if (!/^\/(?:[a-z0-9_-]+\/)+$/.test(card.url || "")) throw new Error("Укажите относительный адрес карточки с завершающим слешем, например /oferta/.");
            if (urls.has(card.url)) throw new Error("В каталоге повторяется адрес: " + card.url);
            urls.add(card.url);
          }
          return value;
        }
        if (!String(value.title || "").trim()) throw new Error("Укажите название документа.");
        const sectionIds = new Set(); const numbers = new Set();
        for (const section of value.sections) {
          if (!section.id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(section.id)) throw new Error("Укажите уникальный якорь раздела латинскими буквами и цифрами; допустимы дефис, подчёркивание, точка и двоеточие.");
          if (sectionIds.has(section.id)) throw new Error("Повторяется якорь раздела: " + section.id);
          sectionIds.add(section.id);
          if (!section.title?.trim()) throw new Error("Укажите название каждого раздела.");
          for (const clause of section.clauses || []) {
            if (!String(clause.number || "").trim()) throw new Error("Укажите номер каждого пункта.");
            if (numbers.has(clause.number)) throw new Error("Повторяется номер пункта: " + clause.number);
            numbers.add(clause.number);
          }
        }
      }
      return value;
    }

    async save(quiet = false) {
      if (!this.editable() || this.busy || this.job) return false;
      let content;
      try { content = this.collect(); } catch (error) { this.showError(error); return false; }
      this.busy = true; this.updateButtons();
      try {
        const payload = await request("/" + encodeURIComponent(this.document.id), {
          method: "PUT", body: JSON.stringify({ content, expected_revision: this.document.draft_revision ?? this.document.revision })
        });
        if (this.destroyed) return false;
        const next = payload.document || payload;
        this.acceptDocument(next.draft_content || next.content ? next : { ...this.document, ...next, draft_content: content, has_changes: true });
        if (!quiet) this.message("Черновик сохранён. На сайте остаётся прежняя опубликованная версия.", "success");
        return true;
      } catch (error) { this.showError(error); return false; }
      finally { this.busy = false; this.updateButtons(); }
    }

    confirmPublish(summary) {
      this.busy = true; this.updateButtons();
      const dialog = document.createElement("dialog");
      dialog.className = "ld-confirm-dialog";
      dialog.setAttribute("aria-labelledby", "ld-publish-confirm-title");
      dialog.setAttribute("aria-describedby", "ld-publish-confirm-description");
      dialog.innerHTML = '<form method="dialog"><span class="ld-confirm-eyebrow">Публикация на сайте</span><h3 id="ld-publish-confirm-title">Подтвердите публикацию</h3><p id="ld-publish-confirm-description"></p><div class="ld-confirm-actions"><button type="submit" class="button" value="cancel" data-ld-confirm="cancel" autofocus>Отмена</button><button type="submit" class="button accent" value="publish" data-ld-confirm="publish">Опубликовать</button></div></form>';
      dialog.querySelector("p").textContent = summary;
      this.container.append(dialog); this.confirmDialog = dialog;
      return new Promise(resolve => {
        dialog.addEventListener("close", () => {
          const approved = dialog.returnValue === "publish" && !this.destroyed;
          dialog.remove(); this.confirmDialog = null;
          this.busy = false; this.updateButtons(); resolve(approved);
        }, { once: true });
        try { dialog.showModal(); }
        catch (error) {
          dialog.remove(); this.confirmDialog = null; this.busy = false; this.updateButtons();
          this.showError(new Error("Не удалось открыть подтверждение публикации. Обновите браузер. " + error.message));
          resolve(false);
        }
      });
    }

    async publish() {
      if (!this.editable() || this.busy || this.job) return;
      let content;
      try { content = this.collect(); } catch (error) { this.showError(error); return; }
      const published = this.document.published_content;
      if (this.document.type === "offer" && published?.version === content.version && (this.hasUnsavedChanges() || this.document.has_changes)) {
        this.setTab("edit"); this.$('[data-path="version"]')?.closest("details")?.setAttribute("open", "");
        this.$('[data-path="version"]')?.focus();
        this.message("Для изменённой оферты нужна новая уникальная версия и новый постоянный адрес. Опубликованная редакция останется в истории.", "error"); return;
      }
      const summary = `Опубликовать документ «${content.title || this.document.title}»?\n\nСтраница: ${this.document.url || content.url || "—"}${content.version ? "\nВерсия: " + content.version : ""}\n\n${this.hasUnsavedChanges() ? "Текущие изменения сначала будут сохранены в черновик. " : ""}После проверки и сборки новая редакция станет доступна посетителям сайта. Предыдущие версии сохраняются.`;
      if (!await this.confirmPublish(summary)) return;
      if (this.hasUnsavedChanges() && !await this.save(true)) return;
      this.busy = true; this.updateButtons();
      try {
        const payload = await request("/" + encodeURIComponent(this.document.id) + "/publish", {
          method: "POST", body: JSON.stringify({ expected_revision: this.document.draft_revision ?? this.document.revision })
        });
        if (this.destroyed) return;
        const job = payload.job || (payload.job_id ? { id: payload.job_id, status: "queued" } : null);
        if (job) { this.trackJob(job); this.message("Публикация поставлена в очередь. Дождитесь подтверждения результата."); }
        else if (payload.document) { this.acceptDocument(payload.document); this.message("Документ опубликован.", "success"); }
        else throw new Error("Сервер принял запрос без подтверждения публикации. Обновите документ и проверьте историю.");
      } catch (error) { this.showError(error); }
      finally { this.busy = false; this.updateButtons(); }
    }

    async restore(versionId) {
      if (!this.confirmLeave()) return;
      if (!window.confirm("Восстановить выбранную версию в черновик? Текущий черновик будет заменён. Опубликованный документ и история не изменятся; для сайта потребуется отдельная публикация.")) return;
      this.busy = true; this.updateButtons();
      try {
        const payload = await request("/" + encodeURIComponent(this.document.id) + "/restore", {
          method: "POST", body: JSON.stringify({ version_id: versionId, expected_revision: this.document.draft_revision ?? this.document.revision })
        });
        if (this.destroyed) return;
        this.acceptDocument(payload.document || payload); this.setTab("edit");
        this.message("Историческая версия восстановлена только в черновик. Проверьте даты и идентификатор перед новой публикацией.", "success");
      } catch (error) { this.showError(error); }
      finally { this.busy = false; this.updateButtons(); }
    }

    trackJob(job) {
      this.job = job; this.pollFailures = 0;
      clearTimeout(this.pollTimer);
      this.renderJob(); this.updateButtons();
      this.pollTimer = setTimeout(() => this.pollJob(), 1500);
    }

    renderJob() {
      const node = this.$('[data-ld="job"]');
      if (!this.job) { node.hidden = true; return; }
      const labels = { queued: "В очереди", pending: "В очереди", running: "Выполняется", completed: "Завершено", succeeded: "Завершено", success: "Завершено", failed: "Ошибка", error: "Ошибка" };
      node.hidden = false;
      node.innerHTML = `<span class="ld-spinner" aria-hidden="true"></span><div><strong>Публикация: ${escape(labels[this.job.status] || this.job.status || "Проверка статуса")}</strong><small>Задание ${escape(this.job.id)}${this.job.message ? " · " + escape(asText(this.job.message)) : ""}</small></div><button type="button" class="button" data-action="poll-job">Проверить</button>`;
    }

    async pollJob() {
      if (!this.job || this.destroyed || this.polling) return;
      clearTimeout(this.pollTimer); this.polling = true;
      const id = this.job.id;
      try {
        const payload = await request("/jobs/" + encodeURIComponent(id));
        if (this.destroyed || this.job?.id !== id) return;
        this.job = payload.job || payload; this.pollFailures = 0; this.renderJob();
        const status = this.job.status;
        if (["completed", "succeeded", "success", "published"].includes(status)) {
          this.job = null; this.renderJob();
          await this.load(this.document.id);
          this.message("Публикация завершена. Документ доступен на сайте, предыдущая версия сохранена в истории.", "success");
        } else if (["failed", "error", "cancelled"].includes(status)) {
          const reason = asText(this.job.error || this.job.message || this.job.result?.error || "Проверьте журнал публикации");
          this.job = null; this.renderJob(); this.message("Публикация не завершена: " + reason + ". Проверьте историю перед повторной попыткой.", "error");
        } else this.pollTimer = setTimeout(() => this.pollJob(), 2500);
      } catch (error) {
        this.pollFailures += 1;
        this.message("Не удалось проверить статус публикации. Повторная проверка безопасна; новый запуск не выполнялся. " + error.message, "error");
        if (this.pollFailures < 6) this.pollTimer = setTimeout(() => this.pollJob(), 5000);
      } finally { this.polling = false; this.updateButtons(); }
    }

    setTab(tab) {
      this.tab = ["edit", "preview", "history"].includes(tab) ? tab : "edit";
      this.$$("[data-tab]").forEach(button => { button.setAttribute("aria-selected", String(button.dataset.tab === this.tab)); });
      this.$$("[data-panel]").forEach(panel => { panel.hidden = panel.dataset.panel !== this.tab; });
      if (this.tab === "preview" && this.content) this.renderPreview();
    }

    renderPreview() {
      const panel = this.$('[data-panel="preview"]');
      let content;
      try { content = this.collect(); } catch (error) { panel.innerHTML = `<div class="ld-message ld-error">${escape(error.message)}</div>`; return; }
      const body = this.document.id === "document-presentation"
        ? `<header><small>ЭЛЕГСО</small><h1>${escape(content.hubTitle)}</h1><p>${escape(content.hubDescription)}</p></header>${(content.hubCards || []).map(card => `<section><h2>${escape(card.title)}</h2><p>${escape(card.description)}</p>${card.date ? `<p class="meta">${escape(card.date)}</p>` : ""}<p class="preview-link">${escape(content.openDocumentLabel || "Открыть документ")} · ${escape(card.url)}</p></section>`).join("")}`
        : Array.isArray(content.sections)
        ? `<header><small>ЭЛЕГСО · Юридические документы</small><h1>${escape(content.title)}</h1>${!content.version && content.lead ? `<p class="lead">${escape(content.lead)}</p>` : ""}<p class="meta">${content.revisionDate ? "Редакция от " + escape(content.revisionDate) : ""}${content.version ? " · " + escape(content.version) : ""}</p>${!content.version && content.notice ? `<aside>${escape(content.notice)}</aside>` : ""}</header>${content.sections.map(section => `<section><h2>${escape(section.title)}</h2>${(section.clauses || []).map(clause => `<div class="clause"><b>${escape(clause.number)}</b><div>${sanitizeHTML(clause.html, true)}</div></div>`).join("")}</section>`).join("")}`
        : `<h1>${escape(this.document.title)}</h1><pre>${escape(JSON.stringify(content, null, 2))}</pre>`;
      const css = `*{box-sizing:border-box}body{margin:0;padding:28px;color:#21352b;background:#fff;font:15px/1.7 Georgia,serif}main{max-width:850px;margin:auto}small,.meta{font:12px/1.5 Arial,sans-serif;color:#64776b}h1{font-size:30px;line-height:1.2}h2{font-size:21px;margin:30px 0 16px}aside{background:#eff5f0;padding:15px;border-left:3px solid #0b7554}.clause{display:grid;grid-template-columns:45px minmax(0,1fr);gap:12px;margin:15px 0}.clause>b{font:700 13px/1.7 Arial,sans-serif;color:#0b7554}.preview-link{color:#0b7554;text-decoration:underline}p{margin:0 0 10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace}code{overflow-wrap:anywhere}section,div{overflow-wrap:anywhere}@media(max-width:480px){body{padding:16px}h1{font-size:25px}.clause{grid-template-columns:35px minmax(0,1fr);gap:7px}}`;
      const src = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'"><style>${css}</style></head><body><main>${body}</main></body></html>`;
      panel.innerHTML = '<div class="ld-preview-head"><p class="ld-help">Безопасный предпросмотр текущего текста. Несохранённые изменения учтены; служебная шапка сайта и окончательная вёрстка могут отличаться. Ссылки здесь неактивны.</p><button class="button" type="button" data-action="preview-update">Обновить</button></div><iframe class="ld-preview" title="Предпросмотр юридического документа" sandbox="" referrerpolicy="no-referrer"></iframe>';
      panel.querySelector("iframe").srcdoc = src;
    }

    renderHistory() {
      const history = this.document.history || [];
      const panel = this.$('[data-panel="history"]');
      const recorded = this.document.published_at || this.document.updated_at;
      panel.innerHTML = `<div class="ld-card"><h3>История документа</h3><p class="ld-help">Восстановление создаёт черновик из выбранного снимка. История и опубликованная страница сохраняются. Для изменённой оферты перед публикацией нужна новая версия.</p>${recorded ? `<p class="ld-help">Последнее обновление записи: ${escape(displayDate(recorded))}</p>` : ""}<div class="ld-history">${history.length ? history.slice().sort((a, b) => (Date.parse(b.recorded_at || b.created_at) || 0) - (Date.parse(a.recorded_at || a.created_at) || 0)).map(item => {
        const version = item.version_id || item.id;
        const url = safeURL(item.url || item.permanentUrl);
        const actor = item.actor?.username || item.actor?.email || item.actor?.name || asText(item.actor);
        return `<article class="ld-history-item"><div><strong>${escape(version || item.revision || "Снимок")}</strong><span>${escape(item.kind || "Редакция")} · ревизия ${escape(item.revision ?? "—")}</span><small>Записано системой: ${escape(displayDate(item.recorded_at || item.created_at))}</small>${item.declared_published_at ? `<small>Дата в документе: ${escape(displayDate(item.declared_published_at))}</small>` : ""}${actor ? `<small>Автор действия: ${escape(actor)}</small>` : ""}${item.sha256 ? `<details><summary>Контрольная сумма</summary><code>${escape(item.sha256)}</code></details>` : ""}</div><div class="ld-history-actions">${url ? `<a class="button" href="${escape(url)}" target="_blank" rel="noopener noreferrer">Открыть ↗</a>` : ""}${version ? `<button class="button" type="button" data-action="restore" data-version="${escape(version)}" data-edit-control>Восстановить в черновик</button>` : ""}</div></article>`;
      }).join("") : '<p class="ld-help">Исторические снимки пока отсутствуют.</p>'}</div></div>`;
    }

    exportDraft() {
      let text;
      try { text = JSON.stringify(this.collect(), null, 2); }
      catch (_) { text = this.raw !== null ? this.raw : JSON.stringify(this.content, null, 2); }
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = `${String(this.document?.id || "document").replace(/[^a-zA-Z0-9_-]/g, "_")}-draft.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.loadToken += 1; clearTimeout(this.pollTimer);
      if (this.confirmDialog?.open) this.confirmDialog.close("cancel");
      window.removeEventListener("beforeunload", this.beforeUnload);
      for (const [name, handler] of [["click", this.handleClick], ["input", this.handleInput], ["change", this.handleChange], ["paste", this.handlePaste], ["drop", this.handleDrop], ["focusin", this.handleFocus], ["keyup", this.handleSelection], ["mouseup", this.handleSelection], ["mousedown", this.handleMouseDown], ["keydown", this.handleKeyDown]]) this.container.removeEventListener(name, handler);
      instances.delete(this.container); mounted.delete(this);
    }
  }

  window.ElegsoLegalDocuments = {
    mount(container, currentUser) {
      if (typeof container === "string") container = document.querySelector(container);
      if (!(container instanceof Element)) throw new Error("Не найден контейнер редактора юридических документов");
      if (instances.has(container)) return instances.get(container);
      const editor = new Editor(container, currentUser);
      instances.set(container, editor); mounted.add(editor);
      return editor;
    },
    confirmLeave() { return [...mounted].every(editor => editor.confirmLeave()); },
    hasUnsavedChanges() { return [...mounted].some(editor => editor.hasUnsavedChanges()); }
  };
})();
