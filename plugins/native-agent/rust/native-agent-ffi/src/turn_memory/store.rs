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

/// Version of the memory tables. 1 = the first release (no meta table);
/// every later step only adds tables or columns, so an older build keeps
/// working on a newer database (ADR-9).
///   2: `memory_meta`, `turn_memory_quarantine`
///   3: `memory_jobs`, `memory_job_parts` (background summaries, Phase 4)
///   4: `memory_retention`; `tool_results.pruned_at`, `pruned_reason`,
///      `pruned_bytes` (retention, Phase 6)
///   5: `turn_fts` full-text index over archived turns + delete trigger
///      (optional: skipped with a reason in `memory_meta.fts` when the
///      SQLite build has no FTS5; see `fts.rs`)
///   6: `memory_goals`, `memory_goal_events`, `memory_goal_state` (goal
///      lifecycle, `goals.rs`; each chat's free-text goal becomes G001) and
///      `context_assembly_audit` (one row per model call, `audit.rs`).
///      Decisions and open items gain an optional `goalId` inside the
///      memory JSON (absent = unknown; old rows read unchanged).
pub const MEMORY_SCHEMA_VERSION: i64 = 6;

fn stored_schema_version(conn: &Connection) -> Option<i64> {
    conn.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key = 'schema_version'", [], |r| r.get(0)).ok()
}

/// Create or upgrade the memory tables. Cheap when they are current (one
/// read); the upgrade runs once, under the write lock, and is idempotent.
pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    if stored_schema_version(conn).is_some_and(|v| v >= MEMORY_SCHEMA_VERSION) {
        return Ok(());
    }
    write_tx(conn, |c| {
        if stored_schema_version(c).is_some_and(|v| v >= MEMORY_SCHEMA_VERSION) {
            return Ok(());
        }
        let from = stored_schema_version(c);
        migrate(c)?;
        super::fts::create_and_backfill(c);
        // v6: existing goals become G001, once, in this same transaction (an
        // interrupted upgrade rolls back and runs again; it skips chats that
        // already have goal events).
        if from.is_some_and(|v| v < 6) || from.is_none() {
            let n = super::goals::migrate_legacy(c, chrono::Utc::now().timestamp_millis())?;
            if n > 0 {
                c.execute(
                    "INSERT INTO memory_meta (key, value) VALUES ('goals_migrated', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [format!("{} chat(s) from schema {}", n, from.unwrap_or(0))],
                )?;
            }
        }
        c.execute(
            "INSERT INTO memory_meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(memory_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)",
            [MEMORY_SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    })
}

/// Every table and column, created when missing. Additive only.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
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
        );
        CREATE TABLE IF NOT EXISTS memory_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        -- Unreadable live rows, kept before a save replaces them.
        CREATE TABLE IF NOT EXISTS turn_memory_quarantine (
            session_key TEXT NOT NULL,
            version INTEGER NOT NULL,
            memory_json TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, version)
        );
        -- Retention runs per chat (Phase 6).
        CREATE TABLE IF NOT EXISTS memory_retention (
            session_key TEXT PRIMARY KEY,
            last_run_at INTEGER,
            last_pruned INTEGER,
            last_pruned_bytes INTEGER,
            live_bytes INTEGER,
            referenced_bytes INTEGER,
            over_budget INTEGER,
            last_error TEXT
        );",
    )?;
    super::jobs::migrate(conn)?;
    conn.execute_batch(super::goals::SCHEMA)?;
    conn.execute_batch(super::audit::SCHEMA)?;
    // tool_results columns for pruned rows (Phase 6). A pruned row keeps its
    // number and a stub, so numbers are never reused.
    let rcols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(tool_results)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.filter_map(Result::ok).collect()
    };
    for (name, ddl) in [
        ("pruned_at", "ALTER TABLE tool_results ADD COLUMN pruned_at INTEGER"),
        ("pruned_reason", "ALTER TABLE tool_results ADD COLUMN pruned_reason TEXT"),
        ("pruned_bytes", "ALTER TABLE tool_results ADD COLUMN pruned_bytes INTEGER"),
    ] {
        if !rcols.iter().any(|c| c == name) {
            conn.execute(ddl, [])?;
        }
    }
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

/// Parse a stored memory. `None` when the JSON is unreadable (W-11): the
/// caller decides what to fall back to; it is never read as empty.
fn try_parse_memory(json: &str, version: u64) -> Option<TurnMemory> {
    let mut mem: TurnMemory = serde_json::from_str(json).ok()?;
    mem.version = version;
    mem.normalize();
    Some(mem)
}

fn parse_memory(json: &str, version: u64) -> TurnMemory {
    try_parse_memory(json, version).unwrap_or_else(|| TurnMemory { version, unreadable: true, ..Default::default() })
}

/// The live memory with its version (0 = never saved). When the live row is
/// unreadable, the newest readable version from the history is returned
/// (`recovered_from` says which; `version` stays the live one so the next
/// save replaces the broken row); with none left, an empty memory marked
/// `unreadable`.
pub fn load_memory(conn: &Connection, session_key: &str) -> TurnMemory {
    if ensure_tables(conn).is_err() {
        return TurnMemory::default();
    }
    let Some((json, v)) = conn
        .query_row("SELECT memory_json, version FROM turn_memory WHERE session_key = ?1", [session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .ok()
    else {
        return TurnMemory::default();
    };
    let v = v as u64;
    if let Some(m) = try_parse_memory(&json, v) {
        return m;
    }
    if v == 0 && json.trim() == "{}" {
        return TurnMemory::default();
    }
    let older: Vec<(i64, String)> = conn
        .prepare("SELECT version, memory_json FROM turn_memory_versions WHERE session_key = ?1 ORDER BY version DESC")
        .and_then(|mut st| st.query_map([session_key], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .unwrap_or_default();
    for (ver, j) in older {
        if let Some(mut m) = try_parse_memory(&j, v) {
            m.recovered_from = Some(ver as u64);
            return m;
        }
    }
    TurnMemory { version: v, unreadable: true, ..Default::default() }
}

#[derive(Debug)]
pub enum SaveError {
    /// Someone saved another version since `expected` was read.
    Conflict { current: u64 },
    Db(String),
    /// The background job this save belonged to is no longer this worker's
    /// (cancelled by a rewind/reset, superseded, or its lease was taken over):
    /// nothing was saved.
    JobLost(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Conflict { current } => write!(f, "version conflict (now at version {})", current),
            SaveError::Db(e) => write!(f, "database error: {}", e),
            SaveError::JobLost(e) => write!(f, "background job lost: {}", e),
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

pub(crate) fn failpoint(_step: &str) -> rusqlite::Result<()> {
    #[cfg(test)]
    {
        if FAIL_AFTER.with(|f| *f.borrow() == Some(_step)) {
            return Err(rusqlite::Error::ToSqlConversionFailure(format!("injected failure after {}", _step).into()));
        }
    }
    Ok(())
}

/// Run `f` as one atomic write. On an idle connection it is a
/// `BEGIN IMMEDIATE` transaction: the write lock is taken before the first
/// read, so a read-then-write can never fail with `SQLITE_BUSY_SNAPSHOT`
/// halfway (ADR-4); `busy_timeout` covers waiting for the lock. Inside an
/// outer transaction it is a savepoint, so writes compose (a rewind deletes
/// messages and forgets memory in one transaction). Any error, or a panic,
/// rolls everything back.
pub fn write_tx<T, E: From<rusqlite::Error>>(conn: &Connection, f: impl FnOnce(&Connection) -> Result<T, E>) -> Result<T, E> {
    struct Guard<'a> {
        conn: &'a Connection,
        outer: bool,
        done: bool,
    }
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            if !self.done {
                let sql = if self.outer { "ROLLBACK" } else { "ROLLBACK TO tm_write; RELEASE tm_write" };
                let _ = self.conn.execute_batch(sql);
            }
        }
    }
    let outer = conn.is_autocommit();
    conn.execute_batch(if outer { "BEGIN IMMEDIATE" } else { "SAVEPOINT tm_write" })?;
    let mut g = Guard { conn, outer, done: false };
    let v = f(conn)?;
    conn.execute_batch(if outer { "COMMIT" } else { "RELEASE tm_write" })?;
    g.done = true;
    Ok(v)
}

/// Save `mem` as the next version if the live version is still `expected`.
/// Archive rows, the live row and the history row are written in one
/// transaction; history keeps the last `KEEP_VERSIONS`. Returns the new
/// version number.
pub fn save_version(conn: &Connection, session_key: &str, expected: u64, mem: &TurnMemory, kind: &str, detail: &Value, archive: Option<ArchiveTurns<'_>>, now_ms: i64) -> Result<u64, SaveError> {
    save_version_for_job(conn, session_key, expected, mem, kind, detail, archive, None, now_ms)
}

/// A background job's claim: `(job_key, lease_owner)`.
pub type JobClaim<'a> = (&'a str, &'a str);

/// `save_version`, and when `job` is given, the job is marked `done` in the
/// same transaction; when the worker no longer holds the job, nothing is
/// saved (`SaveError::JobLost`). So a job commits at most one version.
#[allow(clippy::too_many_arguments)]
pub fn save_version_for_job(conn: &Connection, session_key: &str, expected: u64, mem: &TurnMemory, kind: &str, detail: &Value, archive: Option<ArchiveTurns<'_>>, job: Option<JobClaim<'_>>, now_ms: i64) -> Result<u64, SaveError> {
    ensure_tables(conn)?;
    write_tx(conn, |tx| {
        if let Some((job_key, owner)) = job {
            // Checked first, so a lost job never writes the archive either.
            if !super::jobs::holds(tx, session_key, job_key, owner) {
                return Err(SaveError::JobLost(format!("job {} is no longer running for this worker", job_key)));
            }
        }
        let version = save_version_in(tx, session_key, expected, mem, kind, detail, archive, now_ms)?;
        if let Some((job_key, owner)) = job {
            if !super::jobs::finish_in(tx, session_key, job_key, owner, Some(version), now_ms)? {
                return Err(SaveError::JobLost(format!("job {} is no longer running for this worker", job_key)));
            }
        }
        Ok(version)
    })
}

#[allow(clippy::too_many_arguments)]
fn save_version_in(tx: &Connection, session_key: &str, expected: u64, mem: &TurnMemory, kind: &str, detail: &Value, archive: Option<ArchiveTurns<'_>>, now_ms: i64) -> Result<u64, SaveError> {
    if let Some(a) = archive {
        archive_in(tx, session_key, a.messages, a.turns, now_ms)?;
    }
    failpoint("archive")?;
    if mem.from_newer_build() {
        return Err(SaveError::Db("the memory was written by a newer version of the app; this version does not change it".into()));
    }
    // An unreadable live row is kept aside before it is replaced.
    let live: Option<String> = tx.query_row("SELECT memory_json FROM turn_memory WHERE session_key = ?1 AND version = ?2", params![session_key, expected as i64], |r| r.get(0)).optional()?;
    // Goal links (`goals.rs`): every save keeps the links the live version
    // had and links what is new to the goal current at its source turn.
    let base = live.as_deref().and_then(|j| try_parse_memory(j, expected)).unwrap_or_default();
    if let Some(j) = live.filter(|j| try_parse_memory(j, expected).is_none() && j.trim() != "{}") {
        tx.execute("INSERT OR REPLACE INTO turn_memory_quarantine (session_key, version, memory_json, created_at) VALUES (?1, ?2, ?3, ?4)", params![session_key, expected as i64, j, now_ms])?;
    }
    let next = expected + 1;
    let mut stored = mem.clone();
    super::goals::link_records(&base, &mut stored, &super::goals::state_in(tx, session_key));
    stored.version = next;
    stored.schema_version = super::MEMORY_JSON_VERSION;
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
    Ok(next)
}

// ── Summaries in progress ───────────────────────────────────────────────────────

fn summarizing_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, (u32, u32, u64)>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (u32, u32, u64)>>> = std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

/// Marks a chat as summarizing turns `from..=to` until dropped, so the
/// memory screen opened mid-run (or after a reload) shows the progress too.
pub struct SummarizingGuard {
    key: String,
    token: u64,
}

pub fn mark_summarizing(session_key: &str, from: u32, to: u32) -> SummarizingGuard {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let token = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut m) = summarizing_map().lock() {
        m.insert(session_key.to_string(), (from, to, token));
    }
    SummarizingGuard { key: session_key.to_string(), token }
}

impl Drop for SummarizingGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = summarizing_map().lock() {
            // A newer batch of the same chat owns the entry now: leave it.
            if m.get(&self.key).map(|e| e.2) == Some(self.token) {
                m.remove(&self.key);
            }
        }
    }
}

/// The turn range a chat is summarizing right now, if any.
pub fn summarizing(session_key: &str) -> Option<(u32, u32)> {
    summarizing_map().lock().ok()?.get(session_key).map(|e| (e.0, e.1))
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
    write_tx(conn, |tx| {
        for t in MEMORY_TABLES {
            tx.execute(&format!("DELETE FROM {} WHERE session_key = ?1", t), [session_key])?;
        }
        Ok(())
    })
}

/// Every table that holds rows of one chat's memory.
pub const MEMORY_TABLES: [&str; 12] = [
    "turn_memory",
    "turn_memory_versions",
    "turn_archive",
    "tool_results",
    "turn_memory_quarantine",
    "memory_jobs",
    "memory_job_parts",
    "memory_retention",
    "memory_goals",
    "memory_goal_events",
    "memory_goal_state",
    "context_assembly_audit",
];

/// The transcript was cut after turn `keep_turns` (rewind): archived turns
/// past the cut are forgotten, and a summary that covered any of them is
/// reset (its notes could come from removed turns). Composes with the
/// caller's transaction. Returns true when the memory was reset.
pub fn forget_after(conn: &Connection, session_key: &str, keep_turns: u32, now_ms: i64) -> Result<bool, SaveError> {
    ensure_tables(conn)?;
    write_tx(conn, |tx| {
        tx.execute("DELETE FROM turn_archive WHERE session_key = ?1 AND turn_no > ?2", params![session_key, keep_turns])?;
        // A queued or running summary may read removed turns: cancelled in
        // the same transaction (a later turn queues what is still due).
        super::jobs::cancel_active(tx, session_key, "the chat was rewound", now_ms)?;
        // Goal changes made in removed turns are voided (kept, marked).
        super::goals::void_after(tx, session_key, keep_turns, "the chat was rewound", now_ms)?;
        let cur = load_memory(tx, session_key);
        if cur.through_turn <= keep_turns {
            return Ok(false);
        }
        let empty = TurnMemory { updated_at: now_ms, ..Default::default() };
        let detail = json!({"reason": "rewind", "previousThroughTurn": cur.through_turn, "keptTurns": keep_turns});
        // Archived turns 1..=keep_turns still match the transcript: kept.
        save_version_in(tx, session_key, cur.version, &empty, "reset", &detail, None, now_ms)?;
        Ok(true)
    })
}

/// Start the memory again (user reset, or the transcript got shorter than the
/// summary). The reset is a version of its own; archived turns go (their
/// numbers no longer match the transcript); stored tool results stay, since
/// they are keyed by tool call, not by turn.
pub fn reset_memory(conn: &Connection, session_key: &str, reason: &str, now_ms: i64) -> Result<u64, SaveError> {
    ensure_tables(conn)?;
    // One transaction: either the archive is gone and the reset version
    // exists, or nothing changed (W-5).
    write_tx(conn, |tx| {
        let cur = load_memory(tx, session_key);
        tx.execute("DELETE FROM turn_archive WHERE session_key = ?1", [session_key])?;
        super::jobs::cancel_active(tx, session_key, "the memory was reset", now_ms)?;
        // Turn numbers no longer match: every goal event is voided (kept,
        // marked, visible in the goal history) and the goals replayed empty.
        super::goals::void_all(tx, session_key, reason, now_ms)?;
        let empty = TurnMemory { updated_at: now_ms, ..Default::default() };
        save_version_in(tx, session_key, cur.version, &empty, "reset", &json!({"reason": reason, "previousThroughTurn": cur.through_turn}), None, now_ms)
    })
}

fn preview(messages: &[Message]) -> String {
    messages.first().map(|m| clip(&m.text(), 160)).unwrap_or_default()
}

fn archive_in(conn: &Connection, session_key: &str, messages: &[Message], turns: &[Turn], now_ms: i64) -> rusqlite::Result<usize> {
    let mut n = 0;
    for t in turns {
        let slice = &messages[t.start.min(messages.len())..t.end.min(messages.len())];
        let json = serde_json::to_string(slice).unwrap_or_default();
        let changed = conn.execute(
            "INSERT INTO turn_archive (session_key, turn_no, messages_json, preview, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_key, turn_no) DO UPDATE SET messages_json = excluded.messages_json, preview = excluded.preview
             WHERE excluded.messages_json IS NOT turn_archive.messages_json",
            params![session_key, t.no, json, preview(slice), now_ms],
        )?;
        if changed > 0 {
            // Same transaction as the archive row (schema v5).
            super::fts::index_turn(conn, session_key, t.no, slice)?;
        }
        n += changed;
    }
    Ok(n)
}

/// Archive complete turns outside a version (tests, tools).
pub fn archive_turns(conn: &Connection, session_key: &str, messages: &[Message], turns: &[Turn], now_ms: i64) -> rusqlite::Result<usize> {
    ensure_tables(conn)?;
    write_tx(conn, |tx| archive_in(tx, session_key, messages, turns, now_ms))
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
    // IMMEDIATE: the MAX()+1 read and the insert hold the write lock together.
    write_tx(conn, |tx| {
        let existing: Option<(i64, Option<i64>)> =
            tx.query_row("SELECT result_no, pruned_at FROM tool_results WHERE session_key = ?1 AND tool_use_id = ?2", params![session_key, tool_use_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((no, pruned)) = existing {
            if pruned.is_none() {
                return Ok((format!("R{}", no), false));
            }
            // The same call stored again after its row was pruned: the
            // original is back under its old number.
            tx.execute(
                "UPDATE tool_results SET tool_name = ?3, source = ?4, content = ?5, is_error = ?6, bytes = ?7, turn_no = COALESCE(?8, turn_no), created_at = ?9, pruned_at = NULL, pruned_reason = NULL, pruned_bytes = NULL WHERE session_key = ?1 AND result_no = ?2",
                params![session_key, no, tool_name, source, content, is_error as i64, content.len() as i64, turn, now_ms],
            )?;
            return Ok((format!("R{}", no), true));
        }
        // MAX over every row, pruned ones included: a number is never reused.
        let no: i64 = tx.query_row("SELECT COALESCE(MAX(result_no), 0) + 1 FROM tool_results WHERE session_key = ?1", [session_key], |r| r.get(0))?;
        tx.execute(
            "INSERT INTO tool_results (session_key, result_no, tool_use_id, tool_name, source, content, is_error, bytes, turn_no, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![session_key, no, tool_use_id, tool_name, source, content, is_error as i64, content.len() as i64, turn, now_ms],
        )?;
        Ok((format!("R{}", no), true))
    })
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
        if let Ok(Some(r)) = conn.query_row(&format!("SELECT {} FROM tool_results WHERE session_key = ?1 AND result_no = ?2 AND pruned_at IS NULL", cols), params![session_key, no], result_row).optional() {
            return Some(r);
        }
    }
    conn.query_row(&format!("SELECT {} FROM tool_results WHERE session_key = ?1 AND tool_use_id = ?2 AND pruned_at IS NULL", cols), params![session_key, raw], result_row).optional().ok().flatten()
}

/// Result IDs ("R12") a text refers to: the `#R12` of a result reference or
/// a memory note. Sorted, without duplicates.
pub fn referenced_result_ids(text: &str) -> Vec<u64> {
    let mut out: Vec<u64> = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i + 2 < b.len() {
        if b[i] == b'#' && b[i + 1] == b'R' && b[i + 2].is_ascii_digit() {
            let mut j = i + 2;
            let mut n: u64 = 0;
            while j < b.len() && b[j].is_ascii_digit() && j - i < 12 {
                n = n.saturating_mul(10).saturating_add((b[j] - b'0') as u64);
                j += 1;
            }
            // "#R12" but not "#R12abc" (an identifier that only starts the same).
            if n > 0 && !(j < b.len() && b[j].is_ascii_alphabetic()) {
                out.push(n);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// The chat's stored tool results for the memory screen (no content, a short
/// preview each) and the result IDs that something still refers to but that
/// are no longer stored: a reference in the transcript, an archived turn or
/// the summary, or a gap in the numbering. Those show as unavailable.
pub fn list_results(conn: &Connection, session_key: &str) -> Value {
    if ensure_tables(conn).is_err() {
        return json!({ "results": [], "unavailable": [] });
    }
    let mut rows: Vec<Value> = Vec::new();
    let mut have: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT result_no, tool_use_id, tool_name, source, is_error, bytes, turn_no, created_at, substr(content, 1, 240) FROM tool_results WHERE session_key = ?1 AND pruned_at IS NULL ORDER BY result_no",
    ) {
        if let Ok(it) = stmt.query_map([session_key], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)? != 0,
                r.get::<_, i64>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, Option<String>>(8)?.unwrap_or_default(),
            ))
        }) {
            for (no, tuid, tool, source, is_error, bytes, turn, created, head) in it.flatten() {
                have.insert(no as u64);
                rows.push(json!({
                    "id": format!("R{}", no), "toolUseId": tuid, "tool": tool, "source": source, "isError": is_error,
                    "bytes": bytes, "turn": turn, "createdAt": created, "preview": clip(&head, 160),
                }));
            }
        }
    }
    // Rows pruned by retention (Phase 6): gone, with when and why.
    let mut pruned: std::collections::BTreeMap<u64, Value> = std::collections::BTreeMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT result_no, tool_name, pruned_at, pruned_reason, pruned_bytes, turn_no FROM tool_results WHERE session_key = ?1 AND pruned_at IS NOT NULL") {
        if let Ok(it) = stmt.query_map([session_key], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, Option<i64>>(5)?))
        }) {
            for (no, tool, at, reason, bytes, turn) in it.flatten() {
                pruned.insert(no as u64, json!({ "tool": tool, "prunedAt": at, "reason": reason, "bytes": bytes, "turn": turn }));
            }
        }
    }
    let max_pruned = pruned.keys().next_back().copied();
    // Where each missing ID is still referred to.
    let mut refs: std::collections::BTreeMap<u64, Vec<String>> = std::collections::BTreeMap::new();
    let mut note = |text: &str, place: String| {
        for n in referenced_result_ids(text) {
            if !have.contains(&n) {
                let v = refs.entry(n).or_default();
                if v.len() < 5 && !v.contains(&place) {
                    v.push(place.clone());
                }
            }
        }
    };
    if let Ok(json) = conn.query_row("SELECT memory_json FROM turn_memory WHERE session_key = ?1", [session_key], |r| r.get::<_, String>(0)) {
        note(&json, "summary".into());
    }
    if let Ok(mut stmt) = conn.prepare("SELECT turn_no, messages_json FROM turn_archive WHERE session_key = ?1 AND messages_json LIKE '%#R%'") {
        if let Ok(it) = stmt.query_map([session_key], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
            for (t, j) in it.flatten() {
                note(&j, format!("turn {}", t));
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare("SELECT content FROM messages WHERE session_key = ?1 AND content LIKE '%#R%'") {
        if let Ok(it) = stmt.query_map([session_key], |r| r.get::<_, Option<String>>(0)) {
            for c in it.flatten().flatten() {
                note(&c, "transcript".into());
            }
        }
    }
    // A gap in the numbering: that result was stored once and is gone now.
    if let Some(max) = have.iter().next_back().copied().max(max_pruned) {
        for n in 1..=max {
            if !have.contains(&n) {
                refs.entry(n).or_default();
            }
        }
    }
    let unavailable: Vec<Value> = refs
        .into_iter()
        .map(|(n, places)| {
            let mut v = json!({ "id": format!("R{}", n), "referencedIn": places });
            if let Some(Value::Object(p)) = pruned.get(&n) {
                for (k, x) in p {
                    v[k] = x.clone();
                }
            }
            v
        })
        .collect();
    json!({ "results": rows, "unavailable": unavailable })
}

/// tool_use_id → display ID for every stored result of the chat.
pub fn result_ids(conn: &Connection, session_key: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if ensure_tables(conn).is_err() {
        return out;
    }
    if let Ok(mut stmt) = conn.prepare("SELECT tool_use_id, result_no FROM tool_results WHERE session_key = ?1 AND pruned_at IS NULL") {
        if let Ok(rows) = stmt.query_map([session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
            for (t, n) in rows.flatten() {
                out.insert(t, format!("R{}", n));
            }
        }
    }
    out
}
