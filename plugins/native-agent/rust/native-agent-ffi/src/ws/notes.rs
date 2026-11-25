//! The main agent's working notes in the item registry (unified plan,
//! Phase 4).
//!
//! The notes stay where they are: one notepad in the host's `agent_tools`
//! database (`scratchpad_notes`), written by `device__update_notes` and read
//! by `device__read_notes`. The engine keeps no copy. It indexes the
//! notepad as one `note` item at `loc host:notes`, so it can be found, shared
//! and mounted in a group like any other item; reading it says to use the
//! host tool.

use rusqlite::Connection;
use serde_json::{json, Value};

use super::registry::{self, Entry};

pub const NOTES_LOC: &str = "host:notes";
pub const NOTES_OWNER: &str = "agent:main";
/// The host tools that change the notes.
pub const WRITE_TOOLS: [&str; 2] = ["device__update_notes", "device__clear_scratchpad"];
pub const READ_TOOL: &str = "device__read_notes";

/// `(chars, updated_at)` of the notes after a successful host write, from
/// the tool's result (`structuredContent` when the host sends it, else the
/// "(N chars)" of its text). None when the call failed or is not a write.
pub fn from_tool_result(tool: &str, result_json: &str, now: i64) -> Option<(i64, i64)> {
    if !WRITE_TOOLS.contains(&tool) {
        return None;
    }
    let v: Value = serde_json::from_str(result_json).unwrap_or(Value::String(result_json.to_string()));
    if v.get("isError").and_then(Value::as_bool) == Some(true) || v.get("error").is_some() {
        return None;
    }
    if tool == "device__clear_scratchpad" {
        return Some((0, now));
    }
    let sc = v.get("structuredContent").unwrap_or(&v);
    let updated = sc.get("updatedAt").and_then(Value::as_i64).unwrap_or(now);
    if let Some(n) = sc.get("chars").and_then(Value::as_i64) {
        return Some((n, updated));
    }
    if let Some(t) = sc.get("notes").and_then(Value::as_str) {
        return Some((t.chars().count() as i64, updated));
    }
    // Text only: "Saved your notes (123 chars)."
    let text = match &v {
        Value::String(s) => s.clone(),
        _ => v.get("content").and_then(Value::as_array).and_then(|a| a.first()).and_then(|c| c.get("text")).and_then(Value::as_str).unwrap_or("").to_string(),
    };
    let i = text.find(" chars)")?;
    let n: String = text[..i].chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    n.parse().ok().map(|n| (n, updated))
}

/// Index (or refresh) the notes item; returns its id.
pub fn index(conn: &Connection, chars: i64, updated_at: i64) -> rusqlite::Result<String> {
    let mut e = Entry::new("note", NOTES_LOC.to_string(), NOTES_OWNER.to_string(), "Notes");
    e.size = chars.max(0);
    e.meta = json!({ "chars": chars.max(0), "updatedAt": updated_at, "hostOnly": true, "readWith": READ_TOOL });
    registry::touch(conn, &e)
}

/// After a host tool call: index the notes when it changed them.
pub fn on_tool_result(conn: &Connection, tool: &str, result_json: &str, now: i64) -> Option<String> {
    let (chars, at) = from_tool_result(tool, result_json, now)?;
    index(conn, chars, at).ok()
}

/// What `registry::read` gives for `host:notes`: where the text is.
pub fn read_stub(item: &Value) -> Value {
    let meta = &item["meta"];
    json!({
        "hostOnly": true,
        "readWith": READ_TOOL,
        "chars": meta["chars"],
        "updatedAt": meta["updatedAt"],
        "note": "The notes are kept on the device; call device__read_notes for the current text.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        registry::ensure_tables(&c).unwrap();
        c
    }

    #[test]
    fn notes_write_is_indexed_once_as_host_item() {
        let c = db();
        let r = json!({"content": [{"type": "text", "text": "Saved your notes (12 chars)."}], "structuredContent": {"chars": 12, "updatedAt": 5, "notes": "plan: ship it"}}).to_string();
        let id = on_tool_result(&c, "device__update_notes", &r, 9).expect("indexed");
        let again = on_tool_result(&c, "device__update_notes", &json!({"structuredContent": {"chars": 20, "updatedAt": 7}}).to_string(), 9).unwrap();
        assert_eq!(id, again, "one item, refreshed");
        let item = registry::get(&c, &id).unwrap().unwrap();
        assert_eq!(item["kind"], "note");
        assert_eq!(item["loc"], NOTES_LOC);
        assert_eq!(item["owner"], NOTES_OWNER);
        assert_eq!(item["size"], 20);
        // No copy of the text is kept anywhere in the item.
        assert!(!item.to_string().contains("ship it"));
        let read = registry::read(&c, &registry::Sources::default(), &id, None).unwrap();
        assert_eq!(read["content"]["readWith"], READ_TOOL);
    }

    #[test]
    fn failed_or_other_tools_do_not_index() {
        let c = db();
        assert!(on_tool_result(&c, "device__update_notes", &json!({"isError": true, "content": []}).to_string(), 1).is_none());
        assert!(on_tool_result(&c, "device__read_notes", "{}", 1).is_none());
        assert_eq!(from_tool_result("device__update_notes", "Saved your notes (42 chars). Current notes:\nx", 3), Some((42, 3)));
        assert_eq!(from_tool_result("device__clear_scratchpad", "{}", 3), Some((0, 3)));
    }
}
