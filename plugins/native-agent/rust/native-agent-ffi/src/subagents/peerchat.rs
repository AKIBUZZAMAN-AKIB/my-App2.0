//! Peer chats on the workspace message store (plan.md, Phase 2).
//!
//! Every agent-to-agent, user-to-agent and chat-to-chat note goes through
//! `post_note`: the message is written once to `ws_messages` (the canonical,
//! never-folded record) and the recipient's inbox gets `render_header` +
//! text as view text, which `compact::fold_notes` may fold later.

use super::*;
use crate::ws::envelope::{self, Envelope, Party, Posted};

pub const TOOL_READ_CONVERSATION: &str = "read_conversation";

impl SubagentManager {
    /// The workspace database (the engine's agent.db), when the app set it.
    pub(crate) fn ws_conn(&self) -> Option<rusqlite::Connection> {
        let path = self.tree_db.lock().unwrap().clone()?;
        crate::db::open_db(&path).ok()
    }

    pub(crate) fn party_of(rec: &SubagentRecord) -> Party {
        let name = rec.title.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or(&rec.name);
        Party::new(&format!("agent:{}", rec.id), name)
    }

    /// Write one message and return the note the recipient sees. Without a
    /// database (tests, very early start) the header still has the same
    /// shape, with an id that is not stored.
    pub(crate) fn post_note(&self, env: Envelope, text: &str) -> Result<(String, String), String> {
        // The same write path as a group post (`envelope::write_note_at`).
        let (posted, text) = match self.ws_conn() {
            Some(conn) => envelope::write_note_at(&conn, &env, text, &[], now_ms())?,
            None => {
                if env.reply_to.is_some() {
                    return Err("Replies need the message store, which is not open.".into());
                }
                let id = crate::ws::ids::new_id("m");
                (Posted { id: id.clone(), env, thread_root: id, replied: None, at: now_ms() }, truncate_chars(text, envelope::NOTE_MAX_CHARS))
            }
        };
        Ok((envelope::render_note(&posted, &text), posted.id))
    }

    /// `read_conversation {with | conversation, before?, limit?}` for a
    /// sub-agent: the unfolded thread, oldest first.
    pub(super) fn read_conversation_tool(&self, me: &SubagentRecord, input: &Value) -> (String, bool) {
        let Some(conn) = self.ws_conn() else {
            return ("The message store is not open.".into(), true);
        };
        let my_pid = format!("agent:{}", me.id);
        let conv = match (input.get("conversation").and_then(Value::as_str), input.get("with").and_then(Value::as_str)) {
            (Some(c), _) if !c.trim().is_empty() => c.trim().to_string(),
            (_, Some(w)) if !w.trim().is_empty() => {
                let w = w.trim();
                let other = if w.contains(':') {
                    w.to_string()
                } else {
                    match self.peers_of(me).into_iter().map(|p| p.0).find(|r| r.id == w || r.name.eq_ignore_ascii_case(w) || r.title.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(w))) {
                        Some(r) => format!("agent:{}", r.id),
                        None => return (format!("No visible agent {w}. Call list_peers."), true),
                    }
                };
                envelope::peer_conversation(&my_pid, &other)
            }
            _ => {
                // No argument: list my conversations.
                return match envelope::conversations_of(&conn, &my_pid) {
                    Ok(list) if list.is_empty() => ("You have no conversations yet.".into(), false),
                    Ok(list) => (
                        list.iter()
                            .map(|c| format!("- {} ({}) · {} messages", c["conversation"].as_str().unwrap_or(""), c["withNames"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default(), c["count"]))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        false,
                    ),
                    Err(e) => (e, true),
                };
            }
        };
        // An agent reads only conversations it is part of.
        let mine = conv.starts_with("peer:") && conv[5..].split('|').any(|p| p == my_pid);
        let team = conv.starts_with("team:") || conv.starts_with("topic:") || conv.starts_with("group:");
        if !mine && !team {
            return ("You are not part of that conversation.".into(), true);
        }
        let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(30) as usize;
        let before = input.get("before").and_then(Value::as_str);
        match envelope::read_conversation(&conn, &conv, before, limit) {
            Ok(rows) if rows.is_empty() => ("No messages in that conversation.".into(), false),
            Ok(rows) => {
                let lines: Vec<String> = rows
                    .iter()
                    .map(|m| {
                        let reply = m["replyTo"].as_str().map(|r| format!(" (reply to {r})")).unwrap_or_default();
                        format!("{} · {} ({}){}: {}", m["id"].as_str().unwrap_or(""), m["fromName"].as_str().unwrap_or(""), m["from"].as_str().unwrap_or(""), reply, m["text"].as_str().unwrap_or(""))
                    })
                    .collect();
                (format!("Conversation {conv}:\n{}", lines.join("\n")), false)
            }
            Err(e) => (e, true),
        }
    }

    /// The identity line every sub-agent's system prompt gets.
    pub(super) fn identity_prompt(rec: &SubagentRecord) -> String {
        let p = Self::party_of(rec);
        format!(
            "\n\nYou are {} ({}). Messages from other agents start with a ⟦from … → to …⟧ header that names the sender; reply with message_peer to the sender's id, and pass reply_to with the msg id to answer one message.",
            p.name, p.pid
        )
    }
}
