/* ==== Sidebar: collections tree, search, history ==== */

const Sidebar = (() => {
  let treeRoot;

  function init() {
    treeRoot = $("#tree-root");
    $("#btn-new-request").addEventListener("click", () => Editor.newRequest());
    $("#btn-new-collection").addEventListener("click", createCollection);
    $("#search-input").addEventListener("input", (event) => {
      State.search = event.target.value.trim();
      render();
    });
    render();
  }

  function refresh() {
    render();
  }

  async function createCollection() {
    const name = await promptDialog({
      title: I18N.t("newCollection"),
      label: I18N.t("collectionName"),
      value: "My Collection",
      okText: I18N.t("newCollection"),
    });
    if (!name) return;
    State.collections.push(newCollection(name));
    scheduleSave();
    render();
  }

  function matchesSearch(request, text) {
    if (!text) return true;
    const haystack = (request.name + " " + request.request.url + " " + request.request.method).toLowerCase();
    return text.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
  }

  function render() {
    if (!treeRoot) return;
    treeRoot.textContent = "";
    const query = State.search;

    const collectionsHead = el("button", {
      class: "tree-section__head",
      "aria-expanded": "true",
      onclick: (event) => toggleSection(event.currentTarget),
    },
      icon("folder"),
      el("span", { text: I18N.t("collections") }),
    );
    const collectionsBox = el("div", { class: "tree-section" }, collectionsHead);

    if (!State.collections.length) {
      collectionsBox.append(el("div", { class: "empty" },
        el("span", { text: I18N.t("emptyCollections") }),
        el("button", { class: "btn btn--sm", text: I18N.t("newCollection"), onclick: createCollection }),
      ));
    } else if (query) {
      const hits = renderSearchResults(query);
      if (!hits) {
        collectionsBox.append(el("div", { class: "empty", text: I18N.t("noSearchResults") }));
      }
    } else {
      for (const collection of State.collections) {
        collectionsBox.append(renderCollection(collection));
      }
    }
    treeRoot.append(collectionsBox);
    treeRoot.append(renderHistorySection());
  }

  function toggleSection(headButton) {
    const expanded = headButton.getAttribute("aria-expanded") === "true";
    headButton.setAttribute("aria-expanded", String(!expanded));
    let box = headButton.nextElementSibling;
    while (box) {
      box.hidden = expanded;
      box = box.nextElementSibling;
    }
  }

  function renderSearchResults(query) {
    let any = false;
    const flat = el("div");
    const visit = (items, parentCollection) => {
      for (const item of items) {
        if (item.type === "folder") {
          visit(item.items, parentCollection);
        } else if (matchesSearch(item, query)) {
          any = true;
          flat.append(renderRequestRow(item, parentCollection));
        }
      }
    };
    for (const collection of State.collections) {
      visit(collection.items, collection);
    }
    if (any) return flat;
    return null;
  }

  function countRequests(items) {
    let total = 0;
    for (const item of items) {
      if (item.type === "request") total++;
      else if (item.items) total += countRequests(item.items);
    }
    return total;
  }

  function renderCollection(collection) {
    const expanded = isExpanded(collection.id, true);
    const head = el("button", {
      class: "tree-row",
      "aria-expanded": String(expanded),
      onclick: () => { toggleExpanded(collection.id); render(); },
      oncontextmenu: (event) => {
        event.preventDefault();
        openCollectionMenu(event, collection);
      },
    },
      icon("folder"),
      el("span", { class: "name", text: collection.name }),
      el("span", { class: "tree-count", text: String(countRequests(collection.items)) }),
      collectionMenuButton(collection),
    );
    const children = el("div", { class: "tree-children" });
    children.hidden = !expanded;
    for (const item of collection.items) {
      children.append(item.type === "folder" ? renderFolder(item, collection) : renderRequestRow(item, collection));
    }
    if (!collection.items.length) {
      children.append(el("div", { class: "empty", text: I18N.t("newRequestIn") + " →" }));
    }
    return el("div", { class: "tree-section" }, head, children);
  }

  function collectionMenuButton(collection) {
    return el("span", { class: "tree-row__actions" },
      el("button", {
        class: "icon-btn", type: "button", "aria-label": I18N.t("moreActions"),
        "aria-haspopup": "menu",
        onclick: (event) => {
          event.stopPropagation();
          openCollectionMenu(event, collection);
        },
      }, icon("dots")),
    );
  }

  function openCollectionMenu(event, collection) {
    openContextMenu(event.currentTarget, [
      { label: I18N.t("newRequestIn"), action: () => Editor.newRequest({ collectionId: collection.id, folderId: null }) },
      { label: I18N.t("newFolder"), action: () => createFolder(collection, null) },
      { sep: true },
      { label: I18N.t("rename"), action: () => renameCollection(collection) },
      {
        label: I18N.t("deleteCollection"),
        danger: true,
        action: async () => {
          const ok = await confirmDialog({
            title: I18N.t("deleteCollection"),
            message: I18N.t("deleteCollectionConfirm", { name: collection.name }),
            okText: I18N.t("deleteCollection"),
            okClass: "btn--danger",
          });
          if (!ok) return;
          State.collections = State.collections.filter((c) => c.id !== collection.id);
          if (State.current && State.current.collectionId === collection.id) {
            Editor.markLocationDeleted();
          }
          scheduleSave();
          render();
        },
      },
    ]);
  }

  async function createFolder(collection, parentFolder) {
    const name = await promptDialog({
      title: I18N.t("newFolder"),
      label: I18N.t("folderName"),
      value: "Folder",
      okText: I18N.t("newFolder"),
    });
    if (!name) return;
    const folder = { id: uuid("fld"), type: "folder", name, items: [] };
    if (parentFolder) parentFolder.items.push(folder);
    else collection.items.push(folder);
    scheduleSave();
    render();
  }

  function folderMenu(event, folder, collection) {
    openContextMenu(event.currentTarget, [
      { label: I18N.t("newRequestIn"), action: () => Editor.newRequest({ collectionId: collection.id, folderId: folder.id }) },
      { label: I18N.t("newFolder"), action: () => createFolder(collection, folder) },
      { sep: true },
      {
        label: I18N.t("rename"),
        action: async () => {
          const name = await promptDialog({
            title: I18N.t("rename"), label: I18N.t("folderName"), value: folder.name, okText: I18N.t("rename"),
          });
          if (name) {
            folder.name = name;
            scheduleSave();
            render();
          }
        },
      },
      {
        label: I18N.t("deleteFolder"),
        danger: true,
        action: async () => {
          const ok = await confirmDialog({
            title: I18N.t("deleteFolder"),
            message: I18N.t("deleteFolderConfirm", { name: folder.name }),
            okText: I18N.t("deleteFolder"),
            okClass: "btn--danger",
          });
          if (!ok) return;
          const owner = findItem(folder.id);
          if (owner && owner.parent) {
            owner.parent.items = owner.parent.items.filter((i) => i.id !== folder.id);
          }
          scheduleSave();
          render();
        },
      },
    ]);
  }

  function renderFolder(folder, collection) {
    const expanded = isExpanded(folder.id, true);
    const head = el("button", {
      class: "tree-row",
      "aria-expanded": String(expanded),
      onclick: () => { toggleExpanded(folder.id); render(); },
      oncontextmenu: (event) => {
        event.preventDefault();
        folderMenu(event, folder, collection);
      },
    },
      icon("folder"),
      el("span", { class: "name", text: folder.name }),
      el("span", { class: "tree-count", text: String(countRequests(folder.items)) }),
      el("span", { class: "tree-row__actions" },
        el("button", {
          class: "icon-btn", type: "button", "aria-label": I18N.t("moreActions"),
          "aria-haspopup": "menu",
          onclick: (event) => {
            event.stopPropagation();
            folderMenu(event, folder, collection);
          },
        }, icon("dots")),
      ),
    );
    const children = el("div", { class: "tree-children" });
    children.hidden = !expanded;
    for (const item of folder.items) {
      children.append(item.type === "folder" ? renderFolder(item, collection) : renderRequestRow(item, collection));
    }
    return el("div", { class: "tree-section" }, head, children);
  }

  function requestMenu(event, item, collection) {
    openContextMenu(event.currentTarget, [
      { label: I18N.t("rename"), action: () => renameRequest(item, collection) },
      {
        label: I18N.t("duplicate"),
        action: () => {
          const owner = findItem(item.id);
          const clone = deepClone(item);
          clone.id = uuid("req");
          clone.name = item.name + " (copy)";
          if (owner && owner.parent) owner.parent.items.splice(owner.parent.items.indexOf(item) + 1, 0, clone);
          else collection.items.push(clone);
          scheduleSave();
          render();
        },
      },
      { sep: true },
      {
        label: I18N.t("deleteRequest"),
        danger: true,
        action: async () => {
          const ok = await confirmDialog({
            title: I18N.t("deleteRequest"),
            message: I18N.t("deleteRequestConfirm", { name: item.name }),
            okText: I18N.t("deleteRequest"),
            okClass: "btn--danger",
          });
          if (!ok) return;
          const owner = findItem(item.id);
          if (owner && owner.parent) {
            owner.parent.items = owner.parent.items.filter((i) => i.id !== item.id);
          }
          if (State.current && State.current.requestId === item.id) {
            Editor.markLocationDeleted();
          }
          scheduleSave();
          render();
        },
      },
    ]);
  }

  async function renameCollection(collection) {
    const name = await promptDialog({
      title: I18N.t("rename"), label: I18N.t("collectionName"), value: collection.name, okText: I18N.t("rename"),
    });
    if (name) {
      collection.name = name;
      scheduleSave();
      render();
    }
  }

  async function renameRequest(item, collection) {
    const name = await promptDialog({
      title: I18N.t("rename"), label: I18N.t("requestName"), value: item.name, okText: I18N.t("rename"),
    });
    if (!name) return;
    item.name = name;
    if (State.current && State.current.requestId === item.id) {
      State.current.request.name = name;
      Editor.refreshHeader();
    }
    scheduleSave();
    render();
  }

  function renderRequestRow(item, collection) {
    const active = State.current && State.current.requestId === item.id;
    const row = el("button", {
      class: "tree-row" + (active ? " tree-row--active" : ""),
      onclick: () => Editor.openRequest(item.id),
      oncontextmenu: (event) => {
        event.preventDefault();
        requestMenu(event, item, collection);
      },
      title: item.request.url || item.name,
    },
      el("span", { class: "method-text method-text--" + item.request.method, text: item.request.method }),
      el("span", { class: "name", text: item.name }),
      el("span", { class: "tree-row__actions" },
        el("button", {
          class: "icon-btn", type: "button", "aria-label": I18N.t("moreActions"),
          "aria-haspopup": "menu",
          onclick: (event) => {
            event.stopPropagation();
            requestMenu(event, item, collection);
          },
        }, icon("dots")),
      ),
    );
    return row;
  }

  function renderHistorySection() {
    const open = State.settings.ui.historyOpen;
    const section = el("div", { class: "tree-section" });
    const head = el("button", {
      class: "tree-section__head",
      "aria-expanded": String(open),
      onclick: () => {
        State.settings.ui.historyOpen = !open;
        scheduleSave();
        render();
      },
    },
      icon("clock"),
      el("span", { text: I18N.t("history") }),
      el("span", { class: "tree-section__count", text: String(State.history.length) }),
      el("span", { class: "tree-section__spacer" }),
    );
    if (open && State.history.length) {
      head.append(el("span", { class: "tree-row__actions" },
        el("button", {
          class: "icon-btn", type: "button", "aria-label": I18N.t("clearHistory"),
          style: "width:24px;height:22px",
          onclick: async (event) => {
            event.stopPropagation();
            const ok = await confirmDialog({
              title: I18N.t("history"),
              message: I18N.t("clearHistoryConfirm"),
              okText: I18N.t("clearHistory"),
              okClass: "btn--danger",
            });
            if (!ok) return;
            State.history = [];
            await Api.historyClear().catch(() => {});
            render();
          },
        }, icon("trash")),
      ));
    }
    section.append(head);

    if (open) {
      if (!State.history.length) {
        section.append(el("div", { class: "empty", text: I18N.t("emptyHistory") }));
      } else {
        const list = el("div");
        for (const entry of [...State.history].reverse().slice(0, 100)) {
          list.append(renderHistoryRow(entry));
        }
        section.append(list);
      }
    }
    return section;
  }

  function renderHistoryRow(entry) {
    const statusClass = entry.status == null
      ? (entry.error ? "status-dot--err" : "status-dot--cancelled")
      : "status-dot--" + String(entry.status)[0] + "xx";
    return el("button", {
      class: "history-row",
      onclick: () => Editor.restoreHistoryEntry(entry),
      title: entry.url,
    },
      el("span", { class: "method-text method-text--" + entry.method, text: entry.method }),
      el("span", { class: "url", text: entry.url || entry.name || "" }),
      el("span", { class: "meta" },
        el("span", { class: "status-dot " + statusClass }),
      ),
      el("span", { class: "meta", text: timeAgo(entry.timestamp) }),
    );
  }

  /* expanded-state helpers keep default-expanded behavior without
     persisting a full set of toggles. */
  const collapsed = new Set();
  function isExpanded(id, defaultOpen) {
    return defaultOpen ? !collapsed.has(id) : collapsed.has(id);
  }
  function toggleExpanded(id) {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
  }

  return { init, refresh, render };
})();
