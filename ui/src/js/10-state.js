/* ==== Application state ==== */

const STATE_VERSION = 1;
const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

const State = {
  version: STATE_VERSION,
  collections: [],
  environments: [],
  settings: {
    selectedEnvId: null,
    previewCapBytes: 2 * 1024 * 1024,
    ui: { sidebarWidth: 288, historyOpen: true, editorH: 46 },
  },
  history: [],

  // Editor: the request currently open. `location` is null while the request
  // is an unsaved draft (never yet written into a collection).
  current: null, // { requestId, request, collectionId, folderId, dirty }
  responses: new Map(), // requestId -> normalized response
  sending: null, // requestId while a request is in flight
  lastOutcome: null, // { kind: 'error', category, cause } | { kind: 'cancelled' }
  activeTab: "params",
  responseTab: "body",
  search: "",
  envManagerOpenFor: null,
};

function defaultRequest() {
  return {
    version: 1,
    name: "",
    method: "GET",
    url: "",
    query: [],
    headers: [],
    auth: { type: "none" },
    body: { type: "none", text: "" },
    variables: [],
    settings: {
      timeoutMs: 30000,
      followRedirects: true,
      maxRedirects: 10,
      verifyTls: true,
    },
  };
}

function newRow(key, value) {
  return { id: uuid("kv"), key: key || "", value: value || "", description: "", enabled: true };
}

function newRequestItem(name) {
  return {
    id: uuid("req"),
    type: "request",
    name: name || I18N.t("draftName"),
    request: defaultRequest(),
  };
}

function newCollection(name) {
  return { id: uuid("col"), type: "collection", name: name || "Collection", items: [] };
}

function newEnvironment(name) {
  return {
    id: uuid("env"),
    name: name || "Environment",
    prodLike: false,
    confirmUnsafe: true,
    variables: [],
  };
}

const REDACTED = "[REDACTED]";

/** Header names / markers that mark a value as a credential. Kept in sync with
 * the sidecar's `is_sensitive_header` (backend/src/model.rs). */
const SENSITIVE_HEADER_MARKERS = ["token", "secret", "api-key", "apikey", "password", "credential"];
const SENSITIVE_HEADER_NAMES = [
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token", "x-token",
  "x-csrf-token", "x-xsrf-token", "private-token", "x-amz-security-token",
  "x-goog-api-key", "x-secret",
];

function isSensitiveHeaderName(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return false;
  if (SENSITIVE_HEADER_NAMES.includes(lower)) return true;
  return SENSITIVE_HEADER_MARKERS.some((marker) => lower.includes(marker));
}

const SENSITIVE_QUERY_MARKERS = ["token", "secret", "key", "password", "passwd", "signature", "credential", "auth"];

function isSensitiveQueryName(name) {
  const lower = String(name || "").trim().toLowerCase();
  return SENSITIVE_QUERY_MARKERS.some((marker) => lower.includes(marker));
}

const VARIABLE_NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.";

/** True when the whole string is a single {{name}} reference (a pointer, not a
 * secret). Only such values survive redaction. */
function isPlainVariableReference(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 5) return false;
  if (trimmed.slice(0, 2) !== "{{" || trimmed.slice(-2) !== "}}") return false;
  const name = trimmed.slice(2, -2).trim();
  if (!name) return false;
  for (const ch of name) {
    if (!VARIABLE_NAME_CHARS.includes(ch)) return false;
  }
  return true;
}

function redactCredentialValue(value) {
  const text = String(value || "");
  if (!text) return "";
  return isPlainVariableReference(text) ? text : REDACTED;
}

/** Drop a `scheme://user:pass@` userinfo section without touching the rest. */
function stripUrlUserinfo(url) {
  const schemeAt = url.indexOf("://");
  if (schemeAt < 0) return url;
  const authorityStart = schemeAt + 3;
  let authorityEnd = url.length;
  for (let i = authorityStart; i < url.length; i++) {
    const ch = url[i];
    if (ch === "/" || ch === "?" || ch === "#") {
      authorityEnd = i;
      break;
    }
  }
  const authority = url.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at < 0) return url;
  return url.slice(0, authorityStart) + authority.slice(at + 1) + url.slice(authorityEnd);
}

/** Redact credential-bearing query values from a URL string, keeping its shape. */
function redactUrlForHistory(url) {
  let text = String(url || "");
  const hashIndex = text.indexOf("#");
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : "";
  if (hashIndex >= 0) text = text.slice(0, hashIndex);
  const qIndex = text.indexOf("?");
  const base = stripUrlUserinfo(qIndex < 0 ? text : text.slice(0, qIndex));
  if (qIndex < 0) return base + hash;
  const redacted = text
    .slice(qIndex + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const key = pair.slice(0, eq);
      return isSensitiveQueryName(safeDecode(key)) ? key + "=" + REDACTED : pair;
    })
    .join("&");
  return base + "?" + redacted + hash;
}

/** Auth-bearing fields of a request; these hold directly typed credentials. */
const AUTH_CREDENTIAL_FIELDS = {
  bearer: ["token"],
  basic: ["password"],
  apikey: ["keyValue"],
};

/**
 * Build the persistable copy of a request: credentials are stripped, only
 * `{{variable}}` references survive. Used for BOTH collection storage and
 * history snapshots so no save path can bypass redaction (PRD §6.4: a request
 * never stores resolved secret values).
 */
function sanitizeRequestForPersistence(request) {
  const copy = deepClone(request);
  const auth = copy.auth || { type: "none" };
  for (const field of AUTH_CREDENTIAL_FIELDS[auth.type] || []) {
    auth[field] = redactCredentialValue(auth[field]);
  }
  delete auth.reveal;
  copy.auth = auth;

  copy.variables = (copy.variables || []).map((variable) => ({
    name: variable.name,
    secret: !!variable.secret,
    value: variable.secret ? "" : String(variable.value || ""),
  }));

  copy.headers = (copy.headers || []).map((row) => ({
    ...row,
    value: isSensitiveHeaderName(row.key) ? redactCredentialValue(row.value) : row.value,
  }));

  copy.query = (copy.query || []).map((row) => ({
    ...row,
    value: isSensitiveQueryName(row.key) ? redactCredentialValue(row.value) : row.value,
  }));

  copy.url = redactUrlForHistory(copy.url);
  return copy;
}

/** History snapshot: never carries body text, credentials or resolved values. */
function redactRequestForHistory(request) {
  const copy = sanitizeRequestForPersistence(request);
  const body = copy.body || { type: "none" };
  const bodyLength = String(body.text || "").length;
  copy.body = { type: body.type || "none", text: "", redacted: true, sizeBytes: bodyLength };
  copy.variables = (copy.variables || []).map((variable) => ({ name: variable.name, value: "" }));
  return copy;
}

/** Locate an item plus its parent collection/folder. */
function findItem(id, items = null, parent = null) {
  const list = items || State.collections;
  for (const item of list) {
    if (item.id === id) return { item, parent };
    if (item.items) {
      const found = findItem(id, item.items, item);
      if (found) return found;
    }
  }
  return null;
}

function findCollectionOf(itemId) {
  const found = findItem(itemId);
  if (!found) return null;
  let node = found.item;
  let parent = found.parent;
  while (parent && parent.type !== "collection") {
    const up = findItem(parent.id);
    node = parent;
    parent = up ? up.parent : null;
  }
  return parent || (node.type === "collection" ? node : null);
}

function selectedEnvironment() {
  if (!State.settings.selectedEnvId) return null;
  return State.environments.find((env) => env.id === State.settings.selectedEnvId) || null;
}

/** Total variable scope: request-local wins over environment. */
function variableScope(request) {
  const scope = new Map();
  const env = selectedEnvironment();
  if (env) {
    for (const v of env.variables) {
      scope.set(v.name, { value: v.value, secret: !!v.secret, source: "environment" });
    }
  }
  for (const v of request.variables || []) {
    scope.set(v.name, { value: v.value, secret: false, source: "request" });
  }
  return scope;
}

/** Persisted state payload — every credential is stripped here (auth values that
 * are not {{references}}, secret-marked variables, credential headers/query
 * values), in addition to the sidecar's own scrub of history entries.
 *
 * Request bodies are stored as authored: PRD §6.4 lists `body` as part of a
 * stored request definition, and a body is authored request content rather than
 * a resolved-credential channel. Credential *channels* (auth fields, credential
 * named headers/query, secret variables) are the ones that must never persist —
 * only their `{{variable}}` references survive. History is stricter and keeps no
 * body text at all (`redactRequestForHistory`). */
function persistableState() {
  const environments = State.environments.map((env) => ({
    ...deepClone(env),
    variables: env.variables.map((v) => ({
      name: v.name,
      secret: !!v.secret,
      // Secret values are session-only; ordinary variables must survive a restart.
      value: v.secret ? "" : String(v.value || ""),
    })),
  }));
  const collections = State.collections.map((collection) => sanitizeTree(collection));
  return {
    version: STATE_VERSION,
    collections,
    environments,
    settings: deepClone(State.settings),
  };
}

/** Recursively copy a collection/folder tree, sanitizing every request. */
function sanitizeTree(node) {
  const copy = { ...deepClone(node) };
  if (Array.isArray(node.items)) {
    copy.items = node.items.map((item) =>
      item.type === "request" ? { ...deepClone(item), request: sanitizeRequestForPersistence(item.request) } : sanitizeTree(item),
    );
  }
  return copy;
}

const scheduleSave = debounce(() => {
  Api.saveState(persistableState()).catch((error) => {
    announce("Save failed: " + (error && error.message ? error.message : error));
  });
}, 600);
