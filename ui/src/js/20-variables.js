/* ==== Variable resolution, validation, request folding ==== */

const VAR_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Resolve {{name}} references in one string.
 * - maskSecrets: secret references are kept as {{name}} (used for cURL export)
 *   instead of being copied into the output.
 */
function resolveString(text, scope, maskSecrets) {
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

/** JSONPath of a node inside the parsed response, e.g. $.store.books[2].title */
function jsonPathOf(path) {
  return "$" + path;
}

function btoaUtf8(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

const CONTENT_TYPES = {
  json: "application/json",
  text: "text/plain",
  urlencoded: "application/x-www-form-urlencoded",
};

/**
 * Fold the editor request into a sidecar request spec:
 * - resolve variables (maskSecrets=false),
 * - fold auth into headers/query,
 * - ensure a body content-type header.
 * Returns { spec, issues } where issues maps field -> { message, unresolved }.
 */
function buildSendSpec(request, requestId, scope, maskSecrets) {
  const issues = {};
  const collect = (field, resolved) => {
    if (resolved.unresolved.length) {
      issues[field] = { unresolved: resolved.unresolved };
      return true;
    }
    return false;
  };

  const urlRes = resolveString(request.url, scope, maskSecrets);
  const badUrl = collect("url", urlRes);

  const headerRows = (request.headers || []).filter((row) => row.enabled && row.key.trim());
  const headers = [];
  for (const row of headerRows) {
    const name = resolveString(row.key, scope, maskSecrets);
    const value = resolveString(row.value, scope, maskSecrets);
    if (collect("headers", name) || collect("headers", value)) continue;
    headers.push({ name: name.value, value: value.value });
  }

  const auth = request.auth || { type: "none" };
  const authHeader = (name, value) => {
    const idx = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) headers.splice(idx, 1);
    headers.push({ name, value });
  };
  const authTypeResolved = auth.type;
  if (authTypeResolved === "bearer") {
    const token = resolveString(auth.token || "", scope, maskSecrets);
    if (!token.value && !collect("auth", token)) {
      issues.auth = { messageKey: null, empty: true, unresolved: [] };
    } else if (!collect("auth", token)) {
      authHeader("Authorization", "Bearer " + token.value);
    }
  } else if (authTypeResolved === "basic") {
    const user = resolveString(auth.username || "", scope, maskSecrets);
    const pass = resolveString(auth.password || "", scope, maskSecrets);
    if (!collect("auth", user) && !collect("auth", pass)) {
      authHeader("Authorization", "Basic " + btoaUtf8(user.value + ":" + pass.value));
    }
  } else if (authTypeResolved === "apikey") {
    const keyName = resolveString(auth.keyName || "", scope, maskSecrets);
    const keyValue = resolveString(auth.keyValue || "", scope, maskSecrets);
    if (!collect("auth", keyName) && !collect("auth", keyValue)) {
      if (auth.in === "query") {
        if (!badUrl) urlRes.value = appendQueryParam(urlRes.value, keyName.value, keyValue.value);
      } else {
        authHeader(keyName.value, keyValue.value);
      }
    }
  }

  let bodyText;
  const bodyType = (request.body && request.body.type) || "none";
  if (bodyType !== "none") {
    const raw = request.body.text || "";
    const resolvedBody = resolveString(raw, scope, maskSecrets);
    collect("body", resolvedBody);
    bodyText = resolvedBody.value;
    if (bodyType === "json" && bodyText.trim()) {
      try {
        JSON.parse(bodyText);
      } catch {
        issues.body = issues.body || { unresolved: [] };
        issues.body.json = true;
      }
    }
    const contentType = CONTENT_TYPES[bodyType] || CONTENT_TYPES.text;
    if (!headers.some((h) => h.name.toLowerCase() === "content-type")) {
      headers.push({ name: "Content-Type", value: contentType });
    }
  }

  if (!urlRes.value.trim() || badUrl || !isHttpUrl(urlRes.value)) {
    issues.url = issues.url || { unresolved: urlRes.unresolved };
    issues.url.invalid = true;
  }

  const settings = request.settings || {};
  const spec = {
    requestId,
    method: request.method,
    url: urlRes.value,
    headers,
    body: bodyText == null ? { type: "none" } : { type: "raw", text: bodyText },
    settings: {
      timeoutMs: clampInt(settings.timeoutMs, 1000, 300000, 30000),
      followRedirects: settings.followRedirects !== false,
      maxRedirects: clampInt(settings.maxRedirects, 0, 20, 10),
      verifyTls: settings.verifyTls !== false,
      maxBodyBytes: State.settings.previewCapBytes,
    },
  };
  return { spec, issues };
}

function isHttpUrl(text) {
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function clampInt(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function appendQueryParam(urlText, key, value) {
  const separator = urlText.includes("?") ? "&" : "?";
  const hashIndex = urlText.indexOf("#");
  let base = urlText;
  let hash = "";
  if (hashIndex >= 0) {
    base = urlText.slice(0, hashIndex);
    hash = urlText.slice(hashIndex);
  }
  return base + separator + encodeURIComponent(key) + "=" + encodeURIComponent(value) + hash;
}

/** Query-string sync helpers. The enabled rows and the URL query stay in
 * agreement; manually authored values are re-imported rather than dropped. */
function parseUrlQuery(urlText) {
  const hashIndex = urlText.indexOf("#");
  const withoutHash = hashIndex >= 0 ? urlText.slice(0, hashIndex) : urlText;
  const qIndex = withoutHash.indexOf("?");
  if (qIndex < 0) return { pairs: [], base: withoutHash };
  const base = withoutHash.slice(0, qIndex);
  const query = withoutHash.slice(qIndex + 1);
  const pairs = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? "" : part.slice(eq + 1);
    pairs.push({ key: safeDecode(rawKey), value: safeDecode(rawValue) });
  }
  return { pairs, base };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function rebuildUrlQuery(urlText, pairs) {
  const hashIndex = urlText.indexOf("#");
  const base = hashIndex >= 0 ? urlText.slice(0, hashIndex) : urlText;
  const hash = hashIndex >= 0 ? urlText.slice(hashIndex) : "";
  if (!pairs.length) return base + hash;
  const query = pairs
    .map((pair) => encodeURIComponent(pair.key) + "=" + encodeURIComponent(pair.value))
    .join("&");
  return base + "?" + query + hash;
}

function serializeQueryPairs(rows) {
  return rows.filter((row) => row.enabled).map((row) => ({ key: row.key, value: row.value }));
}
