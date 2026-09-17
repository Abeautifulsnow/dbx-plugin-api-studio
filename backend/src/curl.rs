//! `api/export-curl`: produce a POSIX-shell cURL command from a resolved,
//! secret-masked request. The UI resolves normal variables and substitutes
//! secret references back to `{{name}}` placeholders before calling, so the
//! clipboard output never carries live credentials.

use crate::model::{RequestSpec, ValidatedRequest, validate_spec};

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

    if let Some(text) = &validated.body_text {
        parts.push("--data-raw".to_string());
        parts.push(shell_quote(text));
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

    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn export_json(value: serde_json::Value) -> String {
        export(value).unwrap()
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
}
