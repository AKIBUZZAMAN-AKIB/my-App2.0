//! Storage for turn memory: the live row (with `version` for optimistic
//! concurrency and a visible status), the last versions, the archived
//! original turns and the stored tool results.
//!
//! The checkpoint is the live row: `memory_json`, `through_turn` and
//! `version` change together in one UPDATE that only matches the version the
//! caller read, inside one transaction with the archive rows and the version
//! history. A crash before COMMIT leaves the previous version and checkpoint.

use super::{clip, Turn, TurnMemory};
use crate::types::Message;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Versions kept per chat (the live one included).
pub const KEEP_VERSIONS: i64 = 10;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS turn_memory (
            session_key TEXT PRIMARY KEY,
            memory_json TEXT NOT NULL,
            through_turn INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS turn_archive (
            session_key TEXT NOT NULL,
            turn_no INTEGER NOT NULL,
            messages_json TEXT NOT NULL,
            preview TEXT,
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, turn_no)
        );
        CREATE TABLE IF NOT EXISTS turn_memory_versions (
            session_key TEXT NOT NULL,
            version INTEGER NOT NULL,
            kind TEXT NOT NULL,
            through_turn INTEGER NOT NULL,
            memory_json TEXT NOT NULL,
            detail_json TEXT,
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, version)
        );
        CREATE TABLE IF NOT EXISTS tool_results (
            session_key TEXT NOT NULL,
            result_no INTEGER NOT NULL,
            tool_use_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            source TEXT,
            content TEXT NOT NULL,
            is_error INTEGER NOT NULL DEFAULT 0,
            bytes INTEGER NOT NULL,
            turn_no INTEGER,
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, tool_use_id),
            UNIQUE (session_key, result_no)
        );",
    )?;
    // Columns added after the first release of the table.
    let cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(turn_memory)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.filter_map(Result::ok).collect()
    };
    for (name, ddl) in [
        ("version", "ALTER TABLE turn_memory ADD COLUMN version INTEGER NOT NULL DEFAULT 0"),
        ("status", "ALTER TABLE turn_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'"),
        ("status_detail", "ALTER TABLE turn_memory ADD COLUMN status_detail TEXT"),
        ("status_at", "ALTER TABLE turn_memory ADD COLUMN status_at INTEGER NOT NULL DEFAULT 0"),
        ("retries", "ALTER TABLE turn_memory ADD COLUMN retries INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !cols.iter().any(|c| c == name) {
            conn.execute(ddl, [])?;
        }
    }
    Ok(())
}

fn parse_memory(json: &str, version: u64) -> TurnMemory {
    let mut mem: TurnMemory = serde_json::from_str(json).unwrap_or_default();
    mem.version = version;
    mem.normalize();
    mem
}

/// The live memory with its version (0 = never saved).
pub fn load_memory(conn: &Connection, session_key: &str) -> TurnMemory {
    if ensure_tables(conn).is_err() {
        return TurnMemory::default();
    }
    conn.query_row("SELECT memory_json, version FROM turn_memory WHERE session_key = ?1", [session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .ok()
        .map(|(j, v)| parse_memory(&j, v as u64))
        .unwrap_or_default()
}

#[derive(Debug)]
pub enum SaveError {
    /// Someone saved another version since `expected` was read.
    Conflict { current: u64 },
    Db(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Conflict { current } => write!(f, "version conflict (now at version {})", current),
            SaveError::Db(e) => write!(f, "database error: {}", e),
        }
    }
}

impl From<rusqlite::Error> for SaveError {
    fn from(e: rusqlite::Error) -> Self {
        SaveError::Db(e.to_string())
    }
}

/// Turns to archive in the same transaction as a version.
pub struct ArchiveTurns<'a> {
    pub messages: &'a [Message],
    pub turns: &'a [Turn],
}

#[cfg(test)]
thread_local! {
    /// Test hook: fail the transaction after this step ("archive", "memory", "history").
    pub static FAIL_AFTER: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

fn failpoint(_step: &str) -> rusqlite::Result<()> {
    #[cfg(test)]
    {
        if FAIL_AFTER.with(|f| *f.borrow() == Some(_step)) {
            return Err(rusqlite::Error::ToSqlConversionFailure(format!("injected failure after {}", _step).into()));
        }
    }
    Ok(())
}

/// Save `mem` as the next version if the live version is still `expected`.
/// Archive rows, the live row and the history row are written in one
/// transaction; history keeps the last `KEEP_VERSIONS`. Returns the new
/// version number.
pub fn save_version(conn: &Connection, session_key: &str, expected: u64, mem: &TurnMemory, kind: &str, detail: &Value, archive: Option<ArchiveTurns<'_>>, now_ms: i64) -> Result<u64, SaveError> {
    ensure_tables(conn)?;
    let tx = conn.unchecked_transaction()?;
    if let Some(a) = archive {
        archive_in(&tx, session_key, a.messages, a.turns, now_ms)?;
    }
    failpoint("archive")?;
    let next = expected + 1;
    let mut stored = mem.clone();
    stored.version = next;
    let json = serde_json::to_string(&stored).map_err(|e| SaveError::Db(e.to_string()))?;
    // The version check and the write are one statement.
    let changed = if expected == 0 {
        tx.execute(
            "INSERT INTO turn_memory (session_key, memory_json, through_turn, updated_at, version, status, status_detail, status_at, retries)
             VALUES (?1, ?2, ?3, ?4, ?5, 'ok', NULL, ?4, 0)
             ON CONFLICT(session_key) DO UPDATE SET memory_json = excluded.memory_json, through_turn = excluded.through_turn,
               updated_at = excluded.updated_at, version = excluded.version, status = 'ok', status_detail = NULL, status_at = excluded.updated_at, retries = 0
             WHERE turn_memory.version = 0",
            params![session_key, json, stored.through_turn, now_ms, next as i64],
        )?
    } else {
        tx.execute(
            "UPDATE turn_memory SET memory_json = ?2, through_turn = ?3, updated_at = ?4, version = ?5, status = 'ok', status_detail = NULL, status_at = ?4, retries = 0
             WHERE session_key = ?1 AND version = ?6",
            params![session_key, json, stored.through_turn, now_ms, next as i64, expected as i64],
        )?
    };
    if changed == 0 {
        let current = tx.query_row("SELECT version FROM turn_memory WHERE session_key = ?1", [session_key], |r| r.get::<_, i64>(0)).optional()?.unwrap_or(0) as u64;
        return Err(SaveError::Conflict { current });
    }
    failpoint("memory")?;
    tx.execute(
        "INSERT OR REPLACE INTO turn_memory_versions (session_key, version, kind, through_turn, memory_json, detail_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![session_key, next as i64, kind, stored.through_turn, json, detail.to_string(), now_ms],
    )?;
    tx.execute("DELETE FROM turn_memory_versions WHERE session_key = ?1 AND version <= ?2", params![session_key, next as i64 - KEEP_VERSIONS])?;
    failpoint("history")?;
    tx.commit()?;
    Ok(next)
}

/// Mark the memory as failed/pending ("summary failed, will retry"). The
/// memory itself and its version do not change.
pub fn set_status(conn: &Connection, session_key: &str, status: &str, detail: &str, now_ms: i64) -> rusqlite::Result<()> {
    ensure_tables(conn)?;
    conn.execute(
        "INSERT INTO turn_memory (session_key, memory_json, through_turn, updated_at, version, status, status_detail, status_at, retries)
         VALUES (?1, '{}', 0, ?4, 0, ?2, ?3, ?4, CASE WHEN ?2 = 'ok' THEN 0 ELSE 1 END)
         ON CONFLICT(session_key) DO UPDATE SET status = excluded.status, status_detail = excluded.status_detail, status_at = excluded.status_at,
           retries = CASE WHEN excluded.status = 'ok' THEN 0 ELSE turn_memory.retries + 1 END",
        params![session_key, status, detail, now_ms],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryStatus {
    pub status: String,
    pub detail: Option<String>,
    pub at: i64,
    pub retries: u32,
}

pub fn load_status(conn: &Connection, session_key: &str) -> MemoryStatus {
    let none = MemoryStatus { status: "ok".into(), detail: None, at: 0, retries: 0 };
    if ensure_tables(conn).is_err() {
        return none;
    }
    conn.query_row("SELECT status, status_detail, status_at, retries FROM turn_memory WHERE session_key = ?1", [session_key], |r| {
        Ok(MemoryStatus { status: r.get(0)?, detail: r.get(1)?, at: r.get(2)?, retries: r.get::<_, i64>(3)? as u32 })
    })
    .unwrap_or(none)
}

/// Version history, newest first: number, kind, turn checkpoint, detail.
pub fn list_versions(conn: &Connection, session_key: &str) -> Vec<Value> {
    if ensure_tables(conn).is_err() {
        return Vec::new();
    }
    let Ok(mut stmt) = conn.prepare("SELECT version, kind, through_turn, detail_json, created_at FROM turn_memory_versions WHERE session_key = ?1 ORDER BY version DESC") else {
        return Vec::new();
    };
    stmt.query_map([session_key], |r| {
        let detail: Option<String> = r.get(3)?;
        Ok(json!({
            "version": r.get::<_, i64>(0)?,
            "kind": r.get::<_, String>(1)?,
            "throughTurn": r.get::<_, i64>(2)?,
            "detail": detail.and_then(|d| serde_json::from_str::<Value>(&d).ok()).unwrap_or(Value::Null),
            "createdAt": r.get::<_, i64>(4)?,
        }))
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

/// One stored version: memory, kind and detail.
pub fn load_version(conn: &Connection, session_key: &str, version: u64) -> Option<(TurnMemory, String, Value)> {
    ensure_tables(conn).ok()?;
    conn.query_row(
        "SELECT memory_json, kind, detail_json FROM turn_memory_versions WHERE session_key = ?1 AND version = ?2",
        params![session_key, version as i64],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)),
    )
    .ok()
    .map(|(j, k, d)| (parse_memory(&j, version), k, d.and_then(|d| serde_json::from_str(&d).ok()).unwrap_or(Value::Null)))
}

/// Delete everything this chat stored (the chat itself was deleted): memory,
/// versions, archived turns and stored tool results.
pub fn delete_memory(conn: &Connection, session_key: &str) -> rusqlite::Result<()> {
    ensure_tables(conn)?;
    let tx = conn.unchecked_transaction()?;
    for t in ["turn_memory", "turn_memory_versions", "turn_archive", "tool_results"] {
        tx.execute(&format!("DELETE FROM {} WHERE session_key = ?1", t), [session_key])?;
    }
    tx.commit()
}

/// Start the memory again (user reset, or the transcript got shorter than the
/// summary). The reset is a version of its own; archived turns go (their
/// numbers no longer match the transcript); stored tool results stay, since
/// they are keyed by tool call, not by turn.
pub fn reset_memory(conn: &Connection, session_key: &str, reason: &str, now_ms: i64) -> Result<u64, SaveError> {
    ensure_tables(conn)?;
    let cur = load_memory(conn, session_key);
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM turn_archive WHERE session_key = ?1", [session_key])?;
    tx.commit()?;
    let empty = TurnMemory { updated_at: now_ms, ..Default::default() };
    save_version(conn, session_key, cur.version, &empty, "reset", &json!({"reason": reason, "previousThroughTurn": cur.through_turn}), None, now_ms)
}

fn preview(messages: &[Message]) -> String {
    messages.first().map(|m| clip(&m.text(), 160)).unwrap_or_default()
}

fn archive_in(conn: &Connection, session_key: &str, messages: &[Message], turns: &[Turn], now_ms: i64) -> rusqlite::Result<usize> {
    let mut n = 0;
    for t in turns {
        let slice = &messages[t.start.min(messages.len())..t.end.min(messages.len())];
        let json = serde_json::to_string(slice).unwrap_or_default();
        n += conn.execute(
            "INSERT INTO turn_archive (session_key, turn_no, messages_json, preview, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_key, turn_no) DO UPDATE SET messages_json = excluded.messages_json, preview = excluded.preview
             WHERE length(excluded.messages_json) >= length(turn_archive.messages_json)",
            params![session_key, t.no, json, preview(slice), now_ms],
        )?;
    }
    Ok(n)
}

/// Archive complete turns outside a version (tests, tools).
pub fn archive_turns(conn: &Connection, session_key: &str, messages: &[Message], turns: &[Turn], now_ms: i64) -> rusqlite::Result<usize> {
    ensure_tables(conn)?;
    let tx = conn.unchecked_transaction()?;
    let n = archive_in(&tx, session_key, messages, turns, now_ms)?;
    tx.commit()?;
    Ok(n)
}

/// Original messages of turns `from..=to` from the archive.
pub fn load_turns(conn: &Connection, session_key: &str, from: u32, to: u32) -> Vec<(u32, Vec<Message>)> {
    if ensure_tables(conn).is_err() {
        return Vec::new();
    }
    let Ok(mut stmt) = conn.prepare("SELECT turn_no, messages_json FROM turn_archive WHERE session_key = ?1 AND turn_no BETWEEN ?2 AND ?3 ORDER BY turn_no") else {
        return Vec::new();
    };
    let rows = stmt.query_map(params![session_key, from, to], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)));
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).filter_map(|(n, j)| serde_json::from_str::<Vec<Message>>(&j).ok().map(|m| (n, m))).collect(),
        Err(_) => Vec::new(),
    }
}

/// Turn list for the UI: number, preview, size.
pub fn archive_index(conn: &Connection, session_key: &str) -> Vec<Value> {
    if ensure_tables(conn).is_err() {
        return Vec::new();
    }
    let Ok(mut stmt) = conn.prepare("SELECT turn_no, preview, length(messages_json) FROM turn_archive WHERE session_key = ?1 ORDER BY turn_no") else {
        return Vec::new();
    };
    stmt.query_map([session_key], |r| Ok(json!({"turn": r.get::<_, u32>(0)?, "preview": r.get::<_, Option<String>>(1)?, "bytes": r.get::<_, i64>(2)?})))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

// ── Stored tool results ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct StoredResult {
    /// Display ID, "R12": stable for the chat's lifetime.
    pub id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub source: Option<String>,
    pub content: String,
    pub is_error: bool,
    pub bytes: usize,
    pub turn: Option<u32>,
}

/// Store a tool result the moment it arrives (before any compaction). The
/// stable key is (chat, provider tool_use_id); storing the same call again is
/// a no-op and returns the ID it already has. Returns (id, newly stored).
#[allow(clippy::too_many_arguments)]
pub fn store_result(conn: &Connection, session_key: &str, tool_use_id: &str, tool_name: &str, source: Option<&str>, content: &str, is_error: bool, turn: Option<u32>, now_ms: i64) -> rusqlite::Result<(String, bool)> {
    ensure_tables(conn)?;
    let tx = conn.unchecked_transaction()?;
    let existing: Option<i64> = tx.query_row("SELECT result_no FROM tool_results WHERE session_key = ?1 AND tool_use_id = ?2", params![session_key, tool_use_id], |r| r.get(0)).optional()?;
    if let Some(no) = existing {
        return Ok((format!("R{}", no), false));
    }
    let no: i64 = tx.query_row("SELECT COALESCE(MAX(result_no), 0) + 1 FROM tool_results WHERE session_key = ?1", [session_key], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO tool_results (session_key, result_no, tool_use_id, tool_name, source, content, is_error, bytes, turn_no, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![session_key, no, tool_use_id, tool_name, source, content, is_error as i64, content.len() as i64, turn, now_ms],
    )?;
    tx.commit()?;
    Ok((format!("R{}", no), true))
}

fn result_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredResult> {
    Ok(StoredResult {
        id: format!("R{}", r.get::<_, i64>(0)?),
        tool_use_id: r.get(1)?,
        tool_name: r.get(2)?,
        source: r.get(3)?,
        content: r.get(4)?,
        is_error: r.get::<_, i64>(5)? != 0,
        bytes: r.get::<_, i64>(6)? as usize,
        turn: r.get::<_, Option<i64>>(7)?.map(|t| t as u32),
    })
}

/// A stored result by display ID ("R12", "#R12", "12") or by tool_use_id.
pub fn load_result(conn: &Connection, session_key: &str, id: &str) -> Option<StoredResult> {
    ensure_tables(conn).ok()?;
    let raw = id.trim().trim_start_matches('#');
    let cols = "result_no, tool_use_id, tool_name, source, content, is_error, bytes, turn_no";
    let by_no = raw.strip_prefix('R').or_else(|| raw.strip_prefix('r')).unwrap_or(raw).parse::<i64>().ok();
    if let Some(no) = by_no {
        if let Ok(Some(r)) = conn.query_row(&format!("SELECT {} FROM tool_results WHERE session_key = ?1 AND result_no = ?2", cols), params![session_key, no], result_row).optional() {
            return Some(r);
        }
    }
    conn.query_row(&format!("SELECT {} FROM tool_results WHERE session_key = ?1 AND tool_use_id = ?2", cols), params![session_key, raw], result_row).optional().ok().flatten()
}

/// tool_use_id → display ID for every stored result of the chat.
pub fn result_ids(conn: &Connection, session_key: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if ensure_tables(conn).is_err() {
        return out;
    }
    if let Ok(mut stmt) = conn.prepare("SELECT tool_use_id, result_no FROM tool_results WHERE session_key = ?1") {
        if let Ok(rows) = stmt.query_map([session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
            for (t, n) in rows.flatten() {
                out.insert(t, format!("R{}", n));
            }
        }
    }
    out
}
