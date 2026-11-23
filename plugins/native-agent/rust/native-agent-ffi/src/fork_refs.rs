//! Forks by reference (plan.md Phase 4, "forkChat").
//!
//! A forked chat does not copy the source transcript. `ws_fork_refs` says
//! "this chat starts with the first `upto` messages of `source_key`", and
//! only the fork's own messages are stored under its key. Reading a chat
//! (`db::load_session_messages_raw`) resolves the chain; saving one
//! (`db::save_session`) stores only what is past the shared prefix.
//!
//! A source chat can still be rewound, edited or deleted. Before its rows
//! that some fork references would change, they move to a hidden detached
//! container (`forkbase:<id>`, agent `__forkbase`, never listed), and the
//! forks are repointed at it. A container nobody references is dropped.
//!
//! The fork's ref in `ws_refs` (when the workspace registry is present) is
//! the permission view of the same link: while it is suspended (the range
//! is in Trash) or revoked, the fork reads without the referenced range.

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::Message;
use crate::NativeAgentError;

/// Agent id of the hidden containers; `list_sessions("main")` never sees it.
pub const CONTAINER_AGENT: &str = "__forkbase";
/// Session key prefix of the hidden containers.
pub const CONTAINER_PREFIX: &str = "forkbase:";
/// Longest fork chain followed (a fork of a fork of …).
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkRef {
    pub source: String,
    pub upto: usize,
    pub ref_id: Option<String>,
}

pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_fork_refs (
            session_key TEXT PRIMARY KEY,
            source_key  TEXT NOT NULL,
            upto        INTEGER NOT NULL,
            ref_id      TEXT,
            created_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS ws_fork_refs_source ON ws_fork_refs(source_key);",
    )
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", params![name], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// The fork link of `session_key`, if it is a fork.
pub fn get(conn: &Connection, session_key: &str) -> Result<Option<ForkRef>, NativeAgentError> {
    if !table_exists(conn, "ws_fork_refs") {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT source_key, upto, ref_id FROM ws_fork_refs WHERE session_key = ?1",
            params![session_key],
            |r| Ok(ForkRef { source: r.get(0)?, upto: r.get::<_, i64>(1)?.max(0) as usize, ref_id: r.get(2)? }),
        )
        .optional()?)
}

/// Link `session_key` to the first `upto` messages of `source_key`.
pub fn link(conn: &Connection, session_key: &str, source_key: &str, upto: usize, ref_id: Option<&str>) -> Result<(), NativeAgentError> {
    ensure_table(conn)?;
    conn.execute(
        "INSERT INTO ws_fork_refs (session_key, source_key, upto, ref_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_key) DO UPDATE SET source_key = excluded.source_key, upto = excluded.upto, ref_id = excluded.ref_id",
        params![session_key, source_key, upto as i64, ref_id, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

/// Set the ws_refs id that stands for this link (after the registry made it).
pub fn set_ref_id(conn: &Connection, session_key: &str, ref_id: &str) -> Result<(), NativeAgentError> {
    conn.execute("UPDATE ws_fork_refs SET ref_id = ?2 WHERE session_key = ?1", params![session_key, ref_id])?;
    Ok(())
}

/// Whether the link's permission ref lets the fork read the range now.
/// No registry, no ref id or no row: the link alone decides (live).
pub fn ref_live(conn: &Connection, f: &ForkRef) -> bool {
    let Some(rid) = f.ref_id.as_deref() else { return true };
    if !table_exists(conn, "ws_refs") {
        return true;
    }
    let state: Option<String> = conn
        .query_row("SELECT state FROM ws_refs WHERE id = ?1", params![rid], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    !matches!(state.as_deref(), Some("suspended") | Some("revoked"))
}

/// The referenced prefix of `session_key` (empty when it is not a fork or
/// the ref is not live).
pub fn resolve_prefix(conn: &Connection, session_key: &str, depth: usize) -> Result<Vec<Message>, NativeAgentError> {
    if depth >= MAX_DEPTH {
        return Ok(Vec::new());
    }
    let Some(f) = get(conn, session_key)? else { return Ok(Vec::new()) };
    if !ref_live(conn, &f) {
        return Ok(Vec::new());
    }
    let mut msgs = crate::db::load_resolved(conn, &f.source, depth + 1)?;
    msgs.truncate(f.upto);
    Ok(msgs)
}

/// How many leading messages two transcripts share.
pub fn common_prefix(a: &[Message], b: &[Message]) -> usize {
    a.iter()
        .zip(b.iter())
        .take_while(|(x, y)| x.role == y.role && serde_json::to_value(&x.content).ok() == serde_json::to_value(&y.content).ok())
        .count()
}

/// Forks that read from `session_key`, with the most messages any needs.
fn dependents(conn: &Connection, session_key: &str) -> Result<usize, NativeAgentError> {
    if !table_exists(conn, "ws_fork_refs") {
        return Ok(0);
    }
    let need: Option<i64> = conn.query_row(
        "SELECT MAX(upto) FROM ws_fork_refs WHERE source_key = ?1",
        params![session_key],
        |r| r.get(0),
    )?;
    Ok(need.unwrap_or(0).max(0) as usize)
}

/// Called before `session_key`'s stored transcript is replaced by `next`
/// (or deleted, `next = None`). When that would change messages a fork
/// references, the referenced range moves to a hidden container first and
/// the forks (and `session_key` itself) are repointed at it, so nobody's
/// view changes. Returns the container key when one was made.
pub fn protect_dependents(conn: &Connection, session_key: &str, next: Option<&[Message]>) -> Result<Option<String>, NativeAgentError> {
    let need = dependents(conn, session_key)?;
    if need == 0 {
        return Ok(None);
    }
    let current = crate::db::load_resolved(conn, session_key, 0)?;
    let need = need.min(current.len());
    if need == 0 {
        return Ok(None);
    }
    if let Some(next) = next {
        if common_prefix(&current, next) >= need {
            return Ok(None);
        }
    }
    // The part of the referenced range that `session_key` stores itself (the
    // rest it reads from its own source, which the container keeps reading).
    let own_ref = get(conn, session_key)?;
    let prefix_len = resolve_prefix(conn, session_key, 0)?.len();
    let own_needed = need.saturating_sub(prefix_len);
    let container = format!("{CONTAINER_PREFIX}{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO sessions (session_key, agent_id, created_at, updated_at, total_tokens, input_tokens, output_tokens)
         VALUES (?1, ?2, ?3, ?3, 0, 0, 0)",
        params![container, CONTAINER_AGENT, now],
    )?;
    if let Some(f) = &own_ref {
        // The container reads the same upstream range the chat read.
        link(conn, &container, &f.source, f.upto.min(prefix_len), f.ref_id.as_deref())?;
    }
    conn.execute(
        "UPDATE messages SET session_key = ?2 WHERE session_key = ?1 AND sequence < ?3",
        params![session_key, container, own_needed as i64],
    )?;
    // Renumber what the chat keeps from 0 (two steps: no transient clash on
    // the (session_key, sequence) key).
    conn.execute(
        "UPDATE messages SET sequence = -(sequence - ?2) - 1 WHERE session_key = ?1",
        params![session_key, own_needed as i64],
    )?;
    conn.execute("UPDATE messages SET sequence = -sequence - 1 WHERE session_key = ?1", params![session_key])?;
    // Forks of the chat now read the container (same messages, same count).
    conn.execute("UPDATE ws_fork_refs SET source_key = ?2 WHERE source_key = ?1", params![session_key, container])?;
    // The chat itself reads its old range from the container too, so its
    // view is unchanged until the save that follows trims it.
    link(conn, session_key, &container, need, None)?;
    Ok(Some(container))
}

/// Drop the link of a chat that is being deleted, then any container left
/// with no fork reading it (up the chain).
pub fn unlink_and_collect(conn: &Connection, session_key: &str) -> Result<(), NativeAgentError> {
    let Some(f) = get(conn, session_key)? else { return Ok(()) };
    conn.execute("DELETE FROM ws_fork_refs WHERE session_key = ?1", params![session_key])?;
    if table_exists(conn, "ws_items") {
        // The registry's range and summary items of this link go with it.
        conn.execute(
            "UPDATE ws_items SET state = 'purged', updated_at = ?3 WHERE loc IN (?1, ?2) AND state != 'purged'",
            params![format!("db:fork/{session_key}"), format!("db:fork_summary/{session_key}"), chrono::Utc::now().timestamp_millis()],
        )?;
    }
    collect_container(conn, &f.source, 0)
}

fn collect_container(conn: &Connection, key: &str, depth: usize) -> Result<(), NativeAgentError> {
    if depth >= MAX_DEPTH || !key.starts_with(CONTAINER_PREFIX) || dependents(conn, key)? > 0 {
        return Ok(());
    }
    let still_read: bool = conn
        .query_row("SELECT 1 FROM ws_fork_refs WHERE source_key = ?1 LIMIT 1", params![key], |_| Ok(()))
        .optional()?
        .is_some();
    if still_read {
        return Ok(());
    }
    let up = get(conn, key)?;
    conn.execute("DELETE FROM ws_fork_refs WHERE session_key = ?1", params![key])?;
    conn.execute("DELETE FROM messages WHERE session_key = ?1", params![key])?;
    conn.execute("DELETE FROM sessions WHERE session_key = ?1", params![key])?;
    if let Some(f) = up {
        collect_container(conn, &f.source, depth + 1)?;
    }
    Ok(())
}

/// "Delete everywhere" of the referenced range: the fork keeps only its own
/// messages from now on.
pub fn break_link(conn: &Connection, session_key: &str) -> Result<(), NativeAgentError> {
    unlink_and_collect(conn, session_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        db::ensure_schema(&c).unwrap();
        c
    }

    fn convo(n: usize, tag: &str) -> Vec<Message> {
        (0..n)
            .map(|i| if i % 2 == 0 { Message::user(&format!("{tag} q{i}")) } else { Message::assistant_text(&format!("{tag} a{i}")) })
            .collect()
    }

    fn save(c: &Connection, key: &str, msgs: &[Message]) {
        db::save_session(c, key, "main", &serde_json::to_string(msgs).unwrap(), None, None, 1, None).unwrap();
    }

    fn own_rows(c: &Connection, key: &str) -> i64 {
        c.query_row("SELECT COUNT(*) FROM messages WHERE session_key = ?1", params![key], |r| r.get(0)).unwrap()
    }

    fn texts(c: &Connection, key: &str) -> Vec<String> {
        db::load_session_messages_raw(c, key).unwrap().iter().map(|m| m.text()).collect()
    }

    fn fork(c: &Connection, key: &str, src: &str, upto: usize) {
        save(c, key, &[]);
        link(c, key, src, upto, None).unwrap();
        let kept: Vec<Message> = db::load_session_messages_raw(c, src).unwrap().into_iter().take(upto).collect();
        save(c, key, &kept);
    }

    fn containers(c: &Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM sessions WHERE session_key LIKE 'forkbase:%'", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn fork_stores_no_copy_of_the_referenced_range() {
        let c = conn();
        save(&c, "src", &convo(4, "s"));
        fork(&c, "fk", "src", 2);
        assert_eq!(own_rows(&c, "fk"), 0, "the fork stores nothing of the source range");
        assert_eq!(texts(&c, "fk"), vec!["s q0", "s a1"]);
        // The fork's next turn stores only its own messages.
        let mut next = db::load_session_messages_raw(&c, "fk").unwrap();
        next.extend(convo(2, "f"));
        save(&c, "fk", &next);
        assert_eq!(own_rows(&c, "fk"), 2);
        assert_eq!(texts(&c, "fk"), vec!["s q0", "s a1", "f q0", "f a1"]);
        // The source never sees the fork's messages.
        assert_eq!(texts(&c, "src").len(), 4);
    }

    #[test]
    fn rewinding_the_fork_inside_the_range_moves_the_link_back() {
        let c = conn();
        save(&c, "src", &convo(4, "s"));
        fork(&c, "fk", "src", 4);
        let short: Vec<Message> = convo(4, "s").into_iter().take(2).collect();
        save(&c, "fk", &short);
        assert_eq!(get(&c, "fk").unwrap().unwrap().upto, 2);
        assert_eq!(texts(&c, "fk"), vec!["s q0", "s a1"]);
        save(&c, "fk", &[]);
        assert!(get(&c, "fk").unwrap().is_none(), "an empty fork no longer references anything");
    }

    #[test]
    fn source_rewind_keeps_the_forks_history_in_a_container() {
        let c = conn();
        save(&c, "src", &convo(6, "s"));
        fork(&c, "fk", "src", 4);
        // The source is rewound to 1 message and continues differently.
        let mut next: Vec<Message> = convo(6, "s").into_iter().take(1).collect();
        next.push(Message::assistant_text("new answer"));
        save(&c, "src", &next);
        assert_eq!(texts(&c, "src"), vec!["s q0", "new answer"]);
        assert_eq!(texts(&c, "fk"), vec!["s q0", "s a1", "s q2", "s a3"], "the fork keeps what it referenced");
        assert_eq!(containers(&c), 1);
        // Nothing is duplicated: the container holds the moved rows, the
        // source only its new tail.
        assert_eq!(own_rows(&c, "src"), 1);
        assert_eq!(own_rows(&c, "fk"), 0);
        // The container is never listed as a chat.
        let listed: Vec<serde_json::Value> = serde_json::from_str(&db::list_sessions(&c, "main").unwrap()).unwrap();
        assert!(listed.iter().all(|s| !s["sessionKey"].as_str().unwrap_or("").starts_with(CONTAINER_PREFIX)));
    }

    #[test]
    fn chat_purge_keeps_referenced_messages_in_detached_container() {
        let c = conn();
        save(&c, "src", &convo(4, "s"));
        fork(&c, "fk", "src", 3);
        db::clear_session(&c, "src").unwrap();
        assert!(!db::session_exists(&c, "src").unwrap());
        assert_eq!(texts(&c, "fk"), vec!["s q0", "s a1", "s q2"]);
        assert_eq!(containers(&c), 1);
        let held: i64 = c.query_row("SELECT COUNT(*) FROM messages WHERE session_key LIKE 'forkbase:%'", [], |r| r.get(0)).unwrap();
        assert_eq!(held, 3, "only the referenced messages are kept");
        // When the last fork goes, the container goes too.
        db::clear_session(&c, "fk").unwrap();
        assert_eq!(containers(&c), 0);
        let left: i64 = c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn fork_of_a_fork_resolves_the_chain_and_survives_the_middle_purge() {
        let c = conn();
        save(&c, "a", &convo(4, "a"));
        fork(&c, "b", "a", 2);
        let mut b = db::load_session_messages_raw(&c, "b").unwrap();
        b.extend(convo(2, "b"));
        save(&c, "b", &b);
        fork(&c, "c", "b", 3);
        assert_eq!(own_rows(&c, "c"), 0);
        assert_eq!(texts(&c, "c"), vec!["a q0", "a a1", "b q0"]);
        db::clear_session(&c, "b").unwrap();
        assert_eq!(texts(&c, "c"), vec!["a q0", "a a1", "b q0"]);
        db::clear_session(&c, "a").unwrap();
        assert_eq!(texts(&c, "c"), vec!["a q0", "a a1", "b q0"]);
        db::clear_session(&c, "c").unwrap();
        assert_eq!(containers(&c), 0);
        let left: i64 = c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn deleting_a_fork_leaves_the_source_alone() {
        let c = conn();
        save(&c, "src", &convo(4, "s"));
        fork(&c, "fk", "src", 2);
        db::clear_session(&c, "fk").unwrap();
        assert_eq!(texts(&c, "src").len(), 4);
        assert_eq!(containers(&c), 0);
    }

    #[test]
    fn a_suspended_or_revoked_ref_hides_the_range() {
        let c = conn();
        save(&c, "src", &convo(4, "s"));
        crate::ws::registry::ensure_tables(&c).unwrap();
        crate::ws::refs::ensure_tables(&c).unwrap();
        save(&c, "fk", &[]);
        link(&c, "fk", "src", 2, None).unwrap();
        let rid = crate::ws::refs::record_fork(&c, "src", "fk", 2, "summary").unwrap();
        set_ref_id(&c, "fk", &rid).unwrap();
        assert_eq!(texts(&c, "fk").len(), 2);
        c.execute("UPDATE ws_refs SET state = 'suspended' WHERE id = ?1", params![rid]).unwrap();
        assert!(texts(&c, "fk").is_empty());
        // A save while hidden keeps the link for when it comes back.
        save(&c, "fk", &[Message::user("own")]);
        assert_eq!(get(&c, "fk").unwrap().unwrap().upto, 2);
        c.execute("UPDATE ws_refs SET state = 'live' WHERE id = ?1", params![rid]).unwrap();
        assert_eq!(texts(&c, "fk"), vec!["s q0", "s a1", "own"]);
    }
}
