//! Room-scoped coordination state in the database (unified plan, Phase 3).
//!
//! Before Phase 3 the blackboard, topic subscriptions and the swarm state
//! (auctions, votes, debates, elections, rumours, handoffs) lived in
//! `comms.json`, one tree per chat root. They now live in tables keyed by a
//! *room*: `team:<root>` for a chat's team, `group:<id>` for a group. The
//! comms config (topology, patterns, edges, limits) stays in `comms.json`.
//!
//! - `ws_board`: one row per blackboard mark.
//! - `ws_topics` + `ws_topic_subs`: a topic's window of recent posts and its
//!   digest (the full posts are in `ws_messages`, conversation
//!   `topic:<root>/<name>`), and who is subscribed.
//! - `ws_playbooks` + `ws_playbook_events`: one row per protocol run, its
//!   bids, ballots and debate turns as events. `engine` tells the rows of
//!   the per-chat swarm (`swarm`) from the room playbooks of Phase 5
//!   (`playbook`), so a rewrite of one never touches the other.
//! - `ws_room_meta`: small per-room values (coordinator, term, digests,
//!   compaction counters).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::now_ms;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_board (
            room TEXT NOT NULL, key TEXT NOT NULL,
            value TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            author TEXT NOT NULL DEFAULT 'user',
            author_name TEXT NOT NULL DEFAULT '',
            weight REAL NOT NULL DEFAULT 1.0,
            reinforced_at INTEGER NOT NULL DEFAULT 0,
            tags_json TEXT NOT NULL DEFAULT '[]',
            writes INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (room, key));
         CREATE TABLE IF NOT EXISTS ws_topics (
            room TEXT NOT NULL, topic TEXT NOT NULL,
            created_by TEXT, created_at INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0,
            posts_json TEXT NOT NULL DEFAULT '[]',
            digest_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (room, topic));
         CREATE TABLE IF NOT EXISTS ws_topic_subs (
            room TEXT NOT NULL, topic TEXT NOT NULL, pid TEXT NOT NULL,
            pos INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (room, topic, pid));
         CREATE TABLE IF NOT EXISTS ws_playbooks (
            room TEXT NOT NULL, id TEXT NOT NULL,
            kind TEXT NOT NULL, state TEXT NOT NULL,
            params_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT,
            started_by TEXT,
            engine TEXT NOT NULL DEFAULT 'swarm',
            pos INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY (room, id));
         CREATE INDEX IF NOT EXISTS ws_playbooks_room ON ws_playbooks(room, engine, kind, pos);
         CREATE TABLE IF NOT EXISTS ws_playbook_events (
            room TEXT NOT NULL, playbook_id TEXT NOT NULL, seq INTEGER NOT NULL,
            kind TEXT NOT NULL, pid TEXT, body_json TEXT NOT NULL DEFAULT '{}',
            at INTEGER NOT NULL,
            PRIMARY KEY (room, playbook_id, seq));
         CREATE TABLE IF NOT EXISTS ws_room_meta (
            room TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
            PRIMARY KEY (room, k));",
    )
}

fn e2s(e: rusqlite::Error) -> String {
    e.to_string()
}

/// The pid a board/topic row stores for an agent id (`agent:<id>`), or the
/// value as is when it already names a principal.
pub fn pid_of(id: &str) -> String {
    if id.contains(':') || id == "user" { id.to_string() } else { format!("agent:{id}") }
}

/// The agent id back from a stored pid.
pub fn id_of(pid: &str) -> String {
    pid.strip_prefix("agent:").unwrap_or(pid).to_string()
}

pub fn room_meta_get(conn: &Connection, room: &str, k: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT v FROM ws_room_meta WHERE room = ?1 AND k = ?2", params![room, k], |r| r.get(0)).optional()
}

pub fn room_meta_set(conn: &Connection, room: &str, k: &str, v: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO ws_room_meta (room, k, v) VALUES (?1, ?2, ?3) ON CONFLICT(room, k) DO UPDATE SET v = excluded.v", params![room, k, v])?;
    Ok(())
}

// ── Room blackboard API (a group's board, read and written directly) ─────────

/// One mark of a room's board, for the app and the group tools.
pub fn read(conn: &Connection, room: &str, key: Option<&str>) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let mut st = conn
        .prepare("SELECT key, value, version, author, author_name, weight, updated_at, tags_json FROM ws_board WHERE room = ?1 AND (?2 IS NULL OR key = ?2) ORDER BY key")
        .map_err(e2s)?;
    let rows = st
        .query_map(params![room, key], |r| {
            Ok(json!({
                "key": r.get::<_, String>(0)?, "value": r.get::<_, String>(1)?, "version": r.get::<_, i64>(2)?,
                "author": r.get::<_, String>(3)?, "authorName": r.get::<_, String>(4)?, "weight": r.get::<_, f64>(5)?,
                "updatedAt": r.get::<_, i64>(6)?,
                "tags": serde_json::from_str::<Value>(&r.get::<_, String>(7)?).unwrap_or(json!([])),
            }))
        })
        .map_err(e2s)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(e2s)
}

/// Marks whose key or value contains `q` (case-insensitive).
pub fn search(conn: &Connection, room: &str, q: &str) -> Result<Vec<Value>, String> {
    let q = q.trim().to_lowercase();
    Ok(read(conn, room, None)?
        .into_iter()
        .filter(|m| q.is_empty() || m["key"].as_str().unwrap_or("").to_lowercase().contains(&q) || m["value"].as_str().unwrap_or("").to_lowercase().contains(&q))
        .collect())
}

/// Write a mark. With `expected_version`, the write is a compare-and-set:
/// it fails when someone else wrote the key since (same rule as the team
/// blackboard). Returns the new version.
pub fn write(conn: &Connection, room: &str, key: &str, value: &str, expected_version: Option<i64>, author: &str, author_name: &str) -> Result<i64, String> {
    ensure_tables(conn).map_err(e2s)?;
    let key = key.trim();
    if key.is_empty() {
        return Err("A board mark needs a key.".into());
    }
    super::groups::tx(conn, |c| {
        let cur: Option<i64> = c.query_row("SELECT version FROM ws_board WHERE room = ?1 AND key = ?2", params![room, key], |r| r.get(0)).optional().map_err(e2s)?;
        if let Some(exp) = expected_version {
            if cur.unwrap_or(0) != exp {
                return Err(format!("{key} is at version {}, not {exp}: read it again before writing.", cur.unwrap_or(0)));
            }
        }
        let now = now_ms();
        let v = cur.unwrap_or(0) + 1;
        c.execute(
            "INSERT INTO ws_board (room, key, value, version, author, author_name, weight, reinforced_at, tags_json, writes, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1.0, ?7, '[]', 1, ?7)
             ON CONFLICT(room, key) DO UPDATE SET value = excluded.value, version = excluded.version, author = excluded.author,
               author_name = excluded.author_name, reinforced_at = excluded.reinforced_at, writes = ws_board.writes + 1, updated_at = excluded.updated_at",
            params![room, key, value, v, author, author_name, now],
        )
        .map_err(e2s)?;
        Ok(v)
    })
}

/// Remove a mark. True when it existed.
pub fn delete(conn: &Connection, room: &str, key: &str) -> Result<bool, String> {
    ensure_tables(conn).map_err(e2s)?;
    Ok(conn.execute("DELETE FROM ws_board WHERE room = ?1 AND key = ?2", params![room, key.trim()]).map_err(e2s)? > 0)
}

/// Rooms that hold any coordination state.
pub fn rooms(conn: &Connection) -> Result<Vec<String>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let mut st = conn
        .prepare(
            "SELECT room FROM ws_board UNION SELECT room FROM ws_topics UNION SELECT room FROM ws_topic_subs
             UNION SELECT room FROM ws_playbooks UNION SELECT room FROM ws_room_meta ORDER BY 1",
        )
        .map_err(e2s)?;
    let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(e2s)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(e2s)
}
