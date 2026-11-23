//! Unified workspace: one item registry, peer identity, groups, references and
//! safe deletion (see `plan.md` at the repo root).
//!
//! The plan calls this module `workspace/`, but `src/workspace.rs` already
//! holds the agent's workspace files (AGENTS.md, SOUL.md, ...). To avoid the
//! clash the module is `ws`, matching the `ws_` table prefix.
//!
//! Every table lives in the engine's `agent.db`, is created with
//! `IF NOT EXISTS`, and every write goes through `turn_memory::write_tx`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub mod envelope;
pub mod group_rules;
pub mod groups;
pub mod ids;
pub mod longterm;
pub mod principals;
pub mod projection;
pub mod registry;

#[cfg(test)]
pub mod test_seed;
#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod groups_tests;

/// Current schema version of the `ws_*` tables.
pub const SCHEMA_VERSION: i64 = 1;

/// Create the base tables (`ws_meta`). Later phases add their own tables in
/// their `ensure_*` functions; all of them are idempotent.
pub fn ensure_meta(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ws_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);")
}

pub fn meta_get(conn: &Connection, k: &str) -> rusqlite::Result<Option<String>> {
    ensure_meta(conn)?;
    conn.query_row("SELECT v FROM ws_meta WHERE k = ?1", params![k], |r| r.get(0)).optional()
}

pub fn meta_set(conn: &Connection, k: &str, v: &str) -> rusqlite::Result<()> {
    ensure_meta(conn)?;
    conn.execute("INSERT INTO ws_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params![k, v])?;
    Ok(())
}

/// May `viewer` see `item`? Phase 1: the user sees everything; a holder sees
/// what it owns. Grants (Phase 4) and policies (Phase 5) extend this.
pub fn can_see(_conn: &Connection, viewer: &str, item: &Value) -> bool {
    if viewer == "user" || viewer.is_empty() {
        return true;
    }
    item["owner"].as_str() == Some(viewer)
}

/// Items shared with `holder` (references, Phase 4).
pub fn shared_with(_conn: &Connection, _holder: &str) -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}

/// Groups `holder` is a member of (Phase 3).
pub fn groups_of(conn: &Connection, holder: &str) -> Result<Vec<Value>, String> {
    match holder.strip_prefix("session:") {
        // A chat lists the groups made from it.
        Some(root) => Ok(groups::groups_of(conn, "user")?
            .into_iter()
            .filter(|g| conn.query_row("SELECT home_root FROM ws_groups WHERE id = ?1", params![g["id"].as_str().unwrap_or("")], |r| r.get::<_, Option<String>>(0)).ok().flatten().as_deref() == Some(root))
            .collect()),
        None => groups::groups_of(conn, holder),
    }
}

/// Sync if the registry was never built or is older than `max_age_ms`.
pub fn ensure_synced(conn: &Connection, src: &registry::Sources, max_age_ms: i64) -> Result<(), String> {
    let at: i64 = meta_get(conn, "registry_synced_at").map_err(|e| e.to_string())?.and_then(|v| v.parse().ok()).unwrap_or(0);
    if now_ms() - at > max_age_ms {
        registry::sync(conn, src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The `workspace.*` requests from the UI.
pub fn request(conn: &Connection, workspace_dir: &Path, state_dir: &Path, session_key: &str, op: &str, req: &Value) -> Result<Value, String> {
    let host_keys = req.get("hostMemoryKeys").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
    let src = registry::Sources {
        state_dir: Some(state_dir),
        workspace_dir: if workspace_dir.as_os_str().is_empty() { None } else { Some(workspace_dir) },
        host_memory_keys: host_keys,
    };
    let viewer = req.get("viewer").and_then(Value::as_str).unwrap_or("user");
    let s = |v: &str| req.get(v).and_then(Value::as_str).unwrap_or("").to_string();
    let op = op.strip_prefix("workspace.").unwrap_or(op);
    match op {
        "items.sync" => {
            let r = registry::sync(conn, &src).map_err(|e| e.to_string())?;
            Ok(json!({ "sync": r }))
        }
        "items.tree" => {
            ensure_synced(conn, &src, 5_000)?;
            let holder = req.get("holder").and_then(Value::as_str).map(str::to_string).or_else(|| {
                if req.get("all").and_then(Value::as_bool) == Some(true) || session_key.is_empty() {
                    None
                } else {
                    Some(registry::session_holder(session_key))
                }
            });
            let limit = req.get("limit").and_then(Value::as_u64).map(|n| n as usize);
            projection::tree(conn, holder.as_deref(), viewer, limit)
        }
        "items.get" => registry::get(conn, &s("id")).map_err(|e| e.to_string())?.map(|i| json!({ "item": i })).ok_or_else(|| "No such item.".into()),
        "items.read" => {
            let item = registry::get(conn, &s("id")).map_err(|e| e.to_string())?.ok_or("No such item.")?;
            if !can_see(conn, viewer, &item) {
                return Err("You cannot read that item.".into());
            }
            registry::read(conn, &src, &s("id"), req.get("range"))
        }
        "items.list" => {
            ensure_synced(conn, &src, 5_000)?;
            let kind = s("kind");
            let owner = s("owner");
            let items = registry::query(
                conn,
                "(?1 = '' OR kind = ?1) AND (?2 = '' OR owner = ?2) AND state <> 'purged' ORDER BY created_at DESC LIMIT 500",
                &[&kind, &owner],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "items": items.into_iter().filter(|i| can_see(conn, viewer, i)).collect::<Vec<_>>() }))
        }
        "items.registerClient" => registry::register_client(conn, req),
        "items.fsck" => registry::fsck(conn, &src),
        "principals.list" => {
            principals::sync(conn, Some(state_dir)).map_err(|e| e.to_string())?;
            Ok(json!({ "principals": principals::list(conn).map_err(|e| e.to_string())? }))
        }
        "messages.conversations" => {
            let pid = if s("pid").is_empty() { registry::session_holder(session_key) } else { s("pid") };
            Ok(json!({ "conversations": envelope::conversations_of(conn, &pid)? }))
        }
        "messages.read" => {
            let limit = req.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            let before = req.get("before").and_then(Value::as_str);
            Ok(json!({ "messages": envelope::read_conversation(conn, &s("conversation"), before, limit)? }))
        }
        "messages.thread" => Ok(json!({ "messages": envelope::read_thread(conn, &s("root"))? })),
        other => Err(format!("Unknown workspace request {other}.")),
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(conn: &Connection, table: &str, key: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE session_key = ?1"), [key], |r| r.get(0)).unwrap()
    }

    #[test]
    fn clear_session_removes_ctx_rows() {
        let s = test_seed::seed();
        let key = test_seed::agent_session(test_seed::AGENT_A);
        for t in ["ctx_sessions", "ctx_mem_picks", "ctx_mem_files", "messages", "turn_memory"] {
            assert!(count(&s.conn, t, &key) > 0, "seeded {t}");
        }
        crate::db::clear_session(&s.conn, &key).unwrap();
        for t in ["ctx_sessions", "ctx_nodes", "ctx_notes", "ctx_mem_picks", "ctx_mem_versions", "ctx_mem_tags", "ctx_mem_files", "ctx_mem_status", "messages", "turn_memory"] {
            assert_eq!(count(&s.conn, t, &key), 0, "{t} cleared");
        }
        // other chats untouched, file-store bytes kept
        assert!(count(&s.conn, "ctx_mem_picks", test_seed::CHAT_1) > 0);
        let bytes: i64 = s.conn.query_row("SELECT COUNT(*) FROM ctx_mem_file_store", [], |r| r.get(0)).unwrap();
        assert_eq!(bytes, 1);
    }

    #[test]
    fn hub_id_unique_after_expire() {
        let conn = test_seed::empty_db();
        let mut seen = std::collections::HashSet::new();
        for i in 0..5 {
            let r = crate::agent_hub::send(&conn, &serde_json::json!({"from": "a", "to": "b", "text": format!("m{i}"), "ttlMs": 10}), 0).unwrap();
            assert!(seen.insert(r["message"]["id"].as_str().unwrap().to_string()));
        }
        crate::agent_hub::expire(&conn, 1_000).unwrap();
        let live = crate::agent_hub::send(&conn, &serde_json::json!({"from": "a", "to": "b", "text": "after"}), 2_000).unwrap();
        let id = live["message"]["id"].as_str().unwrap().to_string();
        assert!(!seen.contains(&id), "an id never comes back after expiry");
        let again = crate::agent_hub::send(&conn, &serde_json::json!({"from": "a", "to": "b", "text": "after 2"}), 2_000).unwrap();
        assert_ne!(again["message"]["id"], live["message"]["id"]);
    }

    #[test]
    fn meta_round_trip() {
        let c = Connection::open_in_memory().unwrap();
        assert_eq!(meta_get(&c, "x").unwrap(), None);
        meta_set(&c, "x", "1").unwrap();
        meta_set(&c, "x", "2").unwrap();
        assert_eq!(meta_get(&c, "x").unwrap().as_deref(), Some("2"));
    }
}
