//! Agent hub: agent-to-agent mail, the social feed, and the sub-agent parity rule.
//!
//! Three things the engine was missing, kept together because they answer one
//! question — *what may an agent say, to whom, and with what proof*:
//!
//! * **Mail** ([`send`], [`inbox`], [`deliver`], [`expire`]) — an append-only
//!   table. A message is accepted only with a sender, a recipient and text; its
//!   lifetime is computed from `at + ttl_ms`, never stored as a flag, so a row
//!   cannot be edited back to life. `deliver` writes a separate `receipt` row, so
//!   "delivered" is evidence rather than a guess.
//! * **Feed** ([`publish`], [`feed`], [`like`]) — what agents published, newest
//!   first, with the author kept as text (a deleted agent must not erase its
//!   posts).
//! * **Parity** ([`parity`]) — the rule that a sub-agent may do everything the
//!   main agent may do **except** the things that belong to the chat itself. The
//!   function is here, not in `subagents.rs`, so the rule has one home and one
//!   test rather than a filter copied into three call sites.
//!
//! Every table is created with `IF NOT EXISTS`, so installing this on an existing
//! database is a no-op until something is actually written.

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde_json::{json, Value};

/// Longest message the engine will store. A mail longer than this is a document;
/// it should be written to a file and referenced.
pub const MAX_TEXT_CHARS: usize = 8_000;
/// Default lifetime of a message: one hour.
pub const DEFAULT_TTL_MS: i64 = 3_600_000;
/// Longest lifetime anyone may ask for: one day. A message that outlives the
/// session it was sent in is a note, not mail.
pub const MAX_TTL_MS: i64 = 86_400_000;
/// Newest posts kept by [`feed`] when the caller does not say.
pub const FEED_LIMIT: i64 = 50;

/// The kinds the engine understands. Anything else is stored as `message`.
pub const KINDS: [&str; 5] = ["message", "ask", "answer", "receipt", "handoff"];
/// The topologies a broadcast may use.
pub const TOPOLOGIES: [&str; 5] = ["ring", "star", "mesh", "chain", "bus"];

/// One stored message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub text: String,
    pub at: i64,
    pub ttl_ms: i64,
    pub topology: Option<String>,
    pub reply_to: Option<String>,
    /// True once a receipt for this message exists.
    pub delivered: bool,
}

impl Message {
    /// Alive at `now_ms`. Strictly less, so `ttl_ms: 0` means "already expired".
    pub fn alive(&self, now_ms: i64) -> bool {
        now_ms - self.at < self.ttl_ms
    }

    pub fn to_json(&self, now_ms: i64) -> Value {
        json!({
            "id": self.id,
            "from": self.from,
            "to": self.to,
            "kind": self.kind,
            "text": self.text,
            "at": self.at,
            "ttlMs": self.ttl_ms,
            "topology": self.topology,
            "replyTo": self.reply_to,
            "delivered": self.delivered,
            "expired": !self.alive(now_ms),
            "state": if !self.alive(now_ms) && self.kind != "receipt" { "expired" } else if self.delivered { "delivered" } else { "sent" },
        })
    }
}

/// Create the hub's tables. Idempotent, and cheap enough to call on every write.
///
/// Mail lives in the workspace message store (`ws_messages`, see
/// `ws::envelope`): an older `hub_messages` table is moved there once, then
/// dropped. Posts and the parity table stay here.
pub fn ensure_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS hub_posts (
            id     TEXT PRIMARY KEY,
            author TEXT NOT NULL,
            title  TEXT NOT NULL DEFAULT '',
            body   TEXT NOT NULL,
            at_ms  INTEGER NOT NULL,
            likes  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS hub_agent_tools (
            name TEXT PRIMARY KEY
         );",
    )?;
    crate::ws::envelope::ensure_tables(conn)?;
    crate::ws::envelope::migrate_hub(conn).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
    Ok(())
}

/// The reason a message was refused, in the words the caller will read.
fn refuse(why: &str) -> Result<serde_json::Value> {
    Ok(json!({ "ok": false, "error": why }))
}

/// A new message id: sortable and unique (a ULID), never reused.
fn next_id(_conn: &Connection, prefix: &str) -> Result<String> {
    Ok(crate::ws::ids::new_id(prefix))
}

/// Store a message. Returns `{"ok": true, "message": …}` or `{"ok": false, "error": …}`.
///
/// A refusal is a *value*, not an error: the caller (a model tool call) has to be
/// able to show the reason, not a stack trace.
pub fn send(conn: &Connection, input: &Value, now_ms: i64) -> Result<Value> {
    ensure_tables(conn)?;
    let text_of = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let from = text_of("from");
    let to = text_of("to");
    let text = text_of("text");
    if from.is_empty() {
        return refuse("from is required: an anonymous message cannot be traced back");
    }
    if to.is_empty() {
        return refuse("to is required: a message without a recipient is a broadcast, set topology instead");
    }
    if from == to {
        return refuse("from and to are the same agent");
    }
    if text.is_empty() {
        return refuse("text is required");
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return refuse(&format!(
            "text is {} characters, the limit is {MAX_TEXT_CHARS}: write a file and send its path instead",
            text.chars().count()
        ));
    }
    let kind = match text_of("kind") {
        k if KINDS.contains(&k.as_str()) => k,
        _ => "message".to_string(),
    };
    let topology = match text_of("topology") {
        t if TOPOLOGIES.contains(&t.as_str()) => Some(t),
        _ => None,
    };
    let ttl_ms = input
        .get("ttlMs")
        .or_else(|| input.get("ttl_ms"))
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_TTL_MS)
        .clamp(0, MAX_TTL_MS);
    let reply_to = input.get("replyTo").or_else(|| input.get("reply_to")).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let id = next_id(conn, "m")?;
    insert(conn, &id, &from, &to, &kind, &text, now_ms, ttl_ms, topology.as_deref(), reply_to.as_deref(), &text_of("session"), "sent")?;
    let msg = load(conn, &id)?.expect("just inserted");
    Ok(json!({ "ok": true, "message": msg.to_json(now_ms) }))
}

#[allow(clippy::too_many_arguments)]
fn insert(conn: &Connection, id: &str, from: &str, to: &str, kind: &str, text: &str, at: i64, ttl_ms: i64, topology: Option<&str>, reply_to: Option<&str>, session: &str, state: &str) -> Result<()> {
    use crate::ws::envelope::{hub_conversation, hub_pid};
    let conv = hub_conversation(from, to, session);
    // A reply in mail threads like any other: its root is the replied message's root.
    let root: Option<String> = match reply_to {
        Some(r) => conn.query_row("SELECT COALESCE(thread_root, id) FROM ws_messages WHERE id = ?1", params![r], |x| x.get(0)).optional()?,
        None => None,
    };
    let hub = json!({ "from": from, "to": to, "topology": topology, "session": session, "ttlMs": ttl_ms });
    conn.execute(
        "INSERT INTO ws_messages (id, conversation, from_pid, to_json, reply_to, thread_root, kind, text, attachments_json, state, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, ?1), ?7, ?8, ?9, ?10, ?11, ?12)",
        params![id, conv, hub_pid(from), json!([{ "pid": hub_pid(to), "name": to }]).to_string(), reply_to, root, kind, text, json!([{ "hub": hub }]).to_string(), state, at, at + ttl_ms],
    )?;
    Ok(())
}

fn row_to_message(r: &rusqlite::Row<'_>) -> Result<Message> {
    let att: String = r.get(5)?;
    let hub = serde_json::from_str::<Value>(&att).ok().and_then(|v| v.get(0).and_then(|h| h.get("hub")).cloned()).unwrap_or(json!({}));
    let from_pid: String = r.get(1)?;
    let at: i64 = r.get(6)?;
    let expires: Option<i64> = r.get(7)?;
    let state: String = r.get(8)?;
    Ok(Message {
        id: r.get(0)?,
        from: hub["from"].as_str().map(str::to_string).unwrap_or(from_pid),
        to: hub["to"].as_str().unwrap_or("").to_string(),
        kind: r.get(2)?,
        text: r.get(3)?,
        at,
        ttl_ms: hub["ttlMs"].as_i64().or(expires.map(|e| e - at)).unwrap_or(DEFAULT_TTL_MS),
        topology: hub["topology"].as_str().map(str::to_string),
        reply_to: r.get(4)?,
        delivered: state == "delivered" || r.get::<_, Option<i64>>(9)?.is_some(),
    })
}

const COLS: &str = "id, from_pid, kind, text, reply_to, attachments_json, created_at, expires_at, state, delivered_at";
/// Rows that are agent mail (not peer chats posted by the engine).
const IS_MAIL: &str = "attachments_json LIKE '[{\"hub\":%'";

/// One message by id.
pub fn load(conn: &Connection, id: &str) -> Result<Option<Message>> {
    ensure_tables(conn)?;
    conn.query_row(&format!("SELECT {COLS} FROM ws_messages WHERE id = ?1 AND {IS_MAIL}"), params![id], row_to_message)
        .optional()
}

/// The live mail for one agent, oldest first. Expired mail is left out — it is
/// still in the table, so nothing is lost, but it is not handed to a reader.
pub fn inbox(conn: &Connection, agent: &str, now_ms: i64) -> Result<Vec<Message>> {
    ensure_tables(conn)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM ws_messages WHERE {IS_MAIL} AND json_extract(attachments_json, '$[0].hub.to') = ?1 AND kind <> 'receipt'
           AND state NOT IN ('expired', 'deleted', 'purged') AND expires_at > ?2 ORDER BY created_at ASC, rowid ASC"
    ))?;
    let rows = stmt.query_map(params![agent, now_ms], row_to_message)?;
    rows.collect()
}

/// `Some(reason)` when `from` names a real principal other than `caller`.
pub fn check_sender(conn: &Connection, caller: &str, from: &str) -> Option<String> {
    let from = from.trim();
    if from.is_empty() {
        return None; // send() refuses it with its own reason
    }
    let pid = crate::ws::envelope::hub_pid(from);
    let caller_pid = crate::ws::envelope::hub_pid(caller);
    if pid == caller_pid {
        return None;
    }
    let real = pid == "agent:main"
        || pid.starts_with("session:")
        || crate::ws::principals::get(conn, &pid).ok().flatten().is_some_and(|p| p["kind"] != "user");
    if real {
        Some(format!("from is {from}, but this request comes from {caller}: a message cannot be sent in another agent's name"))
    } else {
        None
    }
}

/// Mark a message read (`state = 'delivered'`) and write the receipt that proves it.
///
/// Refusals: unknown id, a receipt itself, or mail whose lifetime ran out.
pub fn deliver(conn: &Connection, id: &str, now_ms: i64) -> Result<Value> {
    ensure_tables(conn)?;
    let Some(msg) = load(conn, id)? else {
        return refuse(&format!("{id} is not in the log"));
    };
    if msg.kind == "receipt" {
        return refuse("a receipt does not need a receipt");
    }
    if !msg.alive(now_ms) {
        return refuse(&format!(
            "{id} expired {}s ago",
            (now_ms - msg.at - msg.ttl_ms) / 1_000
        ));
    }
    if msg.delivered {
        return Ok(json!({ "ok": true, "already": true, "message": msg.to_json(now_ms) }));
    }
    conn.execute("UPDATE ws_messages SET state = 'delivered', delivered_at = ?2 WHERE id = ?1", params![id, now_ms])?;
    let receipt_id = next_id(conn, "m")?;
    insert(conn, &receipt_id, &msg.to, &msg.from, "receipt", &format!("read {}", msg.id), now_ms, DEFAULT_TTL_MS, None, Some(&msg.id), "", "delivered")?;
    let receipt = load(conn, &receipt_id)?.expect("just inserted");
    let message = load(conn, id)?.expect("exists");
    Ok(json!({ "ok": true, "message": message.to_json(now_ms), "receipt": receipt.to_json(now_ms) }))
}

/// Mark mail that cannot be read any more `expired`. Returns how many rows
/// changed. **Deletes nothing**: the body stays readable in the thread.
pub fn expire(conn: &Connection, now_ms: i64) -> Result<usize> {
    ensure_tables(conn)?;
    let n = conn.execute(
        &format!("UPDATE ws_messages SET state = 'expired' WHERE {IS_MAIL} AND kind <> 'receipt' AND state NOT IN ('expired', 'deleted', 'purged') AND expires_at <= ?1"),
        params![now_ms],
    )?;
    Ok(n)
}

/// Who a broadcast reaches. A direct message returns its recipient only.
pub fn recipients(from: &str, to: &str, topology: Option<&str>, members: &[String]) -> Vec<String> {
    let others: Vec<String> = members.iter().filter(|m| m.as_str() != from).cloned().collect();
    match topology {
        Some("ring") | Some("chain") => others.into_iter().take(1).collect(),
        Some("star") => others
            .into_iter()
            .filter(|m| m.eq_ignore_ascii_case("hub") || m.eq_ignore_ascii_case("main"))
            .take(1)
            .collect(),
        Some("mesh") | Some("bus") => others,
        _ => vec![to.to_string()],
    }
}

/* ---------------------------------------------------------------- the feed -- */

/// Publish a post. Refuses an empty body: an empty post is a bug, not a mood.
pub fn publish(conn: &Connection, input: &Value, now_ms: i64) -> Result<Value> {
    ensure_tables(conn)?;
    let body = input.get("body").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if body.is_empty() {
        return refuse("body is required: a post with no text is not a post");
    }
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM hub_posts", [], |r| r.get(0))?;
    let id = format!("post{}", n + 1);
    conn.execute(
        "INSERT INTO hub_posts (id, author, title, body, at_ms, likes) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![
            &id,
            input.get("author").and_then(|v| v.as_str()).unwrap_or("an agent"),
            input.get("title").and_then(|v| v.as_str()).unwrap_or(""),
            &body,
            now_ms
        ],
    )?;
    Ok(json!({ "ok": true, "post": { "id": id, "author": input.get("author").cloned().unwrap_or(json!("an agent")), "title": input.get("title").cloned().unwrap_or(json!("")), "body": body, "at": now_ms, "likes": 0 } }))
}

/// Newest first. `0` (or a negative) means [`FEED_LIMIT`]; anything else is clamped
/// to 1..=200 so one call cannot read the world.
pub fn feed(conn: &Connection, limit: i64) -> Result<Value> {
    ensure_tables(conn)?;
    let limit = if limit <= 0 { FEED_LIMIT } else { limit.clamp(1, 200) };
    let mut stmt = conn.prepare(
        "SELECT id, author, title, body, at_ms, likes FROM hub_posts ORDER BY at_ms DESC, rowid DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?, "author": r.get::<_, String>(1)?, "title": r.get::<_, String>(2)?,
            "body": r.get::<_, String>(3)?, "at": r.get::<_, i64>(4)?, "likes": r.get::<_, i64>(5)?,
        }))
    })?;
    let posts: Result<Vec<Value>> = rows.collect();
    Ok(json!({ "ok": true, "posts": posts? }))
}

/// One like per call, on an existing post.
pub fn like(conn: &Connection, id: &str) -> Result<Value> {
    ensure_tables(conn)?;
    let changed = conn.execute("UPDATE hub_posts SET likes = likes + 1 WHERE id = ?1", params![id])?;
    if changed == 0 {
        return refuse(&format!("{id} is not a post"));
    }
    let likes: i64 = conn.query_row("SELECT likes FROM hub_posts WHERE id = ?1", params![id], |r| r.get(0))?;
    Ok(json!({ "ok": true, "id": id, "likes": likes }))
}

/* -------------------------------------------------------------- the parity -- */

/// What a sub-agent may use, given what its parent was given.
pub struct Parity {
    /// Everything the main agent has.
    pub main: Vec<String>,
    /// What the child may use: the same list, minus the chat's own tools.
    pub sub: Vec<String>,
    /// Names removed, with the reason — so the UI can show *why* it is missing.
    pub withheld: Vec<(String, &'static str)>,
}

/// The rule in one place.
///
/// * `ui__*` stays with the main agent: a child must not redraw the app (T7 of
///   the plan — one screen, one owner).
/// * Sub-agent management tools stay with the main agent: a child may *ask* for a
///   sibling through `message`, so a runaway tree cannot be grown from below.
/// * Everything else is passed straight through: files, shell, web, docs, memory.
///   A child that cannot read a file its parent could read is a child that will
///   fail for no reason the user can see.
pub fn parity(main_tools: &[String]) -> Parity {
    let mut sub = Vec::new();
    let mut withheld = Vec::new();
    for name in main_tools {
        let n = name.as_str();
        if n.starts_with("ui__") {
            withheld.push((name.clone(), "the app is drawn by the main agent only"));
        } else if matches!(
            n,
            "spawn_subagent" | "list_subagents" | "message_subagent" | "stop_subagent" | "team__spawn" | "ask_session"
        ) {
            withheld.push((name.clone(), "a child asks its parent instead of growing the tree"));
        } else {
            sub.push(name.clone());
        }
    }
    Parity { main: main_tools.to_vec(), sub, withheld }
}

/* ------------------------------------------------------------------ tests -- */

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn
    }

    fn msg(from: &str, to: &str, text: &str) -> Value {
        json!({ "from": from, "to": to, "text": text })
    }

    #[test]
    fn a_message_needs_a_sender_a_recipient_and_text() {
        let conn = db();
        assert!(send(&conn, &json!({"to": "b", "text": "x"}), 0).unwrap()["error"].as_str().unwrap().contains("from is required"));
        assert!(send(&conn, &json!({"from": "a", "text": "x"}), 0).unwrap()["error"].as_str().unwrap().contains("to is required"));
        assert!(send(&conn, &json!({"from": "a", "to": "a", "text": "x"}), 0).unwrap()["error"].as_str().unwrap().contains("same agent"));
        assert!(send(&conn, &json!({"from": "a", "to": "b", "text": "  "}), 0).unwrap()["error"].as_str().unwrap().contains("text is required"));
        let ok = send(&conn, &msg("a", "b", "need the schema"), 1_000).unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["message"]["kind"], "message");
        assert_eq!(ok["message"]["expired"], false);
    }

    #[test]
    fn a_message_longer_than_the_limit_is_a_file_not_mail() {
        let conn = db();
        let long = "x".repeat(MAX_TEXT_CHARS + 1);
        let r = send(&conn, &msg("a", "b", &long), 0).unwrap();
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("write a file"), "{}", r["error"]);
    }

    #[test]
    fn expiry_is_computed_so_an_edited_row_cannot_come_back_to_life() {
        let conn = db();
        let id = send(&conn, &json!({"from": "a", "to": "b", "text": "quick", "ttlMs": 50}), 1_000).unwrap()["message"]["id"].as_str().unwrap().to_string();
        assert_eq!(inbox(&conn, "b", 1_020).unwrap().len(), 1, "still inside its life");
        assert_eq!(inbox(&conn, "b", 1_050).unwrap().len(), 0, "the boundary itself is expired");
        let denied = deliver(&conn, &id, 2_000).unwrap();
        assert_eq!(denied["ok"], false);
        assert!(denied["error"].as_str().unwrap().contains("expired"));
    }

    #[test]
    fn a_zero_ttl_expires_the_moment_it_is_written() {
        let conn = db();
        let id = send(&conn, &json!({"from": "a", "to": "b", "text": "now", "ttlMs": 0}), 5).unwrap()["message"]["id"].as_str().unwrap().to_string();
        assert_eq!(inbox(&conn, "b", 5).unwrap().len(), 0);
        assert_eq!(deliver(&conn, &id, 5).unwrap()["ok"], false);
    }

    #[test]
    fn delivery_writes_a_receipt_addressed_back_and_only_once() {
        let conn = db();
        let id = send(&conn, &msg("a", "b", "build 42 is signed"), 100).unwrap()["message"]["id"].as_str().unwrap().to_string();
        let d = deliver(&conn, &id, 200).unwrap();
        assert_eq!(d["ok"], true);
        assert_eq!(d["receipt"]["kind"], "receipt");
        assert_eq!(d["receipt"]["from"], "b", "the reader signs the receipt");
        assert_eq!(d["receipt"]["to"], "a");
        assert_eq!(d["receipt"]["replyTo"], id);
        let again = deliver(&conn, &id, 300).unwrap();
        assert_eq!(again["already"], true);
        let receipts: i64 = conn.query_row("SELECT COUNT(*) FROM ws_messages WHERE kind = 'receipt'", [], |r| r.get(0)).unwrap();
        assert_eq!(receipts, 1, "a second delivery must not invent a second proof");
        assert_eq!(inbox(&conn, "a", 400).unwrap().len(), 0, "receipts are not mail to read");
    }

    #[test]
    fn expiry_sweeps_old_bodies_and_keeps_the_receipts() {
        let conn = db();
        let id = send(&conn, &json!({"from": "a", "to": "b", "text": "gone soon", "ttlMs": 100}), 0).unwrap()["message"]["id"].as_str().unwrap().to_string();
        deliver(&conn, &id, 10).unwrap();
        let old = send(&conn, &json!({"from": "a", "to": "b", "text": "never read", "ttlMs": 100}), 0).unwrap()["message"]["id"].as_str().unwrap().to_string();
        // Expiry ends a message's life as *mail*: both leave every inbox and are
        // marked expired. Nothing is deleted: the thread keeps the full text and
        // the receipt that proves the first one arrived.
        assert_eq!(expire(&conn, 500).unwrap(), 2, "every expired message is marked");
        assert_eq!(expire(&conn, 600).unwrap(), 0, "marking is idempotent");
        assert!(inbox(&conn, "b", 500).unwrap().is_empty());
        let state = |id: &str| conn.query_row("SELECT state, text FROM ws_messages WHERE id = ?1", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap();
        assert_eq!(state(&old), ("expired".to_string(), "never read".to_string()));
        assert_eq!(state(&id).0, "expired");
        let receipts: i64 = conn.query_row("SELECT COUNT(*) FROM ws_messages WHERE kind = 'receipt'", [], |r| r.get(0)).unwrap();
        assert_eq!(receipts, 1);
    }

    #[test]
    fn topology_decides_reach_not_the_senders_hope() {
        let members: Vec<String> = ["hub", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        assert_eq!(recipients("a", "b", Some("ring"), &members), vec!["hub".to_string()]);
        assert_eq!(recipients("a", "b", Some("star"), &members), vec!["hub".to_string()]);
        assert_eq!(recipients("a", "b", Some("mesh"), &members).len(), 4);
        assert_eq!(recipients("a", "b", None, &members), vec!["b".to_string()]);
        assert_eq!(recipients("hub", "b", Some("mesh"), &members).len(), 3, "the sender is never in its own audience");
    }

    #[test]
    fn a_post_needs_a_body_and_the_feed_is_newest_first() {
        let conn = db();
        assert_eq!(publish(&conn, &json!({"author": "x", "body": " "}), 0).unwrap()["ok"], false);
        let first = publish(&conn, &json!({"author": "builder", "title": "Build 42", "body": "signed"}), 100).unwrap();
        assert_eq!(first["ok"], true);
        publish(&conn, &json!({"author": "reviewer", "body": "looks good"}), 200).unwrap();
        let f = feed(&conn, 10).unwrap();
        assert_eq!(f["posts"].as_array().unwrap().len(), 2);
        assert_eq!(f["posts"][0]["author"], "reviewer", "newest first");
        let id = first["post"]["id"].as_str().unwrap();
        assert_eq!(like(&conn, id).unwrap()["likes"], 1);
        assert_eq!(like(&conn, "post999").unwrap()["ok"], false);
        assert_eq!(feed(&conn, 0).unwrap()["posts"].as_array().unwrap().len(), 2, "a silly limit is clamped, not obeyed");
    }

    #[test]
    fn parity_passes_everything_through_except_the_chats_own_tools() {
        let main: Vec<String> = ["read_file", "write_file", "run_shell", "web_search", "memory_store", "ui__show_card", "spawn_subagent", "stop_subagent", "message_subagent", "list_subagents"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let p = parity(&main);
        assert!(p.sub.contains(&"read_file".to_string()));
        assert!(p.sub.contains(&"run_shell".to_string()), "a child may do what its parent may do");
        assert!(!p.sub.iter().any(|n| n.starts_with("ui__")), "the app has one owner");
        assert!(!p.sub.contains(&"spawn_subagent".to_string()));
        assert_eq!(p.withheld.len(), 5);
        assert!(p.withheld.iter().any(|(n, why)| n == "ui__show_card" && why.contains("main agent")));
        assert_eq!(p.sub.len() + p.withheld.len(), p.main.len(), "nothing is dropped silently");
    }

    #[test]
    fn ensure_tables_is_idempotent() {
        let conn = db();
        ensure_tables(&conn).unwrap();
        ensure_tables(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM ws_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn hub_from_spoof_rejected() {
        let conn = db();
        crate::ws::principals::upsert(&conn, "agent:sa_1", "agent", "researcher", None, "active").unwrap();
        assert!(check_sender(&conn, "user", "sa_1").unwrap().contains("another agent's name"));
        assert!(check_sender(&conn, "user", "main").is_some());
        assert!(check_sender(&conn, "user", "session:chat-1").is_some());
        assert!(check_sender(&conn, "sa_1", "sa_1").is_none(), "an agent may sign as itself");
        assert!(check_sender(&conn, "user", "user").is_none());
        assert!(check_sender(&conn, "user", "scout").is_none(), "an in-page swarm label is not a principal");
    }

    #[test]
    fn hub_expire_never_deletes() {
        let conn = db();
        for i in 0..3 {
            send(&conn, &json!({"from": "a", "to": "b", "text": format!("m{i}"), "ttlMs": 1}), 0).unwrap();
        }
        let before: i64 = conn.query_row("SELECT COUNT(*) FROM ws_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(expire(&conn, 100).unwrap(), 3);
        let after: i64 = conn.query_row("SELECT COUNT(*) FROM ws_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
        let m = &inbox(&conn, "b", 0).unwrap();
        assert!(m.is_empty());
    }

    #[test]
    fn hub_migration_counts_match() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE hub_messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
                text TEXT NOT NULL, at_ms INTEGER NOT NULL, ttl_ms INTEGER NOT NULL, topology TEXT, reply_to TEXT NOT NULL DEFAULT '',
                delivered INTEGER NOT NULL DEFAULT 0, session TEXT NOT NULL DEFAULT '');
             INSERT INTO hub_messages VALUES ('msg1', 'a', 'b', 'message', 'hello', 10, 1000, NULL, '', 1, '');
             INSERT INTO hub_messages VALUES ('msg2', 'b', 'a', 'message', 'hi back', 20, 1000, NULL, 'msg1', 0, '');",
        )
        .unwrap();
        ensure_tables(&conn).unwrap();
        let gone = conn.query_row("SELECT 1 FROM sqlite_master WHERE name = 'hub_messages'", [], |_| Ok(())).optional().unwrap();
        assert!(gone.is_none(), "hub_messages dropped after the move");
        let rows: Vec<(String, String, Option<String>, String)> = conn
            .prepare("SELECT id, text, reply_to, state FROM ws_messages ORDER BY created_at").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
            .collect::<std::result::Result<_, _>>().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1, "hello");
        assert_eq!(rows[0].3, "delivered");
        assert_eq!(rows[1].2.as_deref(), Some(rows[0].0.as_str()), "reply chain kept");
        // runs once: a second ensure moves nothing more
        ensure_tables(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM ws_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
