//! TCPE tables in the session database (pins, tasks, events, the model's
//! `ctx task` pick and rule proposals) and the rule file.
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
        CREATE TABLE IF NOT EXISTS ctx_policy_picks (
            session_key TEXT PRIMARY KEY,
            policy      TEXT,
            params      TEXT NOT NULL DEFAULT '{}',
            ids         TEXT NOT NULL DEFAULT '[]',
            focus       TEXT,
            at          INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ctx_policy_proposals (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            at          INTEGER NOT NULL,
            status      TEXT NOT NULL DEFAULT 'proposed',
            rule_json   TEXT NOT NULL,
            errors      TEXT NOT NULL DEFAULT '[]'
        );
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

pub fn set_pin(
    conn: &Connection,
    session_key: &str,
    policy_id: PolicyId,
    params: &PolicyParams,
    now_ms: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_policy_pins (session_key, policy_id, params, at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_key) DO UPDATE SET policy_id = excluded.policy_id, params = excluded.params, at = excluded.at",
        params![session_key, policy_id.as_str(), Value::Object(params.clone()).to_string(), now_ms],
    )?;
    Ok(())
}

pub fn clear_pin(conn: &Connection, session_key: &str) -> Result<bool> {
    Ok(conn.execute(
        "DELETE FROM ctx_policy_pins WHERE session_key = ?1",
        params![session_key],
    )? > 0)
}

/// The pin of a chat. A row whose policy id is not canonical reads as no pin.
pub fn get_pin(conn: &Connection, session_key: &str) -> Result<Option<Pin>> {
    let row = conn
        .query_row(
            "SELECT policy_id, params, at FROM ctx_policy_pins WHERE session_key = ?1",
            params![session_key],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(id, p, at)| {
        let policy_id = PolicyId::parse(&id)?;
        let params = serde_json::from_str::<Value>(&p)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        Some(Pin {
            policy_id,
            params,
            at,
        })
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
pub fn finish_task(
    conn: &Connection,
    task_id: &str,
    status: TaskStatus,
    redacted_goal: &Value,
    now_ms: i64,
) -> Result<bool> {
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
        params: serde_json::from_str::<Value>(&params_s)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default(),
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
    conn.query_row(
        &format!("SELECT {TASK_COLS} FROM ctx_policy_tasks WHERE task_id = ?1"),
        params![task_id],
        row_to_task,
    )
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
pub fn mark_interrupted(
    conn: &Connection,
    session_key: Option<&str>,
    now_ms: i64,
) -> Result<usize> {
    let ids: Vec<(String, String)> = {
        let mut stmt = match session_key {
            Some(_) => conn.prepare("SELECT task_id, goal_json FROM ctx_policy_tasks WHERE status = 'active' AND session_key = ?1")?,
            None => conn.prepare("SELECT task_id, goal_json FROM ctx_policy_tasks WHERE status = 'active' AND ?1 IS NULL")?,
        };
        let rows = stmt.query_map(params![session_key], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
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

pub fn insert_event(
    conn: &Connection,
    session_key: &str,
    e: &EventRow,
    now_ms: i64,
) -> Result<i64> {
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
pub fn events(
    conn: &Connection,
    session_key: &str,
    task_id: Option<&str>,
    limit: i64,
) -> Result<Vec<Value>> {
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
    let mut n = conn.execute(
        "DELETE FROM ctx_policy_pins WHERE session_key = ?1",
        params![session_key],
    )?;
    n += conn.execute(
        "DELETE FROM ctx_policy_tasks WHERE session_key = ?1",
        params![session_key],
    )?;
    n += conn.execute(
        "DELETE FROM ctx_policy_events WHERE session_key = ?1",
        params![session_key],
    )?;
    n += conn.execute(
        "DELETE FROM ctx_policy_picks WHERE session_key = ?1",
        params![session_key],
    )?;
    n += conn.execute(
        "DELETE FROM ctx_policy_proposals WHERE session_key = ?1 AND status = 'proposed'",
        params![session_key],
    )?;
    Ok(n)
}

// ---------------------------------------------------------------- the model's pick

/// What the model asked for with `ctx task`, kept until the running task
/// reads it. Only one per chat: a new `ctx task` replaces the old one.
#[derive(Debug, Clone, PartialEq)]
pub struct AiPickRow {
    pub policy: Option<String>,
    pub params: Option<Value>,
    pub ids: Vec<String>,
    pub focus: Option<String>,
    pub at: i64,
}

impl AiPickRow {
    pub fn to_json(&self) -> Value {
        json!({ "policy": self.policy, "params": self.params, "ids": self.ids, "focus": self.focus, "at": self.at })
    }
}

pub fn set_pick(conn: &Connection, session_key: &str, pick: &AiPickRow) -> Result<()> {
    conn.execute(
        "INSERT INTO ctx_policy_picks (session_key, policy, params, ids, focus, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_key) DO UPDATE SET policy = excluded.policy, params = excluded.params, ids = excluded.ids,
                focus = excluded.focus, at = excluded.at",
        params![
            session_key,
            pick.policy,
            pick.params.clone().unwrap_or_else(|| json!({})).to_string(),
            Value::from(pick.ids.clone()).to_string(),
            pick.focus,
            pick.at
        ],
    )?;
    Ok(())
}

pub fn get_pick(conn: &Connection, session_key: &str) -> Result<Option<AiPickRow>> {
    conn.query_row(
        "SELECT policy, params, ids, focus, at FROM ctx_policy_picks WHERE session_key = ?1",
        params![session_key],
        |r| {
            let params_s: String = r.get(1)?;
            let ids_s: String = r.get(2)?;
            let params = serde_json::from_str::<Value>(&params_s)
                .ok()
                .filter(|v| v.as_object().is_some_and(|o| !o.is_empty()));
            let ids = serde_json::from_str::<Vec<String>>(&ids_s).unwrap_or_default();
            Ok(AiPickRow {
                policy: r.get(0)?,
                params,
                ids,
                focus: r.get(3)?,
                at: r.get(4)?,
            })
        },
    )
    .optional()
}

pub fn clear_pick(conn: &Connection, session_key: &str) -> Result<bool> {
    Ok(conn.execute(
        "DELETE FROM ctx_policy_picks WHERE session_key = ?1",
        params![session_key],
    )? > 0)
}

// ---------------------------------------------------------------- rule proposals

/// A rule the model proposed with `ctx task text:...`. Never active until the
/// user approves it, and approving validates it again.
#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    pub id: i64,
    pub session_key: String,
    pub at: i64,
    pub status: String,
    pub rule: Value,
    pub errors: Value,
}

impl Proposal {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "sessionKey": self.session_key, "at": self.at, "status": self.status, "rule": self.rule, "errors": self.errors })
    }
}

/// Most proposals waiting at once; the oldest waiting one goes first.
pub const MAX_PROPOSALS: i64 = 50;

pub fn add_proposal(
    conn: &Connection,
    session_key: &str,
    rule: &Value,
    errors: &Value,
    now_ms: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO ctx_policy_proposals (session_key, at, status, rule_json, errors) VALUES (?1, ?2, 'proposed', ?3, ?4)",
        params![session_key, now_ms, rule.to_string(), errors.to_string()],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "DELETE FROM ctx_policy_proposals WHERE status = 'proposed' AND id NOT IN
           (SELECT id FROM ctx_policy_proposals WHERE status = 'proposed' ORDER BY id DESC LIMIT ?1)",
        params![MAX_PROPOSALS],
    )?;
    Ok(id)
}

fn row_to_proposal(r: &rusqlite::Row<'_>) -> rusqlite::Result<Proposal> {
    let rule: String = r.get(4)?;
    let errors: String = r.get(5)?;
    Ok(Proposal {
        id: r.get(0)?,
        session_key: r.get(1)?,
        at: r.get(2)?,
        status: r.get(3)?,
        rule: serde_json::from_str(&rule).unwrap_or(Value::Null),
        errors: serde_json::from_str(&errors).unwrap_or_else(|_| json!([])),
    })
}

/// Proposals, newest first; `status` filters (`proposed`, `approved`, `rejected`).
pub fn list_proposals(conn: &Connection, status: Option<&str>) -> Result<Vec<Proposal>> {
    let mut stmt = conn.prepare(
        "SELECT id, session_key, at, status, rule_json, errors FROM ctx_policy_proposals
         WHERE ?1 IS NULL OR status = ?1 ORDER BY id DESC LIMIT 200",
    )?;
    let rows = stmt.query_map(params![status], row_to_proposal)?;
    rows.collect()
}

pub fn get_proposal(conn: &Connection, id: i64) -> Result<Option<Proposal>> {
    conn.query_row(
        "SELECT id, session_key, at, status, rule_json, errors FROM ctx_policy_proposals WHERE id = ?1",
        params![id],
        row_to_proposal,
    )
    .optional()
}

pub fn set_proposal_status(conn: &Connection, id: i64, status: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE ctx_policy_proposals SET status = ?2 WHERE id = ?1 AND status = 'proposed'",
        params![id, status],
    )? > 0)
}

// ---------------------------------------------------------------- rule file

/// The rule file, next to `native-agent-tool-rules.json` (the workspace's parent).
pub const RULE_FILE_NAME: &str = "native-agent-context-policies.json";

pub fn rules_path(workspace_path: &str) -> std::path::PathBuf {
    let w = std::path::Path::new(workspace_path);
    w.parent().unwrap_or(w).join(RULE_FILE_NAME)
}

/// The rule set in force and where it came from.
#[derive(Debug, Clone)]
pub struct LoadedRules {
    pub set: super::dsl_parser::RuleSet,
    /// The file as written (None when there is no file or it is unreadable).
    pub doc: Option<Value>,
    /// `file`, `builtin` (no file) or `builtin_after_error`.
    pub origin: &'static str,
    /// Why the file was not used, when it was not.
    pub warning: Option<String>,
}

/// Read the rule file. No file, or a file that does not read or validate,
/// gives the built-in default (T7 only) and a warning.
pub fn load_rules(workspace_path: &str) -> LoadedRules {
    let path = rules_path(workspace_path);
    let builtin = super::dsl_parser::builtin_default;
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LoadedRules {
                set: builtin(),
                doc: None,
                origin: "builtin",
                warning: None,
            };
        }
        Err(e) => {
            return LoadedRules {
                set: builtin(),
                doc: None,
                origin: "builtin_after_error",
                warning: Some(format!("the rule file could not be read: {e}")),
            };
        }
    };
    let doc: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            return LoadedRules {
                set: builtin(),
                doc: None,
                origin: "builtin_after_error",
                warning: Some(format!("the rule file is not valid JSON: {e}")),
            };
        }
    };
    match super::dsl_validator::validate(&doc) {
        Ok(set) => LoadedRules {
            set,
            doc: Some(doc),
            origin: "file",
            warning: None,
        },
        Err(errs) => {
            let first = errs.first().map(|e| e.to_string()).unwrap_or_default();
            LoadedRules {
                set: builtin(),
                doc: Some(doc),
                origin: "builtin_after_error",
                warning: Some(format!(
                    "the rule file has {} problem(s) and is not used; first: {first}",
                    errs.len()
                )),
            }
        }
    }
}

/// Validate, then write through a temp file and a rename. On any problem the
/// old file is left exactly as it was.
pub fn save_rules(
    workspace_path: &str,
    doc: &Value,
) -> std::result::Result<super::dsl_parser::RuleSet, Vec<super::dsl_parser::DslError>> {
    use super::dsl_parser::DslError;
    let set = super::dsl_validator::validate(doc)?;
    let path = rules_path(workspace_path);
    let io = |e: std::io::Error| {
        vec![DslError::new(
            "$",
            format!("the rule file could not be written: {e}"),
        )]
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes =
        serde_json::to_vec_pretty(doc).map_err(|e| vec![DslError::new("$", e.to_string())])?;
    std::fs::write(&tmp, bytes).map_err(io)?;
    std::fs::rename(&tmp, &path).map_err(io)?;
    Ok(set)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::store as tree_store;

    #[test]
    fn rule_file_saves_only_valid_rules_and_keeps_the_old_file_on_error() {
        let dir = std::env::temp_dir().join(format!("tcpe-rules-{}", std::process::id()));
        let ws = dir.join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let ws = ws.to_string_lossy().to_string();
        let _ = std::fs::remove_file(rules_path(&ws));
        let none = load_rules(&ws);
        assert_eq!((none.origin, none.set.rules.len()), ("builtin", 0));
        let good = crate::context_policy::dsl_parser::tests::design_example();
        assert_eq!(save_rules(&ws, &good).unwrap().rules.len(), 3);
        let before = std::fs::read(rules_path(&ws)).unwrap();
        let bad = json!({"version": 1, "rules": [{"id": "R_X", "if": "nope.x == 1", "then": {"policy": "T9"}}]});
        assert_eq!(save_rules(&ws, &bad).unwrap_err().len(), 2);
        assert_eq!(
            std::fs::read(rules_path(&ws)).unwrap(),
            before,
            "the old file is untouched"
        );
        assert_eq!(load_rules(&ws).origin, "file");
        std::fs::write(rules_path(&ws), b"{not json").unwrap();
        let broken = load_rules(&ws);
        assert_eq!(broken.origin, "builtin_after_error");
        assert!(broken.warning.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picks_and_proposals_round_trip_and_reset_clears_them() {
        let conn = db();
        let pick = AiPickRow {
            policy: Some("T6".into()),
            params: None,
            ids: vec!["turn/t2".into()],
            focus: Some("x".into()),
            at: 5,
        };
        set_pick(&conn, "s", &pick).unwrap();
        assert_eq!(get_pick(&conn, "s").unwrap().unwrap(), pick);
        let id = add_proposal(&conn, "s", &json!({"id": "R_A"}), &json!([]), 6).unwrap();
        assert_eq!(list_proposals(&conn, Some("proposed")).unwrap().len(), 1);
        assert!(set_proposal_status(&conn, id, "rejected").unwrap());
        assert!(
            !set_proposal_status(&conn, id, "approved").unwrap(),
            "only a waiting proposal changes"
        );
        add_proposal(&conn, "s", &json!({"id": "R_B"}), &json!([]), 7).unwrap();
        reset_session(&conn, "s").unwrap();
        assert!(get_pick(&conn, "s").unwrap().is_none());
        assert_eq!(list_proposals(&conn, Some("proposed")).unwrap().len(), 0);
    }

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
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![t],
                    |r| r.get(0),
                )
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
        let v: String = conn
            .query_row(
                "SELECT value FROM ctx_meta WHERE key = 'threshold_percent'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "55", "old settings survive the upgrade");
        set_pin(&conn, "s", PolicyId::T5, &PolicyParams::new(), 1).unwrap();
        assert_eq!(
            get_pin(&conn, "s").unwrap().unwrap().policy_id,
            PolicyId::T5
        );
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
        conn.execute("UPDATE ctx_policy_pins SET policy_id = 'T9'", [])
            .unwrap();
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
        assert!(
            !finish_task(&conn, "k1", TaskStatus::Failed, &redacted, 21).unwrap(),
            "a finished task stays finished"
        );
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
        assert_eq!(
            get_task(&conn, "k2").unwrap().unwrap().status,
            TaskStatus::Active
        );
    }

    #[test]
    fn events_hold_ids_and_numbers_and_are_trimmed() {
        let conn = db();
        for i in 0..5 {
            let e = EventRow {
                kind: "view".into(),
                step: i,
                included_ids: vec!["turn/t1".into()],
                input_tokens: Some(100),
                ..Default::default()
            };
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
        insert_event(
            &conn,
            "s",
            &EventRow {
                kind: "x".into(),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        tree_store::reset_session(&conn, "s").unwrap();
        assert!(get_pin(&conn, "s").unwrap().is_none());
        assert!(get_task(&conn, "k1").unwrap().is_none());
        assert!(events(&conn, "s", None, 10).unwrap().is_empty());
        assert!(get_pin(&conn, "o").unwrap().is_some());
    }
}
