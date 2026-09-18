/**
 * Variable resolution, validation and request folding.
 *
 * `buildSendSpec` is the single place where the editor state becomes a sidecar
 * request spec, so URL/auth/body validation cannot drift between the send path
 * and the cURL export path (both call it; only `maskSecrets` differs).
 */
import { btoaUtf8, clampInt, safeDecode } from "./format.js";

export const VAR_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

export const CONTENT_TYPES = {
  json: "application/json",
  text: "text/plain",
  urlencoded: "application/x-www-form-urlencoded",
  // Display only: the transport generates the actual boundary; the editor must
  // not show text/plain for a multipart body.
  multipart: "multipart/form-data",
};

/**
 * Resolve `{{name}}` references in one string.
 *
 * With `maskSecrets`, a secret reference stays as `{{name}}` instead of being
 * expanded — that is what keeps `Copy as cURL` from embedding a credential.
 */
export function resolveString(text, scope, maskSecrets) {
  const unresolved = [];
  if (typeof text !== "string") return { value: "", unresolved };
  const value = text.replace(VAR_PATTERN, (whole, name) => {
    const entry = scope.get(name);
    if (!entry) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return whole;
    }
    if (entry.secret) {
      if (maskSecrets) return "{{" + name + "}}";
      if (!entry.value) {
        if (!unresolved.includes(name)) unresolved.push(name);
        return whole;
      }
      return entry.value;
    }
    return entry.value;
  });
  return { value, unresolved };
}

/** Total variable scope: request-local definitions win over the environment.
 * A request-local variable keeps its own secret flag — it is masked in cURL
 * exports exactly like an environment secret. */
export function variableScope(environment, request) {
  const scope = new Map();
  for (const variable of environment?.variables || []) {
    scope.set(variable.key, {
      value: variable.value,
      secret: !!variable.secret,
      source: "environment",
    });
  }
  for (const variable of request?.variables || []) {
    scope.set(variable.key, {
      value: variable.value,
      secret: !!variable.secret,
      source: "request",
    });
  }
  return scope;
}

export function isHttpUrl(text) {
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function appendQueryParam(urlText, key, value) {
  // Decide the separator from the query-less base: a fragment can legally
  // contain "?", which must not make an existing-query URL out of one that has
  // only a fragment (that would yield `users&api_key=x#…`).
  const hashIndex = urlText.indexOf("#");
  const base = hashIndex >= 0 ? urlText.slice(0, hashIndex) : urlText;
  const hash = hashIndex >= 0 ? urlText.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return base + separator + encodeURIComponent(key) + "=" + encodeURIComponent(value) + hash;
}

/**
 * Fold the editor request into a sidecar spec.
 *
 * Returns `{ spec, issues }` where `issues` is keyed by editor field
 * (`url`, `headers`, `auth`, `body`) and carries the unresolved variable names so
 * the UI can point at the field instead of failing opaquely.
 */
export function buildSendSpec(request, requestId, scope, options = {}) {
  const maskSecrets = !!options.maskSecrets;
  const previewCapBytes = options.previewCapBytes ?? 2 * 1024 * 1024;
  const issues = {};

  /** @returns true when the field is unusable (unresolved variables). */
  const collect = (field, resolved) => {
    if (resolved.unresolved.length) {
      issues[field] = { ...(issues[field] || {}), unresolved: resolved.unresolved };
      return true;
    }
    return false;
  };

  const url = resolveString(request.url, scope, maskSecrets);
  const urlBroken = collect("url", url);

  const headers = [];
  for (const row of request.headers || []) {
    if (!row.enabled || !String(row.key || "").trim()) continue;
    const name = resolveString(row.key, scope, maskSecrets);
    const value = resolveString(row.value, scope, maskSecrets);
    if (collect("headers", name) || collect("headers", value)) continue;
    headers.push({ name: name.value, value: value.value });
  }

  const setAuthHeader = (name, value) => {
    const existing = headers.findIndex((header) => header.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) headers.splice(existing, 1);
    headers.push({ name, value });
  };

  const auth = request.auth || { type: "none" };
  if (auth.type === "bearer") {
    const token = resolveString(auth.token || "", scope, maskSecrets);
    if (collect("auth", token)) {
      // reported through issues.auth
    } else if (!token.value) {
      issues.auth = { ...(issues.auth || {}), empty: true };
    } else {
      setAuthHeader("Authorization", "Bearer " + token.value);
    }
  } else if (auth.type === "basic") {
    const user = resolveString(auth.username || "", scope, maskSecrets);
    const password = resolveString(auth.password || "", scope, maskSecrets);
    if (!collect("auth", user) && !collect("auth", password)) {
      setAuthHeader("Authorization", "Basic " + btoaUtf8(user.value + ":" + password.value));
    }
  } else if (auth.type === "apikey") {
    const keyName = resolveString(auth.keyName || "", scope, maskSecrets);
    const keyValue = resolveString(auth.keyValue || "", scope, maskSecrets);
    if (!collect("auth", keyName) && !collect("auth", keyValue)) {
      if (auth.in === "query") {
        if (!urlBroken) url.value = appendQueryParam(url.value, keyName.value, keyValue.value);
      } else {
        setAuthHeader(keyName.value, keyValue.value);
      }
    }
  }

  let bodyText;
  let bodyParts = null;
  const bodyType = request.body?.type || "none";
  if (bodyType === "multipart") {
    // Only names, values and paths cross the bridge — the sidecar reads file
    // bytes itself at send time. The transport generates the multipart
    // boundary, so a user Content-Type would corrupt the request and is
    // dropped below instead of honored.
    bodyParts = [];
    for (const row of request.body?.rows || []) {
      if (!row.enabled || !String(row.name || "").trim()) continue;
      const name = resolveString(row.name, scope, maskSecrets);
      if (collect("body", name)) continue;
      if (row.kind === "file") {
        const path = resolveString(row.path || "", scope, maskSecrets);
        if (collect("body", path)) continue;
        bodyParts.push({ name: name.value, kind: "file", value: "", path: path.value });
      } else {
        const value = resolveString(row.value || "", scope, maskSecrets);
        if (collect("body", value)) continue;
        bodyParts.push({ name: name.value, kind: "text", value: value.value, path: "" });
      }
    }
  } else if (bodyType !== "none") {
    const resolvedBody = resolveString(request.body?.text || "", scope, maskSecrets);
    collect("body", resolvedBody);
    bodyText = resolvedBody.value;
    if (bodyType === "json" && bodyText.trim()) {
      try {
        JSON.parse(bodyText);
      } catch {
        issues.body = { ...(issues.body || {}), json: true };
      }
    }
    const contentType = CONTENT_TYPES[bodyType] || CONTENT_TYPES.text;
    if (!headers.some((header) => header.name.toLowerCase() === "content-type")) {
      headers.push({ name: "Content-Type", value: contentType });
    }
  }
  if (bodyType === "multipart") {
    const contentTypeIndex = headers.findIndex(
      (header) => header.name.toLowerCase() === "content-type",
    );
    if (contentTypeIndex >= 0) headers.splice(contentTypeIndex, 1);
  }

  if (!url.value.trim() || urlBroken || !isHttpUrl(url.value)) {
    issues.url = { ...(issues.url || {}), invalid: true };
  }

  const settings = request.settings || {};
  const proxy = settings.proxy || {};
  const spec = {
    requestId,
    method: request.method,
    url: url.value,
    headers,
    body:
      bodyType === "multipart"
        ? { type: "multipart", parts: bodyParts }
        : bodyText == null
          ? { type: "none" }
          : { type: "raw", text: bodyText },
    jarKey: options.jarKey || null,
    settings: {
      timeoutMs: clampInt(settings.timeoutMs, 1000, 300000, 30000),
      followRedirects: settings.followRedirects !== false,
      maxRedirects: clampInt(settings.maxRedirects, 0, 20, 10),
      verifyTls: settings.verifyTls !== false,
      maxBodyBytes: previewCapBytes,
      // The Rust RequestSpec reads the proxy from settings (model.rs);
      // only non-default plans travel — "system" is the transport default.
      proxy:
        proxy.mode === "none"
          ? { mode: "none" }
          : proxy.mode === "custom"
            ? {
                mode: "custom",
                url: proxy.url || "",
                username: proxy.username || "",
                password: proxy.password || "",
              }
            : { mode: "system" },
    },
  };
  return { spec, issues };
}

/** Split a URL into base + decoded query pairs; the fragment is preserved. */
export function parseUrlQuery(urlText) {
  const text = String(urlText || "");
  const hashIndex = text.indexOf("#");
  const withoutHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return { pairs: [], base: withoutHash };
  const base = withoutHash.slice(0, queryIndex);
  const pairs = [];
  for (const part of withoutHash.slice(queryIndex + 1).split("&")) {
    if (!part) continue;
    const equals = part.indexOf("=");
    const rawKey = equals < 0 ? part : part.slice(0, equals);
    const rawValue = equals < 0 ? "" : part.slice(equals + 1);
    pairs.push({ key: safeDecode(rawKey), value: safeDecode(rawValue) });
  }
  return { pairs, base };
}

/**
 * Replace the query of `urlText` with `pairs`, preserving the fragment.
 * Accepts a full URL or a bare base: an existing query is always replaced,
 * never appended to (appending would produce `url?old?new`).
 */
export function rebuildUrlQuery(urlText, pairs) {
  const text = String(urlText || "");
  const hashIndex = text.indexOf("#");
  const withoutHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : "";
  const queryIndex = withoutHash.indexOf("?");
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  if (!pairs.length) return base + hash;
  const query = pairs
    .map((pair) => encodeURIComponent(pair.key) + "=" + encodeURIComponent(pair.value))
    .join("&");
  return base + "?" + query + hash;
}

export function serializeQueryRows(rows) {
  return rows.filter((row) => row.enabled).map((row) => ({ key: row.key, value: row.value }));
}
