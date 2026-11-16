//! Persistent record of each model call's context assembly (schema v6).
//!
//! One row per request sent to the model: the same numbers the
//! `context.assembly` event carries, plus which memory records were in the
//! request (goal, decision, task, item and segment IDs) and where they came
//! from. It holds IDs and counts only, never prompt text or tool output.
//!
//! Rows are operational, not canonical: the memory, the goals and the
//! transcript never depend on them. Each chat keeps its newest
//! [`KEEP_ROWS_PER_CHAT`] rows (older ones are deleted on insert), and a chat's
//! rows go when the chat is deleted (`MEMORY_TABLES`).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const KEEP_ROWS_PER_CHAT: i64 = 500;

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS context_assembly_audit (
        assembly_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        iteration INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        memory_version INTEGER,
        summary_through_turn INTEGER,
        input_token_budget INTEGER NOT NULL,
        estimated_input_tokens INTEGER NOT NULL,
        reserved_output_tokens INTEGER NOT NULL,
        included_recent_turns TEXT NOT NULL DEFAULT '[]',
        included_goal_ids TEXT NOT NULL DEFAULT '[]',
        included_decision_ids TEXT NOT NULL DEFAULT '[]',
        included_task_ids TEXT NOT NULL DEFAULT '[]',
        included_memory_ids TEXT NOT NULL DEFAULT '[]',
        included_summary_segment_ids TEXT NOT NULL DEFAULT '[]',
        retrieval_sources TEXT NOT NULL DEFAULT '[]',
        compaction_actions TEXT NOT NULL DEFAULT '[]',
        truncation_actions TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS context_assembly_audit_by_chat ON context_assembly_audit (session_key, created_at);
";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssemblyRecord {
    pub assembly_id: String,
    /// The chat (`session_key`).
    pub conversation_id: String,
    pub created_at: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub iteration: u32,
    pub attempt: u32,
    pub memory_version: Option<u64>,
    pub summary_through_turn: Option<u32>,
    pub input_token_budget: usize,
    pub estimated_input_tokens: usize,
    pub reserved_output_tokens: usize,
    /// Turn numbers sent verbatim (first..=last), empty when unknown.
    pub included_recent_turns: Vec<u32>,
    pub included_goal_ids: Vec<String>,
    pub included_decision_ids: Vec<String>,
    pub included_task_ids: Vec<String>,
    /// Facts, preferences and files (F/P/L IDs).
    pub included_memory_ids: Vec<String>,
    /// Segments as `S<from>-<to>` (their turn range is their identity).
    pub included_summary_segment_ids: Vec<String>,
    pub retrieval_sources: Vec<String>,
    pub compaction_actions: Vec<String>,
    pub truncation_actions: Vec<String>,
}

fn j<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

fn ensure(conn: &Connection) -> rusqlite::Result<()> {
    super::store::ensure_tables(conn)
}

/// Store one record and trim the chat's oldest rows past the cap. Plain
/// statements (no IMMEDIATE transaction): an audit row never blocks a turn.
pub fn record(conn: &Connection, r: &AssemblyRecord) -> rusqlite::Result<()> {
    ensure(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO context_assembly_audit (assembly_id, session_key, created_at, provider, model, iteration, attempt, memory_version, summary_through_turn,
            input_token_budget, estimated_input_tokens, reserved_output_tokens, included_recent_turns, included_goal_ids, included_decision_ids, included_task_ids,
            included_memory_ids, included_summary_segment_ids, retrieval_sources, compaction_actions, truncation_actions)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            r.assembly_id,
            r.conversation_id,
            r.created_at,
            r.provider,
            r.model,
            r.iteration as i64,
            r.attempt as i64,
            r.memory_version.map(|v| v as i64),
            r.summary_through_turn.map(|v| v as i64),
            r.input_token_budget as i64,
            r.estimated_input_tokens as i64,
            r.reserved_output_tokens as i64,
            j(&r.included_recent_turns),
            j(&r.included_goal_ids),
            j(&r.included_decision_ids),
            j(&r.included_task_ids),
            j(&r.included_memory_ids),
            j(&r.included_summary_segment_ids),
            j(&r.retrieval_sources),
            j(&r.compaction_actions),
            j(&r.truncation_actions),
        ],
    )?;
    conn.execute(
        "DELETE FROM context_assembly_audit WHERE session_key = ?1 AND assembly_id NOT IN
           (SELECT assembly_id FROM context_assembly_audit WHERE session_key = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        params![r.conversation_id, KEEP_ROWS_PER_CHAT],
    )?;
    Ok(())
}

fn list<T: for<'de> Deserialize<'de> + Default>(s: Option<String>) -> T {
    s.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The newest `limit` records of a chat, newest first.
pub fn recent(conn: &Connection, key: &str, limit: usize) -> Vec<AssemblyRecord> {
    if ensure(conn).is_err() {
        return Vec::new();
    }
    let Ok(mut st) = conn.prepare(
        "SELECT assembly_id, session_key, created_at, provider, model, iteration, attempt, memory_version, summary_through_turn, input_token_budget,
                estimated_input_tokens, reserved_output_tokens, included_recent_turns, included_goal_ids, included_decision_ids, included_task_ids,
                included_memory_ids, included_summary_segment_ids, retrieval_sources, compaction_actions, truncation_actions
         FROM context_assembly_audit WHERE session_key = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    ) else {
        return Vec::new();
    };
    let rows = st.query_map(params![key, limit as i64], |r| {
        Ok(AssemblyRecord {
            assembly_id: r.get(0)?,
            conversation_id: r.get(1)?,
            created_at: r.get(2)?,
            provider: r.get(3)?,
            model: r.get(4)?,
            iteration: r.get::<_, i64>(5)?.max(0) as u32,
            attempt: r.get::<_, i64>(6)?.max(0) as u32,
            memory_version: r.get::<_, Option<i64>>(7)?.map(|v| v.max(0) as u64),
            summary_through_turn: r.get::<_, Option<i64>>(8)?.map(|v| v.max(0) as u32),
            input_token_budget: r.get::<_, i64>(9)?.max(0) as usize,
            estimated_input_tokens: r.get::<_, i64>(10)?.max(0) as usize,
            reserved_output_tokens: r.get::<_, i64>(11)?.max(0) as usize,
            included_recent_turns: list(r.get(12)?),
            included_goal_ids: list(r.get(13)?),
            included_decision_ids: list(r.get(14)?),
            included_task_ids: list(r.get(15)?),
            included_memory_ids: list(r.get(16)?),
            included_summary_segment_ids: list(r.get(17)?),
            retrieval_sources: list(r.get(18)?),
            compaction_actions: list(r.get(19)?),
            truncation_actions: list(r.get(20)?),
        })
    });
    match rows {
        Ok(r) => r.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// The record as the `context.assembly` event carries it (`audit` field).
pub fn event_fields(r: &AssemblyRecord) -> Value {
    serde_json::to_value(r).unwrap_or(Value::Null)
}
