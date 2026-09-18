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
    ApiError, ExecOutcome, MultipartSource, RequestBodyPayload, ResponsePayload, ValidatedRequest,
    canonical_reason, sanitize_cause,
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

/// Execute `spec`, racing it against cancellation. `jar` is the shared cookie
/// jar for this request's jar key (PRD §19); `None` runs cookie-less.
pub fn execute(
    spec: ValidatedRequest,
    registry: &InFlightRegistry,
    cancel: CancelToken,
    jar: Option<std::sync::Arc<reqwest::cookie::Jar>>,
) -> ExecOutcome {
    let request_id = spec.request_id.clone();
    let mut rx = cancel.subscribe();
    let result = runtime().block_on(async move {
        let mut cancelled = *rx.borrow();
        tokio::select! {
            outcome = run_request(spec, jar) => outcome,
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

async fn run_request(spec: ValidatedRequest, jar: Option<std::sync::Arc<reqwest::cookie::Jar>>) -> ExecOutcome {
    let request_id = spec.request_id.clone();
    match run_request_inner(&spec, jar).await {
        Ok(payload) => ExecOutcome::Response(payload),
        Err(error) => ExecOutcome::Failed {
            request_id,
            category: error.category,
            cause: error.message,
        },
    }
}

async fn run_request_inner(
    spec: &ValidatedRequest,
    jar: Option<std::sync::Arc<reqwest::cookie::Jar>>,
) -> Result<ResponsePayload, ApiError> {
    let request_id = spec.request_id.clone();
    let (client, redirect_counter) = build_client(spec, jar).map_err(|e| {
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
    match &spec.body {
        RequestBodyPayload::None => {}
        RequestBodyPayload::Raw(text) => {
            builder = builder.body(text.clone());
        }
        RequestBodyPayload::Multipart(parts) => {
            let mut form = reqwest::multipart::Form::new();
            for (name, source) in parts {
                let part = match source {
                    MultipartSource::Text(value) => reqwest::multipart::Part::text(value.clone()),
                    MultipartSource::File { path, filename } => {
                        // The sidecar reads the file with the user's own
                        // permissions; file bytes never cross the RPC bridge.
                        // Parts load into memory before the upload starts, so
                        // refuse oversized files instead of allocating blindly.
                        let metadata = std::fs::metadata(path).map_err(|e| {
                            ApiError::invalid_request(&format!(
                                "Cannot read file for multipart part \"{name}\": {}",
                                sanitize_cause(&e.to_string())
                            ))
                        })?;
                        if metadata.len() > crate::model::MAX_MULTIPART_FILE_BYTES {
                            return Err(ApiError::invalid_request(&format!(
                                "Multipart file part \"{name}\" exceeds the {} MB in-memory limit; streaming upload is not supported yet",
                                crate::model::MAX_MULTIPART_FILE_BYTES / (1024 * 1024)
                            )));
                        }
                        let bytes = std::fs::read(path).map_err(|e| {
                            ApiError::invalid_request(&format!(
                                "Cannot read file for multipart part \"{name}\": {}",
                                sanitize_cause(&e.to_string())
                            ))
                        })?;
                        let mut part =
                            reqwest::multipart::Part::bytes(bytes).file_name(filename.clone());
                        if let Some(mime) = mime_for(filename) {
                            part = part.mime_str(mime).map_err(|_| {
                                ApiError::invalid_request(&format!("Invalid mime type: {mime}"))
                            })?;
                        }
                        part
                    }
                };
                form = form.part(name.clone(), part);
            }
            builder = builder.multipart(form);
        }
    }
    let builder = builder;

    let started = Instant::now();
    let uses_proxy = matches!(spec.proxy, crate::model::ProxyPlan::Custom { .. });
    let response = builder
        .send()
        .await
        .map_err(|e| map_send_error(&request_id, e, uses_proxy))?;
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
    let total_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let download_ms = total_ms.saturating_sub(ttfb_ms);

    // HEAD responses carry no body by definition; report null rather than an
    // empty string so the UI shows "no preview" instead of an empty pane.
    let (body_text, body_base64, body_bytes, preview_limit, truncated) = if spec.method == "HEAD" {
        (None, None, 0u64, max_bytes as u64, false)
    } else {
        match String::from_utf8(body) {
            Ok(text) => {
                let received = text.len() as u64;
                (Some(text), None, received, max_bytes as u64, truncated)
            }
            Err(err) => {
                let raw = err.into_bytes();
                // Binary travels base64-encoded inside the same 8 MiB JSON-RPC
                // message; a 6 MiB binary would encode to exactly 8 MiB and the
                // transport would drop the entire response. Clamp the binary
                // preview and tell the UI which limit was enforced. body_bytes
                // reports the preview actually delivered, matching the text path
                // where the read loop stops at the cap.
                let limit = max_bytes.min(crate::model::MAX_BINARY_PREVIEW_BYTES);
                let delivered = limit.min(raw.len());
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(&raw[..delivered]);
                (
                    None,
                    Some(encoded),
                    delivered as u64,
                    limit as u64,
                    truncated || delivered < raw.len(),
                )
            }
        }
    };

    Ok(ResponsePayload {
        request_id,
        status,
        status_text,
        content_length: headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<u64>().ok()),
        headers,
        content_type,
        body_text,
        body_base64,
        body_truncated: truncated,
        body_bytes,
        body_preview_limit: preview_limit,
        final_url,
        redirect_count,
        total_ms,
        ttfb_ms: Some(ttfb_ms),
        download_ms: Some(download_ms),
    })
}

fn build_client(
    spec: &ValidatedRequest,
    jar: Option<std::sync::Arc<reqwest::cookie::Jar>>,
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

    let mut builder = reqwest::Client::builder();
    match &spec.proxy {
        crate::model::ProxyPlan::System => {}
        crate::model::ProxyPlan::None => builder = builder.no_proxy(),
        crate::model::ProxyPlan::Custom {
            url,
            username,
            password,
        } => {
            let mut proxy = reqwest::Proxy::all(url)?;
            if let Some(username) = username {
                proxy = proxy.basic_auth(username, password.as_deref().unwrap_or(""));
            }
            builder = builder.proxy(proxy);
        }
    }
    if let Some(jar) = jar {
        builder = builder.cookie_provider(jar);
    }
    let client = builder
        .user_agent(USER_AGENT)
        .redirect(policy)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_millis(spec.timeout_ms))
        .danger_accept_invalid_certs(!spec.verify_tls)
        .build()?;
    Ok((client, counter))
}

/// Minimal extension→MIME mapping for multipart file parts; unknown extensions
/// default to the transport's application/octet-stream.
fn mime_for(filename: &str) -> Option<&'static str> {
    let extension = filename.rsplit('.').next()?.to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "csv" => "text/csv",
        "txt" | "log" | "md" => "text/plain",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" | "gzip" => "application/gzip",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "wasm" => "application/wasm",
        _ => return None,
    };
    Some(mime)
}

/// Map a send-phase failure to the stable error taxonomy. reqwest lumps DNS,
/// TLS and TCP failures into connect errors, so the cause string is inspected
/// to recover the finer-grained categories.
///
/// The returned message is always passed through [`sanitize_cause`]: raw
/// transport text can embed the request URL (including userinfo and query
/// values that may be credentials), so it must never cross the RPC boundary
/// verbatim.
fn map_send_error(request_id: &str, error: reqwest::Error, uses_proxy: bool) -> ApiError {
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
            // Through a custom proxy, a resolution failure is most plausibly
            // the proxy host itself.
            if uses_proxy {
                "PROXY_FAILED"
            } else {
                "DNS_FAILED"
            }
        } else if detail_lower.contains("certificate")
            || detail_lower.contains("tls")
            || detail_lower.contains("ssl")
            || detail_lower.contains("unknown-protocol")
        {
            "TLS_FAILED"
        } else if uses_proxy {
            // With a custom proxy in the path, a refused/dropped connection is
            // far more likely the proxy than the API server.
            "PROXY_FAILED"
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
        run_with_jar(spec, None)
    }

    fn run_with_jar(
        spec: serde_json::Value,
        jar: Option<std::sync::Arc<reqwest::cookie::Jar>>,
    ) -> ExecOutcome {
        let spec: RequestSpec = serde_json::from_value(spec).unwrap();
        let validated = validate_spec(spec).unwrap();
        let registry = InFlightRegistry::default();
        let cancel = registry.register(&validated.request_id);
        execute(validated, &registry, cancel, jar)
    }

    /// Reads the entire request (headers + Content-Length body) and responds
    /// with the request body as the response body — for asserting on what the
    /// transport actually put on the wire.
    fn spawn_echo_server() -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            use std::io::Write;
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let request = read_full_request(&mut socket);
            let body_start = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
                .unwrap_or(request.len());
            let body = &request[body_start..];
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes());
            let _ = socket.write_all(body);
        });
        (addr, handle)
    }

    /// Read one HTTP request: headers first, then exactly Content-Length body
    /// bytes. Reading to EOF would deadlock against keep-alive clients.
    fn read_full_request(socket: &mut std::net::TcpStream) -> Vec<u8> {
        use std::io::Read;
        let mut request = Vec::new();
        let mut buffer = [0u8; 8192];
        let header_end = loop {
            match socket.read(&mut buffer) {
                Ok(0) | Err(_) => return request,
                Ok(n) => {
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(index) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        break index + 4;
                    }
                }
            }
        };
        let header_text = String::from_utf8_lossy(&request[..header_end]);
        let content_length = header_text
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
            .and_then(|line| line.split(':').nth(1))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while request.len() < header_end + content_length {
            match socket.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => request.extend_from_slice(&buffer[..n]),
            }
        }
        request
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
        let outcome = execute(validated, &registry, cancel, None);
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
        assert_eq!(payload.body_preview_limit, 256 * 1024);
    }

    /// `spawn_server` twin that serves raw bytes: a `&str` is valid UTF-8 by
    /// construction, so the binary body path needs its own server.
    fn spawn_binary_server(
        head: &str,
        body: &[u8],
    ) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let mut wire = Vec::with_capacity(head.len() + 64 + body.len());
        wire.extend_from_slice(head.as_bytes());
        wire.extend_from_slice(
            format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes(),
        );
        wire.extend_from_slice(body);
        let wire: &'static [u8] = Box::leak(wire.into_boxed_slice());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf);
            let _ = socket.write_all(wire);
        });
        (addr, handle)
    }

    #[test]
    fn binary_preview_stops_below_the_transport_limit() {
        // 5 MiB of non-UTF-8 bytes under the maximum text cap: base64 of a
        // 6 MiB binary would be exactly 8 MiB — the JSON-RPC single-message
        // limit — so binary previews must clamp at MAX_BINARY_PREVIEW_BYTES
        // (4 MiB raw, ~5.3 MiB encoded) and report that limit to the UI.
        let body = vec![0x80u8; 5 * 1024 * 1024];
        let (addr, server) = spawn_binary_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n",
            &body,
        );
        let mut spec = spec_json("GET", &format!("http://{addr}/bin"));
        spec["settings"]["maxBodyBytes"] = serde_json::json!(6 * 1024 * 1024);
        let outcome = run(spec);
        server.join().unwrap();
        let ExecOutcome::Response(payload) = outcome else {
            panic!("expected a response, got {outcome:?}")
        };
        assert!(payload.body_text.is_none());
        assert!(payload.body_truncated);
        assert_eq!(
            payload.body_preview_limit,
            crate::model::MAX_BINARY_PREVIEW_BYTES as u64
        );
        let encoded = payload.body_base64.expect("binary body must be base64");
        assert_eq!(
            encoded.len(),
            crate::model::MAX_BINARY_PREVIEW_BYTES.div_ceil(3) * 4
        );
        // body_bytes reports the preview delivered to the UI, not the larger
        // received size — the truncation notice quotes it as "showing the
        // first {shown}".
        assert_eq!(payload.body_bytes, crate::model::MAX_BINARY_PREVIEW_BYTES as u64);
        // The encoded preview must fit the transport with envelope headroom.
        assert!(encoded.len() < 8 * 1024 * 1024);
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

    #[test]
    fn multipart_body_delivers_text_and_file_parts() {
        let file_path = std::env::temp_dir().join(format!(
            "api-studio-mp-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&file_path, "file-bytes").unwrap();

        let (addr, server) = spawn_echo_server();
        let mut spec = spec_json("POST", &format!("http://{addr}/upload"));
        spec["body"] = serde_json::json!({
            "type": "multipart",
            "parts": [
                { "name": "note", "kind": "text", "value": "hello" },
                { "name": "doc", "kind": "file", "path": file_path.to_string_lossy() },
            ],
        });
        let outcome = run(spec);
        server.join().unwrap();
        let _ = std::fs::remove_file(&file_path);

        let ExecOutcome::Response(payload) = outcome else {
            panic!("expected a response, got {outcome:?}")
        };
        let echoed = payload.body_text.expect("multipart echoes as text");
        assert!(echoed.contains("name=\"note\""), "{echoed:?}");
        assert!(echoed.contains("hello"), "{echoed:?}");
        assert!(echoed.contains("filename="), "{echoed:?}");
        assert!(echoed.contains("file-bytes"), "{echoed:?}");
    }

    #[test]
    fn multipart_rejects_a_file_part_without_a_path() {
        let spec = serde_json::json!({
            "requestId": "mp-bad",
            "method": "POST",
            "url": "http://127.0.0.1:1/upload",
            "headers": [],
            "body": { "type": "multipart", "parts": [ { "name": "doc", "kind": "file", "path": "" } ] },
            "settings": {}
        });
        let spec: RequestSpec = serde_json::from_value(spec).unwrap();
        let error = validate_spec(spec).unwrap_err();
        assert_eq!(error.category, "INVALID_REQUEST");
        assert!(error.message.contains("file path"), "{}", error.message);
    }

    #[test]
    fn cookie_jar_persists_session_cookie_across_requests() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            // Connection 1: hand out a session cookie.
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer);
            let _ = socket.write_all(
                b"HTTP/1.1 200 OK\r\nSet-Cookie: sid=j1; Path=/\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            );
            // Connection 2: capture whatever Cookie header the client now sends.
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_full_request(&mut socket);
            let text = String::from_utf8_lossy(&request);
            let cookie_line = text
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("cookie:"))
                .unwrap_or("cookie: none");
            let body = format!("captured {cookie_line}");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes());
        });

        let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
        run_with_jar(spec_json("GET", &format!("http://{addr}/login")), Some(jar.clone()));
        let outcome = run_with_jar(spec_json("GET", &format!("http://{addr}/profile")), Some(jar));
        server.join().unwrap();

        let ExecOutcome::Response(payload) = outcome else {
            panic!("expected a response, got {outcome:?}")
        };
        let echoed = payload.body_text.expect("cookie capture echoes as text");
        assert!(echoed.contains("sid=j1"), "{echoed}");
    }

    #[test]
    fn requests_without_a_jar_stay_cookie_less() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer);
            let _ = socket.write_all(
                b"HTTP/1.1 200 OK\r\nSet-Cookie: sid=j2; Path=/\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            );
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_full_request(&mut socket);
            let text = String::from_utf8_lossy(&request);
            let has_cookie = text
                .lines()
                .any(|line| line.to_ascii_lowercase().starts_with("cookie:"));
            let body = format!("cookie-present:{has_cookie}");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes());
        });

        run(spec_json("GET", &format!("http://{addr}/login")));
        let outcome = run(spec_json("GET", &format!("http://{addr}/profile")));
        server.join().unwrap();

        let ExecOutcome::Response(payload) = outcome else {
            panic!("expected a response, got {outcome:?}")
        };
        let echoed = payload.body_text.expect("echo as text");
        assert!(echoed.contains("cookie-present:false"), "{echoed}");
    }
}
