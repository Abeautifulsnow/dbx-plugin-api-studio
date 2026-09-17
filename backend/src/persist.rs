//! Persistence for collections, environments, settings and redacted history.
//!
//! The `PersistenceAdapter` trait isolates storage so the plugin can migrate
//! to a verified DBX Host storage contract later without touching callers.
//! The current implementation is plugin-owned local files under the OS local
//! data directory (`data_local_dir()/dbx-plugin-api-studio/`), overridable via
//! `API_STUDIO_DATA_DIR` for tests and development. Secret values are never
//! persisted: the UI strips them, and `model::redact_history_entry` scrubs
//! sensitive headers again as defense in depth.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use crate::model::redact_history_entry;

pub const HISTORY_LIMIT: usize = 500;
const STATE_FILE: &str = "state.json";
const HISTORY_FILE: &str = "history.json";
/// JSON-RPC messages cap at 8 MiB; entries are redacted request definitions,
/// so anything near 64 KiB is already pathological.
pub const MAX_HISTORY_ENTRY_BYTES: usize = 64 * 1024;
const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;

pub trait PersistenceAdapter: Send + Sync {
    fn load_state(&self) -> io::Result<Option<Value>>;
    fn save_state(&self, state: &Value) -> io::Result<()>;
    fn load_history(&self) -> io::Result<Vec<Value>>;
    /// Append one entry, enforcing the redaction scrub and the 500-entry cap.
    /// Returns the number of evicted (oldest) entries.
    fn append_history(&self, entry: Value) -> io::Result<usize>;
    fn clear_history(&self) -> io::Result<()>;
}

pub struct FilePersistence {
    dir: PathBuf,
    guard: Mutex<()>,
}

impl FilePersistence {
    pub fn new() -> io::Result<Self> {
        let dir = storage_dir()?;
        fs::create_dir_all(&dir)?;
        Ok(Self { dir, guard: Mutex::new(()) })
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join(STATE_FILE)
    }

    fn history_path(&self) -> PathBuf {
        self.dir.join(HISTORY_FILE)
    }
}

pub fn storage_dir() -> io::Result<PathBuf> {
    if let Ok(dir) = std::env::var("API_STUDIO_DATA_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let base = dirs::data_local_dir().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "No local data directory available")
    })?;
    Ok(base.join("dbx-plugin-api-studio"))
}

fn write_atomic(path: &PathBuf, contents: &str) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)
}

fn read_json_file(path: &PathBuf) -> io::Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => {
            // A corrupt or partially written file must never brick startup;
            // treat it as missing so the UI re-seeds and the next save repairs.
            match serde_json::from_slice(&bytes) {
                Ok(value) => Ok(Some(value)),
                Err(_) => Ok(None),
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn read_history_file(path: &PathBuf) -> io::Result<Vec<Value>> {
    Ok(read_json_file(path)?
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default())
}

impl PersistenceAdapter for FilePersistence {
    fn load_state(&self) -> io::Result<Option<Value>> {
        let _guard = self.guard.lock().expect("persistence lock poisoned");
        read_json_file(&self.state_path())
    }

    fn save_state(&self, state: &Value) -> io::Result<()> {
        let serialized = serde_json::to_string(state)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        if serialized.len() > MAX_STATE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "State exceeds the 4 MiB storage limit",
            ));
        }
        let _guard = self.guard.lock().expect("persistence lock poisoned");
        write_atomic(&self.state_path(), &serialized)
    }

    fn load_history(&self) -> io::Result<Vec<Value>> {
        let _guard = self.guard.lock().expect("persistence lock poisoned");
        read_history_file(&self.history_path())
    }

    fn append_history(&self, mut entry: Value) -> io::Result<usize> {
        {
            let bytes = serde_json::to_vec(&entry)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            if bytes.len() > MAX_HISTORY_ENTRY_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "History entry exceeds the 64 KiB limit",
                ));
            }
        }
        redact_history_entry(&mut entry);

        let _guard = self.guard.lock().expect("persistence lock poisoned");
        let mut history = read_history_file(&self.history_path())?;
        history.push(entry);
        let evicted = history.len().saturating_sub(HISTORY_LIMIT);
        if evicted > 0 {
            history.drain(0..evicted);
        }
        let serialized = serde_json::to_string(&history)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        write_atomic(&self.history_path(), &serialized)?;
        Ok(evicted)
    }

    fn clear_history(&self) -> io::Result<()> {
        let _guard = self.guard.lock().expect("persistence lock poisoned");
        write_atomic(&self.history_path(), "[]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "api-studio-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn persistence(tag: &str) -> FilePersistence {
        let dir = temp_dir(tag);
        FilePersistence {
            dir,
            guard: Mutex::new(()),
        }
    }

    #[test]
    fn state_roundtrip_and_missing_default() {
        let store = persistence("state");
        assert_eq!(store.load_state().unwrap(), None);
        store
            .save_state(&json!({ "collections": [1, 2, 3] }))
            .unwrap();
        assert_eq!(
            store.load_state().unwrap(),
            Some(json!({ "collections": [1, 2, 3] }))
        );
    }

    #[test]
    fn corrupt_state_reads_as_missing() {
        let store = persistence("corrupt");
        fs::write(store.dir.join(STATE_FILE), "{ not json").unwrap();
        assert_eq!(store.load_state().unwrap(), None);
    }

    #[test]
    fn history_cap_keeps_newest_500() {
        let store = persistence("cap");
        for index in 0..505 {
            let evicted = store
                .append_history(json!({ "id": index }))
                .unwrap();
            if index < 500 {
                assert_eq!(evicted, 0);
            } else {
                assert_eq!(evicted, 1);
            }
        }
        let history = store.load_history().unwrap();
        assert_eq!(history.len(), 500);
        assert_eq!(history[0]["id"], 5);
        assert_eq!(history[499]["id"], 504);
    }

    #[test]
    fn history_append_redacts_sensitive_headers() {
        let store = persistence("redact");
        store
            .append_history(json!({
                "id": "h1",
                "request": {
                    "method": "GET",
                    "headers": [
                        { "name": "Authorization", "value": "Bearer sekrit" },
                        { "name": "X-Custom", "value": "keep" }
                    ]
                }
            }))
            .unwrap();
        let history = store.load_history().unwrap();
        let headers = history[0]["request"]["headers"].as_array().unwrap();
        assert_eq!(headers[0]["value"], "[REDACTED]");
        assert_eq!(headers[1]["value"], "keep");
    }

    #[test]
    fn oversized_history_entry_rejected() {
        let store = persistence("oversize");
        let result = store.append_history(json!({
            "id": "h1",
            "padding": "x".repeat(MAX_HISTORY_ENTRY_BYTES + 1)
        }));
        assert!(result.is_err());
        assert!(store.load_history().unwrap().is_empty());
    }

    #[test]
    fn clear_history_empties_file() {
        let store = persistence("clear");
        store.append_history(json!({ "id": "h1" })).unwrap();
        store.clear_history().unwrap();
        assert!(store.load_history().unwrap().is_empty());
    }

    #[test]
    fn storage_dir_env_override() {
        let dir = temp_dir("env");
        // SAFETY: tests run single-threaded with respect to this env var; the
        // integration suite does not read storage_dir concurrently.
        std::env::set_var("API_STUDIO_DATA_DIR", &dir);
        assert_eq!(storage_dir().unwrap(), dir);
        std::env::remove_var("API_STUDIO_DATA_DIR");
    }
}
