/* ==== Bootstrap ==== */

async function bootstrap() {
  await window.dbxPlugin.ready;

  applyEnvironment();
  applyI18nText();

  window.addEventListener("dbx-plugin-env", () => {
    applyEnvironment();
    applyI18nText();
    Editor.refreshActionButtons();
    Editor.refreshEnvSelector();
    Editor.refreshTabs();
    Editor.renderPanel();
    ResponseView.render();
    Sidebar.render();
  });

  const loaded = await Api.loadAll().catch(() => ({ state: null, history: [] }));
  if (loaded.state) hydrateState(loaded.state);
  State.history = loaded.history || [];
  seedIfEmpty();

  Sidebar.init();
  Editor.init();
  ResponseView.init();
  initShortcuts();

  Editor.newRequest();
  $("#boot").remove();
  $("#app").hidden = false;
}

function applyEnvironment() {
  I18N.setLocale(window.dbxPlugin.locale || "en");
  const theme = window.dbxPlugin.theme || {};
  const appearance = theme.appearance || "light";
  document.body.dataset.fallback = appearance === "dark" ? "dark" : "light";
  document.documentElement.style.colorScheme = appearance;
}

function applyI18nText() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = I18N.t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
    node.setAttribute("aria-label", I18N.t(node.dataset.i18nAria));
    node.title = I18N.t(node.dataset.i18nAria);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((node) => {
    node.placeholder = I18N.t(node.dataset.i18nPh);
  });
}

function hydrateState(saved) {
  if (!saved || typeof saved !== "object") return;
  if (Array.isArray(saved.collections)) State.collections = saved.collections;
  if (Array.isArray(saved.environments)) {
    // Loaded state carries no secret values by design; mark them present-but-empty.
    State.environments = saved.environments.map((env) => ({
      ...env,
      variables: (env.variables || []).map((v) => ({
        name: v.name || "",
        value: v.secret ? "" : (v.value || ""),
        secret: !!v.secret,
      })),
    }));
  }
  if (saved.settings && typeof saved.settings === "object") {
    State.settings = {
      ...State.settings,
      ...saved.settings,
      ui: { ...State.settings.ui, ...(saved.settings.ui || {}) },
    };
  }
}

function seedIfEmpty() {
  if (!State.collections.length) {
    const collection = newCollection("My Collection");
    const folder = { id: uuid("fld"), type: "folder", name: "Examples", items: [] };
    const sample = newRequestItem("Sample GET");
    sample.request.url = "https://httpbin.org/get";
    sample.request.headers.push(newRow("Accept", "application/json"));
    folder.items.push(sample);
    collection.items.push(folder);
    State.collections.push(collection);
  }
}

bootstrap().catch((error) => {
  const boot = document.getElementById("boot");
  if (boot) {
    boot.textContent = "API Studio failed to start: " + (error && error.message ? error.message : error);
  }
});
