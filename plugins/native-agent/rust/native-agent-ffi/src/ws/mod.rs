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

pub mod ids;

#[cfg(test)]
pub mod test_seed;

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
