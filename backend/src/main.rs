//! DBX API Studio sidecar: protocol glue + RPC dispatch.
//!
//! stdout carries JSON-RPC only (enforced by the SDK). Nothing in this plugin
//! writes request/response content to stderr either — logs are limited to
//! non-sensitive lifecycle lines, keeping secrets out of diagnostics.

mod curl;
mod exec;
mod model;
mod persist;

use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};

use crate::exec::InFlightRegistry;
use crate::model::{ApiError, ExecOutcome};
use crate::persist::{FilePersistence, PersistenceAdapter};

/// Must equal manifest.json `id`; asserted against the manifest by the test
/// below because a mismatch makes the host terminate the sidecar at handshake.
const PLUGIN_ID: &str = "io.dbx.api-studio";

struct Plugin {
    registry: InFlightRegistry,
    storage: Option<FilePersistence>,
}

impl Plugin {
    fn storage(&self) -> Result<&FilePersistence, PluginError> {
        self.storage.as_ref().ok_or_else(|| {
            PluginError::new(-32000, "Local storage is unavailable on this machine")
        })
    }
}

fn api_error(error: ApiError) -> PluginError {
    let mut plugin_error = PluginError::new(error.code, error.message);
    plugin_error.data = Some(json!({
        "category": error.category,
        "requestId": error.request_id,
    }));
    plugin_error
}

fn io_error(error: std::io::Error) -> PluginError {
    PluginError::new(-32000, format!("Persistence failure: {error}"))
}

impl PluginHandler for Plugin {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        mut params: Value,
        _emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "api/request" => {
                let spec: model::RequestSpec = serde_json::from_value(params.clone())
                    .map_err(|e| PluginError::new(-32602, format!("Invalid request: {e}")))?;
                let validated = model::validate_spec(spec).map_err(api_error)?;
                let cancel = self.registry.register(&validated.request_id);
                match exec::execute(validated, &self.registry, cancel) {
                    ExecOutcome::Response(payload) => Ok(response_json(payload)),
                    ExecOutcome::Cancelled { request_id } => Ok(json!({
                        "requestId": request_id,
                        "cancelled": true,
                        "category": "REQUEST_CANCELLED"
                    })),
                    ExecOutcome::Failed { request_id, category, cause } => {
                        Err(api_error(ApiError::transport(&category, cause).with_request_id(&request_id)))
                    }
                }
            }
            "api/cancel" => {
                let request_id = params
                    .get("requestId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| PluginError::new(-32602, "Missing requestId"))?
                    .to_string();
                let cancelled = self.registry.cancel(&request_id);
                Ok(json!({ "requestId": request_id, "cancelled": cancelled }))
            }
            "api/export-curl" => {
                let spec = params.take();
                curl::export(spec).map_err(api_error).map(|command| json!({ "curl": command }))
            }
            "api/persistence/load" => {
                let storage = self.storage()?;
                let state = storage.load_state().map_err(io_error)?;
                let history = storage.load_history().map_err(io_error)?;
                Ok(json!({ "state": state, "history": history }))
            }
            "api/persistence/save" => {
                let mut state = params
                    .get("state")
                    .cloned()
                    .ok_or_else(|| PluginError::new(-32602, "Missing state"))?;
                // Defense in depth: never write a credential even if a client
                // sends one (see model::redact_state_payload).
                model::redact_state_payload(&mut state);
                self.storage()?.save_state(&state).map_err(io_error)?;
                Ok(json!({ "saved": true }))
            }
            "api/persistence/history-append" => {
                let entry = params
                    .get("entry")
                    .cloned()
                    .ok_or_else(|| PluginError::new(-32602, "Missing entry"))?;
                let evicted = self.storage()?.append_history(entry).map_err(io_error)?;
                Ok(json!({ "evicted": evicted }))
            }
            "api/persistence/history-clear" => {
                self.storage()?.clear_history().map_err(io_error)?;
                Ok(json!({ "cleared": true }))
            }
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

fn response_json(payload: model::ResponsePayload) -> Value {
    let model::ResponsePayload {
        request_id,
        status,
        status_text,
        headers,
        content_type,
        body_text,
        body_base64,
        body_truncated,
        body_bytes,
        body_preview_limit,
        final_url,
        redirect_count,
        total_ms,
        ttfb_ms,
        download_ms,
    } = payload;
    json!({
        "requestId": request_id,
        "status": status,
        "statusText": status_text,
        "headers": headers.into_iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect::<Vec<_>>(),
        "contentType": content_type,
        "body": {
            "text": body_text,
            "base64": body_base64,
            "truncated": body_truncated,
            "sizeBytes": body_bytes
        },
        "previewLimitBytes": body_preview_limit,
        "finalUrl": final_url,
        "redirectCount": redirect_count,
        "timing": {
            "totalMs": total_ms,
            "ttfbMs": ttfb_ms,
            "downloadMs": download_ms
        }
    })
}

fn main() -> std::io::Result<()> {
    let storage = match FilePersistence::new() {
        Ok(storage) => Some(storage),
        Err(error) => {
            // Storage being unavailable must not stop request execution; the
            // persistence methods report a structured error to the UI instead.
            eprintln!("api-studio: local storage unavailable: {error}");
            None
        }
    };
    let plugin = Plugin {
        registry: InFlightRegistry::default(),
        storage,
    };
    let metadata = PluginMetadata::new(PLUGIN_ID, env!("CARGO_PKG_VERSION"));
    PluginServer::new(metadata, plugin).serve()
}

#[cfg(test)]
mod tests {
    /// The `plugin/initialize` response must echo the manifest identity or the
    /// host kills the sidecar ("Sidecar identity or protocol does not match
    /// manifest"). The version lives in Cargo.toml while the manifest is a
    /// separate file, so a release bump that touches only one of them breaks
    /// startup at runtime — pin them together here.
    #[test]
    fn sidecar_identity_matches_manifest() {
        let manifest_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../manifest.json");
        let manifest = std::fs::read_to_string(manifest_path)
            .expect("manifest.json must be readable next to the backend crate");
        let manifest: serde_json::Value = serde_json::from_str(&manifest)
            .expect("manifest.json must be valid JSON");
        assert_eq!(
            manifest["id"].as_str(),
            Some(super::PLUGIN_ID),
            "manifest id and the sidecar's PLUGIN_ID diverged"
        );
        assert_eq!(
            manifest["version"].as_str(),
            Some(env!("CARGO_PKG_VERSION")),
            "manifest version and Cargo.toml version diverged — bump both together"
        );
    }
}
