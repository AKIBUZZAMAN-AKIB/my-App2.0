//! One message store for every agent-to-agent, user-to-agent and
//! chat-to-chat message, with the sender identity inside each message.
//!
//! `ws_messages` is the canonical, never-folded record. Inbox notes and
//! prompt folding (`compact::fold_notes` / `fold_queue`) are view text; the
//! full message can always be re-read here (`read_conversation`).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::ids::new_id;
use super::now_ms;
use super::registry::{self, Entry};

/// Characters of the replied message quoted in a header.
pub const QUOTE_CHARS: usize = 40;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    registry::ensure_tables(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_messages (
            id TEXT PRIMARY KEY,
            conversation TEXT NOT NULL,
            from_pid TEXT NOT NULL,
            to_json TEXT NOT NULL,
            mentions_json TEXT NOT NULL DEFAULT '[]',
            reply_to TEXT,
            thread_root TEXT,
            kind TEXT NOT NULL DEFAULT 'text',
            text TEXT NOT NULL,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            state TEXT NOT NULL DEFAULT 'sent',
            edited_at INTEGER,
            deleted_at INTEGER,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            delivered_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS ws_messages_conv ON ws_messages(conversation, created_at);
         CREATE INDEX IF NOT EXISTS ws_messages_thread ON ws_messages(thread_root, created_at);
         CREATE TABLE IF NOT EXISTS ws_cursors (pid TEXT NOT NULL, conversation TEXT NOT NULL, last_read TEXT, PRIMARY KEY (pid, conversation));",
    )
}

/// One side of a message.
#[derive(Debug, Clone, PartialEq)]
pub struct Party {
    pub pid: String,
    pub kind: String,
    pub name: String,
}

impl Party {
    pub fn new(pid: &str, name: &str) -> Self {
        let kind = pid.split(':').next().unwrap_or("user").to_string();
        Party { pid: pid.to_string(), kind, name: name.to_string() }
    }
}

/// The identity part of a message.
#[derive(Debug, Clone)]
pub struct Envelope {
    pub conversation: String,
    pub from: Party,
    pub to: Vec<Party>,
    pub mentions: Vec<String>,
    pub reply_to: Option<String>,
    pub kind: String,
}

impl Envelope {
    pub fn new(conversation: impl Into<String>, from: Party, to: Vec<Party>) -> Self {
        Envelope { conversation: conversation.into(), from, to, mentions: Vec::new(), reply_to: None, kind: "text".into() }
    }
    pub fn kind(mut self, k: &str) -> Self {
        self.kind = k.into();
        self
    }
    pub fn reply_to(mut self, r: Option<String>) -> Self {
        self.reply_to = r.filter(|s| !s.trim().is_empty());
        self
    }
}

/// A stored message as `post` returns it and `render_header` reads it.
#[derive(Debug, Clone)]
pub struct Posted {
    pub id: String,
    pub env: Envelope,
    pub thread_root: String,
    /// `(sender name, sender pid, quote)` of the replied message.
    pub replied: Option<(String, String, String)>,
    pub at: i64,
}

/// Both sides of a peer chat see one thread.
pub fn peer_conversation(a: &str, b: &str) -> String {
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    format!("peer:{x}|{y}")
}

fn conv_label(conv: &str) -> String {
    if conv.starts_with("peer:") {
        "peer chat".into()
    } else if let Some(g) = conv.strip_prefix("group:") {
        format!("group {g}")
    } else if let Some(t) = conv.strip_prefix("topic:") {
        format!("#{}", t.rsplit('/').next().unwrap_or(t))
    } else if conv.starts_with("session:") {
        "chat to chat".into()
    } else if conv.starts_with("team:") {
        "team".into()
    } else {
        conv.to_string()
    }
}

pub(crate) fn clip(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        format!("{}…", one.chars().take(n.saturating_sub(1)).collect::<String>())
    }
}

/// Write one message (and its `message` item). `reply_to` must be a live
/// message of the same conversation.
pub fn post(conn: &Connection, env: &Envelope, text: &str, attachments: &[Value]) -> Result<Posted, String> {
    post_at(conn, env, text, attachments, now_ms(), None)
}

pub fn post_at(conn: &Connection, env: &Envelope, text: &str, attachments: &[Value], at: i64, expires_at: Option<i64>) -> Result<Posted, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    // Every party is a principal, so a header can always name it later.
    for p in std::iter::once(&env.from).chain(env.to.iter()) {
        conn.execute(
            "INSERT OR IGNORE INTO ws_principals (pid, kind, display_name, state, created_at) VALUES (?1, ?2, ?3, 'active', ?4)",
            params![p.pid, p.kind, p.name, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    let mut replied = None;
    let mut thread_root: Option<String> = None;
    if let Some(r) = &env.reply_to {
        let row: Option<(String, String, Option<String>, String, String)> = conn
            .query_row("SELECT conversation, from_pid, thread_root, text, state FROM ws_messages WHERE id = ?1", params![r], |x| {
                Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((conv, from, root, rtext, state)) = row else {
            return Err(format!("No message {r} to reply to."));
        };
        if conv != env.conversation {
            return Err(format!("Message {r} is in another conversation."));
        }
        if state == "deleted" || state == "purged" {
            return Err(format!("Message {r} was deleted."));
        }
        thread_root = Some(root.unwrap_or_else(|| r.clone()));
        let name = super::principals::display_name(conn, &from);
        replied = Some((name, from, clip(&rtext, QUOTE_CHARS)));
    }
    let id = new_id("m");
    let root = thread_root.unwrap_or_else(|| id.clone());
    let to_json = json!(env.to.iter().map(|p| json!({ "pid": p.pid, "name": p.name })).collect::<Vec<_>>()).to_string();
    crate::turn_memory::store::write_tx(conn, |tx| {
        tx.execute(
            "INSERT INTO ws_messages (id, conversation, from_pid, to_json, mentions_json, reply_to, thread_root, kind, text, attachments_json, state, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'sent', ?11, ?12)",
            params![
                id,
                env.conversation,
                env.from.pid,
                to_json,
                json!(env.mentions).to_string(),
                env.reply_to,
                root,
                env.kind,
                text,
                json!(attachments).to_string(),
                at,
                expires_at
            ],
        )?;
        let to_names: Vec<&str> = env.to.iter().map(|p| p.name.as_str()).collect();
        let mut e = Entry::new(
            if env.conversation.starts_with("group:") { "group_message" } else { "message" },
            format!("db:ws_messages/{id}"),
            env.from.pid.clone(),
            format!("{} → {}: {}", env.from.name, to_names.join(", "), clip(text, 60)),
        );
        e.size = text.len() as i64;
        e.created_at = at;
        e.scope = Some(env.conversation.clone());
        e.meta = json!({ "conversation": env.conversation, "from": env.from.pid, "to": env.to.iter().map(|p| &p.pid).collect::<Vec<_>>(), "kind": env.kind, "replyTo": env.reply_to });
        registry::touch(tx, &e)?;
        Ok::<(), rusqlite::Error>(())
    })
    .map_err(|e| e.to_string())?;
    Ok(Posted { id, env: env.clone(), thread_root: root, replied, at })
}

/// Longest note an agent may write; longer text is cut with a marker.
pub const NOTE_MAX_CHARS: usize = 8_000;

fn cap_note(text: &str) -> String {
    if text.chars().count() <= NOTE_MAX_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(NOTE_MAX_CHARS).collect();
    out.push_str("\n…[truncated]");
    out
}

/// The one write path of every note: peer and team messages
/// (`peerchat::post_note`) and group posts (`groups::post_at`) (unified
/// plan, Phase 4). The parties' names are refreshed (a group's own
/// principal keeps the name its settings gave it), an agent's text is
/// capped at `NOTE_MAX_CHARS`, and the message and its registry item are
/// written by `post_at`. Returns the message and the text as stored, which
/// is what `render_note` shows.
pub fn write_note_at(conn: &Connection, env: &Envelope, text: &str, attachments: &[Value], at: i64) -> Result<(Posted, String), String> {
    let text = if env.from.kind == "user" { text.to_string() } else { cap_note(text) };
    super::principals::ensure_tables(conn).map_err(|e| e.to_string())?;
    for p in std::iter::once(&env.from).chain(env.to.iter()).filter(|p| p.kind != "group") {
        super::principals::upsert(conn, &p.pid, &p.kind, &p.name, None, "active").map_err(|e| e.to_string())?;
    }
    let posted = post_at(conn, env, &text, attachments, at, None)?;
    Ok((posted, text))
}

/// The one header format every path uses. Under 160 characters with a short
/// quote (names are clipped).
pub fn render_header(p: &Posted) -> String {
    let from = format!("{} ({})", clip(&p.env.from.name, 24), p.env.from.pid);
    let to = match p.env.to.len() {
        0 => "everyone".to_string(),
        1 => clip(&p.env.to[0].name, 24),
        n => format!("{} and {} more", clip(&p.env.to[0].name, 18), n - 1),
    };
    let mut h = format!("⟦from: {from} → to: {to} · {} · msg {}", conv_label(&p.env.conversation), p.id);
    if let Some((name, _pid, quote)) = &p.replied {
        let r = p.env.reply_to.as_deref().unwrap_or("");
        h.push_str(&format!(" · replying to {} {} \"{}\"", clip(name, 18), r, quote));
    }
    h.push('⟧');
    h
}

/// The identity line of the main agent in one chat.
pub fn main_identity_line(session_key: &str) -> String {
    format!(
        "\n\nYou are the main agent (agent:main) in chat session:{session_key}. Messages from sub-agents and other chats start with a ⟦from … → to …⟧ header naming the sender."
    )
}

/// Header + text: what the recipient's inbox note holds.
pub fn render_note(p: &Posted, text: &str) -> String {
    format!("{}\n{}", render_header(p), text)
}

/// `@Name`, `@id` and `@all`; `@@` is a literal @. `roster` is
/// `(pid, name, title)`. Unknown names are ignored.
pub fn parse_mentions(text: &str, roster: &[(String, String, Option<String>)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }
        if i + 1 < chars.len() && chars[i + 1] == '@' {
            i += 2;
            continue;
        }
        if i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '@') {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '-' || chars[j] == ':') {
            j += 1;
        }
        let word: String = chars[start..j].iter().collect::<String>().trim_end_matches([':', '-']).to_string();
        i = j.max(start + 1);
        if word.is_empty() {
            continue;
        }
        let lw = word.to_lowercase();
        let hits: Vec<String> = if lw == "all" {
            vec!["@all".to_string()]
        } else {
            roster
                .iter()
                .filter(|(pid, name, title)| {
                    let bare = pid.split_once(':').map(|x| x.1).unwrap_or(pid);
                    pid.eq_ignore_ascii_case(&word) || bare.eq_ignore_ascii_case(&word) || name.to_lowercase() == lw || title.as_deref().is_some_and(|t| t.to_lowercase() == lw)
                })
                .map(|r| r.0.clone())
                .collect()
        };
        for h in hits {
            if !out.contains(&h) {
                out.push(h);
            }
        }
    }
    out
}

fn row_json(conn: &Connection, r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let from: String = r.get("from_pid")?;
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "conversation": r.get::<_, String>("conversation")?,
        "from": from,
        "fromName": super::principals::display_name(conn, &from),
        "to": serde_json::from_str::<Value>(&r.get::<_, String>("to_json")?).unwrap_or(json!([])),
        "mentions": serde_json::from_str::<Value>(&r.get::<_, String>("mentions_json")?).unwrap_or(json!([])),
        "replyTo": r.get::<_, Option<String>>("reply_to")?,
        "threadRoot": r.get::<_, Option<String>>("thread_root")?,
        "kind": r.get::<_, String>("kind")?,
        "text": r.get::<_, String>("text")?,
        "attachments": serde_json::from_str::<Value>(&r.get::<_, String>("attachments_json")?).unwrap_or(json!([])),
        "state": r.get::<_, String>("state")?,
        "at": r.get::<_, i64>("created_at")?,
    }))
}

/// The unfolded thread of one conversation, oldest first, `limit` messages
/// before `before` (a message id) when given.
pub fn read_conversation(conn: &Connection, conversation: &str, before: Option<&str>, limit: usize) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let limit = limit.clamp(1, 500) as i64;
    let before_at: i64 = match before {
        Some(b) => conn.query_row("SELECT created_at FROM ws_messages WHERE id = ?1", params![b], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(i64::MAX),
        None => i64::MAX,
    };
    let mut st = conn
        .prepare(
            "SELECT * FROM (SELECT *, rowid AS rid FROM ws_messages WHERE conversation = ?1 AND state <> 'purged' AND created_at <= ?2 AND (?3 IS NULL OR id <> ?3)
             ORDER BY created_at DESC, rid DESC LIMIT ?4) ORDER BY created_at ASC, rid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = st.query_map(params![conversation, before_at, before, limit], |r| row_json(conn, r)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(rows)
}

/// A whole reply chain in one indexed query.
pub fn read_thread(conn: &Connection, root: &str) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut st = conn.prepare("SELECT * FROM ws_messages WHERE thread_root = ?1 ORDER BY created_at, rowid").map_err(|e| e.to_string())?;
    let rows = st.query_map(params![root], |r| row_json(conn, r)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Conversations `pid` takes part in, newest first, with the last message.
pub fn conversations_of(conn: &Connection, pid: &str) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let like_a = format!("peer:{pid}|%");
    let like_b = format!("peer:%|{pid}");
    let mut st = conn
        .prepare(
            "SELECT conversation, MAX(created_at), COUNT(*) FROM ws_messages
             WHERE (conversation LIKE ?1 OR conversation LIKE ?2 OR from_pid = ?3 OR to_json LIKE ?4) AND state <> 'purged'
             GROUP BY conversation ORDER BY MAX(created_at) DESC",
        )
        .map_err(|e| e.to_string())?;
    let to_like = format!("%\"pid\":\"{pid}\"%");
    let rows: Vec<(String, i64, i64)> = st
        .query_map(params![like_a, like_b, pid, to_like], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (conv, at, n) in rows {
        let with: Vec<String> = conv.strip_prefix("peer:").map(|p| p.split('|').filter(|x| *x != pid).map(str::to_string).collect()).unwrap_or_default();
        let names: Vec<String> = with.iter().map(|p| super::principals::display_name(conn, p)).collect();
        let last = read_conversation(conn, &conv, None, 1)?.pop();
        out.push(json!({ "conversation": conv, "with": with, "withNames": names, "label": conv_label(&conv), "lastAt": at, "count": n, "last": last }));
    }
    Ok(out)
}

// ── Agent mail (the old agent_hub tables, folded into ws_messages) ────────────

/// One row of the legacy `hub_messages` table: id, sender, recipient, kind,
/// text, at_ms, ttl_ms, delivered, reply_to, session.
type HubRow = (String, String, String, String, String, i64, i64, i64, String, String);

/// Move `hub_messages` into `ws_messages` once: insert every row, check the
/// count, then drop `hub_messages`, all in one transaction. A one-time move,
/// not a share.
pub fn migrate_hub(conn: &Connection) -> Result<usize, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let exists = conn.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_messages'", [], |_| Ok(())).optional().map_err(|e| e.to_string())?.is_some();
    if !exists {
        return Ok(0);
    }
    crate::turn_memory::store::write_tx(conn, |tx| {
        let src: i64 = tx.query_row("SELECT COUNT(*) FROM hub_messages", [], |r| r.get(0))?;
        let mut st = tx.prepare("SELECT id, sender, recipient, kind, text, at_ms, ttl_ms, delivered, reply_to, session FROM hub_messages ORDER BY rowid")?;
        let rows: Vec<HubRow> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)))?
            .collect::<Result<_, _>>()?;
        drop(st);
        let mut moved = 0i64;
        for (id, from, to, kind, text, at, ttl, delivered, reply_to, session) in &rows {
            let new_id = if id.starts_with("m_") { id.clone() } else { format!("m_hub_{id}") };
            let conv = hub_conversation(from, to, session);
            let to_json = json!([{ "pid": hub_pid(to), "name": to }]).to_string();
            let state = if *delivered != 0 { "delivered" } else { "sent" };
            let reply = if reply_to.is_empty() { None } else if reply_to.starts_with("m_") { Some(reply_to.clone()) } else { Some(format!("m_hub_{reply_to}")) };
            let expires = if *ttl > 0 { Some(at + ttl) } else { None };
            moved += tx.execute(
                "INSERT OR IGNORE INTO ws_messages (id, conversation, from_pid, to_json, reply_to, thread_root, kind, text, state, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?5, ?1), ?6, ?7, ?8, ?9, ?10)",
                params![new_id, conv, hub_pid(from), to_json, reply, kind, text, state, at, expires],
            )? as i64;
            tx.execute("UPDATE ws_items SET loc = ?2 WHERE loc = ?1", params![format!("db:hub_messages/{id}"), format!("db:ws_messages/{new_id}")])?;
        }
        if moved != src {
            return Err(rusqlite::Error::ToSqlConversionFailure(format!("hub migration moved {moved} of {src}").into()));
        }
        tx.execute_batch("DROP TABLE hub_messages;")?;
        Ok(moved as usize)
    })
    .map_err(|e| e.to_string())
}

/// A hub name as a principal: `user`, `main`, an agent id, or a free name.
pub fn hub_pid(name: &str) -> String {
    let n = name.trim();
    if n.is_empty() || n == "user" || n == "you" {
        "user".into()
    } else if n == "main" || n == "agent:main" {
        "agent:main".into()
    } else if n.contains(':') {
        n.to_string()
    } else {
        format!("agent:{n}")
    }
}

pub fn hub_conversation(from: &str, to: &str, _session: &str) -> String {
    if to == "*" || to == "all" {
        "hub:all".into()
    } else {
        peer_conversation(&hub_pid(from), &hub_pid(to))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws::test_seed;

    fn env(conv: &str) -> Envelope {
        Envelope::new(conv, Party::new("agent:sa_1", "researcher"), vec![Party::new("agent:sa_2", "writer")])
    }

    #[test]
    fn envelope_header_names_sender_and_recipient() {
        let c = test_seed::empty_db();
        let p = post(&c, &env("peer:agent:sa_1|agent:sa_2"), "hello", &[]).unwrap();
        let h = render_header(&p);
        assert!(h.starts_with("⟦from: researcher (agent:sa_1) → to: writer · peer chat · msg m_"), "{h}");
        assert!(h.chars().count() < 160, "{h}");
        let r = post(&c, &env("peer:agent:sa_1|agent:sa_2").reply_to(Some(p.id.clone())), "and more", &[]).unwrap();
        let hr = render_header(&r);
        assert!(hr.contains(&format!("replying to researcher {} \"hello\"", p.id)), "{hr}");
        assert_eq!(r.thread_root, p.id);
        // reply to a message in another conversation is refused
        assert!(post(&c, &env("team:x").reply_to(Some(p.id.clone())), "x", &[]).is_err());
        assert!(post(&c, &env("team:x").reply_to(Some("m_nope".into())), "x", &[]).is_err());
    }

    #[test]
    fn mention_parse() {
        let roster = vec![
            ("agent:sa_1".to_string(), "researcher".to_string(), Some("Research".to_string())),
            ("agent:sa_2".to_string(), "writer".to_string(), None),
        ];
        assert_eq!(parse_mentions("hey @researcher and @sa_2", &roster), vec!["agent:sa_1", "agent:sa_2"]);
        assert_eq!(parse_mentions("@all look", &roster), vec!["@all"]);
        assert!(parse_mentions("mail me at a@researcher.com", &roster).is_empty());
        assert!(parse_mentions("literal @@researcher", &roster).is_empty());
        assert!(parse_mentions("@nobody", &roster).is_empty());
        assert_eq!(parse_mentions("@Research: go", &roster), vec!["agent:sa_1"]);
    }

    #[test]
    fn folding_keeps_ws_messages_whole() {
        let c = test_seed::empty_db();
        let long = "x".repeat(5_000);
        let p = post(&c, &env("peer:agent:sa_1|agent:sa_2"), &long, &[]).unwrap();
        let note = render_note(&p, &long);
        let folded = crate::subagents::compact::fold_notes(vec![note.clone(); 6], 1_000);
        assert!(folded.iter().map(|n| n.len()).sum::<usize>() < 6 * note.len(), "the inbox view folds");
        let thread = read_conversation(&c, "peer:agent:sa_1|agent:sa_2", None, 10).unwrap();
        assert_eq!(thread[0]["text"].as_str().unwrap().len(), 5_000, "the record never folds");
    }

    #[test]
    fn read_conversation_pages_and_threads() {
        let c = test_seed::empty_db();
        let conv = "peer:agent:sa_1|agent:sa_2";
        let mut ids = Vec::new();
        for i in 0..5 {
            ids.push(post_at(&c, &env(conv), &format!("m{i}"), &[], 100 + i, None).unwrap().id);
        }
        let last2 = read_conversation(&c, conv, None, 2).unwrap();
        assert_eq!(last2.iter().map(|m| m["text"].as_str().unwrap()).collect::<Vec<_>>(), vec!["m3", "m4"]);
        let before = read_conversation(&c, conv, Some(&ids[3]), 2).unwrap();
        assert_eq!(before.iter().map(|m| m["text"].as_str().unwrap()).collect::<Vec<_>>(), vec!["m1", "m2"]);
        let r = post(&c, &env(conv).reply_to(Some(ids[1].clone())), "re", &[]).unwrap();
        let r2 = post(&c, &env(conv).reply_to(Some(r.id.clone())), "re re", &[]).unwrap();
        assert_eq!(r2.thread_root, ids[1]);
        assert_eq!(read_thread(&c, &ids[1]).unwrap().len(), 3);
        let convs = conversations_of(&c, "agent:sa_2").unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0]["count"], 7);
    }

    #[test]
    fn peer_conversation_is_symmetric() {
        assert_eq!(peer_conversation("agent:a", "agent:b"), peer_conversation("agent:b", "agent:a"));
    }
}
