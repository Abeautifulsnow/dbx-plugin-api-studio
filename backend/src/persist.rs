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
use std::io::Write;
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
    /// Backup paths of files quarantined as corrupt during recent loads, then
    /// drained. Surfaced through `api/persistence/load` so the UI can tell the
    /// user their data was damaged instead of silently re-seeding.
    fn take_corrupted(&self) -> Vec<String>;
}

pub struct FilePersistence {
    dir: PathBuf,
    guard: Mutex<()>,
    corrupted: Mutex<Vec<String>>,
}

impl FilePersistence {
    pub fn new() -> io::Result<Self> {
        let dir = storage_dir()?;
        fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            guard: Mutex::new(()),
            corrupted: Mutex::new(Vec::new()),
        })
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join(STATE_FILE)
    }

    fn history_path(&self) -> PathBuf {
        self.dir.join(HISTORY_FILE)
    }

    /// A malformed file is never silently treated as missing data: the original
    /// is preserved under a `.corrupt-<timestamp>` sibling so the user keeps a
    /// recovery path, the fact is surfaced through `api/persistence/load`, and
    /// only then does the caller see "no data".
    fn quarantine_corrupt(&self, path: &PathBuf) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let mut backup = path.clone().into_os_string();
        backup.push(format!(".corrupt-{stamp}"));
        match fs::rename(path, &backup) {
            Ok(()) => {
                eprintln!(
                    "api-studio: corrupt {} preserved as {}",
                    path.display(),
                    backup.display()
                );
                if let Ok(mut notes) = self.corrupted.lock() {
                    notes.push(backup.display().to_string());
                }
            }
            Err(_) => {
                // Best effort only: keep the damaged file in place rather than
                // lose it; the next load will try again.
            }
        }
    }

    fn read_json_file(&self, path: &PathBuf) -> io::Result<Option<Value>> {
        match fs::read(path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(value) => Ok(Some(value)),
                Err(_) => {
                    self.quarantine_corrupt(path);
                    Ok(None)
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn read_history_file(&self, path: &PathBuf) -> io::Result<Vec<Value>> {
        Ok(self
            .read_json_file(path)?
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default())
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

/// Replace `path` with `contents` via temp file + rename.
///
/// `fs::rename` replaces an existing destination on every platform we ship
/// (Windows: MoveFileExW with MOVEFILE_REPLACE_EXISTING), so the swap itself is
/// atomic. The two real-world Windows failure modes are handled here: no fsync
/// before the rename (durability on power loss), and transient sharing
/// violations when antivirus/indexers hold the destination briefly.
fn write_atomic(path: &PathBuf, contents: &str) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
    }
    for attempt in 0..3 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(err) if attempt < 2 && is_transient_lock(&err) => {
                std::thread::sleep(std::time::Duration::from_millis(50 * (attempt as u64 + 1)));
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Windows sharing/lock violations surface as raw OS errors 32/33; some layers
/// report them as PermissionDenied. Only those are worth retrying.
fn is_transient_lock(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(32) | Some(33))
        || err.kind() == io::ErrorKind::PermissionDenied
}

impl PersistenceAdapter for FilePersistence {
    fn load_state(&self) -> io::Result<Option<Value>> {
        let _guard = self.guard.lock().expect("persistence lock poisoned");
        self.read_json_file(&self.state_path())
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
        self.read_history_file(&self.history_path())
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
        let mut history = self.read_history_file(&self.history_path())?;
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

    fn take_corrupted(&self) -> Vec<String> {
        self.corrupted
            .lock()
            .map(|mut notes| std::mem::take(&mut *notes))
            .unwrap_or_default()
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
            corrupted: Mutex::new(Vec::new()),
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
    fn corrupt_state_is_quarantined_with_a_recovery_copy() {
        // User data must never be silently discarded: the damaged file is kept
        // under a .corrupt-* sibling, the fact is reported through
        // take_corrupted (→ api/persistence/load → UI), and only then does the
        // store behave as if the data were missing.
        let store = persistence("quarantine");
        fs::write(store.dir.join(STATE_FILE), "{ not json").unwrap();
        assert_eq!(store.load_state().unwrap(), None);
        let preserved: Vec<String> = fs::read_dir(&store.dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(preserved.len(), 1, "the damaged file must be preserved");
        assert!(preserved[0].starts_with("state.json.corrupt-"));
        assert_eq!(store.take_corrupted().len(), 1);
        assert_eq!(store.take_corrupted().len(), 0, "notes drain on read");
        // The preserved copy still holds the original bytes for recovery.
        assert_eq!(
            fs::read_to_string(store.dir.join(&preserved[0])).unwrap(),
            "{ not json"
        );
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

    #[test]
    fn atomic_write_replaces_existing_file_repeatedly() {
        // Pins the behaviour the whole save path relies on: rename replaces an
        // existing destination (the "second save fails on Windows" concern),
        // and repeated writes leave no temp file behind.
        let dir = temp_dir("atomic");
        let path = dir.join("target.json");
        for contents in ["first", "second", "third"] {
            write_atomic(&path, contents).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
            assert!(!dir.join("target.tmp").exists());
        }
    }
}
