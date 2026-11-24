//! The host's memory store (main memory), as the workspace code sees it.
//!
//! Main memory lives in the host app (`MemoryProvider` in Kotlin / Swift), not
//! in `agent.db`. The workspace needs three things from it: write an entry
//! back after an edit, forget an entry when it is purged, and merge metadata
//! flags (`pinned`, `trashedAt`, `mainHidden`) into an entry without touching
//! its text. The handle installs the provider for the length of one request
//! with [`with_host`]; code that runs without one (tests, the sub-agent
//! manager) sees `None` and leaves host work queued.

use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;

/// What the workspace needs from the host memory store.
pub trait HostMemory {
    /// Write `text` under `key`. `text` empty + `metadata.__merge = true`
    /// keeps the stored text and merges the metadata (a `null` value removes
    /// that field).
    fn store(&self, key: &str, text: &str, metadata: Option<&Value>) -> Result<(), String>;
    fn forget(&self, key: &str) -> Result<(), String>;
    /// Every key in the host store, newest first, at most `limit`
    /// (`MemoryProvider::list`). The engine's mirror holds only the newest
    /// 200 entries while the host keeps up to 2,000; the registry reads the
    /// rest from here. A host that cannot list returns an error and the
    /// registry indexes the mirror alone.
    fn keys(&self, _limit: u32) -> Result<Vec<String>, String> {
        Err("This host cannot list its memory.".into())
    }
}

/// The most entries a host store holds (Android and iOS `MAX_ENTRIES`).
pub const HOST_MAX_ENTRIES: u32 = 2_000;

/// Parse a `MemoryProvider::list` reply: a JSON array of key strings.
pub fn parse_keys(raw: &str) -> Result<Vec<String>, String> {
    check_reply(raw)?;
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(a)) => Ok(a.into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
        Ok(Value::Object(o)) => match o.get("keys") {
            Some(Value::Array(a)) => Ok(a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
            _ => Err("The host's memory list is not a list of keys.".into()),
        },
        _ => Err("The host's memory list is not a list of keys.".into()),
    }
}

thread_local! {
    static HOST: RefCell<Option<Rc<dyn HostMemory>>> = const { RefCell::new(None) };
}

/// Run `f` with `host` installed as the current host memory store.
pub fn with_host<R>(host: Option<Rc<dyn HostMemory>>, f: impl FnOnce() -> R) -> R {
    let prev = HOST.with(|h| std::mem::replace(&mut *h.borrow_mut(), host));
    let out = f();
    HOST.with(|h| *h.borrow_mut() = prev);
    out
}

pub fn current() -> Option<Rc<dyn HostMemory>> {
    HOST.with(|h| h.borrow().clone())
}

/// Merge metadata flags into a host entry without changing its text.
pub fn merge_flags(key: &str, flags: Value) -> Result<(), String> {
    let Some(h) = current() else { return Err("Main memory is not available right now.".into()) };
    let mut meta = flags;
    meta["__merge"] = json!(true);
    h.store(key, "", Some(&meta))
}

/// Parse a host JSON reply: `{"error": ...}` is an error.
pub fn check_reply(raw: &str) -> Result<(), String> {
    match serde_json::from_str::<Value>(raw) {
        Ok(v) if v.get("error").and_then(Value::as_str).is_some() => Err(v["error"].as_str().unwrap_or("").to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
pub mod fake {
    //! An in-memory host store for tests.
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[derive(Default)]
    pub struct FakeHost {
        pub entries: RefCell<BTreeMap<String, (String, Value)>>,
        pub fail: RefCell<bool>,
    }

    impl HostMemory for FakeHost {
        fn store(&self, key: &str, text: &str, metadata: Option<&Value>) -> Result<(), String> {
            if *self.fail.borrow() {
                return Err("host offline".into());
            }
            let mut e = self.entries.borrow_mut();
            let merge = metadata.and_then(|m| m.get("__merge")).and_then(Value::as_bool) == Some(true);
            if merge {
                let cur = e.get_mut(key).ok_or("No such memory.")?;
                if !text.is_empty() {
                    cur.0 = text.to_string();
                }
                if let (Some(obj), Some(m)) = (cur.1.as_object_mut(), metadata.and_then(Value::as_object)) {
                    for (k, v) in m {
                        if k == "__merge" {
                            continue;
                        }
                        if v.is_null() {
                            obj.remove(k);
                        } else {
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                }
            } else {
                e.insert(key.to_string(), (text.to_string(), metadata.cloned().unwrap_or(json!({}))));
            }
            Ok(())
        }
        fn forget(&self, key: &str) -> Result<(), String> {
            if *self.fail.borrow() {
                return Err("host offline".into());
            }
            self.entries.borrow_mut().remove(key).map(|_| ()).ok_or_else(|| "No such memory.".into())
        }
        fn keys(&self, limit: u32) -> Result<Vec<String>, String> {
            if *self.fail.borrow() {
                return Err("host offline".into());
            }
            Ok(self.entries.borrow().keys().take(limit as usize).cloned().collect())
        }
    }
}
