//! Full-text index over the original text of archived turns (schema v5).
//!
//! Why: recall by question used to find turns only through the model-written
//! segment index; a detail the summarizer left out of the index (an exact
//! error string, a number, a name said once) could not be located in a long
//! chat. SQLite FTS5 is evaluated before any vector index (spec §7.2).
//!
//! * `turn_fts` rowid = `turn_archive` rowid, so a trigger keeps deletes in
//!   step (rewind, reset, chat deletion, retention) inside the same
//!   transaction; inserts and updates are written by `index_turns` from the
//!   same transaction that writes the archive row.
//! * Tokenizer `unicode61 categories 'L* N* Co Mc Mn'`: the default treats
//!   Bengali vowel signs and the virama (Mc/Mn) as separators and splits
//!   "কাগজের" into fragments (measured, see docs/agentic-memory/01-AUDIT_REPORT.md).
//!   Queries use prefix terms so inflected forms (কাগজ → কাগজের) match.
//! * Optional: when the SQLite build has no FTS5 the table is not created,
//!   `memory_meta.fts` says why, and retrieval falls back to the index alone.

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::{ContentBlock, Message, MessageContent};

/// Text of one tool result that is indexed. Larger results are stored whole
/// by result ID and searched through `recall_turns(result_id, question)`.
pub const MAX_INDEXED_RESULT_CHARS: usize = 16_000;
/// Terms taken from one question.
pub const MAX_QUERY_TERMS: usize = 12;

const CREATE: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
        session_key UNINDEXED, turn_no UNINDEXED, body,
        tokenize = \"unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 0\");
    CREATE TRIGGER IF NOT EXISTS turn_archive_fts_delete AFTER DELETE ON turn_archive BEGIN
        DELETE FROM turn_fts WHERE rowid = old.rowid;
    END;";

/// True when the index table exists in this database.
pub fn available(conn: &Connection) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_fts'", [], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// Create the index and backfill it from the archive. Runs inside the schema
/// upgrade transaction under a savepoint: on any error the index work is
/// rolled back, the reason is recorded, and the upgrade itself goes on.
pub fn create_and_backfill(conn: &Connection) {
    if available(conn) {
        return;
    }
    let _ = conn.execute_batch("SAVEPOINT turn_fts_setup");
    let result = (|| -> rusqlite::Result<usize> {
        conn.execute_batch(CREATE)?;
        let rows: Vec<(i64, String, u32, String)> = conn
            .prepare("SELECT rowid, session_key, turn_no, messages_json FROM turn_archive")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;
        let mut n = 0;
        for (rowid, key, no, json) in rows {
            let msgs: Vec<Message> = serde_json::from_str(&json).unwrap_or_default();
            conn.execute("INSERT INTO turn_fts (rowid, session_key, turn_no, body) VALUES (?1, ?2, ?3, ?4)", params![rowid, key, no, turn_text(&msgs)])?;
            n += 1;
        }
        Ok(n)
    })();
    match result {
        Ok(n) => {
            let _ = conn.execute_batch("RELEASE turn_fts_setup");
            set_meta(conn, "fts", &format!("ok; backfilled {} turns", n));
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO turn_fts_setup; RELEASE turn_fts_setup");
            tracing::warn!(error = %e, "full-text index unavailable; recall uses the memory index only");
            set_meta(conn, "fts", &format!("unavailable: {}", e));
        }
    }
}

fn set_meta(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO memory_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

/// The searchable text of one turn: what the user and the agent wrote, tool
/// names with their inputs, and tool results up to `MAX_INDEXED_RESULT_CHARS`.
pub fn turn_text(messages: &[Message]) -> String {
    let mut out = String::new();
    for m in messages {
        match &m.content {
            MessageContent::Text(t) => {
                out.push_str(t);
                out.push('\n');
            }
            MessageContent::Blocks(bs) => {
                for b in bs {
                    match b {
                        ContentBlock::Text { text } => out.push_str(text),
                        ContentBlock::ToolUse { name, input, .. } => {
                            out.push_str(name);
                            out.push(' ');
                            out.push_str(&input.to_string());
                        }
                        ContentBlock::ToolResult { content, .. } => out.extend(content.chars().take(MAX_INDEXED_RESULT_CHARS)),
                        _ => continue,
                    }
                    out.push('\n');
                }
            }
        }
    }
    out
}

/// Write the index row of one archived turn (same transaction as the archive
/// write). A no-op when the index is unavailable.
pub fn index_turn(conn: &Connection, session_key: &str, turn_no: u32, messages: &[Message]) -> rusqlite::Result<()> {
    if !available(conn) {
        return Ok(());
    }
    let Some(rowid) = conn
        .query_row("SELECT rowid FROM turn_archive WHERE session_key = ?1 AND turn_no = ?2", params![session_key, turn_no], |r| r.get::<_, i64>(0))
        .optional()?
    else {
        return Ok(());
    };
    conn.execute("DELETE FROM turn_fts WHERE rowid = ?1", [rowid])?;
    conn.execute("INSERT INTO turn_fts (rowid, session_key, turn_no, body) VALUES (?1, ?2, ?3, ?4)", params![rowid, session_key, turn_no, turn_text(messages)])?;
    Ok(())
}

const STOP: &[&str] = &[
    "the", "and", "for", "was", "were", "what", "which", "who", "when", "where", "why", "how", "did", "does", "you", "your", "our", "his", "her",
    "its", "this", "that", "with", "from", "about", "have", "had", "has", "are", "is", "in", "on", "of", "to", "we", "it", "an", "or", "be", "at",
    "by", "do", "me", "my", "earlier", "before", "said", "tell", "chat", "turn", "turns",
    "কী", "কি", "কে", "কোন", "কোনো", "কোথায়", "কোথায়", "কখন", "কেন", "কেমন", "আমরা", "আমি", "আপনি", "তুমি", "ছিল", "হয়", "হয়", "এবং", "ও", "এর", "যে", "এই", "সেই",
    "আগে", "বলেছিলাম", "বলেছিলেন", "বলেছিল", "করেছিলাম", "ছিলো", "না",
];

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || ('\u{0900}'..='\u{0DFF}').contains(&c) || ('\u{0300}'..='\u{036F}').contains(&c) || c == '_'
}

/// The FTS5 query for a question: its distinct content words as quoted
/// prefix terms joined by OR (bm25 ranks turns matching more of them first).
/// `None` when the question has no usable word.
pub fn query_for(question: &str) -> Option<String> {
    let mut terms: Vec<String> = Vec::new();
    for w in question.split(|c: char| !is_word_char(c)) {
        let w = w.to_lowercase();
        if w.chars().count() < 2 || STOP.contains(&w.as_str()) || terms.contains(&w) {
            continue;
        }
        terms.push(w);
        if terms.len() == MAX_QUERY_TERMS {
            break;
        }
    }
    if terms.is_empty() {
        return None;
    }
    Some(terms.iter().map(|t| format!("\"{}\"*", t.replace('"', ""))).collect::<Vec<_>>().join(" OR "))
}

/// Turns of one chat, up to `through_turn`, whose original text matches the
/// question, best first (bm25), at most `limit`. Empty when the index is
/// unavailable or nothing matches; never an error to the caller.
pub fn search_turns(conn: &Connection, session_key: &str, question: &str, through_turn: u32, limit: usize) -> Vec<u32> {
    if !available(conn) {
        return Vec::new();
    }
    let Some(q) = query_for(question) else {
        return Vec::new();
    };
    let sql = "SELECT turn_no FROM turn_fts WHERE turn_fts MATCH ?1 AND session_key = ?2 AND turn_no <= ?3 ORDER BY bm25(turn_fts) LIMIT ?4";
    let Ok(mut st) = conn.prepare(sql) else {
        return Vec::new();
    };
    let rows = st.query_map(params![q, session_key, through_turn, limit as i64], |r| r.get::<_, u32>(0));
    match rows {
        Ok(r) => r.filter_map(Result::ok).collect(),
        Err(e) => {
            tracing::warn!(error = %e, "full-text search failed");
            Vec::new()
        }
    }
}

/// Index ranges and full-text hits as one sorted list of disjoint ranges.
pub fn merge_hits(by_index: &[(u32, u32)], by_text: &[u32]) -> Vec<(u32, u32)> {
    let mut all: Vec<(u32, u32)> = by_index.iter().copied().chain(by_text.iter().map(|&n| (n, n))).collect();
    all.sort_unstable();
    let mut out: Vec<(u32, u32)> = Vec::new();
    for (a, b) in all {
        match out.last_mut() {
            Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_keeps_bengali_words_whole_and_drops_stopwords() {
        assert_eq!(query_for("আমরা কোন ডেটাবেস বেছেছিলাম?").unwrap(), "\"ডেটাবেস\"* OR \"বেছেছিলাম\"*");
        assert_eq!(query_for("What was the ERROR code?").unwrap(), "\"error\"* OR \"code\"*");
        assert!(query_for("? ! কী").is_none());
    }
}
