/* ==== Key-value row editor (Params / Headers / env variables) ==== */

/**
 * Render a KV table bound to `rows` (mutated in place; caller persists).
 * opts: { columns: {description?:bool, secretToggle?:bool}, addLabel,
 *         rowMenu, onchange, fieldName }
 */
function renderKvEditor(container, rows, opts) {
  container.textContent = "";
  const showDesc = !opts || !opts.columns || opts.columns.description !== false;

  const head = el("div", { class: "kv__head" },
    el("span", { text: "" }),
    el("span", { text: I18N.t("key") }),
    el("span", { text: I18N.t("value") }),
    showDesc ? el("span", { text: I18N.t("description") }) : el("span"),
    el("span", { text: "" }),
  );

  const table = el("div", { class: "kv" });
  table.append(head);

  const commit = () => {
    if (opts && opts.onchange) opts.onchange();
  };

  if (!rows.length) {
    const emptyText = opts && opts.emptyText ? opts.emptyText : I18N.t("addParam");
    table.append(el("div", { class: "kv__empty empty", text: "" },
      el("span", { text: emptyText }),
    ));
  }

  for (const row of rows) {
    table.append(renderKvRow(row, rows, { showDesc, commit, opts }));
  }

  const foot = el("div", { class: "kv__foot" },
    el("button", {
      class: "btn btn--sm btn--ghost",
      type: "button",
      onclick: () => {
        rows.push(newRow());
        commit();
        renderKvEditor(container, rows, opts);
      },
    }, icon("plus"), I18N.t(opts && opts.addLabel ? opts.addLabel : "addParam")),
  );
  table.append(foot);
  container.append(table);
}

function renderKvRow(row, rows, ctx) {
  const { showDesc, commit, opts } = ctx;
  const wrap = el("div", { class: "kv-row" + (row.enabled ? "" : " kv-row--disabled") });

  const enabledBox = el("input", { type: "checkbox", "aria-label": I18N.t("enabled") });
  enabledBox.checked = !!row.enabled;
  enabledBox.addEventListener("change", () => {
    row.enabled = enabledBox.checked;
    commit();
    rerender();
  });

  const keyInput = el("input", {
    class: "kv-input mono",
    type: "text",
    spellcheck: "false",
    "aria-label": I18N.t("key"),
    placeholder: "key",
  });
  keyInput.value = row.key;
  keyInput.addEventListener("input", () => { row.key = keyInput.value; commit(); });

  const secretToggle = opts && opts.columns && opts.columns.secretToggle;
  let valueInput;
  const valueWrap = el("div", { class: "secret-wrap" });
  const applyMask = () => {
    valueInput.type = row.secret && !row.reveal ? "password" : "text";
  };
  valueInput = el("input", {
    class: "kv-input mono",
    type: "text",
    spellcheck: "false",
    "aria-label": I18N.t("value"),
    placeholder: "value",
  });
  valueInput.value = row.value;
  applyMask();
  valueInput.addEventListener("input", () => { row.value = valueInput.value; commit(); });
  valueWrap.append(valueInput);

  if (secretToggle) {
    const revealBtn = el("button", {
      class: "icon-btn",
      type: "button",
      "aria-label": row.reveal ? "Hide value" : "Reveal value",
      title: row.reveal ? "Hide" : "Reveal",
      onclick: () => {
        row.reveal = !row.reveal;
        applyMask();
        revealBtn.replaceChildren(icon(row.reveal ? "eyeOff" : "eye"));
      },
    }, icon(row.reveal ? "eyeOff" : "eye"));
    valueWrap.append(revealBtn);
  }

  const descInput = showDesc
    ? el("input", {
        class: "kv-input",
        type: "text",
        "aria-label": I18N.t("description"),
        placeholder: I18N.t("description"),
      })
    : null;
  if (descInput) {
    descInput.value = row.description || "";
    descInput.addEventListener("input", () => { row.description = descInput.value; commit(); });
  }

  const menuBtn = el("button", {
    class: "icon-btn",
    type: "button",
    "aria-label": I18N.t("rowMenu"),
    title: I18N.t("rowMenu"),
    "aria-haspopup": "menu",
    onclick: (event) => openContextMenu(event.currentTarget, [
      {
        label: I18N.t("duplicateRow"),
        action: () => {
          const index = rows.indexOf(row);
          rows.splice(index + 1, 0, { ...deepClone(row), id: uuid("kv") });
          commit();
          rerender();
        },
      },
      { sep: true },
      {
        label: I18N.t("deleteRow"),
        danger: true,
        action: () => {
          const index = rows.indexOf(row);
          if (index >= 0) rows.splice(index, 1);
          commit();
          rerender();
        },
      },
    ]),
  }, icon("dots"));

  wrap.append(
    el("label", { class: "checkbox" }, enabledBox),
    keyInput,
    valueWrap,
    showDesc ? descInput : el("span"),
    el("div", { class: "kv-row__menu" }, menuBtn),
  );

  function rerender() {
    if (opts && opts.rerenderAll) {
      opts.rerenderAll();
    } else {
      const fresh = renderKvRow(row, rows, ctx);
      wrap.replaceWith(fresh);
    }
  }

  return wrap;
}
