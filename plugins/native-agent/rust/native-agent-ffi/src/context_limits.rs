//! Context windows learned from providers' own overflow errors.
//!
//! Some routes have no window in any catalog the app can read (OVHcloud AI
//! Endpoints, custom OpenAI-compatible hosts), or the catalog reports a larger
//! window than the endpoint really serves. When such a provider rejects a
//! request with "maximum context length is N tokens" (see
//! `agent_loop::assembly::parse_overflow_limits`), N is the best evidence
//! there is: the next turns budget against it instead of a fallback.
//!
//! This is not a second provider catalog. It holds only windows a provider
//! reported in an error, keyed by provider + exact model id, at most
//! `MAX_ENTRIES`, each for `TTL_SECS`; a catalog value still wins when it is
//! smaller. An entry is dropped as soon as a successful request proves it
//! wrong (the provider accepted more prompt tokens than the learned window).
//! The file sits next to the runtime config, outside the workspace, so it is
//! not shown to the model or synced with user files.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_ENTRIES: usize = 64;
pub const TTL_SECS: u64 = 30 * 24 * 60 * 60;
const FILE_NAME: &str = ".native-agent-learned-limits.json";

/// Serialises read-modify-write of the file within this process.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LearnedLimit {
    pub context_tokens: u64,
    pub learned_at: u64,
    /// Always "provider_error" today; kept so the UI can say where it came from.
    pub source: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LimitsFile {
    version: u32,
    #[serde(default)]
    limits: BTreeMap<String, LearnedLimit>,
}

fn key(provider: &str, model: &str) -> String {
    format!(
        "{}\u{1f}{}",
        provider.trim().to_ascii_lowercase(),
        model.trim()
    )
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn limits_path(workspace_path: &str) -> PathBuf {
    crate::config_store::default_config_path(workspace_path).with_file_name(FILE_NAME)
}

fn read(path: &Path) -> LimitsFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<LimitsFile>(&raw).ok())
        .unwrap_or_default()
}

fn write(path: &Path, file: &LimitsFile) {
    let Ok(raw) = serde_json::to_string_pretty(file) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// The learned window for this exact route, when one is recorded and fresh.
pub fn get(workspace_path: &str, provider: &str, model: &str) -> Option<u64> {
    if workspace_path.is_empty() {
        return None;
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = read(&limits_path(workspace_path));
    let entry = file.limits.get(&key(provider, model))?;
    (now_secs().saturating_sub(entry.learned_at) <= TTL_SECS).then_some(entry.context_tokens)
}

/// Records the window a provider reported for this route. Returns true when
/// the stored value changed.
pub fn record(workspace_path: &str, provider: &str, model: &str, context_tokens: u64) -> bool {
    if workspace_path.is_empty()
        || provider.trim().is_empty()
        || model.trim().is_empty()
        || context_tokens == 0
    {
        return false;
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = limits_path(workspace_path);
    let mut file = read(&path);
    file.version = 1;
    let now = now_secs();
    file.limits
        .retain(|_, v| now.saturating_sub(v.learned_at) <= TTL_SECS);
    let k = key(provider, model);
    if file.limits.get(&k).map(|v| v.context_tokens) == Some(context_tokens) {
        if let Some(v) = file.limits.get_mut(&k) {
            v.learned_at = now;
        }
        write(&path, &file);
        return false;
    }
    file.limits.insert(
        k,
        LearnedLimit {
            context_tokens,
            learned_at: now,
            source: "provider_error".into(),
        },
    );
    while file.limits.len() > MAX_ENTRIES {
        let oldest = file
            .limits
            .iter()
            .min_by_key(|(_, v)| v.learned_at)
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                file.limits.remove(&k);
            }
            None => break,
        }
    }
    write(&path, &file);
    true
}

/// Drops a learned window that a successful request just proved too small
/// (the provider accepted `accepted_prompt_tokens` > the window). Returns true
/// when an entry was removed.
pub fn forget_if_exceeded(
    workspace_path: &str,
    provider: &str,
    model: &str,
    accepted_prompt_tokens: u64,
) -> bool {
    if workspace_path.is_empty() || accepted_prompt_tokens == 0 {
        return false;
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = limits_path(workspace_path);
    let mut file = read(&path);
    let k = key(provider, model);
    match file.limits.get(&k) {
        Some(v) if accepted_prompt_tokens > v.context_tokens => {
            file.limits.remove(&k);
            write(&path, &file);
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn workspace() -> (Cleanup, String) {
        let dir = std::env::temp_dir().join(format!("learned-limits-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let s = ws.to_string_lossy().to_string();
        (Cleanup(dir), s)
    }

    #[test]
    fn records_reads_and_forgets_per_provider_and_model() {
        let (_d, ws) = workspace();
        assert_eq!(get(&ws, "ovhcloud", "Qwen2.5-VL-72B-Instruct"), None);
        assert!(record(&ws, "ovhcloud", "Qwen2.5-VL-72B-Instruct", 32_768));
        assert!(!record(&ws, "ovhcloud", "Qwen2.5-VL-72B-Instruct", 32_768));
        assert_eq!(
            get(&ws, "OVHcloud", "Qwen2.5-VL-72B-Instruct"),
            Some(32_768)
        );
        assert_eq!(get(&ws, "ovhcloud", "Meta-Llama-3_3-70B-Instruct"), None);
        assert_eq!(get(&ws, "kilo", "Qwen2.5-VL-72B-Instruct"), None);
        // The file lives outside the workspace.
        assert!(!limits_path(&ws).starts_with(&ws));
        assert!(!forget_if_exceeded(
            &ws,
            "ovhcloud",
            "Qwen2.5-VL-72B-Instruct",
            30_000
        ));
        assert!(forget_if_exceeded(
            &ws,
            "ovhcloud",
            "Qwen2.5-VL-72B-Instruct",
            40_000
        ));
        assert_eq!(get(&ws, "ovhcloud", "Qwen2.5-VL-72B-Instruct"), None);
    }

    #[test]
    fn bounded_and_expiring() {
        let (_d, ws) = workspace();
        for i in 0..(MAX_ENTRIES + 10) {
            record(&ws, "p", &format!("m{i}"), 8_192 + i as u64);
        }
        let file = read(&limits_path(&ws));
        assert_eq!(file.limits.len(), MAX_ENTRIES);
        // An expired entry is ignored.
        let mut file = file;
        file.limits.insert(
            key("p", "old"),
            LearnedLimit {
                context_tokens: 4_096,
                learned_at: 1,
                source: "provider_error".into(),
            },
        );
        write(&limits_path(&ws), &file);
        assert_eq!(get(&ws, "p", "old"), None);
        // Garbage on disk reads as empty.
        std::fs::write(limits_path(&ws), "not json").unwrap();
        assert_eq!(get(&ws, "p", "m1"), None);
        assert_eq!(get("", "p", "m1"), None);
    }
}
