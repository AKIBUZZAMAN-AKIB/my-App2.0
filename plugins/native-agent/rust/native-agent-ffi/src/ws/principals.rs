//! Who can act and be named in an envelope: the user, the main agent, every
//! sub-agent, every group and every main chat. Rows are never deleted: a
//! sub-agent that is gone becomes `deleted`, so old messages keep a sender.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

use super::now_ms;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_principals (
            pid TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            display_name TEXT NOT NULL,
            parent_pid TEXT,
            state TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL
         );",
    )
}

pub fn upsert(conn: &Connection, pid: &str, kind: &str, name: &str, parent: Option<&str>, state: &str) -> rusqlite::Result<()> {
    ensure_tables(conn)?;
    conn.execute(
        "INSERT INTO ws_principals (pid, kind, display_name, parent_pid, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(pid) DO UPDATE SET display_name = excluded.display_name, parent_pid = COALESCE(excluded.parent_pid, parent_pid), state = excluded.state",
        params![pid, kind, name, parent, state, now_ms()],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, pid: &str) -> rusqlite::Result<Option<Value>> {
    ensure_tables(conn)?;
    conn.query_row("SELECT pid, kind, display_name, parent_pid, state FROM ws_principals WHERE pid = ?1", params![pid], |r| {
        Ok(json!({ "pid": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?, "parent": r.get::<_, Option<String>>(3)?, "state": r.get::<_, String>(4)? }))
    })
    .optional()
}

pub fn display_name(conn: &Connection, pid: &str) -> String {
    get(conn, pid).ok().flatten().and_then(|p| p["name"].as_str().map(str::to_string)).unwrap_or_else(|| match pid {
        "user" => "You".into(),
        "agent:main" => "Main agent".into(),
        other => other.to_string(),
    })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    ensure_tables(conn)?;
    let mut st = conn.prepare("SELECT pid, kind, display_name, parent_pid, state FROM ws_principals ORDER BY created_at, pid")?;
    let rows = st
        .query_map([], |r| {
            Ok(json!({ "pid": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?, "parent": r.get::<_, Option<String>>(3)?, "state": r.get::<_, String>(4)? }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Fill from the user, the main agent, sub-agents and main chats.
pub fn sync(conn: &Connection, state_dir: Option<&Path>) -> rusqlite::Result<()> {
    ensure_tables(conn)?;
    upsert(conn, "user", "user", "You", None, "active")?;
    upsert(conn, "agent:main", "agent", "Main agent", None, "active")?;
    let mut st = conn.prepare("SELECT session_key FROM sessions WHERE session_key NOT LIKE 'subagent:%'")?;
    let keys: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    drop(st);
    for k in keys {
        let pid = format!("session:{k}");
        let exists: bool = conn.query_row("SELECT 1 FROM ws_principals WHERE pid = ?1", params![pid], |_| Ok(())).optional()?.is_some();
        if !exists {
            upsert(conn, &pid, "session", &k, None, "active")?;
        }
    }
    if let Some(dir) = state_dir {
        let recs = super::registry::read_registry(dir);
        let live: std::collections::HashSet<String> = recs.iter().filter_map(|r| r["id"].as_str().map(|s| format!("agent:{s}"))).collect();
        for r in &recs {
            let Some(id) = r["id"].as_str() else { continue };
            let name = r["title"].as_str().filter(|t| !t.is_empty()).or_else(|| r["name"].as_str()).unwrap_or(id);
            let parent = match r["parentId"].as_str().filter(|p| !p.is_empty()) {
                Some(p) => format!("agent:{p}"),
                None => super::registry::session_holder(r["rootSessionKey"].as_str().filter(|s| !s.is_empty()).or_else(|| r["parentSessionKey"].as_str()).unwrap_or("")),
            };
            let status = r["status"].as_str().unwrap_or("");
            let state = if matches!(status, "running" | "queued" | "waiting") { "active" } else { "stopped" };
            upsert(conn, &format!("agent:{id}"), "agent", name, Some(&parent), state)?;
        }
        // Agents no longer in the registry: kept, marked deleted.
        let mut st = conn.prepare("SELECT pid FROM ws_principals WHERE kind = 'agent' AND pid <> 'agent:main' AND state <> 'deleted'")?;
        let known: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        for pid in known.into_iter().filter(|p| !live.contains(p)) {
            conn.execute("UPDATE ws_principals SET state = 'deleted' WHERE pid = ?1", params![pid])?;
        }
    }
    Ok(())
}
