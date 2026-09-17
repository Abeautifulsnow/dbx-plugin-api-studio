/* ==== Send/cancel flow and the response inspector ==== */

const RequestFlow = {
  async sendOrCancel() {
    if (State.sending) {
      await Api.cancel(State.sending).catch(() => {});
      return;
    }
    this.send();
  },

  async send() {
    const current = State.current;
    if (!current || State.sending) return;
    const request = current.request;
    const scope = variableScope(request);

    const { spec, issues } = buildSendSpec(request, uuid("call"), scope, false);
    if (!this.validateOrReport(issues)) return;

    const env = selectedEnvironment();
    if (env && env.prodLike && env.confirmUnsafe !== false && UNSAFE_METHODS.includes(request.method)) {
      const ok = await confirmDialog({
        title: I18N.t("prodBadge") + " · " + env.name,
        message: I18N.t("confirmSendUnsafe", { env: env.name, method: request.method }),
        okText: I18N.t("sendAnyway"),
        okClass: "btn--danger",
      });
      if (!ok) return;
    }

    const callId = spec.requestId;
    State.sending = callId;
    State.lastOutcome = null;
    ResponseView.render();

    const timeoutMs = (spec.settings.timeoutMs || 30000) + 5000;
    let outcome;
    try {
      const result = await Api.request(spec, timeoutMs);
      if (State.sending !== callId) return; // superseded
      if (result && result.cancelled) {
        outcome = { kind: "cancelled" };
      } else {
        const response = normalizeResponse(result);
        State.responses.set(current.requestId, response);
        outcome = { kind: "response", response };
      }
    } catch (error) {
      if (State.sending !== callId) return;
      const category = (error && error.data && error.data.category) || "INTERNAL_ERROR";
      if (category === "REQUEST_CANCELLED") {
        outcome = { kind: "cancelled" };
      } else {
        outcome = { kind: "error", category, cause: (error && error.message) || String(error) };
      }
    } finally {
      if (State.sending === callId) State.sending = null;
    }

    State.lastOutcome = outcome.kind === "response" ? null : outcome;
    this.recordHistory(request, outcome);
    ResponseView.render();
    if (outcome.kind === "response") {
      announce(I18N.t("announceSent", { status: outcome.response.status }));
    } else if (outcome.kind === "cancelled") {
      announce(I18N.t("announceCancelled"));
    } else {
      announce(I18N.t("announceFailed", { category: outcome.category }));
    }
  },

  validateOrReport(issues) {
    const fields = Object.keys(issues);
    if (!fields.length) return true;
    const labels = {
      url: I18N.t("urlLabel"),
      headers: I18N.t("tabHeaders"),
      auth: I18N.t("tabAuth"),
      body: I18N.t("tabBody"),
    };
    const lines = fields.map((field) => {
      const issue = issues[field];
      const parts = [labels[field] || field];
      if (issue.invalid) parts.push(I18N.t("invalidUrl"));
      if (issue.json) parts.push(I18N.t("jsonInvalid"));
      if (issue.unresolved && issue.unresolved.length) {
        parts.push(I18N.t("unresolvedVars", { vars: issue.unresolved.join(", ") }));
      }
      return parts.join(" — ");
    });
    const panel = $("#editor-panel");
    let box = panel.querySelector(".field-error[data-send-errors]");
    if (!box) {
      box = el("div", { class: "field-error", "data-send-errors": "1", role: "alert" });
      panel.prepend(box);
    }
    box.textContent = lines.join(" · ");
    box.scrollIntoView({ block: "nearest" });
    announce(I18N.t("notSentYet") + " " + lines.join(". "));
    setTimeout(() => { box.remove(); }, 6000);
    return false;
  },

  /** History snapshot: built from the redacted request copy, so no credential —
   * typed literal or resolved — and no body text can reach persistence. */
  recordHistory(request, outcome) {
    const safe = redactRequestForHistory(request);
    const entry = {
      id: uuid("h"),
      timestamp: Date.now(),
      name: safe.name || "",
      method: safe.method,
      url: safe.url,
      status: outcome.kind === "response" ? outcome.response.status : null,
      durationMs: outcome.kind === "response" ? outcome.response.timing.totalMs : null,
      sizeBytes: outcome.kind === "response" ? outcome.response.body.sizeBytes : null,
      error: outcome.kind === "error" ? { category: outcome.category } : null,
      request: {
        version: 1,
        name: safe.name || "",
        method: safe.method,
        url: safe.url,
        query: [],
        headers: safe.headers
          .filter((row) => row.enabled)
          .map((row) => ({ name: row.key, value: row.value })),
        auth: { type: (safe.auth && safe.auth.type) || "none" },
        body: safe.body,
        variables: safe.variables,
      },
      responseMeta: outcome.kind === "response"
        ? { contentType: outcome.response.contentType, statusText: outcome.response.statusText }
        : null,
    };
    State.history.push(entry);
    if (State.history.length > 500) State.history.splice(0, State.history.length - 500);
    Api.historyAppend(deepClone(entry)).catch(() => {});
    Sidebar.render();
  },

  async copyCurl() {
    const request = State.current && State.current.request;
    if (!request) return;
    const scope = variableScope(request);
    const { spec } = buildSendSpec(request, "curl", scope, true);
    try {
      const result = await Api.exportCurl(spec, 10000);
      const ok = await copyText(result.curl);
      toast(ok ? I18N.t("copied") : I18N.t("copyFailed"));
    } catch (error) {
      toast(I18N.t("copyFailed") + ": " + (error && error.message));
    }
  },
};

function normalizeResponse(result) {
  const body = result.body || {};
  const timing = result.timing || {};
  return {
    requestId: result.requestId,
    status: result.status,
    statusText: result.statusText || "",
    headers: result.headers || [],
    contentType: result.contentType || null,
    body: {
      text: body.text != null ? body.text : null,
      base64: body.base64 != null ? body.base64 : null,
      truncated: !!body.truncated,
      sizeBytes: body.sizeBytes || 0,
    },
    finalUrl: result.finalUrl,
    redirectCount: result.redirectCount || 0,
    timing: {
      totalMs: timing.totalMs != null ? timing.totalMs : null,
      ttfbMs: timing.ttfbMs != null ? timing.ttfbMs : null,
      downloadMs: timing.downloadMs != null ? timing.downloadMs : null,
    },
    timestamp: Date.now(),
  };
}

/* ---- inspector view: content tabs + persistent diagnostics panel ---- */

const ResponseView = {
  init() {
    State.settings.ui.responseView = State.settings.ui.responseView || "text";
    ResponseView.render();
  },

  render() {
    const tabsBar = $("#response-tabs");
    const summary = $("#response-summary");
    const wrap = $("#response-wrap");
    const content = $("#response-content");
    const diag = $("#diagnostics-panel");
    content.textContent = "";
    tabsBar.textContent = "";
    summary.textContent = "";
    diag.textContent = "";

    const sending = !!State.sending;
    wrap.classList.toggle("response-body-wrap--sending", sending);

    const prior = wrap.querySelector(".sending-note");
    if (prior) prior.remove();
    if (sending) {
      wrap.append(el("div", { class: "sending-note", role: "status" },
        el("span", { class: "spinner", "aria-hidden": "true" }),
        el("span", { text: I18N.t("sending") }),
      ));
    }

    const response = this.activeResponse();
    this.renderSummary(summary, response, sending);
    this.renderDiagnostics(diag, response);

    if (State.lastOutcome && State.lastOutcome.kind === "error") {
      content.append(this.renderErrorCard(State.lastOutcome));
    } else if (State.lastOutcome && State.lastOutcome.kind === "cancelled") {
      content.append(el("div", { class: "cancelled-note", role: "status" },
        el("span", { class: "status-dot status-dot--cancelled" }),
        el("span", { text: I18N.t("requestCancelled") }),
      ));
    }

    if (!response) {
      if (!State.lastOutcome && content.children.length === 0) {
        content.append(el("div", { class: "empty", style: "margin:auto" },
          el("span", { text: I18N.t("noResponse") }),
        ));
      }
      return;
    }

    const tabs = tabsBar;
    const cookieCount = response.headers.filter((h) => h.name.toLowerCase() === "set-cookie").length;
    const tabDefs = [
      ["body", "responseBody", 0],
      ["headers", "responseHeaders", response.headers.length],
      ["cookies", "cookies", cookieCount],
    ];
    for (const [id, label, count] of tabDefs) {
      const button = el("button", {
        class: "tab", role: "tab",
        "aria-selected": String(State.responseTab === id),
        onclick: () => { State.responseTab = id; ResponseView.render(); },
      },
        el("span", { text: I18N.t(label) }),
      );
      if (count && id !== "body") button.append(el("span", { class: "tab__count", text: String(count) }));
      tabs.append(button);
    }
    content.append(tabs);

    if (State.responseTab === "headers") this.renderHeaders(content, response);
    else if (State.responseTab === "cookies") this.renderCookies(content, response);
    else this.renderBody(content, response);
  },

  activeResponse() {
    if (!State.current) return null;
    return State.responses.get(State.current.requestId) || null;
  },

  renderSummary(summary, response, sending) {
    if (!response) return;
    const statusClass = "status-dot--" + String(response.status)[0] + "xx";
    summary.append(
      el("span", { class: "stat stat--status" },
        el("span", { class: "status-dot " + statusClass, "aria-hidden": "true" }),
        el("span", { text: response.status + " " + response.statusText }),
      ),
      el("span", { class: "stat mono", text: formatMs(response.timing.totalMs) }),
      el("span", { class: "stat mono", text: formatBytes(response.body.sizeBytes) }),
      el("span", { class: "stat mono", text: formatTime(response.timestamp) }),
    );
    if (sending) {
      summary.append(el("span", { class: "badge badge--warn", text: I18N.t("sending") }));
    }
    summary.append(
      el("button", {
        class: "icon-btn", type: "button",
        "aria-label": I18N.t("copyValue"), title: I18N.t("copyValue"),
        onclick: async () => {
          const ok = await copyText(response.body.text || "");
          toast(ok ? I18N.t("copied") : I18N.t("copyFailed"));
        },
      }, icon("copy")),
      el("button", {
        class: "icon-btn", type: "button",
        "aria-label": I18N.t("moreActions"), title: I18N.t("moreActions"),
        "aria-haspopup": "menu",
        onclick: (event) => openContextMenu(event.currentTarget, [
          { label: I18N.t("copyAsCurl"), action: () => RequestFlow.copyCurl() },
        ]),
      }, icon("dots")),
    );
  },

  renderErrorCard(outcome) {
    const retry = el("button", { class: "btn btn--sm", text: I18N.t("retry"), onclick: () => RequestFlow.send() });
    return el("div", { class: "error-card", role: "alert" },
      el("div", { class: "error-card__title" },
        icon("alert"),
        el("span", { text: I18N.t("errSummary") + " — " + outcome.category }),
      ),
      el("p", { class: "error-card__cause", text: outcome.cause || "" }),
      el("p", { class: "error-card__next", text: I18N.t("errNext") + " " + nextStepFor(outcome.category) }),
      retry,
    );
  },

  renderHeaders(content, response) {
    const table = el("table", { class: "headers-table" });
    table.append(el("thead", {},
      el("tr", {},
        el("th", { text: I18N.t("key") }),
        el("th", { text: I18N.t("value") }),
      )));
    const body = el("tbody");
    for (const header of response.headers) {
      const row = el("tr", {},
        el("td", { text: header.name }),
        el("td", { text: header.value }),
      );
      row.addEventListener("dblclick", async () => {
        const ok = await copyText(header.name + ": " + header.value);
        toast(ok ? I18N.t("copied") : I18N.t("copyFailed"));
      });
      body.append(row);
    }
    table.append(body);
    content.append(el("div", { class: "response-content" }, table));
  },

  renderCookies(content, response) {
    const cookies = response.headers.filter((h) => h.name.toLowerCase() === "set-cookie");
    if (!cookies.length) {
      content.append(el("div", { class: "empty", text: I18N.t("noCookies") }));
      return;
    }
    const table = el("table", { class: "headers-table" });
    table.append(el("thead", {}, el("tr", {},
      el("th", { text: I18N.t("cookies") }),
    )));
    const body = el("tbody");
    for (const cookie of cookies) {
      body.append(el("tr", {}, el("td", { text: cookie.value })));
    }
    table.append(body);
    content.append(el("div", { class: "response-content" }, table));
  },

  /** Right-hand diagnostics panel: measured timing phases only (PRD: absent
   * phases read "not available", never invented) + real response info. */
  renderDiagnostics(diag, response) {
    if (!response) return;
    const { totalMs, ttfbMs, downloadMs } = response.timing;

    const phaseRow = (label, value, percent) => {
      const available = value != null;
      return el("div", { class: "diag-row" + (available ? "" : " diag-row--na") },
        el("span", { text: label }),
        el("span", { class: "mono", text: available ? formatMs(value) : I18N.t("timingNotAvailable") }),
        available && percent != null
          ? el("div", { class: "diag-bar" }, el("div", { class: "diag-bar__fill", style: "width:" + Math.max(1, percent) + "%" }))
          : null,
      );
    };

    const timing = el("div", { class: "diag-section" },
      el("h3", {}, el("span", { text: I18N.t("timingPanelTitle") }), el("span", { class: "mono", text: formatMs(totalMs) })),
      totalMs != null
        ? el("div", { class: "diag-total-bar" }, el("div", { class: "diag-total-bar__fill", style: "width:100%" }))
        : el("div", { class: "diag-total-bar" }),
    );
    if (ttfbMs != null && totalMs > 0) {
      timing.append(phaseRow(I18N.t("phaseTtfb"), ttfbMs, (ttfbMs / totalMs) * 100));
    } else {
      timing.append(phaseRow(I18N.t("phaseTtfb"), null, null));
    }
    if (downloadMs != null && totalMs > 0) {
      timing.append(phaseRow(I18N.t("phaseDownload"), downloadMs, (downloadMs / totalMs) * 100));
    } else {
      timing.append(phaseRow(I18N.t("phaseDownload"), null, null));
    }
    // Phases this transport cannot measure truthfully yet.
    for (const label of [I18N.t("phaseDns"), I18N.t("phaseConnect"), I18N.t("phaseTls"), I18N.t("phaseRequest")]) {
      timing.append(phaseRow(label, null, null));
    }
    diag.append(timing);

    const serverHeader = response.headers.find((h) => h.name.toLowerCase() === "server");
    const info = el("div", { class: "diag-section diag-info" },
      el("h3", { text: I18N.t("responseInfo") }),
    );
    const infoRow = (label, value, mono) => {
      if (value == null || value === "") return;
      info.append(el("div", { class: "diag-row" },
        el("span", { class: "hint", text: label }),
        el("span", { class: mono === false ? "" : "mono", text: String(value) }),
      ));
    };
    const statusClass = "status-dot--" + String(response.status)[0] + "xx";
    info.append(el("div", { class: "diag-row" },
      el("span", { class: "hint", text: I18N.t("infoStatus") }),
      el("span", { class: "diag-status" },
        el("span", { class: "status-dot " + statusClass }),
        response.status + " " + response.statusText,
      ),
    ));
    infoRow(I18N.t("infoSize"), formatBytes(response.body.sizeBytes));
    infoRow(I18N.t("infoType"), response.contentType);
    infoRow(I18N.t("infoServer"), serverHeader ? serverHeader.value : null);
    if (response.redirectCount > 0) {
      infoRow(I18N.t("infoRedirects"), I18N.t("redirectCountLabel", { count: response.redirectCount }));
    }
    infoRow(I18N.t("infoFinalUrl"), response.finalUrl);
    diag.append(info);
  },

  renderBody(content, response) {
    if (response.body.truncated) {
      content.append(el("div", { class: "truncate-note", role: "alert" },
        icon("alert"),
        el("span", {
          text: I18N.t("truncatedNote", {
            cap: formatBytes(State.settings.previewCapBytes),
            shown: formatBytes(response.body.sizeBytes),
          }),
        }),
      ));
    }

    const isJson = detectJson(response);
    const toolbar = el("div", { class: "json-toolbar" });

    if (response.body.text == null && response.body.base64 != null) {
      content.append(el("div", { class: "empty", style: "margin:auto" },
        el("span", {
          text: I18N.t("binaryBody", {
            size: formatBytes(response.body.sizeBytes),
            type: response.contentType || "application/octet-stream",
          }),
        }),
      ));
      return;
    }

    if (isJson) {
      const prettyBtn = el("button", {
        class: "btn btn--sm", text: I18N.t("prettify"),
        title: "Shift+Alt+F",
        onclick: () => {
          try {
            response.body.text = JSON.stringify(JSON.parse(response.body.text), null, 2);
            State.responses.set(State.current.requestId, response);
            ResponseView.render();
          } catch { /* keep original text */ }
        },
      });
      const viewToggle = el("div", { class: "tabs", style: "border:none;padding:0", role: "tablist" });
      for (const [id, label] of [["text", "viewText"], ["tree", "viewTree"]]) {
        viewToggle.append(el("button", {
          class: "tab", role: "tab", style: "height:28px",
          "aria-selected": String(State.settings.ui.responseView === id),
          onclick: () => { State.settings.ui.responseView = id; ResponseView.render(); },
        }, el("span", { text: I18N.t(label) })));
      }
      toolbar.append(
        el("span", { class: "body-format-chip mono", text: "{} JSON" }),
        prettyBtn,
        viewToggle,
      );

      if (State.settings.ui.responseView === "tree") {
        const search = el("input", {
          class: "input", type: "search",
          placeholder: I18N.t("searchJson"),
          "aria-label": I18N.t("searchJson"),
        });
        toolbar.append(search);
        var view = el("div", { class: "jsonview", role: "tree", "aria-label": I18N.t("responseBody") });
        const renderTree = (query) => {
          JsonView.render(view, response.body.text, {
            query,
            onNodeAction: (event, node) => openNodeMenu(event, node, response),
          });
        };
        renderTree("");
        let debounceTimer;
        search.addEventListener("input", () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => renderTree(search.value.trim()), 200);
        });
      }

      const copyBtn = el("button", {
        class: "btn btn--sm",
        onclick: async () => {
          const ok = await copyText(response.body.text);
          toast(ok ? I18N.t("copied") : I18N.t("copyFailed"));
        },
      }, icon("copy"), I18N.t("copyValue"));
      toolbar.append(el("span", { class: "spacer" }), copyBtn);
      content.append(toolbar);
      if (State.settings.ui.responseView === "tree") {
        content.append(view);
      } else {
        content.append(renderPrettyJson(response.body.text));
      }
      return;
    }

    toolbar.append(el("span", { class: "hint", text: response.contentType || "text/plain" }));
    const copyBtn = el("button", {
      class: "btn btn--sm",
      onclick: async () => {
        const ok = await copyText(response.body.text || "");
        toast(ok ? I18N.t("copied") : I18N.t("copyFailed"));
      },
    }, icon("copy"), I18N.t("copyValue"));
    toolbar.append(el("span", { class: "spacer" }), copyBtn);
    content.append(toolbar);
    content.append(renderPrettyJson(response.body.text || "", { highlight: false }));
  },
};

const PRETTY_HIGHLIGHT_LIMIT = 512 * 1024;

/** Pretty-printed view with a line-number gutter; JSON is syntax-colored
 * unless the payload is too large to highlight within the render budget. */
function renderPrettyJson(text, options) {
  const opts = options || {};
  const highlight = opts.highlight !== false;
  const escaped = escapeHtml(text);
  let codeHtml = null;
  if (highlight && text.length <= PRETTY_HIGHLIGHT_LIMIT) {
    codeHtml = highlightJson(escaped);
  }
  const lines = text.length ? text.split("\n").length : 1;
  const gutter = el("div", { class: "pretty-json__gutter", "aria-hidden": "true" });
  const gutterLines = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  gutter.textContent = gutterLines;
  const code = el("pre", { class: "pretty-json__code" });
  if (codeHtml !== null) {
    code.innerHTML = codeHtml;
  } else {
    code.textContent = text;
  }
  return el("div", { class: "pretty-json" }, gutter, code);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Minimal JSON tokenizer over escaped HTML: keys, strings, numbers, literals. */
function highlightJson(escaped) {
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, str, colon, literal) => {
      if (str && colon) return '<span class="pj-key">' + str + "</span>" + colon;
      if (str) return '<span class="pj-string">' + str + "</span>";
      if (literal) return '<span class="pj-literal">' + literal + "</span>";
      return '<span class="pj-number">' + match + "</span>";
    },
  );
}

function detectJson(response) {
  const type = (response.contentType || "").toLowerCase();
  if (type.includes("json")) return true;
  const text = response.body.text;
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function openNodeMenu(event, node, response) {
  const { key, path, value } = node;
  const canSetVar = JsonView.canSetAsVariable(value, response.body.truncated);
  openContextMenu(event.target.closest(".jv-row") || event.target, [
    {
      label: I18N.t("copyValue"),
      action: async () => {
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        toast((await copyText(text)) ? I18N.t("copied") : I18N.t("copyFailed"));
      },
    },
    {
      label: I18N.t("copyKey"),
      disabled: key == null,
      action: async () => toast((await copyText(String(key))) ? I18N.t("copied") : I18N.t("copyFailed")),
    },
    {
      label: I18N.t("copyPath"),
      action: async () => toast((await copyText(path)) ? I18N.t("copied") : I18N.t("copyFailed")),
    },
    { sep: true },
    {
      label: I18N.t("setEnvVar"),
      disabled: !canSetVar,
      title: canSetVar ? undefined : I18N.t("setEnvVarDisabled"),
      action: () => setResponseValueAsEnv(key, value),
    },
  ]);
}

async function setResponseValueAsEnv(key, value) {
  let env = selectedEnvironment();
  if (!env) {
    if (!State.environments.length) {
      env = newEnvironment();
      State.environments.push(env);
    } else {
      env = State.environments[0];
    }
    State.settings.selectedEnvId = env.id;
    Editor.refreshEnvSelector();
  }
  const name = String(key == null ? "value" : key).replace(/\s+/g, "_");
  const existing = env.variables.find((v) => v.name === name);
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (existing) {
    existing.value = serialized;
    existing.secret = false;
  } else {
    env.variables.push({ name, value: serialized, secret: false });
  }
  scheduleSave();
  toast(I18N.t("envVarSet", { name, env: env.name }));
}

/** Localized recovery hint per stable error category. */
const NEXT_STEP_KEYS = {
  INVALID_URL: "nextInvalidUrl",
  INVALID_REQUEST: "nextInvalidRequest",
  VARIABLE_UNRESOLVED: "nextVariableUnresolved",
  DNS_FAILED: "nextDnsFailed",
  CONNECT_FAILED: "nextConnectFailed",
  TLS_FAILED: "nextTlsFailed",
  TIMEOUT: "nextTimeout",
  REQUEST_CANCELLED: "nextRequestCancelled",
  TOO_MANY_REDIRECTS: "nextTooManyRedirects",
  BODY_TOO_LARGE: "nextBodyTooLarge",
  INTERNAL_ERROR: "nextInternalError",
};

function nextStepFor(category) {
  const key = NEXT_STEP_KEYS[category];
  return key ? I18N.t(key) : I18N.t("nextInternalError");
}
