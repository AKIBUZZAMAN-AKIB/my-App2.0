//! The main chat's digest of its groups (unified plan, Phase 4).
//!
//! The home chat's main agent is not woken by group messages. Instead,
//! when agent messages pile up in a group, a short deterministic digest
//! (no model call: one line per message, who said what, the start of the
//! text) is written to the home chat's `session:<key>` conversation. The
//! main agent's next turn carries the digests it has not seen yet.
//!
//! A digest is written after a debounce: `DEBOUNCE_MS` since the first
//! pending message, or `DEBOUNCE_COUNT` pending messages, whichever comes
//! first; at once when a message mentions the main agent or the user
//! (`@main`, `@you`). Each digest is at most `DIGEST_CAP` characters; the
//! whole thread stays in `group_read`.

use rusqlite::{params, Connection, OptionalExtension};

use super::envelope::{self, Envelope, Party};
use super::now_ms;

pub const DEBOUNCE_MS: i64 = 120_000;
pub const DEBOUNCE_COUNT: usize = 5;
pub const DIGEST_CAP: usize = 600;
/// Characters of each message's text in its digest line.
const LINE_TEXT: usize = 90;

fn e2s(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_digest_state (
            group_id TEXT NOT NULL, session_key TEXT NOT NULL,
            last_message_id TEXT, last_message_at INTEGER NOT NULL DEFAULT 0,
            last_sent_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (group_id, session_key));",
    )
}

/// The conversation a chat's digests go to.
pub fn session_conversation(session_key: &str) -> String {
    format!("session:{session_key}")
}

struct Pending {
    id: String,
    from: String,
    name: String,
    text: String,
    mentions: String,
    at: i64,
}

fn mentions_main(p: &Pending) -> bool {
    let t = p.text.to_lowercase();
    let words = ["@main", "@you"];
    words.iter().any(|w| {
        t.match_indices(w).any(|(i, _)| {
            let after = t[i + w.len()..].chars().next();
            !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
        })
    }) || p.mentions.contains("\"agent:main\"")
        || p.mentions.contains("\"user\"")
}

fn short(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        format!("{}…", one.chars().take(n.saturating_sub(1)).collect::<String>())
    }
}

/// Agent messages of the group after the chat's last digest.
fn pending(conn: &Connection, gid: &str, session_key: &str) -> Result<Vec<Pending>, String> {
    let last_at: i64 = conn
        .query_row("SELECT last_message_at FROM ws_digest_state WHERE group_id = ?1 AND session_key = ?2", params![gid, session_key], |r| r.get(0))
        .optional()
        .map_err(e2s)?
        .unwrap_or(0);
    let last_id: Option<String> = conn
        .query_row("SELECT last_message_id FROM ws_digest_state WHERE group_id = ?1 AND session_key = ?2", params![gid, session_key], |r| r.get(0))
        .optional()
        .map_err(e2s)?
        .flatten();
    let mut st = conn
        .prepare(
            "SELECT m.id, m.from_pid, COALESCE(p.display_name, m.from_pid), m.text, m.mentions_json, m.created_at
             FROM ws_messages m LEFT JOIN ws_principals p ON p.pid = m.from_pid
             WHERE m.conversation = ?1 AND m.created_at >= ?2 AND m.state NOT IN ('deleted', 'purged')
               AND m.from_pid LIKE 'agent:%' AND m.from_pid <> 'agent:main' AND m.kind <> 'system'
             ORDER BY m.created_at, m.rowid",
        )
        .map_err(e2s)?;
    let rows = st
        .query_map(params![format!("group:{gid}"), last_at], |r| {
            Ok(Pending { id: r.get(0)?, from: r.get(1)?, name: r.get(2)?, text: r.get(3)?, mentions: r.get(4)?, at: r.get(5)? })
        })
        .map_err(e2s)?;
    let mut out: Vec<Pending> = rows.collect::<Result<Vec<_>, _>>().map_err(e2s)?;
    // Messages at the same millisecond as the last digested one: skip up to
    // and including it.
    if let Some(last) = last_id {
        if let Some(i) = out.iter().position(|p| p.id == last) {
            out.drain(..=i);
        } else {
            out.retain(|p| p.at > last_at);
        }
    }
    Ok(out)
}

/// The digest text for `items` of group `name`, at most `DIGEST_CAP` chars.
fn render(name: &str, items: &[Pending]) -> String {
    let head = format!("#{name}: ");
    let mut out = head.clone();
    let mut shown = 0;
    for (i, p) in items.iter().enumerate() {
        let line = format!("{}{}: {}", if i == 0 { "" } else { " · " }, p.name, short(&p.text, LINE_TEXT));
        let rest = items.len() - i - 1;
        let tail = if rest > 0 { format!(" · +{rest} more (group_read)") } else { String::new() };
        if out.chars().count() + line.chars().count() + tail.chars().count() > DIGEST_CAP {
            break;
        }
        out.push_str(&line);
        shown += 1;
    }
    if shown < items.len() {
        out.push_str(&format!("{}+{} more (group_read)", if shown == 0 { "" } else { " · " }, items.len() - shown));
    }
    out.chars().take(DIGEST_CAP).collect()
}

/// After a post in group `gid`, or at the start of a main-agent turn
/// (`force`): write the digest when it is due. Returns the digest written.
pub fn tick(conn: &Connection, gid: &str, now: i64, force: bool) -> Result<Option<String>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let row: Option<(Option<String>, String)> = conn
        .query_row("SELECT home_root, name FROM ws_groups WHERE id = ?1 AND state NOT IN ('deleted', 'trashed')", params![gid], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(e2s)?;
    let Some((Some(home), name)) = row else { return Ok(None) };
    if home.trim().is_empty() {
        return Ok(None);
    }
    let items = pending(conn, gid, &home)?;
    if items.is_empty() {
        return Ok(None);
    }
    let due = force || items.iter().any(mentions_main) || items.len() >= DEBOUNCE_COUNT || now - items[0].at >= DEBOUNCE_MS;
    if !due {
        return Ok(None);
    }
    let text = render(&name, &items);
    let last = items.last().unwrap();
    super::groups::tx(conn, |c| {
        let mut env = Envelope::new(session_conversation(&home), Party::new("system", "Groups"), Vec::new()).kind("digest");
        env.mentions = items.iter().map(|p| p.from.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        envelope::post_at(c, &env, &text, &[], now, None)?;
        c.execute(
            "INSERT INTO ws_digest_state (group_id, session_key, last_message_id, last_message_at, last_sent_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(group_id, session_key) DO UPDATE SET last_message_id = excluded.last_message_id, last_message_at = excluded.last_message_at, last_sent_at = excluded.last_sent_at",
            params![gid, home, last.id, last.at, now],
        )
        .map_err(e2s)?;
        Ok(())
    })?;
    Ok(Some(text))
}

/// The digests of chat `session_key` its main agent has not seen yet,
/// oldest first; marks them seen. `flush` first writes every group's
/// pending digest (a new turn should not miss what is waiting).
pub fn take_unseen(conn: &Connection, root: &str, session_key: &str, flush: bool) -> Result<Vec<String>, String> {
    ensure_tables(conn).map_err(e2s)?;
    super::board::ensure_tables(conn).map_err(e2s)?;
    if flush {
        for gid in super::groups::of_home(conn, root)? {
            tick(conn, &gid, now_ms(), true)?;
        }
    }
    let conv = session_conversation(root);
    let seen: i64 = super::board::room_meta_get(conn, &conv, &format!("digestSeen:{session_key}")).map_err(e2s)?.and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut st = conn
        .prepare("SELECT text, created_at FROM ws_messages WHERE conversation = ?1 AND kind = 'digest' AND created_at > ?2 ORDER BY created_at, rowid")
        .map_err(e2s)?;
    let rows = st.query_map(params![conv, seen], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(e2s)?;
    let list: Vec<(String, i64)> = rows.collect::<Result<Vec<_>, _>>().map_err(e2s)?;
    if let Some((_, at)) = list.last() {
        super::board::room_meta_set(conn, &conv, &format!("digestSeen:{session_key}"), &at.to_string()).map_err(e2s)?;
    }
    Ok(list.into_iter().map(|x| x.0).collect())
}
