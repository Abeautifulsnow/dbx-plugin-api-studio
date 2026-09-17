/* ==== JSON tree viewer (lazy children, context actions, search) ==== */

const JsonView = (() => {
  const MAX_RENDER_DEPTH = 200;
  const PREVIEW_STR = 160;
  const MAX_SET_VAR_BYTES = 64 * 1024;

  /** Parse the payload and produce a lightweight node tree. */
  function buildTree(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    return { root: value };
  }

  function describe(value) {
    if (value === null) return { kind: "null", label: "null" };
    if (Array.isArray(value)) return { kind: "array", label: "[" + value.length + "]" };
    if (typeof value === "object") {
      return { kind: "object", label: "{" + Object.keys(value).length + "}" };
    }
    if (typeof value === "string") {
      const preview = value.length > PREVIEW_STR ? value.slice(0, PREVIEW_STR) + "…" : value;
      return { kind: "string", label: JSON.stringify(preview) };
    }
    return { kind: typeof value, label: String(value) };
  }

  function valueClass(kind) {
    if (kind === "string") return "jv-string";
    if (kind === "number") return "jv-number";
    if (kind === "null" || kind === "boolean") return "jv-literal";
    return "";
  }

  function containerEntries(value) {
    if (Array.isArray(value)) return value.map((v, i) => ({ key: String(i), path: "[" + i + "]", value: v }));
    return Object.keys(value).map((key) => ({
      key,
      path: /^[A-Za-z_$][\w$]*$/.test(key) ? "." + key : "[" + JSON.stringify(key) + "]",
      value: value[key],
    }));
  }

  function matches(nodePath, query) {
    if (!query) return true;
    return nodePath.toLowerCase().includes(query.toLowerCase());
  }

  /**
   * Render a JSON node as a DOM subtree. Children render lazily on expand so
   * wide payloads never stall the workbench (PRD NFR: 1 MB JSON < 300 ms).
   */
  function renderNode(key, path, value, depth, query, actions) {
    const info = describe(value);
    const rowPath = path;
    const isContainer = info.kind === "object" || info.kind === "array";
    const row = el("div", { class: "jv-row" + (actions ? " jv-row--clickable" : "") });

    const toggle = isContainer
      ? el("button", {
          class: "jv-toggle",
          "aria-expanded": "false",
          "aria-label": (key || "root") + " expand",
          title: "Expand",
        }, icon("chevron"))
      : el("span", { class: "jv-toggle" });

    row.append(toggle);
    if (key !== null && key !== undefined && path !== "$") {
      row.append(el("span", { class: "jv-key", text: JSON.stringify(key) }), el("span", { class: "jv-punct", text: ": " }));
    }

    if (!isContainer) {
      row.append(el("span", { class: valueClass(info.kind), text: info.label }));
    } else {
      row.append(
        el("span", { class: "jv-punct", text: info.kind === "array" ? "[" : "{" }),
        el("span", { class: "jv-summary", text: info.label }),
      );
    }

    const node = el("div", { class: "jv-node" });
    node.append(row);

    let childrenBox = null;
    let expanded = false;

    const renderChildren = () => {
      const entries = containerEntries(value);
      childrenBox = el("div", { class: "jv-children", role: "group" });
      if (!entries.length) {
        childrenBox.append(el("span", {
          class: "jv-summary",
          text: info.kind === "array" ? "[]" : "{}",
        }));
      }
      for (const entry of entries) {
        if (query && !matches(entry.key, query) && depth > MAX_RENDER_DEPTH) continue;
        childrenBox.append(renderNode(entry.key, rowPath + entry.path, entry.value, depth + 1, query, actions));
      }
    };

    const setExpanded = (expand) => {
      expanded = expand;
      toggle.setAttribute("aria-expanded", String(expand));
      if (expand) {
        if (!childrenBox) renderChildren();
        if (childrenBox.parentNode !== node) node.append(childrenBox);
      } else if (childrenBox && childrenBox.parentNode === node) {
        childrenBox.remove();
      }
    };

    if (isContainer) {
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        setExpanded(!expanded);
      });
      // Containers start collapsed except the root's direct children level.
      if (depth === 0) setExpanded(true);
    }

    if (actions) {
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        actions(event, { key: key === undefined ? null : key, path: jsonPathOf(rowPath), value });
      });
      row.addEventListener("dblclick", (event) => {
        actions(event, { key: key === undefined ? null : key, path: jsonPathOf(rowPath), value });
      });
    }

    return node;
  }

  function render(container, text, options) {
    container.textContent = "";
    const tree = buildTree(text);
    if (!tree) return false;
    const actions = options && options.onNodeAction;
    container.append(renderNode(null, "$", tree.root, 0, (options && options.query) || "", actions));
    return true;
  }

  function canSetAsVariable(value, truncated) {
    if (truncated) return false;
    if (value == null) return true;
    if (typeof value === "object") {
      try { return JSON.stringify(value).length <= MAX_SET_VAR_BYTES; } catch { return false; }
    }
    return String(value).length <= MAX_SET_VAR_BYTES;
  }

  return { render, buildTree, canSetAsVariable };
})();
