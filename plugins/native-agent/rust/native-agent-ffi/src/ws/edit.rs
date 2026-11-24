//! Editing an item in place (plan.md, Phase 4): one copy, so an edit is seen
//! by every holder at once. Needs `edit` permission (`refs::can`). A main
//! memory edit goes through `provider.store` with the same key (so the same
//! id), refreshes the `ctx_mem_longterm` mirror (the checklist records the
//! new version on its next build) and writes `ws_audit`.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::registry::{self, Sources};
use super::{now_ms, refs};

const MAX_TEXT: usize = 20_000;

pub fn edit(conn: &Connection, src: &Sources, actor: &str, id: &str, text: &str, via: &str) -> Result<Value, String> {
    refs::ensure_tables(conn).map_err(|e| e.to_string())?;
    let it = registry::get(conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("No item {id}."))?;
    if text.trim().is_empty() {
        return Err("The text is empty.".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("The text is longer than {MAX_TEXT} characters."));
    }
    if !refs::can(conn, actor, &it, "edit") {
        return Err("You can't edit that item.".into());
    }
    let loc = it["loc"].as_str().unwrap_or("").to_string();
    if let Some(eid) = loc.strip_prefix("host:memory#") {
        let key = it["meta"]["key"].as_str().unwrap_or("");
        let host = super::host::current().ok_or("Main memory is not available right now.")?;
        // Keep the entry's metadata (pins, flags); replace only the text.
        host.store(key, text, Some(&json!({ "__merge": true })))?;
        conn.execute("UPDATE ctx_mem_longterm SET text = ?2, updated_at = ?3 WHERE key = ?1", params![key, text, now_ms()]).map_err(|e| e.to_string())?;
        let _ = eid;
    } else if loc.starts_with("host:memory@key:") {
        return Err("This memory came from an older app build and is read-only until the app updates it.".into());
    } else if let Some(rest) = loc.strip_prefix("fs:subagents/") {
        let (aid, key) = rest.split_once("/memory.json#").ok_or("A sub-agent record can't be edited as text.")?;
        let dir = src.state_dir.ok_or("The sub-agent store is not available.")?;
        let p = dir.join("memory").join(format!("{}.json", registry::sanitize(aid)));
        let mut entries: Vec<Value> = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let e = entries.iter_mut().find(|e| registry::memory_entry_is(e, key)).ok_or_else(|| format!("The source of {id} is gone."))?;
        e["text"] = json!(text);
        e["updatedAt"] = json!(now_ms());
        std::fs::write(&p, serde_json::to_vec(&entries).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    } else if let Some(rest) = loc.strip_prefix("db:ctx_notes/") {
        let (key, nid) = rest.rsplit_once('/').ok_or("bad loc")?;
        let n = conn.execute("UPDATE ctx_notes SET text = ?3 WHERE session_key = ?1 AND id = ?2", params![key, nid, text]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("The source of {id} is gone."));
        }
    } else if let Some(rel) = loc.strip_prefix("fs:workspace/") {
        let root = src.workspace_dir.ok_or("The workspace is not available.")?;
        let p = registry::safe_join(root, rel).ok_or("That path is outside the workspace.")?;
        if !p.is_file() {
            return Err(format!("The source of {id} is gone."));
        }
        std::fs::write(&p, text).map_err(|e| format!("{rel}: {e}"))?;
    } else {
        return Err("This kind of item can't be edited.".into());
    }
    conn.execute("UPDATE ws_items SET size_bytes = ?2, updated_at = ?3 WHERE id = ?1", params![id, text.len() as i64, now_ms()]).map_err(|e| e.to_string())?;
    refs::audit(conn, actor, "edit", Some(id), None, json!({ "chars": text.chars().count(), "via": via }));
    Ok(json!({ "id": id, "edited": true }))
}

