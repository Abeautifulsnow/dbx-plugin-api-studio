/**
 * Credential redaction — the UI half of a two-layer guarantee.
 *
 * The sidecar scrubs every payload again before writing it to disk
 * (`backend/src/model.rs`: `redact_history_entry`, `redact_state_payload`), but
 * the UI must never *send* a credential it already knows is a credential. Losing
 * this layer silently is what an earlier review caught, so the sensitive-name
 * rules here are kept in sync with the Rust `is_sensitive_header` list and are
 * covered by `tools/ui-redaction-test.mjs`.
 *
 * Invariant: only `{{name}}` references survive. A reference is a pointer, not a
 * secret, so it stays usable after a restart; a literal credential never does.
 */
import { safeDecode } from "./format.js";

export const REDACTED = "[REDACTED]";

/** Header names that are credentials by name (kept in sync with backend/src/model.rs). */
export const SENSITIVE_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-token",
  "x-csrf-token",
  "x-xsrf-token",
  "private-token",
  "x-amz-security-token",
  "x-goog-api-key",
  "x-secret",
];

/** Header names that are credentials by shape (hand-written X-Tenant-Token, …). */
export const SENSITIVE_HEADER_MARKERS = [
  "token",
  "secret",
  "api-key",
  "apikey",
  "password",
  "credential",
];

export const SENSITIVE_QUERY_MARKERS = [
  "token",
  "secret",
  "key",
  "password",
  "passwd",
  "signature",
  "credential",
  "auth",
];

export function isSensitiveHeaderName(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return false;
  if (SENSITIVE_HEADER_NAMES.includes(lower)) return true;
  return SENSITIVE_HEADER_MARKERS.some((marker) => lower.includes(marker));
}

export function isSensitiveQueryName(name) {
  const lower = String(name || "").trim().toLowerCase();
  return SENSITIVE_QUERY_MARKERS.some((marker) => lower.includes(marker));
}

const VARIABLE_NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.";

/** True when the whole string is exactly one `{{name}}` reference. */
export function isPlainVariableReference(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 5) return false;
  if (trimmed.slice(0, 2) !== "{{" || trimmed.slice(-2) !== "}}") return false;
  const name = trimmed.slice(2, -2).trim();
  if (!name) return false;
  for (const character of name) {
    if (!VARIABLE_NAME_CHARS.includes(character)) return false;
  }
  return true;
}

export function redactCredentialValue(value) {
  const text = String(value || "");
  if (!text) return "";
  return isPlainVariableReference(text) ? text : REDACTED;
}

/**
 * Drop a `scheme://user:pass@` userinfo section, keeping the rest of the URL
 * byte-identical. Written as a scan rather than a regex so the persistence
 * boundary stays trivially auditable.
 */
export function stripUrlUserinfo(url) {
  const text = String(url || "");
  const schemeAt = text.indexOf("://");
  if (schemeAt < 0) return text;
  const authorityStart = schemeAt + 3;
  let authorityEnd = text.length;
  for (let index = authorityStart; index < text.length; index++) {
    const character = text[index];
    if (character === "/" || character === "?" || character === "#") {
      authorityEnd = index;
      break;
    }
  }
  const authority = text.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at < 0) return text;
  return text.slice(0, authorityStart) + authority.slice(at + 1) + text.slice(authorityEnd);
}

/**
 * Redact credential-bearing query values in a URL string while preserving its
 * shape (`?access_token=abc` → `?access_token=[REDACTED]`) and always dropping
 * userinfo, even when there is no query string at all.
 */
export function redactUrlForHistory(url) {
  let text = String(url || "");
  const hashIndex = text.indexOf("#");
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : "";
  if (hashIndex >= 0) text = text.slice(0, hashIndex);

  const queryIndex = text.indexOf("?");
  const base = stripUrlUserinfo(queryIndex < 0 ? text : text.slice(0, queryIndex));
  if (queryIndex < 0) return base + hash;

  const redacted = text
    .slice(queryIndex + 1)
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals < 0) return pair;
      const key = pair.slice(0, equals);
      return isSensitiveQueryName(safeDecode(key)) ? key + "=" + REDACTED : pair;
    })
    .join("&");
  return base + "?" + redacted + hash;
}

/** Auth fields that hold a directly typed credential, per auth type. */
export const AUTH_CREDENTIAL_FIELDS = {
  bearer: ["token"],
  basic: ["password"],
  apikey: ["keyValue"],
};

/**
 * Build the persistable copy of a request: credentials become `[REDACTED]`,
 * `{{references}}` survive, and the URL is scrubbed of query credentials and
 * userinfo. Used for collection storage *and* history snapshots so no save path
 * can bypass redaction (PRD §6.4).
 */
export function sanitizeRequestForPersistence(request) {
  const copy = JSON.parse(JSON.stringify(request ?? {}));

  const auth = copy.auth || { type: "none" };
  for (const field of AUTH_CREDENTIAL_FIELDS[auth.type] || []) {
    auth[field] = redactCredentialValue(auth[field]);
  }
  delete auth.reveal;
  copy.auth = auth;

  copy.variables = (copy.variables || []).map((variable) => ({
    id: variable.id,
    key: variable.key,
    secret: !!variable.secret,
    value: variable.secret ? "" : String(variable.value ?? ""),
  }));

  copy.headers = (copy.headers || []).map((row) => ({
    ...row,
    value: isSensitiveHeaderName(row.key) ? redactCredentialValue(row.value) : row.value,
  }));

  copy.query = (copy.query || []).map((row) => ({
    ...row,
    value: isSensitiveQueryName(row.key) ? redactCredentialValue(row.value) : row.value,
  }));

  // Multipart text parts are form fields: a credential-named part holds a
  // credential. File parts only carry a path — no credential bytes.
  if (copy.body?.type === "multipart") {
    copy.body.rows = (copy.body.rows || []).map((row) => ({
      ...row,
      value:
        row.kind !== "file" && isSensitiveHeaderName(row.name)
          ? redactCredentialValue(row.value)
          : row.value,
    }));
  }

  // A configured proxy password is a credential like any other.
  if (copy.settings?.proxy?.password) {
    copy.settings.proxy.password = redactCredentialValue(copy.settings.proxy.password);
  }

  copy.url = redactUrlForHistory(copy.url);
  return copy;
}

/** History snapshot: additionally strips body text and every resolved value. */
export function redactRequestForHistory(request) {
  const copy = sanitizeRequestForPersistence(request);
  const body = copy.body || { type: "none" };
  const bodyLength = String(body.text || "").length;
  copy.body = {
    type: body.type || "none",
    text: "",
    redacted: true,
    sizeBytes: bodyLength,
  };
  copy.variables = (copy.variables || []).map((variable) => ({
    id: variable.id,
    key: variable.key,
    value: "",
  }));
  return copy;
}

/** Recursively copy a collection/folder tree, sanitizing every request node. */
export function sanitizeTree(node) {
  const copy = JSON.parse(JSON.stringify(node));
  if (Array.isArray(node.items)) {
    copy.items = node.items.map((item) =>
      item.type === "request"
        ? { ...JSON.parse(JSON.stringify(item)), request: sanitizeRequestForPersistence(item.request) }
        : sanitizeTree(item),
    );
  }
  return copy;
}
