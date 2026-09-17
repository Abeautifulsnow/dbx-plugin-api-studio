<script>
  import { onMount } from "svelte";
  import * as api from "./lib/api.js";
  import { deepClone, debounce, uid, copyText } from "./lib/format.js";
  import { normalizeLocale, translate } from "./lib/i18n.js";
  import { valueAsText } from "./lib/jsonview.js";
  import {
    defaultRequest,
    defaultSettings,
    duplicateItem,
    findCollectionOf,
    findItem,
    historyEntry,
    migrateHistory,
    migrateState,
    newCollection,
    newEnvironment,
    newFolder,
    newRequestItem,
    newRow,
    normalizeResponse,
    persistableState,
    removeItem,
  } from "./lib/model.js";
  import { redactRequestForHistory } from "./lib/redaction.js";
  import { filterCollections } from "./lib/search.js";
  import {
    UNSAFE_METHODS,
    buildSendSpec,
    parseUrlQuery,
    rebuildUrlQuery,
    variableScope,
  } from "./lib/variables.js";
  import CommandRow from "./components/CommandRow.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import EnvironmentDialog from "./components/EnvironmentDialog.svelte";
  import HeaderBar from "./components/HeaderBar.svelte";
  import Icon from "./components/Icon.svelte";
  import Menu from "./components/Menu.svelte";
  import Modal from "./components/Modal.svelte";
  import PromptDialog from "./components/PromptDialog.svelte";
  import RequestTabs from "./components/RequestTabs.svelte";
  import ResponsePane from "./components/ResponsePane.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Splitter from "./components/Splitter.svelte";
  import Toasts from "./components/Toasts.svelte";

  /* ------------------------------------------------------------------ state */

  let locale = $state("en");
  let appearance = $state("light");
  let ready = $state(false);
  let loaded = $state(false);
  let loadError = $state("");

  let collections = $state([]);
  let environments = $state([]);
  let settings = $state(defaultSettings());
  let history = $state([]);

  /** The editor buffer: unsaved until written into a collection. */
  let current = $state({
    id: "",
    request: defaultRequest(),
    dirty: false,
    bodyRedacted: false,
    collectionId: null,
  });

  let responses = $state({});
  let receivedAt = $state({});
  let sending = $state("");
  let outcome = $state(null);
  let sendIssues = $state({});

  let activeTab = $state("params");
  let search = $state("");
  let expanded = $state(new Set());
  let historyActiveId = $state("");

  let menu = $state(null);
  let prompt = $state(null);
  let confirmDialog = $state(null);
  let pendingAction = $state(null);
  let pendingSend = $state(false);
  let envOpen = $state(false);

  let toasts = $state([]);
  let polite = $state("");
  let assertive = $state("");

  /* ---------------------------------------------------------------- derived */

  const t = (key, params) => translate(locale, key, params);
  const selectedEnv = $derived(
    environments.find((environment) => environment.id === settings.selectedEnvId) || null,
  );
  const visibleCollections = $derived(filterCollections(collections, search));
  const response = $derived(responses[current.id] ?? null);
  const error = $derived(
    outcome?.kind === "error" ? { category: outcome.category, message: outcome.message } : null,
  );
  const cancelled = $derived(outcome?.kind === "cancelled");
  /** Ancestors of the open request, for the breadcrumb. */
  const currentPath = $derived.by(() => {
    const segments = [];
    const walk = (items, trail) => {
      for (const item of items) {
        if (item.id === current.id) {
          segments.push(...trail);
          return true;
        }
        if (item.items && walk(item.items, [...trail, item])) return true;
      }
      return false;
    };
    walk(collections, []);
    return segments;
  });

  /* ------------------------------------------------------------ persistence */

  const persist = debounce((snapshot) => {
    api.saveState(snapshot).catch((failure) => {
      const message = t("announceSaveFailed", { reason: failure?.message ?? String(failure) });
      toast(message);
      announcePolite(message);
    });
  }, 600);

  $effect(() => {
    // Reading through `persistableState` subscribes this effect to exactly the
    // state that is persisted (and to nothing else).
    const snapshot = persistableState({ collections, environments, settings });
    if (!loaded) return;
    persist(snapshot);
  });

  $effect(() => {
    document.body.dataset.theme = appearance;
  });

  /* --------------------------------------------------------------- feedback */

  function toast(message) {
    const id = uid("toast");
    toasts = [...toasts, { id, message }];
    setTimeout(() => (toasts = toasts.filter((item) => item.id !== id)), 2400);
  }

  function announcePolite(message) {
    polite = "";
    queueMicrotask(() => (polite = message));
  }

  function announceAssertive(message) {
    assertive = "";
    queueMicrotask(() => (assertive = message));
  }

  async function copyToClipboard(text, successMessage) {
    const ok = await copyText(text);
    toast(ok ? (successMessage ?? t("copied")) : t("copyFailed"));
  }

  /* ------------------------------------------------------------- navigation */

  /** Ask about unsaved edits before replacing the editor buffer. */
  function guard(action) {
    if (current.dirty) {
      pendingAction = action;
      return;
    }
    action();
  }

  function openRequest(node) {
    guard(() => {
      const collection = findCollectionOf(collections, node.id);
      current = {
        id: node.id,
        request: deepClone(node.request),
        dirty: false,
        bodyRedacted: false,
        collectionId: collection?.id ?? null,
      };
      sendIssues = {};
      outcome = null;
    });
  }

  function newRequest() {
    guard(() => {
      const request = defaultRequest();
      request.name = t("draftName");
      current = {
        id: uid("req"),
        request,
        dirty: true,
        bodyRedacted: false,
        collectionId: collections[0]?.id ?? null,
      };
      activeTab = "params";
      sendIssues = {};
      outcome = null;
    });
  }

  function openHistory(entry) {
    guard(() => {
      const hadBody = !!entry.request?.body?.type && entry.request.body.type !== "none";
      current = {
        id: uid("req"),
        request: deepClone(entry.request),
        dirty: true,
        bodyRedacted: hadBody,
        collectionId: null,
      };
      historyActiveId = entry.id;
      sendIssues = {};
      outcome = null;
      announcePolite(
        hadBody
          ? `${t("restoredFromHistory")} ${t("bodyNotRestored")}`
          : t("restoredFromHistory"),
      );
      toast(hadBody ? t("bodyNotRestored") : t("restoredFromHistory"));
    });
  }

  function saveCurrent() {
    if (!current.request.name.trim()) current.request.name = t("draftName");
    const existing = findItem(collections, current.id);
    if (existing) {
      existing.item.name = current.request.name;
      existing.item.request = deepClone(current.request);
    } else {
      if (!collections.length) collections = [newCollection("My Collection")];
      const target =
        (current.collectionId && findItem(collections, current.collectionId)?.item) ||
        collections[0];
      target.items = [
        ...(target.items || []),
        {
          id: current.id,
          type: "request",
          name: current.request.name,
          request: deepClone(current.request),
        },
      ];
      current.collectionId = target.id;
    }
    current.dirty = false;
    announcePolite(t("announceSaved"));
    toast(t("announceSaved"));
  }

  /* ------------------------------------------------------------------- tree */

  function sameNameSibling(items, name, ignoreId = null) {
    return (items || []).some(
      (item) =>
        item.id !== ignoreId && item.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
  }

  function addCollection() {
    prompt = {
      title: t("newCollection"),
      label: t("collectionName"),
      initialValue: "",
      requiredMessage: t("nameRequired"),
      takenMessage: t("nameTaken"),
      isTaken: (name) => sameNameSibling(collections, name),
      onSubmit: (name) => {
        collections = [...collections, newCollection(name)];
        prompt = null;
      },
    };
  }

  function addFolder(parent) {
    prompt = {
      title: t("newFolder"),
      label: t("folderName"),
      initialValue: "",
      requiredMessage: t("nameRequired"),
      takenMessage: t("nameTaken"),
      isTaken: (name) => sameNameSibling(parent.items, name),
      onSubmit: (name) => {
        parent.items = [...(parent.items || []), newFolder(name)];
        prompt = null;
      },
    };
  }

  function addRequestTo(parent) {
    prompt = {
      title: t("newRequestIn"),
      label: t("requestName"),
      initialValue: "",
      requiredMessage: t("nameRequired"),
      takenMessage: t("nameTaken"),
      isTaken: (name) => sameNameSibling(parent.items, name),
      onSubmit: (name) => {
        const item = newRequestItem(name);
        parent.items = [...(parent.items || []), item];
        prompt = null;
        openRequest(item);
      },
    };
  }

  function renameNode(node) {
    const parent = findItem(collections, node.id)?.parent;
    prompt = {
      title: t("rename"),
      label:
        node.type === "request"
          ? t("requestName")
          : node.type === "folder"
            ? t("folderName")
            : t("collectionName"),
      initialValue: node.name,
      requiredMessage: t("nameRequired"),
      takenMessage: t("nameTaken"),
      isTaken: (name) => sameNameSibling(parent ? parent.items : collections, name, node.id),
      onSubmit: (name) => {
        node.name = name;
        if (node.type === "request") {
          node.request.name = name;
          if (node.id === current.id) current.request.name = name;
        }
        prompt = null;
      },
    };
  }

  function deleteNode(node) {
    const labels = {
      collection: "deleteCollection",
      folder: "deleteFolder",
      request: "deleteRequest",
    };
    const confirmKeys = {
      collection: "deleteCollectionConfirm",
      folder: "deleteFolderConfirm",
      request: "deleteRequestConfirm",
    };
    confirmDialog = {
      title: t(labels[node.type]),
      message: t(confirmKeys[node.type], { name: node.name }),
      confirmLabel: t(labels[node.type]),
      danger: true,
      onConfirm: () => {
        const openInside = node.id === current.id || !!findItem([node], current.id);
        removeItem(collections, node.id);
        collections = [...collections];
        if (openInside) {
          current = { ...current, id: uid("req"), dirty: true, collectionId: null };
        }
        confirmDialog = null;
      },
    };
  }

  function duplicateNode(node) {
    duplicateItem(collections, node.id, (name) => `${name} (copy)`);
    collections = [...collections];
  }

  function treeMenuItems(node) {
    if (node.type === "request") {
      return [
        { id: "open", label: t("newRequestIn"), icon: "send" },
        { id: "rename", label: t("rename"), icon: "pencil" },
        { id: "duplicate", label: t("duplicate"), icon: "copy" },
        { separator: true, id: "sep" },
        { id: "delete", label: t("deleteRequest"), icon: "trash", danger: true },
      ];
    }
    return [
      { id: "add-request", label: t("newRequestIn"), icon: "plus" },
      { id: "add-folder", label: t("newFolder"), icon: "folder" },
      { id: "rename", label: t("rename"), icon: "pencil" },
      { id: "duplicate", label: t("duplicate"), icon: "copy" },
      { separator: true, id: "sep" },
      {
        id: "delete",
        label: node.type === "collection" ? t("deleteCollection") : t("deleteFolder"),
        icon: "trash",
        danger: true,
      },
    ];
  }

  function onTreeMenu(event, node) {
    menu = {
      x: event.clientX,
      y: event.clientY,
      items: treeMenuItems(node),
      onSelect: (id) => {
        if (id === "open") openRequest(node);
        else if (id === "add-request") addRequestTo(node);
        else if (id === "add-folder") addFolder(node);
        else if (id === "rename") renameNode(node);
        else if (id === "duplicate") duplicateNode(node);
        else if (id === "delete") deleteNode(node);
      },
    };
  }

  function toggleNode(id) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function clearHistory() {
    confirmDialog = {
      title: t("clearHistory"),
      message: t("clearHistoryConfirm"),
      confirmLabel: t("clearHistory"),
      danger: true,
      onConfirm: () => {
        history = [];
        confirmDialog = null;
        api.clearHistory().catch((failure) => toast(failure?.message ?? String(failure)));
      },
    };
  }

  /* ------------------------------------------------------ URL <-> param sync */

  /** Mirror the URL query into rows, keeping row ids and disabled rows intact. */
  function syncQueryFromUrl(urlText) {
    const { pairs } = parseUrlQuery(urlText);
    const previous = new Map(
      current.request.query.filter((row) => row.enabled && row.key).map((row) => [row.key, row]),
    );
    const rows = pairs.map((pair) => {
      const existing = previous.get(pair.key);
      return existing ? { ...existing, value: pair.value } : newRow(pair.key, pair.value);
    });
    current.request.query = [...rows, ...current.request.query.filter((row) => !row.enabled)];
  }

  function syncUrlFromQuery() {
    const pairs = current.request.query
      .filter((row) => row.enabled && String(row.key || "").trim())
      .map((row) => ({ key: row.key, value: row.value }));
    current.request.url = rebuildUrlQuery(current.request.url, pairs);
  }

  function touch() {
    current.dirty = true;
    sendIssues = {};
  }

  function onUrlInput(value) {
    current.request.url = value;
    syncQueryFromUrl(value);
    touch();
  }

  function onQueryChange() {
    syncUrlFromQuery();
    touch();
  }

  /* -------------------------------------------------------------- send flow */

  let sendSequence = 0;

  function send(confirmed = false) {
    if (sending) return;
    const environment = selectedEnv;
    if (
      !confirmed &&
      environment?.prodLike &&
      environment.confirmUnsafe !== false &&
      UNSAFE_METHODS.includes(current.request.method)
    ) {
      pendingSend = true;
      return;
    }

    const scope = variableScope(environment, current.request);
    const requestId = uid("call");
    const { spec, issues } = buildSendSpec(current.request, requestId, scope, {
      previewCapBytes: settings.previewCapBytes,
    });
    if (Object.keys(issues).length) {
      sendIssues = issues;
      announceAssertive(t("notSentYet"));
      activeTab = issues.url
        ? "params"
        : issues.auth
          ? "auth"
          : issues.body
            ? "body"
            : issues.headers
              ? "headers"
              : activeTab;
      return;
    }

    sendIssues = {};
    outcome = null;
    sending = requestId;
    const token = ++sendSequence;
    const requestKey = current.id;

    api
      .sendRequest(spec)
      .then((result) => {
        // A newer send owns the pane now; dropping a superseded result keeps a
        // slow response from overwriting a fresh one.
        if (token !== sendSequence) return;
        if (result?.cancelled) {
          outcome = { kind: "cancelled" };
          announcePolite(t("announceCancelled"));
        } else {
          const normalized = normalizeResponse(result);
          responses = { ...responses, [requestKey]: normalized };
          receivedAt = { ...receivedAt, [requestKey]: Date.now() };
          outcome = { kind: "ok" };
          announcePolite(t("announceSent", { status: normalized.status }));
        }
      })
      .catch((failure) => {
        if (token !== sendSequence) return;
        const category = failure?.category || "INTERNAL_ERROR";
        outcome = { kind: "error", category, message: failure?.message ?? String(failure) };
        announceAssertive(t("announceFailed", { category }));
      })
      .finally(() => {
        if (token === sendSequence) sending = "";
        recordHistory(requestKey);
      });
  }

  async function cancel() {
    if (!sending) return;
    try {
      await api.cancelRequest(sending);
    } catch (failure) {
      toast(failure?.message ?? String(failure));
    }
  }

  /** History keeps a redacted snapshot: no body text and no credentials. */
  function recordHistory(requestKey) {
    const snapshot = redactRequestForHistory(current.request);
    const entry = historyEntry({
      request: snapshot,
      response: responses[requestKey] ?? null,
      error: outcome?.kind === "error" ? { category: outcome.category } : null,
    });
    history = [entry, ...history].slice(0, 500);
    historyActiveId = entry.id;
    api.appendHistory(entry).catch((failure) => toast(failure?.message ?? String(failure)));
  }

  async function copyCurl() {
    const scope = variableScope(selectedEnv, current.request);
    const { spec, issues } = buildSendSpec(current.request, uid("curl"), scope, {
      maskSecrets: true,
      previewCapBytes: settings.previewCapBytes,
    });
    if (issues.url?.invalid) {
      toast(t("invalidUrl"));
      return;
    }
    try {
      const command = await api.exportCurl(spec);
      await copyToClipboard(command, t("copied"));
    } catch (failure) {
      toast(failure?.message ?? String(failure));
    }
  }

  function formatBody() {
    try {
      current.request.body.text = JSON.stringify(JSON.parse(current.request.body.text), null, 2);
      current.request.body.type = "json";
      touch();
    } catch {
      toast(t("jsonInvalid"));
    }
  }

  function promoteToEnvironment(node) {
    const environment = selectedEnv;
    if (!environment) {
      toast(t("noEnvSelected"));
      return;
    }
    const name = String(node.key ?? "value");
    const text = valueAsText(node.value);
    const existing = environment.variables.find((variable) => variable.key === name);
    if (existing) existing.value = text;
    else environment.variables = [...environment.variables, { ...newRow(name, text), secret: true }];
    toast(t("envVarSet", { name, env: environment.name }));
  }

  /* ----------------------------------------------------------------- overlays */

  function commandMenu(event) {
    menu = {
      x: event.clientX,
      y: event.clientY,
      items: [
        { id: "curl", label: t("copyAsCurl"), icon: "copy" },
        { id: "save", label: t("save"), icon: "save", disabled: !current.dirty },
      ],
      onSelect: (id) => (id === "curl" ? copyCurl() : saveCurrent()),
    };
  }

  function finishGuard(action) {
    const pending = pendingAction;
    pendingAction = null;
    if (action === "save") saveCurrent();
    if (action !== "cancel") pending?.();
  }

  function addEnvironment(name) {
    const environment = newEnvironment(name);
    environments = [...environments, environment];
    settings.selectedEnvId = environment.id;
    return environment;
  }

  function deleteEnvironment(environment) {
    confirmDialog = {
      title: t("deleteEnv"),
      message: t("deleteEnvConfirm", { name: environment.name }),
      confirmLabel: t("deleteEnv"),
      danger: true,
      onConfirm: () => {
        environments = environments.filter((item) => item.id !== environment.id);
        if (settings.selectedEnvId === environment.id) settings.selectedEnvId = null;
        confirmDialog = null;
      },
    };
  }

  /* ---------------------------------------------------------------- shortcuts */

  function onKeyDown(event) {
    const modifier = event.ctrlKey || event.metaKey;
    const plain = modifier && !event.shiftKey && !event.altKey;
    const key = event.key.toLowerCase();

    if (plain && event.key === "Enter") {
      event.preventDefault();
      if (sending) cancel();
      else send();
      return;
    }
    if (plain && key === "s") {
      event.preventDefault();
      saveCurrent();
      return;
    }
    if (plain && key === "n") {
      event.preventDefault();
      newRequest();
      return;
    }
    if (plain && key === "l") {
      event.preventDefault();
      const input = document.querySelector(".url-input");
      input?.focus();
      input?.select?.();
      return;
    }
    if (event.shiftKey && event.altKey && key === "f") {
      event.preventDefault();
      formatBody();
    }
  }

  /* -------------------------------------------------------------- lifecycle */

  function seedWorkspace() {
    const request = defaultRequest();
    request.name = "Sample GET";
    request.url = "https://httpbin.org/get";
    request.headers = [newRow("Accept", "application/json")];
    const item = { id: uid("req"), type: "request", name: request.name, request };
    collections = [{ ...newCollection("My Collection"), items: [item] }];
    return item;
  }

  /** First stored request at any depth — collections may hold only folders. */
  function firstStoredRequest() {
    const walk = (items) => {
      for (const item of items) {
        if (item.type === "request") return item;
        const found = item.items ? walk(item.items) : null;
        if (found) return found;
      }
      return null;
    };
    for (const collection of collections) {
      const found = walk(collection.items || []);
      if (found) return found;
    }
    return null;
  }

  /** Open something usable without ever overwriting stored data. */
  function openInitialRequest() {
    const stored = collections.length ? firstStoredRequest() : seedWorkspace();
    if (stored) {
      current = {
        id: stored.id,
        request: deepClone(stored.request),
        dirty: false,
        bodyRedacted: false,
        collectionId: findCollectionOf(collections, stored.id)?.id ?? null,
      };
      return;
    }
    // Collections exist but hold no request yet: start an unsaved draft.
    const request = defaultRequest();
    request.name = t("draftName");
    current = {
      id: uid("req"),
      request,
      dirty: true,
      bodyRedacted: false,
      collectionId: collections[0]?.id ?? null,
    };
  }

  onMount(async () => {
    try {
      await window.dbxPlugin.ready;
      locale = normalizeLocale(window.dbxPlugin.locale);
      appearance = window.dbxPlugin.theme?.appearance === "dark" ? "dark" : "light";
    } catch (failure) {
      loadError = failure?.message ?? String(failure);
    }

    try {
      const stored = await api.loadPersistedState();
      const migrated = migrateState(stored.state);
      collections = migrated.collections;
      environments = migrated.environments;
      settings = migrated.settings;
      history = migrateHistory(stored.history);
      loaded = true;
    } catch (failure) {
      // Never strand the workbench on the loading screen. Fall back to an empty
      // workspace and leave persistence off so nothing overwrites stored data.
      loadError = `${t("loadFailed")} ${failure?.message ?? String(failure)}`;
    }

    openInitialRequest();
    expanded = new Set(collections.map((collection) => collection.id));
    ready = true;
  });

  $effect(() => {
    const onEnvironmentChange = () => {
      locale = normalizeLocale(window.dbxPlugin.locale);
      appearance = window.dbxPlugin.theme?.appearance === "dark" ? "dark" : "light";
    };
    window.addEventListener("dbx-plugin-env", onEnvironmentChange);
    return () => window.removeEventListener("dbx-plugin-env", onEnvironmentChange);
  });
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="visually-hidden" aria-live="assertive" aria-atomic="true">{assertive}</div>
<div class="visually-hidden" aria-live="polite" aria-atomic="true">{polite}</div>

{#if !ready}
  <main class="boot">
    <Icon name="clock" size={20} />
    <p>{t("booting")}</p>
  </main>
{:else}
  <div
    class="app"
    class:app--sidebar-collapsed={settings.ui.sidebarCollapsed}
    data-theme={appearance}
    style={`--sidebar-w:${settings.ui.sidebarWidth}px; --editor-h:${settings.ui.editorH}%`}
  >
    {#if !settings.ui.sidebarCollapsed}
      <Sidebar
        {collections}
        {visibleCollections}
        {history}
        activeRequestId={current.id}
        {historyActiveId}
        {search}
        historyOpen={settings.ui.historyOpen}
        {expanded}
        {t}
        onSearch={(value) => (search = value)}
        onToggleNode={toggleNode}
        onToggleHistory={() => (settings.ui.historyOpen = !settings.ui.historyOpen)}
        onToggleSidebar={() => (settings.ui.sidebarCollapsed = true)}
        onOpenRequest={openRequest}
        onOpenHistory={openHistory}
        onNodeMenu={onTreeMenu}
        onNewRequest={newRequest}
        onNewCollection={addCollection}
        onClearHistory={clearHistory}
      />
      <Splitter
        axis="x"
        value={settings.ui.sidebarWidth}
        min={220}
        max={440}
        label={t("collapseSidebar")}
        onChange={(value) => (settings.ui.sidebarWidth = value)}
      />
    {/if}

    <section class="workspace">
      <HeaderBar
        requestName={current.request.name}
        dirty={current.dirty}
        path={currentPath}
        {environments}
        {selectedEnv}
        sidebarCollapsed={settings.ui.sidebarCollapsed}
        {t}
        onSelectEnv={(id) => (settings.selectedEnvId = id || null)}
        onManageEnvironments={() => (envOpen = true)}
        onRename={() => {
          const found = findItem(collections, current.id);
          if (found) renameNode(found.item);
        }}
        onToggleSidebar={() => (settings.ui.sidebarCollapsed = false)}
      />

      <CommandRow
        request={current.request}
        sending={!!sending}
        dirty={current.dirty}
        tlsDisabled={current.request.settings.verifyTls === false}
        {t}
        onUrlInput={onUrlInput}
        onMethodChange={(method) => {
          current.request.method = method;
          touch();
        }}
        onSend={() => send()}
        onCancel={cancel}
        onSave={saveCurrent}
        onMore={commandMenu}
      />

      <RequestTabs
        request={current.request}
        {activeTab}
        issues={sendIssues}
        previewCapBytes={settings.previewCapBytes}
        {t}
        onChange={activeTab === "params" ? onQueryChange : touch}
        onActiveTab={(id) => (activeTab = id)}
        onOpenEnvironments={() => (envOpen = true)}
        onPreviewCapChange={(value) => (settings.previewCapBytes = value)}
      />

      <Splitter
        axis="y"
        value={settings.ui.editorH}
        min={20}
        max={80}
        unit="%"
        label={t("responseOf")}
        onChange={(value) => (settings.ui.editorH = value)}
      />

      <ResponsePane
        {response}
        sending={!!sending}
        {error}
        {cancelled}
        receivedAt={receivedAt[current.id] ?? null}
        truncatedLimit={settings.previewCapBytes}
        {t}
        onRetry={() => send()}
        onCopyText={(text) => copyToClipboard(text)}
        onPromoteToEnv={promoteToEnvironment}
      />

      {#if loadError}
        <p class="notice notice--warning app__notice" role="alert">
          <Icon name="alert" />
          <span>{loadError}</span>
          <button type="button" class="link-btn" onclick={() => (loadError = "")}>
            {t("dismiss")}
          </button>
        </p>
      {/if}
    </section>
  </div>
{/if}

{#if menu}
  <Menu
    x={menu.x}
    y={menu.y}
    items={menu.items}
    onClose={() => (menu = null)}
    onSelect={(id) => menu.onSelect(id)}
  />
{/if}

{#if prompt}
  <PromptDialog
    title={prompt.title}
    label={prompt.label}
    initialValue={prompt.initialValue}
    requiredMessage={prompt.requiredMessage}
    takenMessage={prompt.takenMessage}
    isTaken={prompt.isTaken}
    submitLabel={t("save")}
    cancelLabel={t("keepEditing")}
    onSubmit={prompt.onSubmit}
    onCancel={() => (prompt = null)}
  />
{/if}

{#if confirmDialog}
  <ConfirmDialog
    title={confirmDialog.title}
    message={confirmDialog.message}
    confirmLabel={confirmDialog.confirmLabel}
    cancelLabel={t("cancel")}
    danger={confirmDialog.danger}
    onConfirm={confirmDialog.onConfirm}
    onCancel={() => (confirmDialog = null)}
  />
{/if}

{#if pendingSend}
  <Modal
    title={t("prodBadge")}
    titleId="production-title"
    onClose={() => (pendingSend = false)}
    width="min(460px, calc(100vw - 32px))"
  >
    <p class="modal__text">
      {t("confirmSendUnsafe", { env: selectedEnv?.name ?? "", method: current.request.method })}
    </p>
    {#snippet footer()}
      <button type="button" class="btn" data-initial-focus onclick={() => (pendingSend = false)}>
        {t("cancel")}
      </button>
      <button
        type="button"
        class="btn btn--danger"
        onclick={() => {
          pendingSend = false;
          send(true);
        }}
      >
        {t("sendAnyway")}
      </button>
    {/snippet}
  </Modal>
{/if}

{#if pendingAction}
  <Modal
    title={t("unsavedTitle")}
    titleId="unsaved-title"
    dismissable={false}
    onClose={() => finishGuard("cancel")}
    width="min(440px, calc(100vw - 32px))"
  >
    <p class="modal__text">{t("unsavedMessage")}</p>
    {#snippet footer()}
      <button type="button" class="btn" data-initial-focus onclick={() => finishGuard("cancel")}>
        {t("keepEditing")}
      </button>
      <button type="button" class="btn" onclick={() => finishGuard("discard")}>{t("discard")}</button>
      <button type="button" class="btn btn--primary" onclick={() => finishGuard("save")}>
        {t("saveChanges")}
      </button>
    {/snippet}
  </Modal>
{/if}

{#if envOpen}
  <EnvironmentDialog
    {environments}
    selectedId={settings.selectedEnvId ?? ""}
    {t}
    onClose={() => (envOpen = false)}
    onChange={touch}
    onAdd={addEnvironment}
    onDelete={deleteEnvironment}
  />
{/if}

<Toasts {toasts} />
