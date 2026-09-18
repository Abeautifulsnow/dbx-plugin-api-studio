//! `api/export-curl`: produce a POSIX-shell cURL command from a resolved,
//! secret-masked request. The UI resolves normal variables and substitutes
//! secret references back to `{{name}}` placeholders before calling, so the
//! clipboard output never carries live credentials.
//!
//! `api/import-curl` goes the other way: a shell-word tokenizer recovers the
//! arguments of a pasted cURL command (quotes, escapes and line continuations
//! included) and the recognized flags map back onto the editor's request model.

use crate::model::{ApiError, MultipartPart, RequestSpec, ValidatedRequest, validate_spec};
use base64::Engine;
use serde_json::{Value, json};

/// Escape for POSIX single quotes: '…' with inner quotes replayed as '\''.
fn shell_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

pub fn export(spec_value: serde_json::Value) -> Result<String, crate::model::ApiError> {
    let spec: RequestSpec = serde_json::from_value(spec_value)
        .map_err(|e| crate::model::ApiError::invalid_request(&format!("Invalid request: {e}")))?;
    // Reuse transport validation so exported commands cannot contain header
    // injection or unsupported methods even when the UI is misbehaving.
    let validated: ValidatedRequest = validate_spec(spec)?;

    let mut parts: Vec<String> = vec!["curl".to_string()];
    parts.push("--request".to_string());
    parts.push(shell_quote(&validated.method));
    parts.push(shell_quote(validated.url.as_str()));

    for (name, value) in &validated.headers {
        parts.push("--header".to_string());
        parts.push(shell_quote(&format!("{name}: {value}")));
    }

    match &validated.body {
        crate::model::RequestBodyPayload::None => {}
        crate::model::RequestBodyPayload::Raw(text) => {
            parts.push("--data-raw".to_string());
            parts.push(shell_quote(text));
        }
        crate::model::RequestBodyPayload::Multipart(form_parts) => {
            for (name, source) in form_parts {
                match &source {
                    crate::model::MultipartSource::Text(value) => {
                        parts.push("--form".to_string());
                        parts.push(shell_quote(&format!("{name}={value}")));
                    }
                    crate::model::MultipartSource::File { path, .. } => {
                        parts.push("--form".to_string());
                        parts.push(shell_quote(&format!("{name}=@{path}")));
                    }
                }
            }
        }
    }

    if validated.follow_redirects {
        parts.push("--location".to_string());
        if validated.max_redirects != 10 {
            parts.push("--max-redirs".to_string());
            parts.push(validated.max_redirects.to_string());
        }
    }

    parts.push("--max-time".to_string());
    parts.push(format!("{}", validated.timeout_ms.div_ceil(1000)));

    if !validated.verify_tls {
        parts.push("--insecure".to_string());
    }

    // "Copy as cURL reproduces the request" — that includes the transport
    // route, so a custom proxy must appear in the command.
    match &validated.proxy {
        // curl requires an argument here; `*` disables proxying for all hosts.
        crate::model::ProxyPlan::None => {
            parts.push("--noproxy".to_string());
            parts.push(shell_quote("*"));
        }
        crate::model::ProxyPlan::Custom {
            url,
            username: Some(username),
            password,
        } => {
            parts.push("--proxy".to_string());
            parts.push(shell_quote(url));
            parts.push("--proxy-user".to_string());
            parts.push(shell_quote(&format!(
                "{}:{}",
                username,
                password.as_deref().unwrap_or("")
            )));
        }
        crate::model::ProxyPlan::Custom { url, .. } => {
            parts.push("--proxy".to_string());
            parts.push(shell_quote(url));
        }
        crate::model::ProxyPlan::System => {}
    }

    Ok(parts.join(" "))
}

/* ------------------------------------------------------------ cURL import */

/// Split a pasted shell line into words: POSIX quotes, backslash escapes and
/// backslash-newline continuations are resolved; `#` starts a comment.
fn tokenize(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut has_word = false;
    let mut chars = input.chars().peekable();

    while let Some(character) = chars.next() {
        match character {
            '\'' => {
                has_word = true;
                while let Some(inner) = chars.next() {
                    if inner == '\'' {
                        // The `'\''` idiom: a closing quote, an escaped quote,
                        // and a reopening quote — all one literal quote.
                        if chars.peek().copied() == Some('\'') {
                            chars.next();
                            current.push('\'');
                        } else {
                            break;
                        }
                    } else {
                        current.push(inner);
                    }
                }
            }
            '"' => {
                has_word = true;
                while let Some(inner) = chars.next() {
                    match inner {
                        '"' => break,
                        '\\' => match chars.peek().copied() {
                            Some(escaped @ ('"' | '\\' | '$' | '`')) => {
                                chars.next();
                                current.push(escaped);
                            }
                            _ => current.push('\\'),
                        },
                        _ => current.push(inner),
                    }
                }
            }
            '\\' => match chars.next() {
                Some('\n') => {}
                Some(escaped) => {
                    has_word = true;
                    current.push(escaped);
                }
                None => {}
            },
            '\n' => {
                if has_word {
                    words.push(std::mem::take(&mut current));
                    has_word = false;
                }
            }
            '#' if !has_word => {
                for inner in chars.by_ref() {
                    if inner == '\n' {
                        break;
                    }
                }
            }
            space if space.is_whitespace() => {
                if has_word {
                    words.push(std::mem::take(&mut current));
                    has_word = false;
                }
            }
            other => {
                has_word = true;
                current.push(other);
            }
        }
    }
    if has_word {
        words.push(current);
    }
    words
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = bytes.get(index + 1..index + 3);
                match hex.and_then(|hex| {
                    std::str::from_utf8(hex)
                        .ok()
                        .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                }) {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

enum AuthKind {
    Bearer(String),
    Basic {
        username: String,
        password: String,
    },
}

/// Recover an editor request from a pasted cURL command. Only the flags that
/// map onto the v0.1 request model are interpreted; anything else is collected
/// as a warning instead of failing the import.
pub fn parse_import(input: &str) -> Result<Value, ApiError> {
    let words = tokenize(input);
    let mut args: &[String] = words.as_slice();
    // Drop leading shell noise and the program name: `$`, a prompt suffix, and
    // `curl` (or a path to it) may each appear.
    while args.len() > 1 {
        let first = args[0].as_str();
        let base = first.rsplit(['/', '\\']).next().unwrap_or(first);
        if base == "$" || base.to_ascii_lowercase().starts_with("curl") {
            args = &args[1..];
        } else {
            break;
        }
    }

    let mut method: Option<String> = None;
    let mut url: Option<String> = None;
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut data_parts: Vec<String> = Vec::new();
    let mut urlencode_rows: Vec<(String, String)> = Vec::new();
    let mut has_urlencode = false;
    let mut form_parts: Vec<MultipartPart> = Vec::new();
    let mut auth: Option<AuthKind> = None;
    let mut verify_tls: Option<bool> = None;
    let mut follow_redirects: Option<bool> = None;
    let mut timeout_ms: Option<u64> = None;
    let mut force_get = false;
    let mut ignored: Vec<String> = Vec::new();

    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let value = || args.get(index + 1).map(|value| value.as_str());
        match arg {
            "-X" | "--request" => {
                if let Some(value) = value() {
                    method = Some(value.to_ascii_uppercase());
                    index += 1;
                }
            }
            "-I" | "--head" => method = Some("HEAD".to_string()),
            "--url" => {
                if let Some(value) = value() {
                    url = url.take().or_else(|| Some(value.to_string()));
                    index += 1;
                }
            }
            "-H" | "--header" => {
                if let Some(value) = value() {
                    index += 1;
                    if let Some((name, header_value)) = value.split_once(':') {
                        let name = name.trim();
                        if !name.is_empty() {
                            headers.push((name.to_string(), header_value.trim().to_string()));
                        }
                    }
                }
            }
            "-d" | "--data" | "--data-raw" | "--data-ascii" | "--data-binary" => {
                if let Some(value) = value() {
                    index += 1;
                    // --data-raw is literal by definition, but --data-binary
                    // @file would read a (binary) file — the body model has no
                    // binary body yet, so warn instead of silently importing
                    // the literal path as text.
                    if arg == "--data-binary" && value.starts_with('@') {
                        ignored
                            .push("--data-binary @file is not supported yet".to_string());
                    } else {
                        data_parts.push(value.to_string());
                    }
                }
            }
            "--data-urlencode" => {
                if let Some(value) = value() {
                    index += 1;
                    has_urlencode = true;
                    if let Some((name, encoded)) = value.split_once('=') {
                        urlencode_rows.push((name.to_string(), percent_decode(encoded)));
                    } else {
                        data_parts.push(value.to_string());
                    }
                }
            }
            "-F" | "--form" => {
                if let Some(value) = value() {
                    index += 1;
                    if let Some((name, part_value)) = value.split_once('=') {
                        if let Some(path) = part_value.strip_prefix('@') {
                            form_parts.push(MultipartPart {
                                name: name.to_string(),
                                kind: "file".to_string(),
                                value: String::new(),
                                path: path.split(';').next().unwrap_or(path).to_string(),
                            });
                        } else {
                            form_parts.push(MultipartPart {
                                name: name.to_string(),
                                kind: "text".to_string(),
                                value: part_value.to_string(),
                                path: String::new(),
                            });
                        }
                    }
                }
            }
            "--form-string" => {
                if let Some(value) = value() {
                    index += 1;
                    if let Some((name, part_value)) = value.split_once('=') {
                        form_parts.push(MultipartPart {
                            name: name.to_string(),
                            kind: "text".to_string(),
                            value: part_value.to_string(),
                            path: String::new(),
                        });
                    }
                }
            }
            "-u" | "--user" => {
                if let Some(value) = value() {
                    index += 1;
                    let (username, password) = value.split_once(':').unwrap_or((value, ""));
                    auth = auth.or(Some(AuthKind::Basic {
                        username: username.to_string(),
                        password: password.to_string(),
                    }));
                }
            }
            "-b" | "--cookie" => {
                if let Some(value) = value() {
                    index += 1;
                    headers.push(("Cookie".to_string(), value.to_string()));
                }
            }
            "-A" | "--user-agent" => {
                if let Some(value) = value() {
                    index += 1;
                    headers.push(("User-Agent".to_string(), value.to_string()));
                }
            }
            "-e" | "--referer" => {
                if let Some(value) = value() {
                    index += 1;
                    headers.push(("Referer".to_string(), value.to_string()));
                }
            }
            "-k" | "--insecure" => verify_tls = Some(false),
            "-L" | "--location" => follow_redirects = Some(true),
            "--max-time" => {
                if let Some(value) = value() {
                    index += 1;
                    if let Ok(seconds) = value.trim().parse::<f64>() {
                        timeout_ms = Some((seconds * 1000.0).round() as u64);
                    }
                }
            }
            "-G" | "--get" => force_get = true,
            flag if flag.len() > 1 && flag.starts_with('-') => ignored.push(flag.to_string()),
            word => {
                if url.is_none() {
                    url = Some(word.to_string());
                }
            }
        }
        index += 1;
    }

    let Some(url) = url else {
        return Err(ApiError::invalid_request(
            "No URL found in the cURL command",
        ));
    };

    // An Authorization header folds into the auth model so the editor can
    // manage the credential (masked, session-only) instead of a raw header.
    // A Content-Type is *remembered* here but only removed later, once the
    // body model has actually consumed its semantics (see the remove step
    // after the body kind is decided); otherwise the header survives, so an
    // imported `application/xml` never degrades to the editor's default
    // text/plain.
    let mut content_type: Option<String> = None;
    for (name, value) in headers.iter() {
        if name.eq_ignore_ascii_case("content-type") {
            content_type = Some(value.clone());
        }
    }
    headers.retain(|(name, value)| {
        let lower = name.to_ascii_lowercase();
        if lower == "content-type" {
            return false;
        }
        if lower == "authorization" {
            if let Some(token) = value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
            {
                if auth.is_none() {
                    auth = Some(AuthKind::Bearer(token.trim().to_string()));
                }
                return false;
            }
            let encoded = value
                .strip_prefix("Basic ")
                .or_else(|| value.strip_prefix("basic "));
            if let Some(decoded) = encoded.and_then(|encoded| {
                base64::engine::general_purpose::STANDARD
                    .decode(encoded.trim())
                    .ok()
            }) {
                let decoded = String::from_utf8_lossy(&decoded).into_owned();
                let (username, password) =
                    decoded.split_once(':').unwrap_or((decoded.as_str(), ""));
                if auth.is_none() {
                    auth = Some(AuthKind::Basic {
                        username: username.to_string(),
                        password: password.to_string(),
                    });
                }
                return false;
            }
        }
        true
    });

    let mut url = url;
    let mut body_kind = "none";
    let mut body_text = String::new();
    let mut body_rows: Vec<(String, String)> = Vec::new();

    if !form_parts.is_empty() {
        body_kind = "multipart";
        if !data_parts.is_empty() {
            ignored.push("(--data combined with --form; data ignored)".to_string());
        }
    } else if force_get {
        // -G moves EVERY data option into the URL query — both `-d` and
        // `--data-urlencode` (whose rows are re-encoded here) — and leaves no
        // request body. An explicit -X still wins for the method string.
        let mut pieces: Vec<String> = Vec::new();
        if !data_parts.is_empty() {
            pieces.push(data_parts.join("&"));
        }
        if !urlencode_rows.is_empty() {
            pieces.push(serialize_urlencoded_pairs(&urlencode_rows));
        }
        let data = pieces.join("&");
        if !data.is_empty() {
            url = append_query(&url, &data);
        }
    } else if !data_parts.is_empty() || has_urlencode {
        // Plain `-d` posts urlencoded by default; an explicit JSON content
        // type keeps the body JSON instead. Anything else stays as a plain
        // text body (`text` — a type the editor knows), keeping the original
        // Content-Type header intact.
        let raw_text = data_parts.join("&");
        let is_json = content_type
            .as_deref()
            .map(|value| value.to_ascii_lowercase().contains("json"))
            .unwrap_or(false);
        if is_json {
            body_kind = "json";
            body_text = raw_text;
        } else {
            let rows = if has_urlencode {
                urlencode_rows
            } else {
                parse_urlencoded_pairs(&raw_text)
            };
            // Only represent the body as rows when they round-trip to the same
            // bytes; otherwise stay as plain text so no data is lost through
            // the editor.
            if !rows.is_empty() && serialize_urlencoded_pairs(&rows) == raw_text {
                body_kind = "urlencoded";
                body_text = raw_text;
                body_rows = rows;
            } else if has_urlencode && !rows.is_empty() {
                body_kind = "urlencoded";
                body_text = serialize_urlencoded_pairs(&rows);
                body_rows = rows;
            } else {
                body_kind = "text";
                body_text = raw_text;
            }
        }
    } else if has_urlencode {
        body_kind = "urlencoded";
    }

    // The Content-Type header was taken out of `headers` above; put it back
    // unless the body is multipart — the transport must own the multipart
    // boundary. json/urlencoded/text keep the ORIGINAL header: the editor only
    // adds a default when the header is absent, so custom types such as
    // `application/vnd.api+json` survive the import untouched.
    if body_kind != "multipart" {
        if let Some(original) = &content_type {
            headers.push(("Content-Type".to_string(), original.clone()));
        }
    }

    let method = method.unwrap_or_else(|| {
        if body_kind == "none" {
            "GET".to_string()
        } else {
            "POST".to_string()
        }
    });

    let mut settings = serde_json::Map::new();
    if let Some(value) = timeout_ms {
        settings.insert("timeoutMs".to_string(), Value::from(value));
    }
    if let Some(value) = follow_redirects {
        settings.insert("followRedirects".to_string(), Value::from(value));
    }
    if let Some(value) = verify_tls {
        settings.insert("verifyTls".to_string(), Value::from(value));
    }

    let auth_json = match auth {
        Some(AuthKind::Bearer(token)) => json!({ "type": "bearer", "token": token }),
        Some(AuthKind::Basic { username, password }) => {
            json!({ "type": "basic", "username": username, "password": password })
        }
        None => json!({ "type": "none" }),
    };

    let body_json = if body_kind == "multipart" {
        json!({
            "type": "multipart",
            "parts": form_parts.iter().map(|part| json!({
                "name": part.name, "kind": part.kind, "value": part.value, "path": part.path,
            })).collect::<Vec<_>>(),
        })
    } else if body_kind == "urlencoded" {
        json!({
            "type": "urlencoded",
            "text": body_text,
            "rows": body_rows.iter().map(|(key, value)| json!({ "key": key, "value": value })).collect::<Vec<_>>(),
        })
    } else if body_kind == "none" {
        json!({ "type": "none" })
    } else {
        json!({ "type": body_kind, "text": body_text })
    };

    Ok(json!({
        "request": {
            "method": method,
            "url": url,
            "headers": headers.iter().map(|(name, value)| json!({ "key": name, "value": value })).collect::<Vec<_>>(),
            "auth": auth_json,
            "body": body_json,
            "settings": settings,
        },
        "warnings": ignored,
    }))
}

fn append_query(url: &str, query: &str) -> String {
    // Decide the separator from the fragment-less base: a fragment may legally
    // contain "?" and must not make an existing-query URL out of one that only
    // has a fragment (mirrors the UI's appendQueryParam fix).
    let hash_index = url.find('#');
    let (base, hash) = match hash_index {
        Some(index) => (&url[..index], &url[index..]),
        None => (url, ""),
    };
    let separator = if base.contains('?') { "&" } else { "?" };
    format!("{base}{separator}{query}{hash}")
}

/// Best-effort decode of `a=1&b=2` style text into rows, so imported
/// urlencoded bodies keep their round-trip through the key/value editor.
fn parse_urlencoded_pairs(text: &str) -> Vec<(String, String)> {
    text.split('&')
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

fn serialize_urlencoded_pairs(rows: &[(String, String)]) -> String {
    rows.iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                encode_component(key),
                encode_component(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn export_json(value: serde_json::Value) -> String {
        export(value).unwrap()
    }

    fn import(curl: &str) -> serde_json::Value {
        parse_import(curl).unwrap()
    }

    #[test]
    fn basic_get_has_url_only() {
        let curl = export_json(json!({
            "requestId": "r1",
            "method": "GET",
            "url": "https://api.test/ping",
            "headers": [],
            "body": { "type": "none" },
            "settings": {}
        }));
        assert!(curl.contains("--request 'GET'"), "{curl}");
        assert!(curl.contains("'https://api.test/ping'"), "{curl}");
        assert!(!curl.contains("--data-raw"), "{curl}");
        assert!(!curl.contains("--insecure"), "{curl}");
    }

    #[test]
    fn quotes_single_quotes_in_values() {
        let curl = export_json(json!({
            "requestId": "r1",
            "method": "POST",
            "url": "https://api.test/x",
            "headers": [{ "name": "X-Note", "value": "it's fine" }],
            "body": { "type": "raw", "text": "{\"q\":\"O'Neill\"}" },
            "settings": {}
        }));
        assert!(curl.contains("X-Note: it'\\''s fine"), "{curl}");
        assert!(curl.contains("O'\\''Neill"), "{curl}");
    }

    #[test]
    fn reflects_tls_and_redirect_settings() {
        let curl = export_json(json!({
            "requestId": "r1",
            "method": "GET",
            "url": "https://api.test/x",
            "headers": [],
            "body": { "type": "none" },
            "settings": { "verifyTls": false, "followRedirects": true, "maxRedirects": 3, "timeoutMs": 2500 }
        }));
        assert!(curl.contains("--insecure"), "{curl}");
        assert!(curl.contains("--location"), "{curl}");
        assert!(curl.contains("--max-redirs 3"), "{curl}");
        assert!(curl.contains("--max-time 3"), "{curl}");
    }

    #[test]
    fn no_redirect_flag_when_disabled() {
        let curl = export_json(json!({
            "requestId": "r1",
            "method": "GET",
            "url": "https://api.test/x",
            "headers": [],
            "body": { "type": "none" },
            "settings": { "followRedirects": false }
        }));
        assert!(!curl.contains("--location"), "{curl}");
    }

    #[test]
    fn rejects_header_injection_even_from_ui() {
        let result = export(json!({
            "requestId": "r1",
            "method": "GET",
            "url": "https://api.test/x",
            "headers": [{ "name": "X-A", "value": "1\r\nX-Evil: 2" }],
            "body": { "type": "none" },
            "settings": {}
        }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_unsupported_method() {
        let result = export(json!({
            "requestId": "r1",
            "method": "TRACE",
            "url": "https://api.test/x",
            "headers": [],
            "body": { "type": "none" },
            "settings": {}
        }));
        assert!(result.is_err());
    }

    /* ------------------------------------------------------------ import */

    #[test]
    fn imports_multiline_post_with_headers_and_json_body() {
        let command = "$ curl -X POST 'https://api.test/v1/orders' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer sk-abc' \\\n  --data-raw '{\"item\":1}'";
        let imported = import(command);
        let request = &imported["request"];
        assert_eq!(request["method"], "POST");
        assert_eq!(request["url"], "https://api.test/v1/orders");
        assert_eq!(request["auth"]["type"], "bearer");
        assert_eq!(request["auth"]["token"], "sk-abc");
        // Authorization folds into the auth model; Content-Type survives — the
        // json body keeps its original header instead of a rebuilt default.
        let headers = request["headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1, "{headers:?}");
        assert_eq!(headers[0]["key"], "Content-Type");
        assert_eq!(headers[0]["value"], "application/json");
        assert_eq!(request["body"]["type"], "json");
        assert_eq!(request["body"]["text"], "{\"item\":1}");
    }

    #[test]
    fn imports_basic_auth_and_insecure_flag() {
        let imported = import("curl -k -u alice:s3cret https://api.test/x");
        let request = &imported["request"];
        assert_eq!(request["auth"]["type"], "basic");
        assert_eq!(request["auth"]["username"], "alice");
        assert_eq!(request["auth"]["password"], "s3cret");
        assert_eq!(request["settings"]["verifyTls"], false);
    }

    #[test]
    fn imports_multipart_form_with_file() {
        let command = "curl https://api.test/upload -F 'name=Alice' -F 'avatar=@/tmp/me.png;type=image/png'";
        let imported = import(command);
        let body = &imported["request"]["body"];
        assert_eq!(body["type"], "multipart");
        assert_eq!(body["parts"][0]["name"], "name");
        assert_eq!(body["parts"][0]["kind"], "text");
        assert_eq!(body["parts"][0]["value"], "Alice");
        assert_eq!(body["parts"][1]["kind"], "file");
        assert_eq!(body["parts"][1]["path"], "/tmp/me.png");
    }

    #[test]
    fn imports_get_with_data_moved_to_query() {
        let imported = import("curl -G 'https://api.test/search' -d 'q=rust' -d 'page=2'");
        let request = &imported["request"];
        assert_eq!(request["method"], "GET");
        assert_eq!(request["url"], "https://api.test/search?q=rust&page=2");
        assert_eq!(request["body"]["type"], "none");
    }

    #[test]
    fn imports_urlencoded_data_as_rows() {
        let imported = import("curl https://api.test/login -d 'user=alice&pass=secret%20x'");
        let body = &imported["request"]["body"];
        assert_eq!(body["type"], "urlencoded");
        assert_eq!(body["rows"][0]["key"], "user");
        assert_eq!(body["rows"][0]["value"], "alice");
        assert_eq!(body["rows"][1]["value"], "secret x");
        // text matches what the row editor would re-serialize.
        assert_eq!(body["text"], "user=alice&pass=secret%20x");
    }

    #[test]
    fn collects_unknown_flags_as_warnings_and_defaults_method() {
        // -sS/-v/--weird-flag carry nothing the request model can represent,
        // so they surface as warnings instead of failing the import.
        let imported = import("curl -sS -v https://api.test/x --weird-flag");
        assert_eq!(imported["request"]["method"], "GET");
        assert_eq!(imported["request"]["url"], "https://api.test/x");
        let warnings = imported["warnings"].as_array().unwrap();
        for flag in ["-sS", "-v", "--weird-flag"] {
            assert!(warnings.iter().any(|w| w == flag), "{warnings:?}");
        }
    }

    #[test]
    fn import_requires_a_url() {
        assert!(parse_import("curl -X POST -d 'x'").is_err());
    }

    #[test]
    fn import_handles_double_quoted_body_and_head() {
        let imported = import("curl -I --url 'https://api.test/x'");
        assert_eq!(imported["request"]["method"], "HEAD");
        assert_eq!(imported["request"]["url"], "https://api.test/x");
    }

    #[test]
    fn import_keeps_non_json_content_type_as_a_header() {
        // The body model only consumes json/urlencoded content types; anything
        // else must survive as a header or the imported request would silently
        // send text/plain instead of the original type.
        let imported = import(
            "curl https://x.test -H 'Content-Type: application/xml' -d '<hello />'",
        );
        let request = &imported["request"];
        assert_eq!(request["body"]["type"], "text");
        let headers = request["headers"].as_array().unwrap();
        assert!(
            headers.iter().any(|header| header["key"] == "Content-Type"
                && header["value"] == "application/xml"),
            "{headers:?}"
        );
    }

    #[test]
    fn import_get_with_data_honors_a_fragment_containing_a_question_mark() {
        let imported = import("curl -G 'https://x.test/users#docs?foo' -d 'a=1'");
        assert_eq!(imported["request"]["url"], "https://x.test/users?a=1#docs?foo");
    }

    #[test]
    fn get_moves_data_urlencode_into_the_query() {
        // -G + --data-urlencode: the decoded row is re-encoded into the URL
        // query and NO urlencoded body remains.
        let imported = import("curl -G --data-urlencode 'q=hello world' https://api.test/search");
        let request = &imported["request"];
        assert_eq!(request["method"], "GET");
        // %20 matches curl's own urlencoding of the query data.
        assert_eq!(request["url"], "https://api.test/search?q=hello%20world");
        assert_eq!(request["body"]["type"], "none");
    }

    #[test]
    fn get_joins_onto_an_existing_query_and_keeps_the_fragment() {
        let imported = import("curl -G 'https://x.test/?page=1#frag' -d 'a=1'");
        assert_eq!(imported["request"]["url"], "https://x.test/?page=1&a=1#frag");
    }

    #[test]
    fn get_with_an_explicit_method_keeps_that_method() {
        // curl's -X still names the request line even with -G; the data still
        // moves to the query.
        let imported = import("curl -G -X POST 'https://x.test/ups' -d 'a=1'");
        assert_eq!(imported["request"]["method"], "POST");
        assert_eq!(imported["request"]["url"], "https://x.test/ups?a=1");
        assert_eq!(imported["request"]["body"]["type"], "none");
    }

    #[test]
    fn data_binary_at_file_becomes_a_warning_not_a_literal_body() {
        let imported = import("curl --data-binary '@payload.bin' https://x.test/up");
        let warnings = imported["warnings"].as_array().unwrap();
        assert!(
            warnings.iter().any(|w| {
                w.as_str().is_some_and(|s| s.contains("--data-binary @file is not supported yet"))
            }),
            "{warnings:?}"
        );
        assert_ne!(imported["request"]["body"]["text"], "@payload.bin");
    }

    #[test]
    fn import_preserves_a_custom_json_content_type() {
        // json/urlencoded/text bodies keep the ORIGINAL content type header;
        // the editor only adds a default when the header is absent, so
        // vendor JSON types survive the import untouched.
        let imported = import(
            "curl https://api.test -H 'Content-Type: application/vnd.api+json' -d '{\"name\":\"A\"}'",
        );
        let request = &imported["request"];
        assert_eq!(request["body"]["type"], "json");
        let headers = request["headers"].as_array().unwrap();
        assert!(
            headers.iter().any(|header| header["key"] == "Content-Type"
                && header["value"] == "application/vnd.api+json"),
            "{headers:?}"
        );
    }

    #[test]
    fn import_still_strips_a_stale_content_type_for_multipart() {
        let imported = import(
            "curl https://x.test/up -H 'Content-Type: multipart/form-data; boundary=old' -F 'a=1'",
        );
        assert_eq!(imported["request"]["body"]["type"], "multipart");
        let headers = imported["request"]["headers"].as_array().unwrap();
        assert!(
            !headers.iter().any(|header| header["key"]
                .as_str()
                .unwrap_or("")
                .eq_ignore_ascii_case("content-type")),
            "{headers:?}"
        );
    }

    #[test]
    fn import_never_emits_a_raw_body_type() {
        // "raw" is a transport-side concept; the editor only knows
        // none/json/text/urlencoded/multipart.
        let imported = import("curl https://x.test -H 'Content-Type: application/octet-stream' -d 'binary-ish'");
        assert_eq!(imported["request"]["body"]["type"], "text");
    }

    #[test]
    fn import_keeps_the_declared_content_type_when_the_body_model_cannot_consume_it() {
        // Declared urlencoded but the body is not parseable as pairs: the body
        // becomes plain text, and the ORIGINAL content type must survive as a
        // header instead of degrading to the editor default (text/plain).
        let imported = import(
            "curl https://x.test -H 'Content-Type: application/x-www-form-urlencoded' -d 'this-is-not-a-key-value'",
        );
        let request = &imported["request"];
        assert_eq!(request["body"]["type"], "text");
        let headers = request["headers"].as_array().unwrap();
        assert!(
            headers.iter().any(|header| header["key"] == "Content-Type"
                && header["value"] == "application/x-www-form-urlencoded"),
            "{headers:?}"
        );
    }

    #[test]
    fn import_preserves_the_original_json_content_type() {
        // Plain application/json is kept as-is; the editor only supplies its
        // default when the header is absent.
        let imported = import(
            "curl https://x.test -H 'Content-Type: application/json' -d '{\"a\":1}'",
        );
        assert_eq!(imported["request"]["body"]["type"], "json");
        let headers = imported["request"]["headers"].as_array().unwrap();
        assert!(
            headers.iter().any(|header| header["key"] == "Content-Type"
                && header["value"] == "application/json"),
            "{headers:?}"
        );
    }

    #[test]
    fn export_includes_a_custom_proxy() {
        // "Copy as cURL reproduces the request" — the transport route included.
        let curl = export_json(json!({
            "requestId": "r1",
            "method": "GET",
            "url": "https://api.test/x",
            "headers": [],
            "body": { "type": "none" },
            "jarKey": null,
            "settings": { "proxy": { "mode": "custom", "url": "http://127.0.0.1:8080", "username": "u", "password": "it's" } }
        }));
        assert!(curl.contains("--proxy 'http://127.0.0.1:8080'"), "{curl}");
        assert!(curl.contains("--proxy-user 'u:it'\\''s'"), "{curl}");
    }

    #[test]
    fn export_flags_noproxy_when_disabled() {
        // --noproxy needs an argument; `*` disables proxying for all hosts.
        let curl = export_json(json!({
            "requestId": "r1",
            "method": "GET",
            "url": "https://api.test/x",
            "headers": [],
            "body": { "type": "none" },
            "jarKey": null,
            "settings": { "proxy": { "mode": "none" } }
        }));
        assert!(curl.contains("--noproxy '*'"), "{curl}");
    }

    #[test]
    fn export_keeps_proxy_auth_for_a_username_without_password() {
        // The transport sends an empty password in this case; the command must
        // reproduce that instead of silently dropping the credential.
        let curl = export_json(json!({
            "requestId": "r1",
            "method": "GET",
            "url": "https://api.test/x",
            "headers": [],
            "body": { "type": "none" },
            "jarKey": null,
            "settings": { "proxy": { "mode": "custom", "url": "http://127.0.0.1:8080", "username": "u", "password": "" } }
        }));
        assert!(curl.contains("--proxy-user 'u:'"), "{curl}");
    }
}
