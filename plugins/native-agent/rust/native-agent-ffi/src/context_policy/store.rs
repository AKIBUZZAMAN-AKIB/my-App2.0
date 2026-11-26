//! TCPE tables in the session database: pins, tasks and events.
//!
//! Created next to the `ctx_*` tables by `context_tree::store::ensure_tables`
//! (schema version 2). Events hold ids and numbers only: no prompt text and no
//! tool output (the rule of `turn_memory/audit.rs`). A task keeps the user's
//! request in `goal_json` only while it runs; `finish` replaces it with ids and
//! state.

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde_json::{json, Value};

use super::types::{PolicyId, PolicyParams, Source, TaskStatus};

/// Event rows kept per chat; older ones go first.
pub const MAX_EVENT_ROWS: i64 = 2_000;

pub fn ensure_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ctx_policy_pins (
            session_key TEXT PRIMARY KEY,
            policy_id   TEXT NOT NULL,
            params      TEXT NOT NULL DEFAULT '{}',
            at          INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ctx_policy_tasks (
            task_id        TEXT PRIMARY KEY,
            session_key    TEXT NOT NULL,
            goal_json      TEXT NOT NULL,
            checklist_json TEXT NOT NULL,
            policy_id      TEXT NOT NULL,
            params         TEXT NOT NULL DEFAULT '{}',
            source         TEXT NOT NULL,
            status         TEXT NOT NULL,
            retries        INTEGER NOT NULL DEFAULT 0,
            escalations    INTEGER NOT NULL DEFAULT 0,
            started_at     INTEGER NOT NULL,
            ended_at       INTEGER
        );
        CREATE INDEX IF NOT EXISTS ctx_policy_tasks_session ON ctx_policy_tasks(session_key, started_at);
        CREATE TABLE IF NOT EXISTS ctx_policy_events (
            seq            INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id        TEXT,
            session_key    TEXT NOT NULL,
            at             INTEGER NOT NULL,
            step           INTEGER NOT NULL DEFAULT 0,
            kind           TEXT NOT NULL,
            policy_id      TEXT,
            included_ids   TEXT NOT NULL DEFAULT '[]',
            excluded_ids   TEXT NOT NULL DEFAULT '[]',
            reason         TEXT,
            input_tokens   INTEGER,
            t7_tokens      INTEGER,
            latency_ms     INTEGER,
            first_token_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS ctx_policy_events_session ON ctx_policy_events(session_key, seq);
        "#,
    )
}

// ---------------------------------------------------------------- pins

#[derive(Debug, Clone, PartialEq)]
pub struct Pin {
    pub policy_id: PolicyId,
    pub params: PolicyParams,
    pub at: i64,
}

pub fn set_pin(conn: &Connection, session_key: &str, policy_id: PolicyId, params: &PolicyParams, now_ms: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_policy_pins (session_key, policy_id, params, at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_key) DO UPDATE SET policy_id = excluded.policy_id, params = excluded.params, at = excluded.at",
        params![session_key, policy_id.as_str(), Value::Object(params.clone()).to_string(), now_ms],
    )?;
    Ok(())
}

pub fn clear_pin(conn: &Connection, session_key: &str) -> Result<bool> {
    Ok(conn.execute("DELETE FROM ctx_policy_pins WHERE session_key = ?1", params![session_key])? > 0)
}

/// The pin of a chat. A row whose policy id is not canonical reads as no pin.
pub fn get_pin(conn: &Connection, session_key: &str) -> Result<Option<Pin>> {
    let row = conn
        .query_row(
            "SELECT policy_id, params, at FROM ctx_policy_pins WHERE session_key = ?1",
            params![session_key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
        )
        .optional()?;
    Ok(row.and_then(|(id, p, at)| {
        let policy_id = PolicyId::parse(&id)?;
        let params = serde_json::from_str::<Value>(&p).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        Some(Pin { policy_id, params, at })
    }))
}

// ---------------------------------------------------------------- tasks

#[derive(Debug, Clone, PartialEq)]
pub struct TaskRow {
    pub task_id: String,
    pub session_key: String,
    pub goal_json: Value,
    pub checklist_json: Value,
    pub policy_id: PolicyId,
    pub params: PolicyParams,
    pub source: Source,
    pub status: TaskStatus,
    pub retries: u32,
    pub escalations: u32,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

impl TaskRow {
    pub fn to_json(&self) -> Value {
        json!({
            "taskId": self.task_id,
            "goal": self.goal_json,
            "checklist": self.checklist_json,
            "policy": self.policy_id.as_str(),
            "params": Value::Object(self.params.clone()),
            "source": self.source.as_str(),
            "status": self.status.as_str(),
            "retries": self.retries,
            "escalations": self.escalations,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
        })
    }
}

pub fn insert_task(conn: &Connection, t: &TaskRow) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_policy_tasks (task_id, session_key, goal_json, checklist_json, policy_id, params, source, status,
                                       retries, escalations, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            t.task_id,
            t.session_key,
            t.goal_json.to_string(),
            t.checklist_json.to_string(),
            t.policy_id.as_str(),
            Value::Object(t.params.clone()).to_string(),
            t.source.as_str(),
            t.status.as_str(),
            t.retries,
            t.escalations,
            t.started_at,
            t.ended_at,
        ],
    )?;
    Ok(())
}

/// Update the running state of a task (policy, checklist, counters).
pub fn update_task(conn: &Connection, t: &TaskRow) -> Result<()> {
    conn.execute(
        "UPDATE ctx_policy_tasks SET goal_json = ?2, checklist_json = ?3, policy_id = ?4, params = ?5, source = ?6,
                status = ?7, retries = ?8, escalations = ?9, ended_at = ?10 WHERE task_id = ?1",
        params![
            t.task_id,
            t.goal_json.to_string(),
            t.checklist_json.to_string(),
            t.policy_id.as_str(),
            Value::Object(t.params.clone()).to_string(),
            t.source.as_str(),
            t.status.as_str(),
            t.retries,
            t.escalations,
            t.ended_at,
        ],
    )?;
    Ok(())
}

/// End a task: set its final status and replace the goal with its redacted form,
/// so no user text outlives the task.
pub fn finish_task(conn: &Connection, task_id: &str, status: TaskStatus, redacted_goal: &Value, now_ms: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE ctx_policy_tasks SET status = ?2, goal_json = ?3, ended_at = ?4 WHERE task_id = ?1 AND status = 'active'",
        params![task_id, status.as_str(), redacted_goal.to_string(), now_ms],
    )?;
    Ok(n > 0)
}

fn row_to_task(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRow> {
    let goal: String = r.get(2)?;
    let checklist: String = r.get(3)?;
    let policy: String = r.get(4)?;
    let params_s: String = r.get(5)?;
    let source: String = r.get(6)?;
    let status: String = r.get(7)?;
    Ok(TaskRow {
        task_id: r.get(0)?,
        session_key: r.get(1)?,
        goal_json: serde_json::from_str(&goal).unwrap_or(Value::Null),
        checklist_json: serde_json::from_str(&checklist).unwrap_or(Value::Null),
        policy_id: PolicyId::parse_or_full(&policy),
        params: serde_json::from_str::<Value>(&params_s).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default(),
        source: Source::parse(&source).unwrap_or(Source::Fallback),
        status: TaskStatus::parse(&status).unwrap_or(TaskStatus::Interrupted),
        retries: r.get::<_, i64>(8)?.max(0) as u32,
        escalations: r.get::<_, i64>(9)?.max(0) as u32,
        started_at: r.get(10)?,
        ended_at: r.get(11)?,
    })
}

const TASK_COLS: &str = "task_id, session_key, goal_json, checklist_json, policy_id, params, source, status, retries, escalations, started_at, ended_at";

pub fn get_task(conn: &Connection, task_id: &str) -> Result<Option<TaskRow>> {
    conn.query_row(&format!("SELECT {TASK_COLS} FROM ctx_policy_tasks WHERE task_id = ?1"), params![task_id], row_to_task)
        .optional()
}

/// The running task of a chat, if any (the newest active one).
pub fn active_task(conn: &Connection, session_key: &str) -> Result<Option<TaskRow>> {
    conn.query_row(
        &format!(
            "SELECT {TASK_COLS} FROM ctx_policy_tasks WHERE session_key = ?1 AND status = 'active'
             ORDER BY started_at DESC, rowid DESC LIMIT 1"
        ),
        params![session_key],
        row_to_task,
    )
    .optional()
}

/// The newest `limit` tasks of a chat, newest first.
pub fn recent_tasks(conn: &Connection, session_key: &str, limit: i64) -> Result<Vec<TaskRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_COLS} FROM ctx_policy_tasks WHERE session_key = ?1 ORDER BY started_at DESC, rowid DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![session_key, limit.max(0)], row_to_task)?;
    rows.collect()
}

/// Mark every task still `active` as `interrupted`, with its user text removed.
/// Run when the engine starts and when a new turn begins: an `active` row from
/// an earlier run means the app was killed in the middle of it.
pub fn mark_interrupted(conn: &Connection, session_key: Option<&str>, now_ms: i64) -> Result<usize> {
    let ids: Vec<(String, String)> = {
        let mut stmt = match session_key {
            Some(_) => conn.prepare("SELECT task_id, goal_json FROM ctx_policy_tasks WHERE status = 'active' AND session_key = ?1")?,
            None => conn.prepare("SELECT task_id, goal_json FROM ctx_policy_tasks WHERE status = 'active' AND ?1 IS NULL")?,
        };
        let rows = stmt.query_map(params![session_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<Vec<_>>>()?
    };
    let mut n = 0;
    for (id, goal) in ids {
        let redacted = redact_goal_json(&goal, TaskStatus::Interrupted);
        n += conn.execute(
            "UPDATE ctx_policy_tasks SET status = 'interrupted', goal_json = ?2, ended_at = ?3 WHERE task_id = ?1",
            params![id, redacted.to_string(), now_ms],
        )?;
    }
    Ok(n)
}

/// The ids-and-state form of a stored goal.
fn redact_goal_json(raw: &str, status: TaskStatus) -> Value {
    let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    json!({
        "goal_id": v.get("goal_id").cloned().unwrap_or(Value::Null),
        "linked_goal_id": v.get("linked_goal_id").cloned().unwrap_or(Value::Null),
        "created_at": v.get("created_at").cloned().unwrap_or(Value::Null),
        "status": status.as_str(),
        "steer_count": v.get("steer_messages").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0),
    })
}

// ---------------------------------------------------------------- events

/// One event: ids and numbers only.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventRow {
    pub task_id: Option<String>,
    pub step: u32,
    pub kind: String,
    pub policy_id: Option<String>,
    pub included_ids: Vec<String>,
    pub excluded_ids: Vec<String>,
    /// A short machine reason (`pin`, `rule:R_X`, `fallback:tool_error`, …).
    pub reason: Option<String>,
    pub input_tokens: Option<i64>,
    pub t7_tokens: Option<i64>,
    pub latency_ms: Option<i64>,
    pub first_token_ms: Option<i64>,
}

pub fn insert_event(conn: &Connection, session_key: &str, e: &EventRow, now_ms: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO ctx_policy_events (task_id, session_key, at, step, kind, policy_id, included_ids, excluded_ids, reason,
                                        input_tokens, t7_tokens, latency_ms, first_token_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            e.task_id,
            session_key,
            now_ms,
            e.step,
            e.kind,
            e.policy_id,
            json!(e.included_ids).to_string(),
            json!(e.excluded_ids).to_string(),
            e.reason.as_ref().map(|r| r.chars().take(200).collect::<String>()),
            e.input_tokens,
            e.t7_tokens,
            e.latency_ms,
            e.first_token_ms,
        ],
    )?;
    let seq = conn.last_insert_rowid();
    trim_events(conn, session_key, MAX_EVENT_ROWS)?;
    Ok(seq)
}

pub fn trim_events(conn: &Connection, session_key: &str, keep: i64) -> Result<usize> {
    conn.execute(
        "DELETE FROM ctx_policy_events WHERE session_key = ?1 AND seq NOT IN (
            SELECT seq FROM ctx_policy_events WHERE session_key = ?1 ORDER BY seq DESC LIMIT ?2)",
        params![session_key, keep.max(0)],
    )
}

/// The newest `limit` events of a chat (or of one task), oldest first.
pub fn events(conn: &Connection, session_key: &str, task_id: Option<&str>, limit: i64) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT seq, task_id, at, step, kind, policy_id, included_ids, excluded_ids, reason, input_tokens, t7_tokens,
                latency_ms, first_token_ms
         FROM ctx_policy_events WHERE session_key = ?1 AND (?2 IS NULL OR task_id = ?2)
         ORDER BY seq DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![session_key, task_id, limit.max(0)], |r| {
        let inc: String = r.get(6)?;
        let exc: String = r.get(7)?;
        Ok(json!({
            "seq": r.get::<_, i64>(0)?,
            "taskId": r.get::<_, Option<String>>(1)?,
            "at": r.get::<_, i64>(2)?,
            "step": r.get::<_, i64>(3)?,
            "kind": r.get::<_, String>(4)?,
            "policy": r.get::<_, Option<String>>(5)?,
            "included": serde_json::from_str::<Value>(&inc).unwrap_or(json!([])),
            "excluded": serde_json::from_str::<Value>(&exc).unwrap_or(json!([])),
            "reason": r.get::<_, Option<String>>(8)?,
            "inputTokens": r.get::<_, Option<i64>>(9)?,
            "t7Tokens": r.get::<_, Option<i64>>(10)?,
            "latencyMs": r.get::<_, Option<i64>>(11)?,
            "firstTokenMs": r.get::<_, Option<i64>>(12)?,
        }))
    })?;
    let mut out: Vec<Value> = rows.collect::<Result<Vec<_>>>()?;
    out.reverse();
    Ok(out)
}

// ---------------------------------------------------------------- reset

/// Drop every TCPE row of one chat (part of `ctx.reset`).
pub fn reset_session(conn: &Connection, session_key: &str) -> Result<usize> {
    let mut n = conn.execute("DELETE FROM ctx_policy_pins WHERE session_key = ?1", params![session_key])?;
    n += conn.execute("DELETE FROM ctx_policy_tasks WHERE session_key = ?1", params![session_key])?;
    n += conn.execute("DELETE FROM ctx_policy_events WHERE session_key = ?1", params![session_key])?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::store as tree_store;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        tree_store::ensure_tables(&conn).unwrap();
        conn
    }

    fn task(id: &str, session: &str) -> TaskRow {
        TaskRow {
            task_id: id.into(),
            session_key: session.into(),
            goal_json: json!({"goal_id": "tg_1", "user_request": "secret words", "steer_messages": ["more"]}),
            checklist_json: json!({"policy": "T1"}),
            policy_id: PolicyId::T1,
            params: PolicyParams::new(),
            source: Source::Ai,
            status: TaskStatus::Active,
            retries: 0,
            escalations: 0,
            started_at: 10,
            ended_at: None,
        }
    }

    #[test]
    fn the_schema_is_version_two_with_the_three_tables() {
        let conn = db();
        assert_eq!(tree_store::schema_version(&conn), Some(2));
        for t in ["ctx_policy_pins", "ctx_policy_tasks", "ctx_policy_events"] {
            let n: i64 = conn
                .query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", params![t], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "{t}");
        }
    }

    #[test]
    fn an_old_v1_database_gains_the_new_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE ctx_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO ctx_meta VALUES ('schema_version', '1');
             INSERT INTO ctx_meta VALUES ('threshold_percent', '55');",
        )
        .unwrap();
        tree_store::ensure_tables(&conn).unwrap();
        assert_eq!(tree_store::schema_version(&conn), Some(2));
        let v: String = conn.query_row("SELECT value FROM ctx_meta WHERE key = 'threshold_percent'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "55", "old settings survive the upgrade");
        set_pin(&conn, "s", PolicyId::T5, &PolicyParams::new(), 1).unwrap();
        assert_eq!(get_pin(&conn, "s").unwrap().unwrap().policy_id, PolicyId::T5);
    }

    #[test]
    fn pins_round_trip_and_a_bad_row_is_no_pin() {
        let conn = db();
        assert!(get_pin(&conn, "s").unwrap().is_none());
        let mut p = PolicyParams::new();
        p.insert("recent_turns".into(), json!(3));
        set_pin(&conn, "s", PolicyId::T5, &p, 7).unwrap();
        let pin = get_pin(&conn, "s").unwrap().unwrap();
        assert_eq!(pin.params["recent_turns"], 3);
        conn.execute("UPDATE ctx_policy_pins SET policy_id = 'T9'", []).unwrap();
        assert!(get_pin(&conn, "s").unwrap().is_none());
        assert!(clear_pin(&conn, "s").unwrap());
        assert!(!clear_pin(&conn, "s").unwrap());
    }

    #[test]
    fn finishing_a_task_removes_the_users_words() {
        let conn = db();
        insert_task(&conn, &task("k1", "s")).unwrap();
        assert_eq!(active_task(&conn, "s").unwrap().unwrap().task_id, "k1");
        let redacted = json!({"goal_id": "tg_1", "status": "completed"});
        assert!(finish_task(&conn, "k1", TaskStatus::Completed, &redacted, 20).unwrap());
        assert!(!finish_task(&conn, "k1", TaskStatus::Failed, &redacted, 21).unwrap(), "a finished task stays finished");
        let t = get_task(&conn, "k1").unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Completed);
        assert!(!t.goal_json.to_string().contains("secret"));
        assert_eq!(t.ended_at, Some(20));
        assert!(active_task(&conn, "s").unwrap().is_none());
    }

    #[test]
    fn a_task_left_active_is_marked_interrupted() {
        let conn = db();
        insert_task(&conn, &task("k1", "s")).unwrap();
        insert_task(&conn, &task("k2", "other")).unwrap();
        assert_eq!(mark_interrupted(&conn, Some("s"), 30).unwrap(), 1);
        let t = get_task(&conn, "k1").unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Interrupted);
        assert!(!t.goal_json.to_string().contains("secret"));
        assert_eq!(t.goal_json["steer_count"], 1);
        assert_eq!(get_task(&conn, "k2").unwrap().unwrap().status, TaskStatus::Active);
    }

    #[test]
    fn events_hold_ids_and_numbers_and_are_trimmed() {
        let conn = db();
        for i in 0..5 {
            let e = EventRow { kind: "view".into(), step: i, included_ids: vec!["turn/t1".into()], input_tokens: Some(100), ..Default::default() };
            insert_event(&conn, "s", &e, i as i64).unwrap();
        }
        trim_events(&conn, "s", 3).unwrap();
        let ev = events(&conn, "s", None, 50).unwrap();
        assert_eq!(ev.len(), 3);
        assert_eq!(ev[0]["step"], 2, "oldest kept first");
        assert_eq!(ev[2]["included"], json!(["turn/t1"]));
    }

    #[test]
    fn reset_session_drops_only_that_chats_rows() {
        let conn = db();
        set_pin(&conn, "s", PolicyId::T1, &PolicyParams::new(), 1).unwrap();
        set_pin(&conn, "o", PolicyId::T1, &PolicyParams::new(), 1).unwrap();
        insert_task(&conn, &task("k1", "s")).unwrap();
        insert_event(&conn, "s", &EventRow { kind: "x".into(), ..Default::default() }, 1).unwrap();
        tree_store::reset_session(&conn, "s").unwrap();
        assert!(get_pin(&conn, "s").unwrap().is_none());
        assert!(get_task(&conn, "k1").unwrap().is_none());
        assert!(events(&conn, "s", None, 10).unwrap().is_empty());
        assert!(get_pin(&conn, "o").unwrap().is_some());
    }
}
