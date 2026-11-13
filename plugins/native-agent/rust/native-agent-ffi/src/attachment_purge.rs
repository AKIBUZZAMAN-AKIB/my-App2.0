//! Remove a deleted file from stored chat sessions.
//!
//! Text files live in user messages as
//! `<attached_file name="…">…</attached_file>` (both when the engine builds
//! them from `attachments` and when an older WebView inlines them). Images are
//! `Image` blocks. When the user deletes a file from the files manager, every
//! copy in the stored transcripts is replaced by a short marker, so the model
//! never sees the content again on resume and the chat can show it as removed.

use regex::Regex;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::types::ContentBlock;
use crate::NativeAgentError;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PurgeSpec {
    /// File name as it was attached (`<attached_file name="…">`).
    pub name: Option<String>,
    /// Lowercase hex SHA-256 of an image's base64 data (no `data:` prefix).
    pub image_sha256: Option<String>,
    /// Limit to these sessions; all sessions when absent.
    pub session_keys: Option<Vec<String>>,
}

pub fn removed_marker(name: &str) -> String {
    format!("<attached_file name=\"{}\" removed=\"true\">\n[This file was deleted by the user. Its content is no longer available.]\n</attached_file>", name)
}

fn text_pattern(name: &str) -> Result<Regex, NativeAgentError> {
    let quoted = regex::escape(&name.replace('"', "'"));
    Regex::new(&format!(
        r#"(?s)<attached[_-]file name="{quoted}">\n?.*?\n?</attached[_-]file>"#
    ))
    .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })
}

pub fn sha256_hex(data: &str) -> String {
    let digest = Sha256::digest(data.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Rewrite one stored content value. Returns the new content when it changed.
fn rewrite(
    content: &str,
    kind: Option<&str>,
    re: Option<&Regex>,
    marker: &str,
    image_sha: Option<&str>,
    name: &str,
) -> Option<String> {
    let as_blocks = match kind {
        Some("blocks") => serde_json::from_str::<Vec<ContentBlock>>(content).ok(),
        Some("text") => None,
        _ => serde_json::from_str::<Vec<ContentBlock>>(content).ok(),
    };
    match as_blocks {
        Some(mut blocks) => {
            let mut changed = false;
            for block in blocks.iter_mut() {
                match block {
                    ContentBlock::Text { text } => {
                        if let Some(re) = re {
                            if re.is_match(text) {
                                *text = re.replace_all(text, regex::NoExpand(marker)).into_owned();
                                changed = true;
                            }
                        }
                    }
                    ContentBlock::Image { data, .. } => {
                        if image_sha.map(|h| sha256_hex(data) == h).unwrap_or(false) {
                            let label = if name.is_empty() {
                                "image".to_string()
                            } else {
                                name.to_string()
                            };
                            *block = ContentBlock::Text {
                                text: format!("[Image {label} was deleted by the user.]"),
                            };
                            changed = true;
                        }
                    }
                    _ => {}
                }
            }
            changed.then(|| serde_json::to_string(&blocks).unwrap_or_else(|_| content.to_string()))
        }
        None => {
            let re = re?;
            re.is_match(content).then(|| {
                re.replace_all(content, regex::NoExpand(marker))
                    .into_owned()
            })
        }
    }
}

pub fn purge(conn: &Connection, spec: &PurgeSpec) -> Result<serde_json::Value, NativeAgentError> {
    let name = spec.name.as_deref().map(str::trim).unwrap_or("");
    let image_sha = spec
        .image_sha256
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s.len() == 64);
    if name.is_empty() && image_sha.is_none() {
        return Err(NativeAgentError::Tool {
            msg: "name or imageSha256 is required".into(),
        });
    }
    let re = if name.is_empty() {
        None
    } else {
        Some(text_pattern(name)?)
    };
    let marker = removed_marker(&name.replace('"', "'"));
    let mut stmt = conn.prepare(
        "SELECT session_key, sequence, content, content_kind FROM messages WHERE role = 'user' AND (content LIKE '%attached_file%' OR content LIKE '%\"image\"%')",
    )?;
    let rows: Vec<(String, i64, String, Option<String>)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get(3)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    let only = spec.session_keys.as_ref();
    let mut sessions: Vec<String> = Vec::new();
    let mut changed_messages = 0usize;
    let tx = conn.unchecked_transaction()?;
    for (key, seq, content, kind) in rows {
        if only.map(|keys| !keys.contains(&key)).unwrap_or(false) {
            continue;
        }
        if let Some(next) = rewrite(
            &content,
            kind.as_deref(),
            re.as_ref(),
            &marker,
            image_sha.as_deref(),
            name,
        ) {
            tx.execute(
                "UPDATE messages SET content = ? WHERE session_key = ? AND sequence = ?",
                params![next, key, seq],
            )?;
            changed_messages += 1;
            if !sessions.contains(&key) {
                sessions.push(key);
            }
        }
    }
    tx.commit()?;
    Ok(serde_json::json!({ "sessions": sessions, "messages": changed_messages }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_webview_hyphen_form_too() {
        let re = text_pattern("a.md").unwrap();
        assert!(re.is_match("<attached-file name=\"a.md\">\nx\n</attached-file>"));
        assert!(re.is_match("<attached_file name=\"a.md\">x</attached_file>"));
        assert!(!re.is_match("<attached-file name=\"b.md\">\nx\n</attached-file>"));
    }

    #[test]
    fn replaces_text_attachments_in_plain_and_block_rows() {
        let re = text_pattern("notes.md").unwrap();
        let marker = removed_marker("notes.md");
        let plain = "see this\n<attached_file name=\"notes.md\">\nsecret\n</attached_file>\nthanks";
        let out = rewrite(plain, Some("text"), Some(&re), &marker, None, "notes.md").unwrap();
        assert!(!out.contains("secret"));
        assert!(
            out.contains("removed=\"true\"")
                && out.starts_with("see this")
                && out.ends_with("thanks")
        );
        let other = "<attached_file name=\"other.md\">\nkeep\n</attached_file>";
        assert!(rewrite(other, Some("text"), Some(&re), &marker, None, "notes.md").is_none());
        let blocks = serde_json::to_string(&vec![
            ContentBlock::Text {
                text: "<attached_file name=\"notes.md\">\nsecret\n</attached_file>".into(),
            },
            ContentBlock::Image {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            },
        ])
        .unwrap();
        let sha = sha256_hex("AAAA");
        let out = rewrite(
            &blocks,
            Some("blocks"),
            Some(&re),
            &marker,
            Some(&sha),
            "notes.md",
        )
        .unwrap();
        assert!(!out.contains("secret") && !out.contains("AAAA"));
    }

    #[test]
    fn purge_updates_the_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE messages (session_key TEXT, sequence INTEGER, role TEXT, content TEXT, content_kind TEXT);").unwrap();
        conn.execute(
            "INSERT INTO messages VALUES ('s1', 0, 'user', ?, 'text')",
            params!["<attached_file name=\"a.txt\">\nhello\n</attached_file>"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages VALUES ('s2', 0, 'user', 'nothing here', 'text')",
            [],
        )
        .unwrap();
        let out = purge(
            &conn,
            &PurgeSpec {
                name: Some("a.txt".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out["messages"], 1);
        assert_eq!(out["sessions"][0], "s1");
        let c: String = conn
            .query_row(
                "SELECT content FROM messages WHERE session_key='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!c.contains("hello"));
        assert!(purge(&conn, &PurgeSpec::default()).is_err());
    }
}
