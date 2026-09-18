//! Wire models crossing the UI ↔ Sidecar boundary.
//!
//! The UI fully resolves variables and folds auth into headers/query before
//! calling `api/request`, so the sidecar only ever sees a plain HTTP request.
//! Secret values therefore never need special treatment on this side — they are
//! just header/query values that must never be logged (the sidecar logs nothing
//! on stdout, which is protocol-only).

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 300_000;
/// Protocol single-message limit is 8 MiB; the largest configurable body cap
/// leaves headroom for JSON string escaping plus envelope metadata.
pub const MAX_BODY_BYTES_CEILING: usize = 6 * 1024 * 1024;
pub const MIN_BODY_BYTES: usize = 256 * 1024;
pub const DEFAULT_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Binary bodies travel as base64 (a 4/3 expansion) inside the same 8 MiB
/// JSON-RPC message, so a binary preview near the 6 MiB text ceiling would
/// overflow the transport and the whole response would be rejected. Binary
/// previews therefore stop at 4 MiB raw (~5.3 MiB encoded).
pub const MAX_BINARY_PREVIEW_BYTES: usize = 4 * 1024 * 1024;

pub const METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/// The JSON-RPC transport rejects any single message over 8 MiB. serde_json can
/// expand control characters up to 6x while escaping, so the byte-based body
/// cap cannot bound the serialized message by itself: after building a response
/// the payload is measured and the text preview shrunk until it provably fits,
/// with headroom for envelope growth.
pub const TRANSPORT_MESSAGE_BUDGET: usize = 7 * 1024 * 1024;

/// Measure the serialized payload and shrink `body.text` until it fits the
/// transport. `body.sizeBytes` follows the delivered preview and `truncated`
/// is set, so the UI always quotes a size the user actually received.
pub fn fit_payload_to_transport(payload: &mut Value) {
    for _ in 0..8 {
        let Ok(serialized) = serde_json::to_vec(payload) else {
            return;
        };
        if serialized.len() <= TRANSPORT_MESSAGE_BUDGET {
            return;
        }
        let Some(body) = payload.get_mut("body").and_then(Value::as_object_mut) else {
            return;
        };
        let Some(text) = body.get("text").and_then(Value::as_str) else {
            return;
        };
        // Cut proportionally to the overshoot (with a safety factor) so two or
        // three iterations converge; never split a UTF-8 character.
        let overshoot = serialized.len() as f64 / TRANSPORT_MESSAGE_BUDGET as f64;
        let mut keep = (text.len() as f64 / (overshoot * 1.25)) as usize;
        while keep > 0 && !text.is_char_boundary(keep) {
            keep -= 1;
        }
        body.insert("text".to_string(), Value::String(text[..keep].to_string()));
        body.insert("sizeBytes".to_string(), Value::from(keep as u64));
        body.insert("truncated".to_string(), Value::Bool(true));
    }
    // Still over after repeated proportional cuts: drop the preview entirely —
    // a response without a body beats a response the transport rejects.
    if let Some(body) = payload.get_mut("body").and_then(Value::as_object_mut) {
        body.insert("text".to_string(), Value::String(String::new()));
    }
}

/// Stable error taxonomy (PRD §6.2 plus the RPC-params category). Both the UI
/// and the sidecar must classify every failure into one of these names so the
/// workbench can render a predictable cause + next step.
pub const ERROR_CATEGORIES: [&str; 11] = [
    "INVALID_URL",
    "INVALID_REQUEST",
    "VARIABLE_UNRESOLVED",
    "DNS_FAILED",
    "CONNECT_FAILED",
    "TLS_FAILED",
    "TIMEOUT",
    "REQUEST_CANCELLED",
    "TOO_MANY_REDIRECTS",
    "BODY_TOO_LARGE",
    "INTERNAL_ERROR",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    pub request_id: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub body: RequestBody,
    #[serde(default)]
    pub settings: RequestSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBody {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSettings {
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    #[serde(default = "default_max_redirects")]
    pub max_redirects: u32,
    #[serde(default = "default_true")]
    pub verify_tls: bool,
    #[serde(default = "default_body_bytes")]
    pub max_body_bytes: usize,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_MS
}
fn default_max_redirects() -> u32 {
    10
}
fn default_body_bytes() -> usize {
    DEFAULT_BODY_BYTES
}
fn default_true() -> bool {
    true
}

impl Default for RequestSettings {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_TIMEOUT_MS,
            follow_redirects: true,
            max_redirects: 10,
            verify_tls: true,
            max_body_bytes: DEFAULT_BODY_BYTES,
        }
    }
}

/// A validated request ready for transport.
#[derive(Debug)]
pub struct ValidatedRequest {
    pub request_id: String,
    pub method: String,
    pub url: url::Url,
    pub headers: Vec<(String, String)>,
    pub body_text: Option<String>,
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub max_redirects: u32,
    pub verify_tls: bool,
    pub max_body_bytes: usize,
}

/// Terminal outcome of one execution attempt (success, cancelled or transport
/// failure) in the shape the UI consumes.
#[derive(Debug)]
pub enum ExecOutcome {
    Response(ResponsePayload),
    Cancelled { request_id: String },
    Failed { request_id: String, category: String, cause: String },
}

impl ExecOutcome {
    pub fn request_id(&self) -> &str {
        match self {
            ExecOutcome::Response(payload) => &payload.request_id,
            ExecOutcome::Cancelled { request_id } => request_id,
            ExecOutcome::Failed { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug)]
pub struct ResponsePayload {
    pub request_id: String,
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    pub body_text: Option<String>,
    pub body_base64: Option<String>,
    pub body_truncated: bool,
    pub body_bytes: u64,
    /// The preview limit actually applied to this body: the configured cap for
    /// text, or the smaller binary cap for base64-encoded bodies. The UI shows
    /// this in the truncation notice so it never quotes a limit that was not
    /// the one enforced.
    pub body_preview_limit: u64,
    /// The response's total size as reported by `Content-Length`, when the
    /// server sent one. lets the UI distinguish "this is the whole response"
    /// from "this is a preview of a larger body".
    pub content_length: Option<u64>,
    pub final_url: String,
    pub redirect_count: u32,
    pub total_ms: u64,
    /// Milliseconds until the final response headers arrived (includes any
    /// redirect chain). None when not measured.
    pub ttfb_ms: Option<u64>,
    /// Milliseconds spent reading the body after headers.
    pub download_ms: Option<u64>,
}

pub fn validate_spec(spec: RequestSpec) -> Result<ValidatedRequest, ApiError> {
    let request_id = spec.request_id.trim().to_string();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(ApiError::invalid_request(
            "requestId must be 1-128 characters",
        ));
    }

    let method = spec.method.trim().to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(ApiError::invalid_request(&format!(
            "Unsupported method {method}. Supported: {}",
            METHODS.join(", ")
        )));
    }

    let parsed = url::Url::parse(spec.url.trim()).map_err(|e| {
        ApiError::invalid_url(&format!("Invalid URL: {}", sanitize_cause(&e.to_string())))
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ApiError::invalid_url(
            "Only http and https URLs can be sent",
        ));
    }

    let mut headers = Vec::with_capacity(spec.headers.len());
    for header in spec.headers {
        let name = header.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        if !is_valid_header_name(&name) {
            return Err(ApiError::invalid_request(&format!(
                "Invalid header name: {name}"
            )));
        }
        // Empty values are legal; header values containing CR/LF would allow
        // request splitting and are rejected outright.
        if header.value.contains('\r') || header.value.contains('\n') {
            return Err(ApiError::invalid_request(&format!(
                "Header {name} contains a line break"
            )));
        }
        headers.push((name, header.value));
    }

    let body_text = match spec.body.kind.as_str() {
        "" | "none" => None,
        "raw" => Some(spec.body.text.unwrap_or_default()),
        other => {
            return Err(ApiError::invalid_request(&format!(
                "Unknown body type: {other}"
            )))
        }
    };

    let settings = spec.settings;
    Ok(ValidatedRequest {
        request_id,
        method,
        url: parsed,
        headers,
        body_text,
        timeout_ms: settings.timeout_ms.clamp(1, MAX_TIMEOUT_MS),
        follow_redirects: settings.follow_redirects,
        max_redirects: settings.max_redirects.clamp(0, 20),
        verify_tls: settings.verify_tls,
        max_body_bytes: settings
            .max_body_bytes
            .clamp(MIN_BODY_BYTES, MAX_BODY_BYTES_CEILING),
    })
}

fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| matches!(b, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z'))
}

/// Error sent to the UI: a stable category plus a *sanitized* cause. Raw
/// transport text is never forwarded verbatim because it can embed the request
/// URL, including query values that may be credentials.
#[derive(Debug)]
pub struct ApiError {
    pub code: i32,
    pub category: String,
    pub message: String,
    pub request_id: Option<String>,
}

impl ApiError {
    /// Malformed RPC params (unknown method, bad header name, bad body type).
    pub fn invalid_request(message: &str) -> Self {
        Self {
            code: -32602,
            category: "INVALID_REQUEST".to_string(),
            message: message.to_string(),
            request_id: None,
        }
    }

    /// URL that cannot be parsed or uses an unsupported scheme.
    pub fn invalid_url(message: &str) -> Self {
        Self {
            code: -32602,
            category: "INVALID_URL".to_string(),
            message: message.to_string(),
            request_id: None,
        }
    }

    /// Transport failure; `message` must already be sanitized by the caller.
    /// The category is checked against the declared taxonomy so a typo can never
    /// reach the UI as an unrecognized code.
    pub fn transport(category: &str, message: impl Into<String>) -> Self {
        debug_assert!(
            ERROR_CATEGORIES.contains(&category),
            "undeclared error category: {category}"
        );
        Self {
            code: -32000,
            category: category.to_string(),
            message: message.into(),
            request_id: None,
        }
    }

    pub fn with_request_id(mut self, request_id: &str) -> Self {
        self.request_id = Some(request_id.to_string());
        self
    }
}

impl Serialize for ApiError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("ApiError", 4)?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("category", &self.category)?;
        state.serialize_field("message", &self.message)?;
        state.serialize_field("requestId", &self.request_id)?;
        state.end()
    }
}

/* ---------------- credential redaction ---------------- */

/// Headers that are credentials by name. Kept lowercase for comparison.
const SENSITIVE_HEADER_NAMES: [&str; 16] = [
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

/// Marker substrings that make a header name credential-bearing even when it is
/// not on the list above (`x-tenant-token`, `x-service-password`, …).
/// Over-redaction is the safe direction for persisted snapshots.
const SENSITIVE_HEADER_MARKERS: [&str; 6] =
    ["token", "secret", "api-key", "apikey", "password", "credential"];

pub fn is_sensitive_header(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    if SENSITIVE_HEADER_NAMES.contains(&lower.as_str()) {
        return true;
    }
    SENSITIVE_HEADER_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// Query-parameter names that carry credentials; their values are redacted from
/// any persisted URL.
const SENSITIVE_QUERY_MARKERS: [&str; 8] = [
    "token",
    "secret",
    "key",
    "password",
    "passwd",
    "signature",
    "credential",
    "auth",
];

pub fn is_sensitive_query_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    SENSITIVE_QUERY_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

pub const REDACTED: &str = "[REDACTED]";

/// Replace a credential value with a placeholder. Variable references are
/// preserved because `{{name}}` is a pointer, not a secret.
pub fn redact_credential_value(value: &str) -> String {
    if is_plain_variable_reference(value) {
        value.to_string()
    } else if value.is_empty() {
        String::new()
    } else {
        REDACTED.to_string()
    }
}

/// True when the whole string is one `{{name}}` reference (ignoring padding).
pub fn is_plain_variable_reference(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(inner) = trimmed.strip_prefix("{{").and_then(|rest| rest.strip_suffix("}}")) else {
        return false;
    };
    let name = inner.trim();
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}
/// Redact credential-bearing query values in a URL string, preserving structure.
/// Userinfo is dropped even when there is no query string.
pub fn redact_url_query(url: &str) -> String {
    let (base, query, tail) = match split_url(url) {
        Some(parts) => parts,
        None => return url.to_string(),
    };
    if query.is_empty() {
        return format!("{base}{tail}");
    }
    let redacted = query
        .split('&')
        .map(|pair| {
            let (name, _) = match pair.split_once('=') {
                Some((name, value)) => (name, Some(value)),
                None => (pair, None),
            };
            if is_sensitive_query_name(&safe_decode(name)) {
                format!("{name}={REDACTED}")
            } else {
                pair.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{redacted}{tail}")
}

fn safe_decode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Split `url` into (prefix-through-`?`, query, suffix-from-`#`), dropping the
/// userinfo section so `user:pass@host` never survives.
fn split_url(url: &str) -> Option<(String, String, String)> {
    let scheme_end = url.find("://")? + 3;
    let (scheme, rest) = url.split_at(scheme_end);
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    let host = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    let hash_at = tail.find('#').unwrap_or(tail.len());
    let (before_hash, fragment) = tail.split_at(hash_at);
    let query_at = before_hash.find('?');
    let (path, query) = match query_at {
        Some(at) => before_hash.split_at(at),
        None => (before_hash, ""),
    };
    let query = query.strip_prefix('?').unwrap_or(query);
    Some((
        format!("{scheme}{host}{path}"),
        query.to_string(),
        fragment.to_string(),
    ))
}

/// Redact credentials and query strings from raw transport error text before it
/// crosses the RPC boundary. reqwest messages can embed the full request URL,
/// including userinfo and query values.
pub fn sanitize_cause(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut cursor = 0;
    while cursor < raw.len() {
        let rest = &raw[cursor..];
        let scheme_len = if rest.starts_with("https://") {
            8
        } else if rest.starts_with("http://") {
            7
        } else {
            0
        };
        if scheme_len == 0 {
            let ch = rest.chars().next().expect("cursor is on a char boundary");
            out.push(ch);
            cursor += ch.len_utf8();
            continue;
        }
        // Consume until a delimiter that ends a URL token in error messages.
        let mut end = raw.len();
        for (offset, ch) in rest.char_indices().skip(1) {
            if ch.is_whitespace() || matches!(ch, ')' | ']' | '"' | '\'' | ',' | ';' | '>') {
                end = cursor + offset;
                break;
            }
        }
        let token = &raw[cursor..end];
        out.push_str(&sanitize_url_token(token));
        cursor = end;
    }
    out
}

fn sanitize_url_token(token: &str) -> String {
    match sanitize_url_token_inner(token) {
        Some(clean) => clean,
        None => token.to_string(),
    }
}

fn sanitize_url_token_inner(token: &str) -> Option<String> {
    let scheme_end = token.find("://")? + 3;
    let (scheme, rest) = token.split_at(scheme_end);
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    let host = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    let mut clean = String::with_capacity(token.len());
    clean.push_str(scheme);
    clean.push_str(host);
    clean.push_str(tail.split(['?', '#']).next().unwrap_or(""));
    Some(clean)
}

/* ---------------- history redaction (defense in depth) ---------------- */

/// Scrub a history entry before it is written to disk. The UI already redacts
/// before sending; this catches regressions and older clients.
///
/// Invariants enforced here:
/// - request body text is never persisted (only its type/size survive),
/// - credential-bearing header values become `[REDACTED]` (variable references
///   are kept, they are pointers rather than secrets),
/// - credential-bearing query values in the stored URL become `[REDACTED]`,
/// - no other field is trusted to be pre-redacted.
pub fn redact_history_entry(entry: &mut Value) {
    let Some(request) = entry.get_mut("request").and_then(Value::as_object_mut) else {
        return;
    };

    if let Some(url) = request.get("url").and_then(Value::as_str) {
        let redacted = redact_url_query(url);
        request.insert("url".to_string(), Value::String(redacted));
    }

    if let Some(headers) = request.get_mut("headers").and_then(Value::as_array_mut) {
        for header in headers.iter_mut() {
            let is_sensitive = header
                .get("name")
                .and_then(Value::as_str)
                .map(is_sensitive_header)
                .unwrap_or(false);
            if !is_sensitive {
                continue;
            }
            if let Some(obj) = header.as_object_mut() {
                let current = obj
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                obj.insert(
                    "value".to_string(),
                    Value::String(redact_credential_value(&current)),
                );
            }
        }
    }

    // Body: drop the text, keep non-sensitive metadata for the history list.
    if let Some(body) = request.get_mut("body").and_then(Value::as_object_mut) {
        let previous_size = body
            .get("text")
            .and_then(Value::as_str)
            .map(|text| text.len())
            .unwrap_or(0);
        body.insert("text".to_string(), Value::String(String::new()));
        body.insert("redacted".to_string(), Value::Bool(true));
        if previous_size > 0 && !body.contains_key("sizeBytes") {
            body.insert("sizeBytes".to_string(), Value::from(previous_size));
        }
    }
}

/* ---------------- persisted-state redaction (defense in depth) ---------------- */

/// Scrub a `api/persistence/save` payload: collections, folders and requests,
/// plus environment variables marked secret.
///
/// The UI already builds a persistable copy (`sanitizeRequestForPersistence`);
/// this makes the guarantee hold even if a client sends raw credentials, so no
/// save path can write a secret to disk. Authored request bodies are kept — PRD
/// §6.4 stores `body` as part of the request definition, and history (not
/// collections) is the place that drops bodies entirely.
pub fn redact_state_payload(state: &mut Value) {
    if let Some(environments) = state.get_mut("environments").and_then(Value::as_array_mut) {
        for env in environments.iter_mut() {
            if let Some(vars) = env.get_mut("variables").and_then(Value::as_array_mut) {
                for var in vars.iter_mut() {
                    if var.get("secret").and_then(Value::as_bool).unwrap_or(false) {
                        set_empty_string(var, "value");
                    }
                }
            }
        }
    }
    if let Some(collections) = state.get_mut("collections").and_then(Value::as_array_mut) {
        for node in collections.iter_mut() {
            redact_tree_node(node);
        }
    }
}

fn set_empty_string(target: &mut Value, field: &str) {
    if let Some(obj) = target.as_object_mut() {
        obj.insert(field.to_string(), Value::String(String::new()));
    }
}

fn redact_tree_node(node: &mut Value) {
    let node_type = node
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if node_type == "request" {
        if let Some(request) = node.get_mut("request") {
            redact_request_definition(request);
        }
        return;
    }
    if let Some(items) = node.get_mut("items").and_then(Value::as_array_mut) {
        for item in items.iter_mut() {
            redact_tree_node(item);
        }
    }
}

fn redact_request_definition(request: &mut Value) {
    if let Some(url) = request.get("url").and_then(Value::as_str) {
        let redacted = redact_url_query(url);
        if let Some(obj) = request.as_object_mut() {
            obj.insert("url".to_string(), Value::String(redacted));
        }
    }

    if let Some(auth) = request.get_mut("auth").and_then(Value::as_object_mut) {
        let auth_type = auth
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("none")
            .to_string();
        let fields: &[&str] = match auth_type.as_str() {
            "bearer" => &["token"],
            "basic" => &["password"],
            "apikey" => &["keyValue"],
            _ => &[],
        };
        for field in fields {
            let current = auth
                .get(*field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            auth.insert(
                (*field).to_string(),
                Value::String(redact_credential_value(&current)),
            );
        }
    }

    for section in ["headers", "query"] {
        let is_header = section == "headers";
        if let Some(rows) = request.get_mut(section).and_then(Value::as_array_mut) {
            for row in rows.iter_mut() {
                let name = row
                    .get("key")
                    .or_else(|| row.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let sensitive = if is_header {
                    is_sensitive_header(&name)
                } else {
                    is_sensitive_query_name(&name)
                };
                if !sensitive {
                    continue;
                }
                let current = row
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if let Some(obj) = row.as_object_mut() {
                    obj.insert(
                        "value".to_string(),
                        Value::String(redact_credential_value(&current)),
                    );
                }
            }
        }
    }

    if let Some(vars) = request.get_mut("variables").and_then(Value::as_array_mut) {
        for var in vars.iter_mut() {
            if var.get("secret").and_then(Value::as_bool).unwrap_or(false) {
                set_empty_string(var, "value");
            }
        }
    }
}

pub fn canonical_reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        407 => "Proxy Authentication Required",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Content Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        417 => "Expectation Failed",
        418 => "I'm a teapot",
        422 => "Unprocessable Content",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        451 => "Unavailable For Legal Reasons",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(method: &str, url: &str) -> RequestSpec {
        serde_json::from_value(serde_json::json!({
            "requestId": "r1",
            "method": method,
            "url": url,
            "headers": [],
            "body": { "type": "none" },
            "settings": {}
        }))
        .unwrap()
    }

    fn category_of(result: Result<ValidatedRequest, ApiError>) -> String {
        result.expect_err("expected an error").category
    }

    #[test]
    fn validates_supported_methods_only() {
        assert!(validate_spec(spec("GET", "http://x.test")).is_ok());
        assert!(validate_spec(spec("get", "http://x.test")).is_ok());
        assert_eq!(category_of(validate_spec(spec("TRACE", "http://x.test"))), "INVALID_REQUEST");
    }

    #[test]
    fn url_failures_use_the_prd_invalid_url_category() {
        // The backend must classify independently of the UI pre-check.
        assert_eq!(category_of(validate_spec(spec("GET", "not a url"))), "INVALID_URL");
        assert_eq!(category_of(validate_spec(spec("GET", "file:///etc/passwd"))), "INVALID_URL");
        assert_eq!(category_of(validate_spec(spec("GET", "ftp://x.test"))), "INVALID_URL");
        assert_eq!(category_of(validate_spec(spec("GET", ""))), "INVALID_URL");
    }

    #[test]
    fn invalid_url_messages_do_not_echo_query_secrets() {
        // Malformed IPv6 host: parse fails, and the credential in the query must
        // not appear in the message handed to the UI.
        let error =
            validate_spec(spec("GET", "http://[::1?access_token=supersecret")).unwrap_err();
        assert_eq!(error.category, "INVALID_URL");
        assert!(
            !error.message.contains("supersecret"),
            "cause leaked a query value: {}",
            error.message
        );
    }

    #[test]
    fn url_credentials_never_survive_into_an_error_message() {
        // Sanitizer applied to a realistic transport message.
        let leaked = sanitize_cause("builder error for url (http://u:p@x.test/?api_key=live)");
        assert!(!leaked.contains("live"), "{leaked}");
        assert!(!leaked.contains(":p@"), "{leaked}");
    }

    #[test]
    fn every_emitted_category_is_declared() {
        let cases = [
            validate_spec(spec("BAD", "http://x.test")).unwrap_err(),
            validate_spec(spec("GET", "nope")).unwrap_err(),
            ApiError::transport("TIMEOUT", "x"),
        ];
        for error in cases {
            assert!(
                ERROR_CATEGORIES.contains(&error.category.as_str()),
                "undeclared category {}",
                error.category
            );
        }
    }

    #[test]
    fn rejects_header_injection() {
        let mut s = spec("GET", "http://x.test");
        s.headers = vec![KeyValue {
            name: "X-A".into(),
            value: "1\r\nX-Evil: 2".into(),
        }];
        assert_eq!(category_of(validate_spec(s)), "INVALID_REQUEST");
    }

    #[test]
    fn clamps_settings_into_safe_ranges() {
        let mut s = spec("GET", "http://x.test");
        s.settings.timeout_ms = 10_000_000;
        s.settings.max_body_bytes = 999_999_999;
        s.settings.max_redirects = 999;
        let v = validate_spec(s).unwrap();
        assert_eq!(v.timeout_ms, MAX_TIMEOUT_MS);
        assert_eq!(v.max_body_bytes, MAX_BODY_BYTES_CEILING);
        assert_eq!(v.max_redirects, 20);
    }

    #[test]
    fn classifies_common_credential_header_names() {
        for name in [
            "Authorization",
            "COOKIE",
            "X-API-Key",
            "x-api-key",
            "apikey",
            "X-Auth-Token",
            "X-Tenant-Token",
            "x-service-password",
            "Private-Token",
            "x-goog-api-key",
        ] {
            assert!(is_sensitive_header(name), "{name} should be sensitive");
        }
        for name in ["Accept", "Content-Type", "User-Agent", "X-Request-Id"] {
            assert!(!is_sensitive_header(name), "{name} should not be sensitive");
        }
    }

    #[test]
    fn plain_variable_references_are_pointers_not_secrets() {
        assert!(is_plain_variable_reference("{{access_token}}"));
        assert!(is_plain_variable_reference("  {{ api-key }} "));
        assert!(!is_plain_variable_reference("Bearer live-token"));
        assert!(!is_plain_variable_reference("{{}}"));
        assert!(!is_plain_variable_reference("{{a}}{{b}}"));
        assert_eq!(redact_credential_value("{{apiKey}}"), "{{apiKey}}");
        assert_eq!(redact_credential_value("live-secret"), REDACTED);
    }

    #[test]
    fn redacts_credential_query_values_only() {
        let url = "https://api.test/v1/users?token=abc123&page=2&api_key=xyz#frag";
        let redacted = redact_url_query(url);
        assert!(redacted.contains("token=".to_string().as_str()));
        assert!(!redacted.contains("abc123"), "{redacted}");
        assert!(!redacted.contains("xyz"), "{redacted}");
        assert!(redacted.contains("page=2"), "{redacted}");
        assert!(redacted.ends_with("#frag"), "{redacted}");
    }

    #[test]
    fn redacts_userinfo_from_urls() {
        let redacted = redact_url_query("https://user:pw@api.test/v1?page=1");
        assert!(!redacted.contains("pw"), "{redacted}");
        assert!(redacted.starts_with("https://api.test/v1"), "{redacted}");
    }

    #[test]
    fn sanitize_cause_strips_query_and_userinfo() {
        let raw = "error sending request for url (https://alice:hunter2@api.test/v1?token=zzz)";
        let clean = sanitize_cause(raw);
        assert!(!clean.contains("hunter2"), "{clean}");
        assert!(!clean.contains("zzz"), "{clean}");
        assert!(clean.contains("https://api.test/v1"), "{clean}");
    }

    #[test]
    fn sanitize_cause_keeps_plain_messages_intact() {
        let raw = "connection refused";
        assert_eq!(sanitize_cause(raw), raw);
    }

    #[test]
    fn history_never_persists_body_text() {
        let mut entry = serde_json::json!({
            "id": "h1",
            "request": {
                "method": "POST",
                "url": "https://api.test/login",
                "headers": [],
                "body": { "type": "json", "text": "{\"password\":\"hunter2\"}" }
            }
        });
        redact_history_entry(&mut entry);
        let body = &entry["request"]["body"];
        assert_eq!(body["text"], "");
        assert_eq!(body["redacted"], true);
        assert_eq!(body["sizeBytes"], 22);
        assert!(!entry.to_string().contains("hunter2"));
    }

    #[test]
    fn history_redacts_credential_headers_including_offlist_names() {
        let mut entry = serde_json::json!({
            "id": "h1",
            "request": {
                "method": "GET",
                "url": "https://api.test/x",
                "headers": [
                    { "name": "Authorization", "value": "Bearer live" },
                    { "name": "X-API-Key", "value": "live-key" },
                    { "name": "X-Tenant-Token", "value": "live-token" },
                    { "name": "X-Api-Key-Ref", "value": "{{apiKey}}" },
                    { "name": "Accept", "value": "application/json" }
                ]
            }
        });
        redact_history_entry(&mut entry);
        let headers = entry["request"]["headers"].as_array().unwrap();
        assert_eq!(headers[0]["value"], REDACTED);
        assert_eq!(headers[1]["value"], REDACTED);
        assert_eq!(headers[2]["value"], REDACTED);
        assert_eq!(headers[3]["value"], "{{apiKey}}");
        assert_eq!(headers[4]["value"], "application/json");
    }

    #[test]
    fn history_redacts_credential_query_values() {
        let mut entry = serde_json::json!({
            "id": "h1",
            "request": { "method": "GET", "url": "https://api.test/x?access_token=live&page=1" }
        });
        redact_history_entry(&mut entry);
        let url = entry["request"]["url"].as_str().unwrap();
        assert!(!url.contains("live"), "{url}");
        assert!(url.contains("page=1"), "{url}");
    }

    #[test]
    fn redaction_tolerates_missing_sections() {
        let mut entry = serde_json::json!({ "id": "h1" });
        redact_history_entry(&mut entry);
        let mut entry = serde_json::json!({ "request": { "method": "GET" } });
        redact_history_entry(&mut entry);
    }

    #[test]
    fn userinfo_is_dropped_even_without_a_query_string() {
        let redacted = redact_url_query("https://alice:hunter2@api.test/v1/users");
        assert!(!redacted.contains("hunter2"), "{redacted}");
        assert_eq!(redacted, "https://api.test/v1/users");
    }

    #[test]
    fn state_payload_redaction_strips_credential_channels() {
        let mut state = serde_json::json!({
            "version": 1,
            "environments": [{
                "id": "e1",
                "name": "dev",
                "variables": [
                    { "name": "apiKey", "value": "LIVE-KEY", "secret": true },
                    { "name": "host", "value": "api.test", "secret": false }
                ]
            }],
            "collections": [{
                "id": "c1",
                "type": "collection",
                "items": [{
                    "id": "f1",
                    "type": "folder",
                    "items": [{
                        "id": "r1",
                        "type": "request",
                        "request": {
                            "method": "POST",
                            "url": "https://u:p@api.test/login?access_token=LIVE-QS&page=1",
                            "query": [{ "key": "access_token", "value": "LIVE-QS" }, { "key": "page", "value": "1" }],
                            "headers": [
                                { "key": "Authorization", "value": "Bearer LIVE-AUTH" },
                                { "key": "X-API-Key", "value": "LIVE-APIKEY" },
                                { "key": "Accept", "value": "application/json" }
                            ],
                            "auth": { "type": "bearer", "token": "LIVE-AUTH" },
                            "variables": [{ "name": "apiKey", "value": "LIVE-KEY", "secret": true }],
                            "body": { "type": "json", "text": "{\"page\":1}" }
                        }
                    }]
                }]
            }]
        });
        redact_state_payload(&mut state);
        let dump = state.to_string();
        for secret in ["LIVE-KEY", "LIVE-QS", "LIVE-AUTH", "LIVE-APIKEY", "hunter2"] {
            assert!(!dump.contains(secret), "{secret} survived: {dump}");
        }

        let request = &state["collections"][0]["items"][0]["items"][0]["request"];
        assert_eq!(request["auth"]["token"], REDACTED);
        assert_eq!(request["headers"][0]["value"], REDACTED);
        assert_eq!(request["headers"][1]["value"], REDACTED);
        assert_eq!(request["headers"][2]["value"], "application/json");
        assert_eq!(request["query"][1]["value"], "1");
        assert_eq!(request["variables"][0]["value"], "");
        // Body is authored request content and stays; secret env vars are emptied
        // while ordinary ones survive a restart.
        assert_eq!(request["body"]["text"], "{\"page\":1}");
        assert_eq!(state["environments"][0]["variables"][0]["value"], "");
        assert_eq!(state["environments"][0]["variables"][1]["value"], "api.test");
    }

    #[test]
    fn state_payload_redaction_keeps_variable_references() {
        let mut state = serde_json::json!({
            "collections": [{
                "id": "c1", "type": "collection",
                "items": [{
                    "id": "r1", "type": "request",
                    "request": {
                        "method": "GET", "url": "https://api.test/x",
                        "headers": [{ "key": "X-Api-Key-Ref", "value": "{{apiKey}}" }],
                        "auth": { "type": "bearer", "token": "{{access_token}}" }
                    }
                }]
            }]
        });
        redact_state_payload(&mut state);
        let request = &state["collections"][0]["items"][0]["request"];
        assert_eq!(request["auth"]["token"], "{{access_token}}");
        assert_eq!(request["headers"][0]["value"], "{{apiKey}}");
    }

    #[test]
    fn state_payload_redaction_tolerates_unknown_shapes() {
        let mut state = serde_json::json!({ "settings": { "selectedEnvId": null } });
        redact_state_payload(&mut state);
        let mut state = serde_json::json!({ "collections": [{ "type": "collection" }] });
        redact_state_payload(&mut state);
        let mut state = serde_json::json!({ "environments": [{ "id": "e1" }] });
        redact_state_payload(&mut state);
    }

    #[test]
    fn canonical_reasons_cover_common_codes() {
        assert_eq!(canonical_reason(200), "OK");
        assert_eq!(canonical_reason(404), "Not Found");
        assert_eq!(canonical_reason(599), "Unknown");
    }

    #[test]
    fn response_payload_is_shrunk_to_fit_the_transport() {
        // 4 MiB of control characters escape at 6 bytes each: ~24 MiB of JSON
        // from a body that is under the 6 MiB byte cap. The fitter must shrink
        // the preview until the serialized payload provably fits the 8 MiB
        // transport with headroom.
        let mut payload = serde_json::json!({
            "requestId": "call_1",
            "status": 200,
            "headers": [{ "name": "x", "value": "y" }],
            "body": {
                "text": "\u{1}".repeat(4 * 1024 * 1024),
                "truncated": false,
                "sizeBytes": 4 * 1024 * 1024,
            },
            "previewLimitBytes": 6 * 1024 * 1024,
            "timing": { "totalMs": 5 },
        });
        fit_payload_to_transport(&mut payload);
        let serialized = serde_json::to_vec(&payload).unwrap();
        assert!(
            serialized.len() <= TRANSPORT_MESSAGE_BUDGET,
            "serialized payload is {} bytes, budget {}",
            serialized.len(),
            TRANSPORT_MESSAGE_BUDGET
        );
        let body = payload["body"].as_object().unwrap();
        assert_eq!(body["truncated"], serde_json::Value::Bool(true));
        // sizeBytes follows the delivered preview, so the truncation notice
        // never quotes bytes the user did not receive.
        assert_eq!(body["sizeBytes"], body["text"].as_str().unwrap().len());
        assert!(body["text"].as_str().unwrap().len() < 4 * 1024 * 1024);
    }

    #[test]
    fn response_payload_that_fits_is_untouched() {
        let mut payload = serde_json::json!({
            "body": { "text": "hello", "sizeBytes": 5, "truncated": false },
            "previewLimitBytes": 1024,
        });
        fit_payload_to_transport(&mut payload);
        assert_eq!(payload["body"]["text"], "hello");
        assert_eq!(payload["body"]["sizeBytes"], 5);
        assert_eq!(payload["body"]["truncated"], serde_json::Value::Bool(false));
    }
}
