//! Run ledger: every run a room (a group, a playbook, a team room) starts,
//! kept in the database so it survives a restart and one agent can be in
//! runs of several rooms at once (unified plan, Phase 2).
//!
//! A row is written *before* the run starts (`starting`), so a very short run
//! that finishes at once still finds it. Messages from other rooms that
//! reach a live run are kept in `ws_run_triggers`, so the run's answer goes
//! to every room that asked, each as a reply to its own trigger.

use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_runs (
            id TEXT PRIMARY KEY,
            agent TEXT NOT NULL,
            room TEXT NOT NULL,
            trigger_msg TEXT,
            started_by TEXT NOT NULL,
            env_session TEXT NOT NULL,
            status TEXT NOT NULL,
            tokens_before INTEGER NOT NULL DEFAULT 0,
            tokens_used INTEGER NOT NULL DEFAULT 0,
            outcome TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER);
         CREATE INDEX IF NOT EXISTS ws_runs_live ON ws_runs(agent, status);
         CREATE INDEX IF NOT EXISTS ws_runs_room ON ws_runs(room, started_at);
         CREATE TABLE IF NOT EXISTS ws_run_triggers (
            run_id TEXT NOT NULL, room TEXT NOT NULL, message_id TEXT NOT NULL,
            at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (run_id, room, message_id));",
    )
}

/// One run of the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub id: String,
    /// `agent:<id>`.
    pub agent: String,
    /// `group:<id>`, `team:<root>`, `playbook:<id>`, ...
    pub room: String,
    pub trigger_msg: Option<String>,
    pub started_by: String,
    /// The chat whose env the run uses.
    pub env_session: String,
    pub status: String,
    pub tokens_before: i64,
    pub started_at: i64,
}

const COLS: &str = "id, agent, room, trigger_msg, started_by, env_session, status, tokens_before, started_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: r.get(0)?,
        agent: r.get(1)?,
        room: r.get(2)?,
        trigger_msg: r.get(3)?,
        started_by: r.get(4)?,
        env_session: r.get(5)?,
        status: r.get(6)?,
        tokens_before: r.get(7)?,
        started_at: r.get(8)?,
    })
}

/// Open a run (status `starting`) before it starts. Returns its id.
pub fn open(conn: &Connection, agent: &str, room: &str, trigger: Option<&str>, started_by: &str, env_session: &str, tokens_before: i64) -> rusqlite::Result<String> {
    let id = super::ids::new_id("run");
    let now = now_ms();
    conn.execute(
        "INSERT INTO ws_runs (id, agent, room, trigger_msg, started_by, env_session, status, tokens_before, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', ?7, ?8)",
        params![id, agent, room, trigger, started_by, env_session, tokens_before, now],
    )?;
    if let Some(t) = trigger {
        conn.execute("INSERT OR IGNORE INTO ws_run_triggers (run_id, room, message_id, at) VALUES (?1, ?2, ?3, ?4)", params![id, room, t, now])?;
    }
    Ok(id)
}

pub fn set_status(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE ws_runs SET status = ?2 WHERE id = ?1 AND status IN ('starting','running')", params![id, status]).map(|_| ())
}

/// End a run.
pub fn close(conn: &Connection, id: &str, status: &str, tokens_used: i64, outcome: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE ws_runs SET status = ?2, tokens_used = ?3, outcome = COALESCE(?4, outcome), ended_at = ?5 WHERE id = ?1",
        params![id, status, tokens_used, outcome, now_ms()],
    )
    .map(|_| ())
}

/// A message of `room` reached the live run `id`: the run answers it too.
pub fn add_trigger(conn: &Connection, id: &str, room: &str, message_id: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR IGNORE INTO ws_run_triggers (run_id, room, message_id, at) VALUES (?1, ?2, ?3, ?4)", params![id, room, message_id, now_ms()])
        .map(|_| ())
}

/// Every room the run answers, each with its latest trigger, in the order
/// the rooms first reached the run.
pub fn triggers(conn: &Connection, id: &str) -> rusqlite::Result<Vec<(String, String)>> {
    let mut st = conn.prepare("SELECT room, message_id FROM ws_run_triggers WHERE run_id = ?1 ORDER BY at, rowid")?;
    let all: Vec<(String, String)> = st.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut out: Vec<(String, String)> = Vec::new();
    for (room, msg) in all {
        match out.iter_mut().find(|(r, _)| *r == room) {
            Some(slot) => slot.1 = msg,
            None => out.push((room, msg)),
        }
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Run>> {
    conn.query_row(&format!("SELECT {COLS} FROM ws_runs WHERE id = ?1"), params![id], row).optional()
}

/// The newest live run of `agent` (`agent:<id>`), any room.
pub fn live_for(conn: &Connection, agent: &str) -> rusqlite::Result<Option<Run>> {
    conn.query_row(
        &format!("SELECT {COLS} FROM ws_runs WHERE agent = ?1 AND status IN ('starting','running') ORDER BY started_at DESC, rowid DESC LIMIT 1"),
        params![agent],
        row,
    )
    .optional()
}

/// Agents with a live run that answers `room` (the run's own room or a
/// trigger added from it).
pub fn live_in_room(conn: &Connection, room: &str) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare(
        "SELECT DISTINCT r.agent FROM ws_runs r WHERE r.status IN ('starting','running')
           AND (r.room = ?1 OR EXISTS(SELECT 1 FROM ws_run_triggers t WHERE t.run_id = r.id AND t.room = ?1))
         ORDER BY r.agent",
    )?;
    let v = st.query_map(params![room], |r| r.get(0))?.collect();
    v
}

/// The room whose trigger reached the live run of `agent` last (memory the
/// run stores gets that room's category).
pub fn newest_room(conn: &Connection, agent: &str) -> rusqlite::Result<Option<String>> {
    let Some(run) = live_for(conn, agent)? else { return Ok(None) };
    let room: Option<String> = conn
        .query_row("SELECT room FROM ws_run_triggers WHERE run_id = ?1 ORDER BY at DESC, rowid DESC LIMIT 1", params![run.id], |r| r.get(0))
        .optional()?;
    Ok(Some(room.unwrap_or(run.room)))
}

/// Every live run.
pub fn live(conn: &Connection) -> rusqlite::Result<Vec<Run>> {
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM ws_runs WHERE status IN ('starting','running') ORDER BY started_at"))?;
    let v = st.query_map([], row)?.collect();
    v
}

/// After a restart: live runs whose agent is not running any more are
/// marked `interrupted`. Returns them.
pub fn recover(conn: &Connection, is_running: impl Fn(&str) -> bool) -> rusqlite::Result<Vec<Run>> {
    let mut out = Vec::new();
    for r in live(conn)? {
        if !is_running(&r.agent) {
            close(conn, &r.id, "interrupted", 0, None)?;
            out.push(r);
        }
    }
    Ok(out)
}

/// Recent runs of a room with their outcome, newest first (the "why no
/// reply" view).
pub fn recent_in_room(conn: &Connection, room: &str, limit: usize) -> rusqlite::Result<Vec<(Run, Option<String>)>> {
    let mut st = conn.prepare(&format!("SELECT {COLS}, outcome FROM ws_runs WHERE room = ?1 ORDER BY started_at DESC, rowid DESC LIMIT ?2"))?;
    let v = st.query_map(params![room, limit as i64], |r| Ok((row(r)?, r.get(9)?)))?.collect();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_tables(&c).unwrap();
        c
    }

    #[test]
    fn open_close_and_live() {
        let c = db();
        let id = open(&c, "agent:a", "group:g1", Some("m1"), "user", "chat1", 5).unwrap();
        assert_eq!(live_for(&c, "agent:a").unwrap().unwrap().id, id);
        assert_eq!(live_in_room(&c, "group:g1").unwrap(), vec!["agent:a".to_string()]);
        add_trigger(&c, &id, "group:g2", "m2").unwrap();
        assert_eq!(live_in_room(&c, "group:g2").unwrap(), vec!["agent:a".to_string()]);
        let t = triggers(&c, &id).unwrap();
        assert_eq!(t, vec![("group:g1".into(), "m1".into()), ("group:g2".into(), "m2".into())]);
        assert_eq!(newest_room(&c, "agent:a").unwrap().as_deref(), Some("group:g2"));
        close(&c, &id, "done", 7, Some("posted")).unwrap();
        assert!(live_for(&c, "agent:a").unwrap().is_none());
        let (r, outcome) = recent_in_room(&c, "group:g1", 5).unwrap().remove(0);
        assert_eq!((r.status.as_str(), outcome.as_deref()), ("done", Some("posted")));
    }

    #[test]
    fn recover_marks_dead_runs_interrupted() {
        let c = db();
        let a = open(&c, "agent:a", "group:g", None, "user", "chat1", 0).unwrap();
        let b = open(&c, "agent:b", "group:g", None, "user", "chat1", 0).unwrap();
        let gone = recover(&c, |agent| agent == "agent:b").unwrap();
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].id, a);
        assert_eq!(get(&c, &a).unwrap().unwrap().status, "interrupted");
        assert_eq!(get(&c, &b).unwrap().unwrap().status, "starting");
    }
}
