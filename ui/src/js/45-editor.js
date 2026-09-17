/* ==== Request editor: header, command row, tabs, panels ==== */

const Editor = (() => {
  let urlInput, methodSelect, sendBtn, saveBtn;
  let renderUrlMirror = () => {};
  let syncingQuery = false;

  const TABS = [
    { id: "params", label: "tabParams" },
    { id: "headers", label: "tabHeaders" },
    { id: "auth", label: "tabAuth" },
    { id: "body", label: "tabBody" },
    { id: "settings", label: "tabSettings" },
  ];

  function init() {
    urlInput = $("#url-input");
    methodSelect = $("#method-select");
    sendBtn = $("#btn-send");
    saveBtn = $("#btn-save");

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      methodSelect.append(el("option", { value: method, text: method }));
    }
    methodSelect.addEventListener("change", () => {
      mutateCurrent((request) => { request.method = methodSelect.value; });
      methodSelect.className = "select method-select method-select--" + methodSelect.value;
    });

    urlInput.addEventListener("input", () => {
      mutateCurrent((request) => {
        request.url = urlInput.value;
        syncQueryFromUrl(request);
      }, { skipUrlRefresh: true });
    });
    initUrlMirror();
    sendBtn.addEventListener("click", () => RequestFlow.sendOrCancel());
    $("#btn-send-caret").addEventListener("click", (event) => openRequestMenu(event));
    $("#btn-sidebar-collapse").addEventListener("click", () => {
      State.settings.ui.sidebarCollapsed = true;
      applySidebarCollapsed();
      scheduleSave();
    });
    $("#btn-sidebar-show").addEventListener("click", () => {
      State.settings.ui.sidebarCollapsed = false;
      applySidebarCollapsed();
      scheduleSave();
    });
    saveBtn.addEventListener("click", () => saveCurrent());
    $("#btn-env-manager").addEventListener("click", openEnvironmentManager);
    $("#env-select").addEventListener("change", (event) => {
      State.settings.selectedEnvId = event.target.value || null;
      scheduleSave();
      refreshEnvSelector();
      ResponseView.render();
    });
    $("#btn-request-menu").addEventListener("click", (event) => openRequestMenu(event));
    $("#splitter-response").addEventListener("keydown", splitterKeyNav);
    $("#splitter-sidebar").addEventListener("keydown", splitterKeyNav);

    initSplitters();
    applySidebarCollapsed();
    refreshActionButtons();
    renderTabs();
    refreshEnvSelector();
    refreshHeader();
    refreshCommandRow();
  }

  /** Icon-bearing action buttons (shell leaves them empty for i18n safety). */
  function refreshActionButtons() {
    sendBtn.replaceChildren(icon("send"), el("span", { text: I18N.t("send") }));
    saveBtn.replaceChildren(icon("save"), el("span", { text: I18N.t("save") }));
    $("#btn-send-caret").replaceChildren(icon("chevron"));
    $("#btn-env-manager").replaceChildren(icon("globe"));
    $("#btn-sidebar-collapse").replaceChildren(icon("chevronsLeft"));
    $("#btn-sidebar-show").replaceChildren(icon("chevronsRight"));
    $("#btn-request-menu").replaceChildren(icon("dots"));
    const envButton = $("#btn-env-manager");
    envButton.title = I18N.t("manageEnvironments");
    envButton.setAttribute("aria-label", I18N.t("manageEnvironments"));
  }

  function applySidebarCollapsed() {
    $(".app").classList.toggle("app--sidebar-collapsed", !!State.settings.ui.sidebarCollapsed);
    $("#btn-sidebar-show").hidden = !State.settings.ui.sidebarCollapsed;
  }

  /* ---- URL variable highlighting (mirror under a transparent-text input) ---- */

  function initUrlMirror() {
    const mirror = $("#url-mirror");
    const wrap = $("#url-wrap");
    renderUrlMirror = () => {
      const text = urlInput.value;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      text.replace(VAR_PATTERN, (match, name, offset) => {
        if (offset > lastIndex) fragment.append(document.createTextNode(text.slice(lastIndex, offset)));
        fragment.append(el("span", { class: "url-var", text: match }));
        lastIndex = offset + match.length;
        return match;
      });
      if (lastIndex < text.length) fragment.append(document.createTextNode(text.slice(lastIndex)));
      mirror.replaceChildren(fragment);
      mirror.scrollLeft = urlInput.scrollLeft;
    };
    urlInput.addEventListener("scroll", () => { mirror.scrollLeft = urlInput.scrollLeft; });
    wrap.dataset.mirrorReady = "1";
  }

  /* ---- splitters ---- */

  function initSplitters() {
    const sidebarSplitter = $("#splitter-sidebar");
    const responseSplitter = $("#splitter-response");
    const app = $(".app");
    const mainCol = $(".main-col");

    dragSplitter(sidebarSplitter, (event) => {
      const width = Math.min(440, Math.max(220, event.clientX));
      State.settings.ui.sidebarWidth = width;
      app.style.setProperty("--sidebar-w", width + "px");
    }, () => {
      app.style.setProperty("--sidebar-w", State.settings.ui.sidebarWidth + "px");
      scheduleSave();
    });

    dragSplitter(responseSplitter, (event) => {
      const rect = mainCol.getBoundingClientRect();
      const ratio = ((event.clientY - rect.top) / rect.height) * 100;
      const clamped = Math.min(80, Math.max(20, ratio));
      State.settings.ui.editorH = clamped;
      mainCol.style.setProperty("--editor-h", clamped + "%");
    }, () => {
      mainCol.style.setProperty("--editor-h", State.settings.ui.editorH + "%");
      scheduleSave();
    });

    app.style.setProperty("--sidebar-w", (State.settings.ui.sidebarWidth || 288) + "px");
    mainCol.style.setProperty("--editor-h", (State.settings.ui.editorH || 46) + "%");
  }

  function dragSplitter(handle, onMove, onEnd) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.classList.add("splitter--active");
      handle.setPointerCapture(event.pointerId);
      const move = (moveEvent) => onMove(moveEvent);
      const up = (upEvent) => {
        handle.classList.remove("splitter--active");
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        if (onEnd) onEnd();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  function splitterKeyNav(event) {
    const mainCol = $(".main-col");
    const step = event.shiftKey ? 8 : 2;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (event.currentTarget.id === "splitter-sidebar") {
      const delta = event.key === "ArrowLeft" ? -step : step;
      State.settings.ui.sidebarWidth = Math.min(440, Math.max(220, State.settings.ui.sidebarWidth + delta));
      $(".app").style.setProperty("--sidebar-w", State.settings.ui.sidebarWidth + "px");
    } else {
      const delta = (event.key === "ArrowUp" ? -step : step) * 0.6;
      State.settings.ui.editorH = Math.min(80, Math.max(20, State.settings.ui.editorH + delta));
      mainCol.style.setProperty("--editor-h", State.settings.ui.editorH + "%");
    }
    scheduleSave();
  }

  /* ---- current request plumbing ---- */

  function currentRequest() {
    return State.current ? State.current.request : null;
  }

  /** Mutate the current request, mark dirty, refresh dependent UI. */
  function mutateCurrent(fn, options = {}) {
    const request = currentRequest();
    if (!request) return;
    fn(request);
    State.current.dirty = true;
    if (!options.skipUrlRefresh) refreshCommandRow();
    refreshHeader();
    refreshTabs();
    saveBtn.disabled = false;
  }

  function refreshHeader() {
    const crumb = $("#breadcrumb");
    crumb.textContent = "";
    if (!State.current) return;
    crumb.append(icon("home"));
    const collection = State.current.collectionId
      ? State.collections.find((c) => c.id === State.current.collectionId) : null;
    const folder = State.current.folderId && collection
      ? findItem(State.current.folderId) : null;
    if (collection) {
      crumb.append(el("span", { class: "crumb-dim", text: collection.name }));
      crumb.append(el("span", { class: "crumb-dim", text: "/" }));
    }
    if (folder && folder.item) {
      crumb.append(el("span", { class: "crumb-dim", text: folder.item.name }));
      crumb.append(el("span", { class: "crumb-dim", text: "/" }));
    }
    crumb.append(el("span", { class: "crumb-name", text: State.current.request.name || I18N.t("draftName") }));
    if (State.current.dirty) {
      crumb.append(el("span", { class: "dirty-mark", text: "*", "aria-label": "Unsaved changes", title: I18N.t("unsavedTitle") }));
    }
    crumb.append(el("button", {
      class: "icon-btn crumb-rename", type: "button",
      "aria-label": I18N.t("rename"), title: I18N.t("rename"),
      onclick: () => renameCurrent(),
    }, icon("pencil")));
  }

  async function renameCurrent() {
    if (!State.current) return;
    const name = await promptDialog({
      title: I18N.t("rename"),
      label: I18N.t("requestName"),
      value: State.current.request.name || I18N.t("draftName"),
      okText: I18N.t("rename"),
    });
    if (!name) return;
    mutateCurrent((request) => { request.name = name; });
    scheduleSave();
    Sidebar.refresh();
  }

  function refreshCommandRow() {
    const request = currentRequest();
    if (!request) return;
    if (document.activeElement !== urlInput) {
      urlInput.value = request.url;
    }
    renderUrlMirror();
    methodSelect.value = request.method;
    methodSelect.className = "select method-select method-select--" + request.method;
    const tlsOff = request.settings && request.settings.verifyTls === false;
    let badge = $("#tls-badge");
    if (tlsOff) {
      if (!badge) {
        badge = el("span", { class: "badge badge--warn", id: "tls-badge", text: "TLS" });
        $("#method-select").before(badge);
      }
      badge.hidden = false;
    } else if (badge) {
      badge.hidden = true;
    }
  }

  function refreshEnvSelector() {
    const select = $("#env-select");
    select.textContent = "";
    select.append(el("option", { value: "", text: I18N.t("noEnvironment") }));
    for (const env of State.environments) {
      select.append(el("option", { value: env.id, text: env.name }));
    }
    select.value = State.settings.selectedEnvId || "";
    const env = selectedEnvironment();
    const badge = $("#env-prod-badge");
    badge.hidden = !(env && env.prodLike);
    ResponseView.render();
  }

  function refreshTabs() {
    const request = currentRequest();
    const tabbar = $("#editor-tabs");
    tabbar.textContent = "";
    if (!request) return;
    const counts = {
      params: (request.query || []).filter((r) => r.enabled).length,
      headers: (request.headers || []).filter((r) => r.enabled).length,
    };
    for (const tab of TABS) {
      const button = el("button", {
        class: "tab", role: "tab",
        "aria-selected": String(State.activeTab === tab.id),
        onclick: () => { State.activeTab = tab.id; renderTabs(); renderPanel(); },
      },
        el("span", { text: I18N.t(tab.label) }),
      );
      if (counts[tab.id]) button.append(el("span", { class: "tab__count", text: String(counts[tab.id]) }));
      tabbar.append(button);
    }
  }

  function renderTabs() {
    refreshTabs();
    renderPanel();
  }

  /* ---- panels ---- */

  function renderPanel() {
    const panel = $("#editor-panel");
    panel.textContent = "";
    const request = currentRequest();
    if (!request) return;
    if (State.activeTab === "params") renderParamsPanel(panel, request);
    else if (State.activeTab === "headers") renderHeadersPanel(panel, request);
    else if (State.activeTab === "auth") renderAuthPanel(panel, request);
    else if (State.activeTab === "body") renderBodyPanel(panel, request);
    else if (State.activeTab === "settings") renderSettingsPanel(panel, request);
  }

  const rerenderAllRows = () => renderPanel();

  function renderParamsPanel(panel, request) {
    if (!request.query.length) request.query.push(newRow());
    const box = el("div", { class: "panel-stack" });
    renderKvEditor(box, request.query, {
      addLabel: "addParam",
      rerenderAll: rerenderAllRows,
      onchange: () => {
        syncUrlFromQuery(request);
        mutateCurrent(() => {}, { skipUrlRefresh: true });
      },
    });
    panel.append(box);
  }

  function renderHeadersPanel(panel, request) {
    if (!request.headers.length) request.headers.push(newRow());
    const box = el("div", { class: "panel-stack" });
    renderKvEditor(box, request.headers, {
      addLabel: "addHeader",
      rerenderAll: rerenderAllRows,
      onchange: () => mutateCurrent(() => {}, { skipUrlRefresh: true }),
    });
    panel.append(box);
  }

  const AUTH_TYPES = [
    { id: "none", label: "authNone", desc: "authNoneDesc", icon: "slash" },
    { id: "apikey", label: "authApiKey", desc: "authApiKeyDesc", icon: "keyIcon" },
    { id: "bearer", label: "authBearer", desc: "authBearerDesc", icon: "shield" },
    { id: "basic", label: "authBasic", desc: "authBasicDesc", icon: "user" },
  ];

  function renderAuthPanel(panel, request) {
    const auth = request.auth;
    const rail = el("div", { class: "auth-rail", role: "tablist", "aria-label": I18N.t("authType") });
    const detail = el("div", { class: "auth-detail" });

    const renderDetail = () => {
      detail.textContent = "";
      const meta = AUTH_TYPES.find((t) => t.id === auth.type) || AUTH_TYPES[0];
      detail.append(
        el("h3", { class: "auth-detail__title", text: I18N.t(meta.label) }),
        el("p", { class: "auth-detail__desc", text: I18N.t(meta.desc) }),
      );

      const field = (labelKey, key, secret) => {
        const input = el("input", {
          class: "input mono", type: secret && !auth.reveal ? "password" : "text",
          value: auth[key] || "", spellcheck: "false",
          "aria-label": I18N.t(labelKey),
        });
        input.addEventListener("input", () => {
          mutateCurrent((req) => { req.auth[key] = input.value; });
        });
        detail.append(el("div", { class: "auth-detail__field" },
          el("label", { text: I18N.t(labelKey) }),
          el("div", { class: "secret-wrap", style: "display:flex" },
            input,
            secret
              ? el("button", {
                  class: "icon-btn", type: "button", style: "width:28px",
                  "aria-label": auth.reveal ? "Hide value" : "Reveal value",
                  onclick: () => {
                    auth.reveal = !auth.reveal;
                    renderDetail();
                  },
                }, icon(auth.reveal ? "eyeOff" : "eye"))
              : null,
          ),
        ));
      };

      if (auth.type === "bearer") field("tokenLabel", "token", true);
      if (auth.type === "basic") {
        field("usernameLabel", "username", false);
        field("passwordLabel", "password", true);
      }
      if (auth.type === "apikey") {
        field("apiKeyNameLabel", "keyName", false);
        field("apiKeyValueLabel", "keyValue", true);
        const inSelect = el("select", { class: "select", "aria-label": I18N.t("authIn") });
        for (const [value, label] of [["header", "authHeader"], ["query", "authQuery"]]) {
          const option = el("option", { value, text: I18N.t(label) });
          if ((auth.in || "header") === value) option.selected = true;
          inSelect.append(option);
        }
        inSelect.addEventListener("change", () => {
          mutateCurrent((req) => { req.auth.in = inSelect.value; });
        });
        detail.append(el("div", { class: "auth-detail__field" },
          el("label", { text: I18N.t("authIn") }), inSelect));
      }

      if (auth.type !== "none") {
        detail.append(
          el("div", { class: "auth-hint" },
            icon("info"),
            el("span", { text: I18N.t("authHint") }),
            el("button", {
              class: "link-btn", type: "button", text: I18N.t("goToEnvSettings"),
              onclick: openEnvironmentManager,
            }),
          ),
          el("p", { class: "hint auth-session-note", text: I18N.t("authSessionNote") }),
        );
      }
    };

    for (const type of AUTH_TYPES) {
      const selected = auth.type === type.id;
      rail.append(el("button", {
        class: "auth-rail__item",
        role: "tab",
        "aria-selected": String(selected),
        onclick: () => {
          if (auth.type === type.id) return;
          mutateCurrent((req) => { req.auth.type = type.id; });
          renderPanel();
        },
      },
        icon(type.icon),
        el("span", { text: I18N.t(type.label) }),
      ));
    }

    renderDetail();
    panel.append(el("div", { class: "auth-layout" }, rail, detail));
  }

  let bodyGutter, bodyArea;

  function renderBodyPanel(panel, request) {
    const typeSelect = el("select", { class: "select", "aria-label": I18N.t("bodyType") });
    for (const [value, label] of [["none", "bodyNone"], ["json", "bodyJson"], ["text", "bodyText"], ["urlencoded", "bodyForm"]]) {
      const option = el("option", { value, text: I18N.t(label) });
      if ((request.body.type || "none") === value) option.selected = true;
      typeSelect.append(option);
    }
    typeSelect.addEventListener("change", () => {
      mutateCurrent((req) => {
        req.body.type = typeSelect.value;
        if (typeSelect.value === "urlencoded" && !req.body.rows) req.body.rows = [];
      });
      renderPanel();
    });

    const toolbar = el("div", { class: "body-toolbar" },
      el("label", { class: "hint", text: I18N.t("bodyType") }),
      typeSelect,
      el("span", { class: "spacer" }),
    );

    if (request.body.type === "none") {
      panel.append(toolbar);
      return;
    }

    if (State.current && State.current.bodyRedacted) {
      panel.append(el("div", { class: "truncate-note", role: "status" },
        icon("info"),
        el("span", { text: I18N.t("bodyNotRestored") }),
      ));
      State.current.bodyRedacted = false;
    }

    if (request.body.type === "urlencoded") {
      panel.append(toolbar);
      if (!request.body.rows) request.body.rows = [];
      if (!request.body.rows.length) request.body.rows.push(newRow());
      const box = el("div", { class: "panel-stack" });
      renderKvEditor(box, request.body.rows, {
        addLabel: "addParam",
        rerenderAll: rerenderAllRows,
        onchange: () => {
          mutateCurrent((req) => {
            req.body.text = request.body.rows
              .filter((r) => r.enabled && r.key)
              .map((r) => encodeURIComponent(r.key) + "=" + encodeURIComponent(r.value))
              .join("&");
          }, { skipUrlRefresh: true });
        },
      });
      panel.append(box);
      return;
    }

    if (request.body.type === "json") {
      const formatBtn = el("button", { class: "btn btn--sm", text: I18N.t("format"), onclick: () => formatBody(true) });
      const minifyBtn = el("button", { class: "btn btn--sm", text: I18N.t("minify"), onclick: () => formatBody(false) });
      toolbar.append(formatBtn, minifyBtn);
    }

    bodyGutter = el("div", { class: "body-gutter", "aria-hidden": "true" });
    bodyArea = el("textarea", {
      class: "body-textarea",
      spellcheck: "false",
      "aria-label": I18N.t("tabBody"),
      placeholder: request.body.type === "json" ? '{ "key": "value" }' : "",
    });
    bodyArea.value = request.body.text || "";
    bodyArea.addEventListener("input", () => {
      mutateCurrent((req) => { req.body.text = bodyArea.value; });
      updateGutter();
      if (request.body.type === "json") updateJsonStatus(request.body.text);
    });
    bodyArea.addEventListener("scroll", () => {
      bodyGutter.scrollTop = bodyArea.scrollTop;
    });
    bodyArea.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = bodyArea.selectionStart;
        bodyArea.setRangeText("  ", start, bodyArea.selectionEnd, "end");
        mutateCurrent((req) => { req.body.text = bodyArea.value; });
      }
    });

    const wrap = el("div", { class: "body-editor-wrap" },
      el("div", { class: "body-editor" }, bodyGutter, bodyArea),
    );
    panel.append(toolbar, wrap);
    const status = el("div", { class: "field-error", id: "json-status", role: "status", hidden: request.body.type !== "json" });
    panel.append(status);
    updateGutter();
    if (request.body.type === "json") updateJsonStatus(request.body.text);
  }

  function updateGutter() {
    if (!bodyGutter || !bodyArea) return;
    const lines = bodyArea.value.split("\n").length;
    bodyGutter.textContent = "";
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= lines; i++) {
      frag.append(document.createTextNode(i + "\n"));
    }
    bodyGutter.append(frag);
    bodyGutter.scrollTop = bodyArea.scrollTop;
  }

  function updateJsonStatus(text) {
    const status = $("#json-status");
    if (!status) return;
    status.hidden = false;
    const trimmed = (text || "").trim();
    if (!trimmed) {
      status.replaceChildren();
      status.hidden = true;
      return;
    }
    try {
      JSON.parse(trimmed);
      status.classList.remove("field-error");
      status.replaceChildren(icon("check"), el("span", { text: I18N.t("jsonValid") }));
    } catch (error) {
      status.classList.add("field-error");
      status.replaceChildren(
        icon("alert"),
        el("span", { text: I18N.t("jsonInvalid") + " — " + error.message }),
      );
    }
  }

  function formatBody(pretty) {
    const request = currentRequest();
    if (!request || request.body.type !== "json") return;
    try {
      const parsed = JSON.parse(request.body.text || "");
      const text = pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed);
      request.body.text = text;
      State.current.dirty = true;
      renderPanel();
    } catch {
      announce(I18N.t("jsonInvalid"));
    }
  }

  function renderSettingsPanel(panel, request) {
    const settings = request.settings;
    const grid = el("div", { class: "settings-grid" });

    const numberField = (labelKey, key, min, max) => {
      const input = el("input", { class: "input", type: "number", value: settings[key], min, max, "aria-label": I18N.t(labelKey) });
      input.addEventListener("change", () => {
        mutateCurrent((req) => { req.settings[key] = clampInt(input.value, min, max, settings[key]); input.value = req.settings[key]; });
      });
      grid.append(el("label", { class: "hint", text: I18N.t(labelKey) }), input);
    };
    const boolField = (labelKey, key, onChange) => {
      const box = el("input", { type: "checkbox" });
      box.checked = settings[key] !== false;
      box.addEventListener("change", () => {
        mutateCurrent((req) => { req.settings[key] = box.checked; });
        if (onChange) onChange();
      });
      grid.append(el("span"), el("label", { class: "checkbox" }, box, el("span", { text: I18N.t(labelKey) })));
    };

    numberField("timeout", "timeoutMs", 1000, 300000);
    boolField("followRedirects", "followRedirects");
    numberField("maxRedirects", "maxRedirects", 0, 20);
    boolField("verifyTls", "verifyTls", () => {
      refreshCommandRow();
      const warning = panel.querySelector(".tls-warning");
      if (warning) warning.hidden = settings.verifyTls !== false;
    });

    panel.append(grid);

    const warning = el("div", {
      class: "tls-warning truncate-note", role: "alert",
      hidden: settings.verifyTls !== false,
      text: "⚠ " + I18N.t("tlsWarning"),
    });
    panel.append(warning);
  }

  /* ---- URL ↔ params sync ---- */

  function syncQueryFromUrl(request) {
    if (syncingQuery) return;
    syncingQuery = true;
    const { pairs } = parseUrlQuery(request.url);
    const disabledRows = request.query.filter((row) => !row.enabled);
    request.query = pairs.map((pair) => newRow(pair.key, pair.value)).concat(disabledRows);
    syncingQuery = false;
    if (State.activeTab === "params") renderPanel();
    refreshTabs();
  }

  function syncUrlFromQuery(request) {
    if (syncingQuery) return;
    syncingQuery = true;
    request.url = rebuildUrlQuery(request.url, serializeQueryPairs(request.query));
    syncingQuery = false;
    refreshCommandRow();
  }

  /* ---- actions ---- */

  function openRequestMenu(event) {
    openContextMenu(event.currentTarget, [
      { label: I18N.t("copyAsCurl"), action: () => RequestFlow.copyCurl() },
      { sep: true },
      { label: I18N.t("save"), action: () => saveCurrent() },
    ]);
  }

  async function saveCurrent() {
    const current = State.current;
    if (!current) return;
    const item = findItem(current.requestId);
    if (item && item.item) {
      item.item.request = deepClone(current.request);
      item.item.name = current.request.name || item.item.name;
    } else {
      // Draft: attach to the target (or first) collection.
      let collection = State.collections.find((c) => c.id === current.collectionId)
        || State.collections[0];
      if (!collection) {
        collection = newCollection("My Collection");
        State.collections.push(collection);
      }
      let parentItems = collection.items;
      if (current.folderId) {
        const folder = findItem(current.folderId);
        if (folder && folder.item && folder.item.type === "folder") parentItems = folder.item.items;
      }
      const newItem = {
        id: current.requestId,
        type: "request",
        name: current.request.name || I18N.t("draftName"),
        request: deepClone(current.request),
      };
      parentItems.push(newItem);
      current.collectionId = collection.id;
    }
    current.dirty = false;
    current.request.name = current.request.name || I18N.t("draftName");
    saveBtn.disabled = true;
    scheduleSave();
    Sidebar.refresh();
    refreshHeader();
    announce(I18N.t("announceSaved"), true);
  }

  /** Ask what to do about unsaved changes. Returns 'save' | 'discard' | 'cancel'. */
  async function guardUnsaved() {
    if (!State.current || !State.current.dirty) return "discard";
    return unsavedDialog();
  }

  function newRequest(location) {
    const id = uuid("req");
    const request = defaultRequest();
    request.name = I18N.t("draftName");
    State.current = {
      requestId: id,
      request,
      collectionId: (location && location.collectionId) || null,
      folderId: (location && location.folderId) || null,
      dirty: true,
      isNew: true,
    };
    State.lastOutcome = null;
    State.activeTab = "params";
    renderAll();
    urlInput.focus();
  }

  async function openRequest(itemId) {
    if (State.current && State.current.requestId === itemId) return;
    const guard = await guardUnsaved();
    if (guard === "cancel") return;
    if (guard === "save") await saveCurrent();
    const found = findItem(itemId);
    if (!found || found.item.type !== "request") return;
    const collection = findCollectionOf(itemId);
    const folder = found.parent && found.parent.type === "folder" ? found.parent : null;
    State.current = {
      requestId: itemId,
      request: deepClone(found.item.request),
      collectionId: collection ? collection.id : null,
      folderId: folder ? folder.id : null,
      dirty: false,
      isNew: false,
    };
    State.lastOutcome = null;
    renderAll();
  }

  async function restoreHistoryEntry(entry) {
    const guard = await guardUnsaved();
    if (guard === "cancel") return;
    if (guard === "save") await saveCurrent();
    const request = deepClone(entry.request);
    request.name = entry.name || request.name || entry.url;
    // Body text is never persisted in history (PRD §6.4); tell the user rather
    // than silently presenting a request with an empty body.
    const bodyRedacted = !!(request.body && request.body.redacted);
    if (bodyRedacted) {
      request.body = { type: request.body.type || "none", text: "" };
    }
    State.current = {
      requestId: uuid("req"),
      request,
      collectionId: null,
      folderId: null,
      dirty: true,
      isNew: true,
      bodyRedacted,
    };
    State.lastOutcome = null;
    renderAll();
    announce(
      bodyRedacted
        ? I18N.t("restoredFromHistory") + ". " + I18N.t("bodyNotRestored")
        : I18N.t("restoredFromHistory"),
      true,
    );
    if (bodyRedacted) toast(I18N.t("bodyNotRestored"));
  }

  /** Collection/folder containing the open request was deleted. */
  function markLocationDeleted() {
    if (!State.current) return;
    State.current.collectionId = null;
    State.current.folderId = null;
    State.current.isNew = true;
    State.current.dirty = true;
    refreshHeader();
    saveBtn.disabled = false;
  }

  function renderAll() {
    Sidebar.refresh();
    refreshHeader();
    refreshCommandRow();
    refreshEnvSelector();
    refreshTabs();
    renderPanel();
    saveBtn.disabled = !(State.current && State.current.dirty);
    ResponseView.render();
  }

  return {
    init,
    renderAll,
    renderPanel,
    refreshHeader,
    refreshEnvSelector,
    refreshTabs,
    refreshActionButtons,
    mutateCurrent,
    currentRequest,
    saveCurrent,
    guardUnsaved,
    newRequest,
    openRequest,
    restoreHistoryEntry,
    markLocationDeleted,
    formatBody,
    get urlInput() { return urlInput; },
  };
})();
