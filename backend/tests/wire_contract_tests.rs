//! Wire-contract tests: the UI→JSON→Rust layer.
//!
//! `tools/ui-lib-test.mjs` runs `buildSendSpec()` (the real shipped fold) and
//! exports its spec JSON here (`tests/fixtures/wire_specs.json`). These tests
//! deserialize those specs with the same serde model the RPC entry uses and
//! assert the derived transport configuration.
//!
//! This layer exists because a whole feature (custom proxy) shipped with the
//! JS side emitting a top-level `spec.proxy` while this crate read
//! `settings.proxy`; serde ignored the unknown field silently, both sides'
//! unit tests stayed green, and proxy never took effect at runtime.

use dbx_plugin_api_studio::model::{validate_spec, ProxyPlan, RequestBodyPayload, RequestSpec};
use serde_json::Value;

const FIXTURES: &str = include_str!("fixtures/wire_specs.json");

fn wire_case(name: &str) -> (Value, Value) {
    let fixtures: Value = serde_json::from_str(FIXTURES).expect("wire fixture JSON must parse");
    for case in fixtures["cases"].as_array().expect("cases array") {
        if case["name"].as_str() == Some(name) {
            return (case["spec"].clone(), case["expect"].clone());
        }
    }
    panic!("wire case \"{name}\" missing — regenerate fixtures with `npm run test:ui` (tools/ui-lib-test.mjs)");
}

fn wire_validated(name: &str) -> (dbx_plugin_api_studio::model::ValidatedRequest, Value) {
    let (spec_json, expect) = wire_case(name);
    let spec: RequestSpec = serde_json::from_value(spec_json)
        .unwrap_or_else(|e| panic!("wire case \"{name}\" failed to deserialize: {e}"));
    (validate_spec(spec).expect("wire case must validate"), expect)
}

#[test]
fn custom_proxy_flows_from_the_ui_wire_to_the_transport() {
    let (validated, expect) = wire_validated("custom proxy");
    match &validated.proxy {
        ProxyPlan::Custom { url, username, .. } => {
            assert_eq!(url, &expect["proxy_url"].as_str().unwrap());
            assert_eq!(username.as_deref(), expect["proxy_user"].as_str());
        }
        other => panic!("expected a custom proxy plan, got {other:?}"),
    }
}

#[test]
fn proxy_none_flows_from_the_ui_wire_to_the_transport() {
    let (validated, _) = wire_validated("proxy none");
    assert!(matches!(validated.proxy, ProxyPlan::None), "{:?}", validated.proxy);
}

#[test]
fn proxy_system_is_the_default_plan() {
    let (validated, _) = wire_validated("system proxy default");
    assert!(matches!(validated.proxy, ProxyPlan::System), "{:?}", validated.proxy);
}

#[test]
fn multipart_body_and_dropped_content_type_survive_the_wire() {
    let (validated, expect) = wire_validated("multipart through the wire");
    let RequestBodyPayload::Multipart(parts) = &validated.body else {
        panic!("expected a multipart body, got {:?}", validated.body);
    };
    assert_eq!(parts.len(), expect["part_count"].as_u64().unwrap() as usize);
    assert!(
        !validated.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")),
        "the transport must own the multipart boundary; a user Content-Type survived the wire"
    );
}

#[test]
fn cookie_jar_key_survives_the_wire() {
    let (validated, expect) = wire_validated("jar key");
    assert_eq!(validated.jar_key.as_deref(), expect["jar_key"].as_str());
}
