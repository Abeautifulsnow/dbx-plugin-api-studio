/**
 * Editor data model, persisted-state schema and history entries.
 *
 * ## Persisted schema
 *
 * v1 is what the first (pre-Svelte) UI wrote to
 * `<data dir>/state.json`: environment variables keyed by `name`, layout
 * preferences under `settings.ui`, and key/value rows without ids. v2 adds a
 * stable `id` to every row and folds the environment variable key into `key`,
 * matching request rows.
 *
 * `migrateState` accepts *both* shapes and always returns v2, so an existing
 * install keeps its collections, environment values and pane sizes instead of
 * silently losing them. Bumping the schema without a migration is what makes a
 * UI rewrite look like data loss to the user.
 */
import { deepClone, uid } from "./format.js";
import {
  AUTH_CREDENTIAL_FIELDS,
  REDACTED,
  isSensitiveHeaderName,
  isSensitiveQueryName,
  sanitizeTree,
  sanitizeRequestForPersistence,
} from "./redaction.js";
import { parseUrlQuery, rebuildUrlQuery } from "./variables.js";

export const STATE_VERSION = 2;

/** The response preview limit is a persisted user preference, not a constant. */
export const DEFAULT_PREVIEW_CAP_BYTES = 2 * 1024 * 1024;

export const DEFAULT_UI_SETTINGS = {
  sidebarWidth: 288,
  sidebarCollapsed: false,
  historyOpen: true,
  editorH: 46,
  responseView: "text",
};

export function defaultRequest() {
  return {
    version: 1,
    name: "",
    method: "GET",
    url: "",
    query: [],
    headers: [],
    auth: { type: "none" },
    body: { type: "none", text: "", rows: [] },
    variables: [],
    settings: {
      timeoutMs: 30000,
      followRedirects: true,
      maxRedirects: 10,
      verifyTls: true,
    },
  };
}

export function newRow(key = "", value = "") {
  return { id: uid("kv"), key, value, description: "", enabled: true };
}

export function newRequestItem(name) {
  return { id: uid("req"), type: "request", name: name || "", request: defaultRequest() };
}

export function newCollection(name = "Collection") {
  return { id: uid("col"), type: "collection", name, items: [] };
}

export function newFolder(name = "Folder") {
  return { id: uid("folder"), type: "folder", name, items: [] };
}

export function newEnvironment(name = "Environment") {
  return { id: uid("env"), name, prodLike: false, confirmUnsafe: true, variables: [] };
}

export function defaultSettings() {
  return {
    selectedEnvId: null,
    previewCapBytes: DEFAULT_PREVIEW_CAP_BYTES,
    ui: { ...DEFAULT_UI_SETTINGS },
  };
}

/* ------------------------------------------------------------------ migration */

/** Persisted data is untrusted input: a valid file can still hold wrong types. */
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

function normalizeRow(raw, { secret = false } = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof row.id === "string" && row.id ? row.id : uid("kv"),
    // v1 environment variables used `name`; v2 uses `key` everywhere.
    key: String(row.key ?? row.name ?? ""),
    value: String(row.value ?? ""),
    description: String(row.description ?? ""),
    enabled: row.enabled !== false,
    ...(secret ? { secret: !!row.secret } : {}),
  };
}

function normalizeRequest(raw) {
  const request = asObject(raw);
  const base = defaultRequest();
  const normalized = {
    ...base,
    ...request,
    name: String(request.name ?? ""),
    method: String(request.method ?? base.method).toUpperCase(),
    url: String(request.url ?? ""),
    query: asArray(request.query).map((row) => normalizeRow(row)),
    headers: asArray(request.headers).map((row) => normalizeRow(row)),
    auth: asObject(request.auth).type ? request.auth : { type: "none" },
    body: {
      type: asObject(request.body).type || "none",
      text: String(request.body?.text ?? ""),
      // `urlencoded` bodies are edited as rows and serialized into `text`.
      rows: asArray(request.body?.rows).map((row) => normalizeRow(row)),
    },
    variables: asArray(request.variables).map((row) => normalizeRow(row, { secret: true })),
    settings: { ...base.settings, ...asObject(request.settings) },
  };

  // Saved credentials are stored as the `[REDACTED]` placeholder (or emptied).
  // The placeholder must never masquerade as a value the user can send, so on
  // load it becomes an empty field the user has to refill.
  const auth = asObject(normalized.auth);
  for (const field of AUTH_CREDENTIAL_FIELDS[auth.type] || []) {
    if (auth[field] === REDACTED) auth[field] = "";
  }
  for (const row of normalized.headers) {
    if (row.value === REDACTED && isSensitiveHeaderName(row.key)) row.value = "";
  }
  // ... and in the URL itself, where a credential query parameter is stored
  // redacted: drop the pair instead of sending the placeholder.
  const urlPairs = parseUrlQuery(normalized.url);
  if (urlPairs.pairs.some((pair) => pair.value === REDACTED && isSensitiveQueryName(pair.key))) {
    normalized.url = rebuildUrlQuery(
      normalized.url,
      urlPairs.pairs.filter((pair) => !(pair.value === REDACTED && isSensitiveQueryName(pair.key))),
    );
  }
  for (const row of normalized.query) {
    if (row.value === REDACTED && isSensitiveQueryName(row.key)) row.value = "";
  }
  return normalized;
}

function normalizeNode(raw) {
  const node = asObject(raw);
  const type = node.type === "folder" ? "folder" : node.type === "request" ? "request" : "collection";
  const normalized = {
    id: typeof node.id === "string" && node.id ? node.id : uid(type === "request" ? "req" : type === "folder" ? "folder" : "col"),
    type,
    name: String(node.name ?? ""),
  };
  if (type === "request") normalized.request = normalizeRequest(node.request);
  else normalized.items = asArray(node.items).map(normalizeNode);
  return normalized;
}

export function normalizeEnvironment(raw) {
  const environment = asObject(raw);
  return {
    id: typeof environment.id === "string" && environment.id ? environment.id : uid("env"),
    name: String(environment.name ?? "Environment"),
    prodLike: !!environment.prodLike,
    confirmUnsafe: environment.confirmUnsafe !== false,
    variables: asArray(environment.variables).map((row) => normalizeRow(row, { secret: true })),
  };
}

/** Accept any historical persisted payload and return a v2 state object. */
export function migrateState(raw) {
  const state = asObject(raw);
  const settings = asObject(state.settings);
  return {
    version: STATE_VERSION,
    collections: asArray(state.collections).map(normalizeNode),
    environments: asArray(state.environments).map(normalizeEnvironment),
    settings: {
      selectedEnvId: settings.selectedEnvId ?? null,
      previewCapBytes: Number.isFinite(settings.previewCapBytes)
        ? settings.previewCapBytes
        : DEFAULT_PREVIEW_CAP_BYTES,
      ui: { ...DEFAULT_UI_SETTINGS, ...asObject(settings.ui) },
    },
  };
}

/** History entries written by v1 stored headers as `{name, value}`.
 *
 * Disk order is oldest-first (the sidecar appends and evicts from the front);
 * the UI invariant is `history[0]` = newest, so the reversal happens here and
 * no caller can forget it.
 */
export function migrateHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      ...entry,
      id: typeof entry?.id === "string" && entry.id ? entry.id : uid("history"),
      request: entry?.request ? normalizeRequest(entry.request) : undefined,
    }))
    .reverse();
}

/* ------------------------------------------------------------- state payload */

/**
 * Persisted payload: credentials are stripped from every request node and
 * secret-marked environment values are emptied (see `redaction.js`).
 *
 * Request bodies are stored as authored — PRD §6.4 lists `body` as part of a
 * stored request definition — while history stores no body text at all.
 */
export function persistableState(state) {
  const source = asObject(state);
  return {
    version: STATE_VERSION,
    collections: asArray(source.collections).map(sanitizeTree),
    environments: asArray(source.environments).map((environment) => ({
      ...deepClone(environment),
      variables: asArray(environment.variables).map((variable) => ({
        id: variable.id,
        key: variable.key,
        secret: !!variable.secret,
        value: variable.secret ? "" : String(variable.value ?? ""),
      })),
    })),
    settings: deepClone(source.settings),
  };
}

/* ------------------------------------------------------------ row reconcile */

/**
 * Reconcile the query rows with pairs parsed from the URL (URL → Params sync).
 *
 * Existing enabled rows are consumed in order per key, so `?tag=a&tag=b` maps
 * the first pair to the first `tag` row and clones a fresh row for the second:
 * duplicate keys must never share a row id (the keyed editor throws) or a
 * value. Enabled rows whose key no longer appears are dropped; disabled rows
 * always survive, so unticking a parameter is not undone by editing the URL.
 */
export function mergeQueryRows(existingRows, pairs) {
  const pool = new Map();
  for (const row of asArray(existingRows)) {
    if (!row.enabled || !row.key) continue;
    if (!pool.has(row.key)) pool.set(row.key, []);
    pool.get(row.key).push(row);
  }
  const rows = asArray(pairs).map((pair) => {
    const candidates = pool.get(pair.key);
    const existing = candidates && candidates.shift();
    return existing ? { ...existing, value: pair.value } : newRow(pair.key, pair.value);
  });
  const disabled = asArray(existingRows).filter((row) => !row.enabled);
  return [...rows, ...disabled];
}

/* --------------------------------------------------------------- tree access */

export function walkTree(items, visit, parent = null) {
  for (const item of items || []) {
    visit(item, parent);
    if (item.items) walkTree(item.items, visit, item);
  }
}

export function findItem(collections, id, items = null, parent = null) {
  const list = items || collections;
  for (const item of list) {
    if (item.id === id) return { item, parent };
    if (item.items) {
      const found = findItem(collections, id, item.items, item);
      if (found) return found;
    }
  }
  return null;
}

/** The collection a node ultimately belongs to (folders may be nested). */
export function findCollectionOf(collections, id) {
  const found = findItem(collections, id);
  if (!found) return null;
  let node = found.item;
  let parent = found.parent;
  while (parent && parent.type !== "collection") {
    const above = findItem(collections, parent.id);
    node = parent;
    parent = above ? above.parent : null;
  }
  return parent || (node.type === "collection" ? node : null);
}

export function removeItem(collections, id) {
  const found = findItem(collections, id);
  if (!found) return false;
  const list = found.parent ? found.parent.items : collections;
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

export function duplicateItem(collections, id, copyLabel) {
  const found = findItem(collections, id);
  if (!found) return null;
  const clone = deepClone(found.item);
  const reassign = (node) => {
    node.id = uid(node.type === "request" ? "req" : node.type === "folder" ? "folder" : "col");
    if (node.type === "request" && node.request) {
      node.request.headers = (node.request.headers || []).map((row) => ({ ...row, id: uid("kv") }));
      node.request.query = (node.request.query || []).map((row) => ({ ...row, id: uid("kv") }));
    }
    (node.items || []).forEach(reassign);
  };
  reassign(clone);
  clone.name = copyLabel(clone.name);
  const list = found.parent ? found.parent.items : collections;
  list.splice(list.findIndex((item) => item.id === id) + 1, 0, clone);
  return clone;
}

/* ------------------------------------------------------------ normalization */

/** Normalize a sidecar response payload into the shape the panes render. */
export function normalizeResponse(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    requestId: payload.requestId,
    status: payload.status,
    statusText: payload.statusText || "",
    headers: (payload.headers || []).map((header) => ({
      id: uid("header"),
      name: String(header.name ?? header.key ?? ""),
      value: String(header.value ?? ""),
    })),
    contentType: payload.contentType || "",
    finalUrl: payload.finalUrl || "",
    redirectCount: payload.redirectCount ?? 0,
    body: {
      text: payload.body?.text ?? null,
      base64: payload.body?.base64 ?? null,
      truncated: !!payload.body?.truncated,
      sizeBytes: payload.body?.sizeBytes ?? 0,
    },
    // The preview limit the sidecar actually enforced: the configured cap for
    // text, the smaller binary cap for base64 bodies.
    previewLimitBytes: payload.previewLimitBytes ?? null,
    // Total body size per Content-Length, when the server reported one — this
    // is what the meta line shows next to the preview size on truncated
    // responses, so a preview is never mistaken for the whole body.
    contentLength: payload.contentLength ?? null,
    timing: {
      totalMs: payload.timing?.totalMs ?? null,
      ttfbMs: payload.timing?.ttfbMs ?? null,
      downloadMs: payload.timing?.downloadMs ?? null,
    },
  };
}

/** Cookies carried by `Set-Cookie` response headers. */
export function responseCookies(response) {
  return (response?.headers || [])
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => {
      const [pair, ...attributes] = header.value.split(";");
      const equals = pair.indexOf("=");
      return {
        id: header.id,
        name: equals < 0 ? pair.trim() : pair.slice(0, equals).trim(),
        value: equals < 0 ? "" : pair.slice(equals + 1).trim(),
        attributes: attributes.map((attribute) => attribute.trim()).filter(Boolean),
      };
    });
}

export function historyEntry({ request, response, error, timestamp }) {
  return {
    id: uid("history"),
    timestamp: timestamp ?? Date.now(),
    name: request.name,
    method: request.method,
    url: request.url,
    status: response?.status ?? null,
    statusText: response?.statusText ?? "",
    durationMs: response?.timing?.totalMs ?? null,
    sizeBytes: response?.body?.sizeBytes ?? null,
    error: error || null,
    responseMeta: response
      ? { contentType: response.contentType, statusText: response.statusText }
      : null,
    request,
  };
}

/** Persistable form of a request that is about to be saved into a collection. */
export function withRedactedRequest(request) {
  return sanitizeRequestForPersistence(request);
}
