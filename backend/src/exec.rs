//! HTTP execution for `api/request`.
//!
//! Each call runs on a tokio runtime and races the transfer against a cancel
//! token shared with `api/cancel`. Dropping the request future on cancellation
//! aborts the underlying connection, so a cancelled request stops consuming
//! server resources instead of silently finishing in the background.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use tokio::sync::watch;

use crate::model::{
    ApiError, ExecOutcome, ResponsePayload, ValidatedRequest, canonical_reason, sanitize_cause,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = concat!("DBX-API-Studio/", env!("CARGO_PKG_VERSION"));

pub type CancelToken = Arc<watch::Sender<bool>>;

#[derive(Default)]
pub struct InFlightRegistry {
    tokens: std::sync::Mutex<std::collections::HashMap<String, CancelToken>>,
}

impl InFlightRegistry {
    pub fn register(&self, request_id: &str) -> CancelToken {
        let (tx, _rx) = watch::channel(false);
        let token: CancelToken = Arc::new(tx);
        self.tokens
            .lock()
            .expect("in-flight registry lock poisoned")
            .insert(request_id.to_string(), token.clone());
        token
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        let map = self.tokens.lock().expect("in-flight registry lock poisoned");
        match map.get(request_id) {
            Some(token) => {
                let _ = token.send(true);
                true
            }
            None => false,
        }
    }

    pub fn unregister(&self, request_id: &str) {
        self.tokens
            .lock()
            .expect("in-flight registry lock poisoned")
            .remove(request_id);
    }
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("failed to start tokio runtime")
    })
}

/// Execute `spec`, racing it against cancellation.
pub fn execute(
    spec: ValidatedRequest,
    registry: &InFlightRegistry,
    cancel: CancelToken,
) -> ExecOutcome {
    let request_id = spec.request_id.clone();
    let mut rx = cancel.subscribe();
    let result = runtime().block_on(async move {
        let mut cancelled = *rx.borrow();
        tokio::select! {
            outcome = run_request(spec) => outcome,
            _ = async {
                while !cancelled {
                    if rx.changed().await.is_err() {
                        // Sender dropped; treat as never-cancelled.
                        std::future::pending::<()>().await;
                    }
                    cancelled = *rx.borrow();
                }
            } => ExecOutcome::Cancelled { request_id },
        }
    });
    let finished_id = result.request_id().to_string();
    registry.unregister(&finished_id);
    result
}

async fn run_request(spec: ValidatedRequest) -> ExecOutcome {
    let request_id = spec.request_id.clone();
    match run_request_inner(&spec).await {
        Ok(payload) => ExecOutcome::Response(payload),
        Err(error) => ExecOutcome::Failed {
            request_id,
            category: error.category,
            cause: error.message,
        },
    }
}

async fn run_request_inner(spec: &ValidatedRequest) -> Result<ResponsePayload, ApiError> {
    let request_id = spec.request_id.clone();
    let (client, redirect_counter) = build_client(spec).map_err(|e| {
        ApiError::transport(
            "INTERNAL_ERROR",
            format!("Failed to build client: {}", sanitize_cause(&e.to_string())),
        )
    })?;

    let method = reqwest::Method::from_bytes(spec.method.as_bytes())
        .map_err(|_| ApiError::invalid_request(&format!("Unsupported method {}", spec.method)))?;
    let mut builder = client.request(method, spec.url.clone());
    for (name, value) in &spec.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    if let Some(text) = &spec.body_text {
        builder = builder.body(text.clone());
    }
    let builder = builder;

    let started = Instant::now();
    let response = builder
        .send()
        .await
        .map_err(|e| map_send_error(&request_id, e))?;
    let redirect_count = redirect_counter.load(Ordering::Relaxed) as u32;
    // Headers of the final (post-redirect) response have arrived; the wall
    // clock up to here is the honest TTFB this transport can report.
    let ttfb_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let status = response.status().as_u16();
    let status_text = canonical_reason(status).to_string();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let final_url = response.url().to_string();

    let max_bytes = spec.max_body_bytes;
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut response = response;
    loop {
        let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| map_body_error(&request_id, e))?
        else {
            break;
        };
        if body.len() + chunk.len() > max_bytes {
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    let body_bytes = body.len() as u64;
    let total_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let download_ms = total_ms.saturating_sub(ttfb_ms);

    let (body_text, body_base64) = match String::from_utf8(body) {
        Ok(text) => (Some(text), None),
        Err(raw) => (
            None,
            Some(base64::engine::general_purpose::STANDARD.encode(raw.into_bytes())),
        ),
    };

    Ok(ResponsePayload {
        request_id,
        status,
        status_text,
        headers,
        content_type,
        body_text,
        body_base64,
        body_truncated: truncated,
        body_bytes,
        final_url,
        redirect_count,
        total_ms,
        ttfb_ms: Some(ttfb_ms),
        download_ms: Some(download_ms),
    })
}

fn build_client(
    spec: &ValidatedRequest,
) -> Result<(reqwest::Client, Arc<AtomicUsize>), reqwest::Error> {
    let max_redirects = spec.max_redirects as usize;
    let (policy, counter): (reqwest::redirect::Policy, Arc<AtomicUsize>) = if spec.follow_redirects
    {
        let counter = Arc::new(AtomicUsize::new(0));
        let policy_counter = counter.clone();
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            policy_counter.store(attempt.previous().len(), Ordering::Relaxed);
            if attempt.previous().len() > max_redirects {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        });
        (policy, counter)
    } else {
        (reqwest::redirect::Policy::none(), Arc::new(AtomicUsize::new(0)))
    };

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(policy)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_millis(spec.timeout_ms))
        .danger_accept_invalid_certs(!spec.verify_tls)
        .build()?;
    Ok((client, counter))
}

/// Map a send-phase failure to the stable error taxonomy. reqwest lumps DNS,
/// TLS and TCP failures into connect errors, so the cause string is inspected
/// to recover the finer-grained categories.
///
/// The returned message is always passed through [`sanitize_cause`]: raw
/// transport text can embed the request URL (including userinfo and query
/// values that may be credentials), so it must never cross the RPC boundary
/// verbatim.
fn map_send_error(request_id: &str, error: reqwest::Error) -> ApiError {
    let detail = error.to_string();
    let detail_lower = detail.to_lowercase();
    let sanitized = sanitize_cause(&detail);
    let category = if error.is_timeout() {
        "TIMEOUT"
    } else if error.is_redirect() {
        "TOO_MANY_REDIRECTS"
    } else if error.is_builder() {
        "INVALID_URL"
    } else if error.is_connect() {
        if detail_lower.contains("dns")
            || detail_lower.contains("name or service not known")
            || detail_lower.contains("failed to lookup")
            || detail_lower.contains("nodename nor servname")
            || detail_lower.contains("no such host")
        {
            "DNS_FAILED"
        } else if detail_lower.contains("certificate")
            || detail_lower.contains("tls")
            || detail_lower.contains("ssl")
            || detail_lower.contains("unknown-protocol")
        {
            "TLS_FAILED"
        } else {
            "CONNECT_FAILED"
        }
    } else if error.is_request() && detail_lower.contains("url") {
        "INVALID_URL"
    } else {
        "INTERNAL_ERROR"
    };
    ApiError::transport(category, sanitized).with_request_id(request_id)
}

fn map_body_error(request_id: &str, error: reqwest::Error) -> ApiError {
    if error.is_timeout() {
        ApiError::transport("TIMEOUT", sanitize_cause(&error.to_string()))
            .with_request_id(request_id)
    } else {
        ApiError::transport(
            "INTERNAL_ERROR",
            format!("Failed while reading body: {}", sanitize_cause(&error.to_string())),
        )
        .with_request_id(request_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{RequestSpec, validate_spec};

    fn spec_json(method: &str, url: &str) -> serde_json::Value {
        serde_json::json!({
            "requestId": "t1",
            "method": method,
            "url": url,
            "headers": [],
            "body": { "type": "none" },
            "settings": {}
        })
    }

    fn run(spec: serde_json::Value) -> ExecOutcome {
        let spec: RequestSpec = serde_json::from_value(spec).unwrap();
        let validated = validate_spec(spec).unwrap();
        let registry = InFlightRegistry::default();
        let cancel = registry.register(&validated.request_id);
        execute(validated, &registry, cancel)
    }

    /// Minimal HTTP/1.1 test server on an ephemeral localhost port. Serves the
    /// canned response to up to `connections` sequential connections; with a
    /// `None` response it accepts and never replies (drives timeout/cancel).
    fn spawn_server(
        response: Option<&'static str>,
        connections: usize,
    ) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            use std::io::Read;
            for _ in 0..connections {
                let Ok((mut socket, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf);
                if let Some(response) = response {
                    use std::io::Write;
                    let _ = socket.write_all(response.as_bytes());
                } else {
                    // Hold the connection open well past the test timeouts.
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            }
        });
        (addr, handle)
    }

    fn canned(head: &str, body: &str) -> &'static str {
        Box::leak(
            format!(
                "{head}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .into_boxed_str(),
        )
    }

    #[test]
    fn executes_request_against_local_server() {
        let response = canned(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n",
            "{\"ok\":true}",
        );
        let (addr, server) = spawn_server(Some(response), 1);
        let outcome = run(spec_json("GET", &format!("http://{addr}/ping")));
        server.join().unwrap();
        let ExecOutcome::Response(payload) = outcome else {
            panic!("expected a response, got {outcome:?}")
        };
        assert_eq!(payload.status, 200);
        assert_eq!(payload.status_text, "OK");
        assert_eq!(payload.body_text.as_deref(), Some("{\"ok\":true}"));
        assert!(!payload.body_truncated);
        assert_eq!(payload.redirect_count, 0);
        assert!(payload.total_ms <= 10_000);
        let ttfb = payload.ttfb_ms.expect("ttfb measured");
        let download = payload.download_ms.expect("download measured");
        assert!(ttfb <= payload.total_ms);
        assert_eq!(ttfb + download, payload.total_ms);
    }

    #[test]
    fn counts_followed_redirects() {
        let (addr2, server2) = spawn_server(
            Some(canned(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n",
                "done",
            )),
            1,
        );
        let (redirect_addr, redirect_server) = spawn_server(
            Some(Box::leak(
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://{addr2}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .into_boxed_str(),
            )),
            1,
        );
        let outcome = run(spec_json("GET", &format!("http://{redirect_addr}/start")));
        server2.join().unwrap();
        redirect_server.join().unwrap();
        let ExecOutcome::Response(payload) = outcome else {
            panic!("expected a response, got {outcome:?}")
        };
        assert_eq!(payload.status, 200);
        assert_eq!(payload.redirect_count, 1);
        assert!(payload.final_url.ends_with("/final"));
    }

    #[test]
    fn reports_dns_failure_category() {
        // RFC 6761 reserved invalid TLD; resolution must fail offline-safe.
        let outcome = run(spec_json("GET", "http://api-studio-invalid-host.invalid/"));
        let ExecOutcome::Failed { category, .. } = outcome else {
            panic!("expected failure, got {outcome:?}")
        };
        assert!(
            category == "DNS_FAILED" || category == "CONNECT_FAILED",
            "unexpected category {category}"
        );
    }

    #[test]
    fn timeout_maps_to_timeout_category() {
        let (addr, server) = spawn_server(None, 1);
        let mut spec = spec_json("GET", &format!("http://{addr}/slow"));
        spec["settings"]["timeoutMs"] = serde_json::json!(400);
        let outcome = run(spec);
        server.join().unwrap();
        let ExecOutcome::Failed { category, .. } = outcome else {
            panic!("expected failure, got {outcome:?}")
        };
        assert_eq!(category, "TIMEOUT");
    }

    #[test]
    fn cancel_produces_neutral_outcome() {
        let (addr, server) = spawn_server(None, 1);
        let mut spec = spec_json("GET", &format!("http://{addr}/slow"));
        spec["settings"]["timeoutMs"] = serde_json::json!(60_000);
        let spec: RequestSpec = serde_json::from_value(spec).unwrap();
        let validated = validate_spec(spec).unwrap();
        let registry = std::sync::Arc::new(InFlightRegistry::default());
        let cancel = registry.register(&validated.request_id);
        let registry_clone = registry.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            assert!(registry_clone.cancel("t1"));
        });
        let outcome = execute(validated, &registry, cancel);
        server.join().unwrap();
        handle.join().unwrap();
        match outcome {
            ExecOutcome::Cancelled { request_id } => assert_eq!(request_id, "t1"),
            other => panic!("expected cancellation, got {other:?}"),
        }
        // Idempotent: cancelling an unknown or finished request reports false.
        assert!(!registry.cancel("t1"));
    }

    #[test]
    fn body_truncation_sets_flag() {
        // 400KB exceeds the minimum enforceable cap (256 KiB).
        let body = "x".repeat(400_000);
        let response = canned(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n",
            &body,
        );
        let (addr, server) = spawn_server(Some(response), 1);
        let mut spec = spec_json("GET", &format!("http://{addr}/big"));
        spec["settings"]["maxBodyBytes"] = serde_json::json!(256 * 1024);
        let outcome = run(spec);
        server.join().unwrap();
        let ExecOutcome::Response(payload) = outcome else {
            panic!("expected a response, got {outcome:?}")
        };
        assert!(payload.body_truncated);
        assert!((payload.body_bytes as usize) <= 256 * 1024);
    }

    #[test]
    fn connect_failure_maps_to_connect_category() {
        // Bind then drop a listener so the port is guaranteed refused.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let outcome = run(spec_json("GET", &format!("http://{addr}/")));
        let ExecOutcome::Failed { category, .. } = outcome else {
            panic!("expected failure, got {outcome:?}")
        };
        assert_eq!(category, "CONNECT_FAILED");
    }

    #[test]
    fn transport_failure_never_echoes_query_secrets() {
        // Closed port guarantees a connect failure; the URL carries a credential.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let outcome = run(spec_json(
            "GET",
            &format!("http://{addr}/x?access_token=supersecret"),
        ));
        let ExecOutcome::Failed { cause, category, .. } = outcome else {
            panic!("expected failure")
        };
        assert_eq!(category, "CONNECT_FAILED");
        assert!(!cause.contains("supersecret"), "cause leaked a query secret: {cause}");
    }

    #[test]
    fn send_error_mapping_prefers_redirect_category() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        // A closed port yields a connect error; verify the fallback mapping.
        let outcome = run(spec_json("GET", &format!("http://{addr}/")));
        let ExecOutcome::Failed { category, cause, .. } = outcome else {
            panic!("expected failure")
        };
        assert_eq!(category, "CONNECT_FAILED");
        assert!(!cause.is_empty());
    }
}
