//! Test fixture shared by every phase: a seeded `agent.db` and a sub-agent
//! state directory with two main chats, two sub-agents (one nested), turn
//! memory, checklist rows, file-store rows and agent mail.
//!
//! The plan puts this in `tests/fixtures/workspace_seed.rs`, but the crate
//! builds only `cdylib` / `staticlib`, which integration tests cannot link,
//! so it lives here behind `#[cfg(test)]`.

use rusqlite::{params, Connection};
use serde_json::json;
use std::path::PathBuf;

pub const CHAT_1: &str = "chat-1";
pub const CHAT_2: &str = "chat-2";
pub const AGENT_A: &str = "sa_aaaaaaaaaa";
pub const AGENT_B: &str = "sa_bbbbbbbbbb";

pub fn agent_session(id: &str) -> String {
    format!("subagent:{id}")
}

pub struct Seed {
    pub conn: Connection,
    pub state_dir: PathBuf,
}

/// Every table the engine creates, empty.
pub fn empty_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    crate::turn_memory::store::ensure_tables(&conn).unwrap();
    crate::context_tree::store::ensure_tables(&conn).unwrap();
    crate::context_tree::memory_checklist::ensure_tables(&conn).unwrap();
    crate::agent_hub::ensure_tables(&conn).unwrap();
    conn
}

fn chat(conn: &Connection, key: &str, at: i64, msgs: &[(&str, &str)]) {
    conn.execute("INSERT OR REPLACE INTO sessions (session_key, created_at, updated_at) VALUES (?1, ?2, ?2)", params![key, at]).unwrap();
    for (i, (role, text)) in msgs.iter().enumerate() {
        conn.execute(
            "INSERT INTO messages (session_key, sequence, role, content, content_kind, timestamp) VALUES (?1, ?2, ?3, ?4, 'text', ?5)",
            params![key, i as i64, role, text, at + i as i64],
        )
        .unwrap();
    }
    conn.execute("INSERT OR REPLACE INTO turn_memory (session_key, memory_json, through_turn, updated_at) VALUES (?1, '{}', 1, ?2)", params![key, at]).unwrap();
    conn.execute("INSERT OR REPLACE INTO ctx_sessions (session_key, rev, next_node_no, created_at, updated_at) VALUES (?1, 1, 1, ?2, ?2)", params![key, at]).unwrap();
    conn.execute("INSERT OR REPLACE INTO ctx_mem_picks (session_key, rid, pick, updated_at) VALUES (?1, 'lt:k', 'pinned', ?2)", params![key, at]).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO ctx_mem_files (session_key, path, hash, turn, call_index, chars) VALUES (?1, 'notes.md', 'h1', 1, 0, 10)",
        params![key],
    )
    .unwrap();
}

pub fn seed() -> Seed {
    let conn = empty_db();
    chat(&conn, CHAT_1, 1_000, &[("user", "plan the launch"), ("assistant", "ok")]);
    chat(&conn, CHAT_2, 2_000, &[("user", "write the report")]);
    chat(&conn, &agent_session(AGENT_A), 3_000, &[("user", "research"), ("assistant", "found 3 sources")]);
    chat(&conn, &agent_session(AGENT_B), 4_000, &[("user", "summarise")]);
    conn.execute(
        "INSERT OR REPLACE INTO ctx_mem_file_store (path, hash, content, chars, bytes, first_seen, last_seen) VALUES ('notes.md', 'h1', 'hello', 5, 5, 1, 1)",
        [],
    )
    .unwrap();
    crate::agent_hub::send(&conn, &json!({"from": AGENT_A, "to": AGENT_B, "text": "schema is in notes.md", "session": CHAT_1}), 5_000).unwrap();

    let state_dir = std::env::temp_dir().join(format!("ws-seed-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(state_dir.join("memory")).unwrap();
    let registry = json!([
        {"id": AGENT_A, "name": "researcher", "task": "research", "status": "done", "parentSessionKey": CHAT_1,
         "sessionKey": agent_session(AGENT_A), "depth": 1, "tools": [], "memoryMode": "private", "tokenBudget": 0,
         "maxSteps": 0, "timeoutSeconds": 0, "createdAt": 3_000, "startedAt": 3_000, "rootSessionKey": CHAT_1},
        {"id": AGENT_B, "name": "writer", "task": "summarise", "status": "done", "parentSessionKey": agent_session(AGENT_A),
         "sessionKey": agent_session(AGENT_B), "depth": 2, "tools": [], "memoryMode": "private", "tokenBudget": 0,
         "maxSteps": 0, "timeoutSeconds": 0, "createdAt": 4_000, "startedAt": 4_000, "parentId": AGENT_A, "rootSessionKey": CHAT_1}
    ]);
    std::fs::write(state_dir.join("registry.json"), serde_json::to_vec_pretty(&registry).unwrap()).unwrap();
    std::fs::write(
        state_dir.join("memory").join(format!("{}.json", AGENT_A.replace('_', "-"))),
        serde_json::to_vec(&json!([{"key": "topic", "text": "rust", "updatedAt": 3_000}])).unwrap(),
    )
    .unwrap();
    Seed { conn, state_dir }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_builds() {
        let s = seed();
        let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4);
        assert!(s.state_dir.join("registry.json").exists());
    }
}
