/* ==== Dialogs (plugin-styled; native alert/confirm/prompt are forbidden),
   context menu, and the environment manager ==== */

function closeTopOverlay() {
  const overlay = document.querySelector(".overlay");
  if (overlay) {
    overlay.remove();
    return true;
  }
  return false;
}

function openDialog(content, { wide, initialFocus } = {}) {
  const dialog = el("div", { class: "dialog" + (wide ? " dialog--wide" : ""), role: "dialog", "aria-modal": "true" });
  dialog.append(content);
  const overlay = el("div", {
    class: "overlay",
    onclick: (event) => { if (event.target === overlay) closeDialog(); },
  }, dialog);
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeDialog();
    }
  });
  document.body.append(overlay);
  function closeDialog() {
    overlay.remove();
  }
  const focusTarget = initialFocus || dialog.querySelector("input, select, textarea, button");
  if (focusTarget) focusTarget.focus();
  return { close: closeDialog, dialog };
}

function promptDialog({ title, label, value, okText, errorText }) {
  return new Promise((resolve) => {
    const input = el("input", { class: "input", type: "text", value: value || "", spellcheck: "false" });
    const error = el("div", { class: "dialog__error", text: errorText || "", hidden: true });
    let handle;
    const submit = () => {
      const text = input.value.trim();
      if (!text) {
        error.textContent = I18N.t("nameRequired");
        error.hidden = false;
        input.classList.add("input--error");
        return;
      }
      handle.close();
      resolve(text);
    };
    const form = el("form", {},
      el("h2", { class: "dialog__title", text: title }),
      el("div", { class: "dialog__field" },
        el("label", { text: label, for: "dialog-input" }),
        input,
        error,
      ),
      el("div", { class: "dialog__actions" },
        el("button", {
          class: "btn", type: "button", text: I18N.t("keepEditing"),
          onclick: () => { handle.close(); resolve(null); },
        }),
        el("button", { class: "btn btn--primary", type: "submit", text: okText || I18N.t("save") }),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    handle = openDialog(form, { initialFocus: input });
  });
}

function confirmDialog({ title, message, okText, okClass, cancelText }) {
  return new Promise((resolve) => {
    let handle;
    const panel = el("div", {},
      el("h2", { class: "dialog__title", text: title }),
      el("p", { class: "dialog__message", text: message }),
      el("div", { class: "dialog__actions" },
        el("button", {
          class: "btn", type: "button", text: cancelText || I18N.t("keepEditing"),
          onclick: () => { handle.close(); resolve(false); },
        }),
        el("button", {
          class: "btn " + (okClass || "btn--primary"), type: "button", text: okText || I18N.t("send"),
          onclick: () => { handle.close(); resolve(true); },
        }),
      ),
    );
    handle = openDialog(panel);
  });
}

/** Unsaved-changes guard: Save / Discard / Cancel (Cancel is the default). */
function unsavedDialog() {
  return new Promise((resolve) => {
    let handle;
    const cancelBtn = el("button", {
      class: "btn", type: "button", text: I18N.t("keepEditing"),
      onclick: () => { handle.close(); resolve("cancel"); },
    });
    const panel = el("div", {},
      el("h2", { class: "dialog__title", text: I18N.t("unsavedTitle") }),
      el("p", { class: "dialog__message", text: I18N.t("unsavedMessage") }),
      el("div", { class: "dialog__actions" },
        el("button", {
          class: "btn btn--danger", type: "button", text: I18N.t("discard"),
          onclick: () => { handle.close(); resolve("discard"); },
        }),
        el("button", {
          class: "btn btn--primary", type: "button", text: I18N.t("saveChanges"),
          onclick: () => { handle.close(); resolve("save"); },
        }),
        cancelBtn,
      ),
    );
    handle = openDialog(panel, { initialFocus: cancelBtn });
  });
}

/* ---- Context menu ---- */

function closeContextMenu() {
  const menu = document.querySelector(".menu");
  if (menu) menu.remove();
}

function openContextMenu(anchor, items) {
  closeContextMenu();
  const menu = el("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item.sep) {
      menu.append(el("div", { class: "menu__sep" }));
      continue;
    }
    menu.append(el("button", {
      class: "menu__item" + (item.danger ? " menu__item--danger" : ""),
      type: "button",
      role: "menuitem",
      text: item.label,
      disabled: item.disabled || undefined,
      title: item.title || undefined,
      onclick: () => {
        closeContextMenu();
        item.action();
      },
    }));
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let x = rect.left;
  let y = rect.bottom + 4;
  if (x + menuRect.width > window.innerWidth - 8) x = window.innerWidth - menuRect.width - 8;
  if (y + menuRect.height > window.innerHeight - 8) y = rect.top - menuRect.height - 4;
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
  const first = menu.querySelector("button:not(:disabled)");
  if (first) first.focus();
}

document.addEventListener("click", (event) => {
  const menu = document.querySelector(".menu");
  if (menu && !menu.contains(event.target)) closeContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeContextMenu();
    closeTopOverlay();
  }
});

/* ---- Environment manager ---- */

function openEnvironmentManager() {
  let selectedId = State.settings.selectedEnvId || (State.environments[0] && State.environments[0].id) || null;

  let list, editor, handle;
  const rerender = () => {
    renderEnvList();
    renderEnvEditor();
  };

  const content = el("div", {},
    el("h2", { class: "dialog__title", text: I18N.t("envManagerTitle") }),
    el("div", { class: "env-manager" },
      el("div", { class: "env-list", id: "env-list" }),
      el("div", { class: "env-editor", id: "env-editor" }),
    ),
    el("div", { class: "dialog__actions" },
      el("button", {
        class: "btn", type: "button", text: I18N.t("keepEditing"),
        onclick: () => { handle.close(); Editor.refreshEnvSelector(); },
      }),
    ),
  );

  handle = openDialog(content, { wide: true });

  function currentEnv() {
    return State.environments.find((env) => env.id === selectedId) || null;
  }

  function renderEnvList() {
    list = content.querySelector("#env-list");
    list.textContent = "";
    for (const env of State.environments) {
      const item = el("button", {
        class: "env-list__item" + (env.id === selectedId ? " env-list__item--active" : ""),
        type: "button",
        onclick: () => { selectedId = env.id; rerender(); },
      },
        el("span", { text: env.name, style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }),
        env.prodLike ? el("span", { class: "badge badge--prod", text: I18N.t("prodBadge") }) : null,
      );
      list.append(item);
    }
    list.append(el("div", { style: "padding:6px" },
      el("button", {
        class: "btn btn--sm btn--ghost", type: "button",
        onclick: () => {
          const env = newEnvironment();
          State.environments.push(env);
          selectedId = env.id;
          scheduleSave();
          rerender();
        },
      }, icon("plus"), I18N.t("newEnv")),
    ));
  }

  function renderEnvEditor() {
    editor = content.querySelector("#env-editor");
    editor.textContent = "";
    const env = currentEnv();
    if (!env) {
      editor.append(el("div", { class: "empty", text: I18N.t("noEnvSelected") }));
      return;
    }

    const nameInput = el("input", { class: "input", type: "text", value: env.name, "aria-label": I18N.t("envName") });
    nameInput.addEventListener("change", () => {
      env.name = nameInput.value.trim() || env.name;
      nameInput.value = env.name;
      scheduleSave();
      renderEnvList();
    });

    const prodBox = el("input", { type: "checkbox" });
    prodBox.checked = !!env.prodLike;
    prodBox.addEventListener("change", () => {
      env.prodLike = prodBox.checked;
      scheduleSave();
      renderEnvList();
      Editor.refreshEnvSelector();
    });

    const confirmBox = el("input", { type: "checkbox" });
    confirmBox.checked = env.confirmUnsafe !== false;
    confirmBox.addEventListener("change", () => {
      env.confirmUnsafe = confirmBox.checked;
      scheduleSave();
    });

    const delBtn = el("button", {
      class: "btn btn--sm btn--danger", type: "button", text: I18N.t("deleteEnv"),
      onclick: async () => {
        const ok = await confirmDialog({
          title: I18N.t("deleteEnv"),
          message: I18N.t("deleteEnvConfirm", { name: env.name }),
          okText: I18N.t("deleteEnv"),
          okClass: "btn--danger",
        });
        if (!ok) return;
        State.environments = State.environments.filter((e) => e.id !== env.id);
        if (State.settings.selectedEnvId === env.id) State.settings.selectedEnvId = null;
        selectedId = State.environments[0] ? State.environments[0].id : null;
        scheduleSave();
        rerender();
        Editor.refreshEnvSelector();
      },
    });

    editor.append(
      el("div", { class: "env-editor__head" },
        nameInput,
        delBtn,
      ),
      el("label", { class: "checkbox" }, prodBox, el("span", { text: I18N.t("prodLike") })),
      el("label", { class: "checkbox" }, confirmBox, el("span", { text: I18N.t("confirmUnsafe") })),
      el("div", { class: "hint", text: I18N.t("secretNote") }),
    );

    const varsBox = el("div", { class: "env-vars" });
    editor.append(varsBox);

    const rerenderRows = () => renderEnvVars(env, varsBox, rerenderRows);
    rerenderRows();
  }

  function renderEnvVars(env, varsBox, rerenderRows) {
    varsBox.textContent = "";
    const rows = env.variables;
    for (const row of rows) {
      const nameInput = el("input", {
        class: "kv-input mono", type: "text", value: row.name,
        "aria-label": I18N.t("key"), placeholder: "name", spellcheck: "false",
      });
      nameInput.addEventListener("input", () => { row.name = nameInput.value; scheduleSave(); });

      const valueInput = el("input", {
        class: "kv-input mono",
        type: row.secret && !row.reveal ? "password" : "text",
        value: row.value,
        "aria-label": I18N.t("value"), placeholder: "value", spellcheck: "false",
      });
      valueInput.addEventListener("input", () => { row.value = valueInput.value; scheduleSave(); });

      const revealBtn = el("button", {
        class: "icon-btn", type: "button",
        "aria-label": row.reveal ? "Hide value" : "Reveal value",
        onclick: () => {
          row.reveal = !row.reveal;
          valueInput.type = row.secret && !row.reveal ? "password" : "text";
          revealBtn.replaceChildren(icon(row.reveal ? "eyeOff" : "eye"));
        },
      }, icon(row.reveal ? "eyeOff" : "eye"));

      const secretBox = el("input", { type: "checkbox", "aria-label": I18N.t("secret") });
      secretBox.checked = !!row.secret;
      secretBox.addEventListener("change", () => {
        row.secret = secretBox.checked;
        scheduleSave();
      });

      varsBox.append(el("div", { class: "env-var-row" },
        nameInput,
        el("div", { class: "secret-wrap", style: "display:flex" }, valueInput, revealBtn),
        el("label", { class: "checkbox", title: I18N.t("secretNote") }, secretBox, el("span", { class: "hint", text: I18N.t("secret") })),
        el("span"),
        el("button", {
          class: "icon-btn", type: "button", "aria-label": I18N.t("deleteRow"),
          onclick: () => {
            rows.splice(rows.indexOf(row), 1);
            scheduleSave();
            rerenderRows();
          },
        }, icon("trash")),
      ));
    }
    varsBox.append(el("div", { style: "padding:6px 0" },
      el("button", {
        class: "btn btn--sm btn--ghost", type: "button",
        onclick: () => {
          rows.push({ name: "", value: "", secret: false });
          scheduleSave();
          rerenderRows();
        },
      }, icon("plus"), I18N.t("addVariable")),
    ));
  }

  rerender();
}
