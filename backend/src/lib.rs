//! Library facade so integration tests (`tests/`) can exercise the same
//! modules the binary uses. The sidecar entry point lives in `main.rs`; the
//! protocol contract is covered by `tests/wire_contract_tests.rs`, which pins
//! the UI→JSON→Rust layer where per-side unit tests cannot see mismatches.

pub mod curl;
pub mod exec;
pub mod model;
pub mod persist;
