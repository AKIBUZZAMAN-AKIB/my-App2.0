//! Phase 5: `ws_context_use`, per holder, per item: does the holder's
//! prompt carry the item (`in`), leave it out (`out`), or let the assembler
//! pick it under budget (`auto`)?
//!
//! Each holder (a chat, a sub-agent, a group) has its own row for the same
//! shared item, so one holder's choice never changes another's. The user sets
//! rows from the tree; in a group whose `aiContext` setting is `model`, the
//! group's agents may change them through `group_context`, which is logged
//! with its reason. A row the user locked is the user's alone.
//!
//! With no row, an item's state follows how the holder has it: a mounted item
//! is `in`, a reference is `out` (it reaches the prompt only when used), and
//! the holder's own items are `auto`.

use super::{now_ms, refs, registry};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub const STATES: [&str; 3] = ["in", "out", "auto"];

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_context_use (
            holder     TEXT NOT NULL,
            item_id    TEXT NOT NULL,
            state      TEXT NOT NULL CHECK (state IN ('in', 'out', 'auto')),
            actor      TEXT NOT NULL DEFAULT 'user',
            reason     TEXT NOT NULL DEFAULT '',
            locked     INTEGER NOT NULL DEFAULT 0,
            hidden     INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (holder, item_id)
        );
        CREATE INDEX IF NOT EXISTS ws_context_use_item ON ws_context_use(item_id);",
    )
}

fn e2s(e: rusqlite::Error) -> String {
    e.to_string()
}

/// The stored row for (holder, item), if any.
pub fn row(conn: &Connection, holder: &str, item_id: &str) -> Result<Option<Value>, String> {
    ensure_tables(conn).map_err(e2s)?;
    conn.query_row(
        "SELECT state, actor, reason, locked, hidden, updated_at FROM ws_context_use WHERE holder = ?1 AND item_id = ?2",
        params![holder, item_id],
        |r| {
            Ok(json!({
                "state": r.get::<_, String>(0)?,
                "actor": r.get::<_, String>(1)?,
                "reason": r.get::<_, String>(2)?,
                "locked": r.get::<_, i64>(3)? != 0,
                "hidden": r.get::<_, i64>(4)? != 0,
                "updatedAt": r.get::<_, i64>(5)?,
            }))
        },
    )
    .optional()
    .map_err(e2s)
}

/// The state with no row: mount = in, reference = out, own = auto.
pub fn default_state(conn: &Connection, holder: &str, item: &Value) -> &'static str {
    if item["owner"].as_str() == Some(holder) {
        return "auto";
    }
    let id = item["id"].as_str().unwrap_or("");
    let mode: Option<String> = conn
        .query_row("SELECT mode FROM ws_refs WHERE item_id = ?1 AND holder = ?2 AND state = 'live'", params![id, holder], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    match mode.as_deref() {
        Some("mount") => "in",
        _ => "out",
    }
}

/// The holder's effective state for an item, with who set it and why.
pub fn effective(conn: &Connection, holder: &str, item: &Value) -> Result<Value, String> {
    let id = item["id"].as_str().unwrap_or("");
    Ok(match row(conn, holder, id)? {
        Some(mut r) => {
            r["default"] = json!(default_state(conn, holder, item));
            r
        }
        None => json!({ "state": default_state(conn, holder, item), "actor": "default", "reason": "", "locked": false, "hidden": false, "default": default_state(conn, holder, item) }),
    })
}

#[allow(clippy::too_many_arguments)]
fn upsert(conn: &Connection, holder: &str, item_id: &str, state: &str, actor: &str, reason: &str, locked: Option<bool>, hidden: Option<bool>) -> Result<(), String> {
    let prev = row(conn, holder, item_id)?;
    let locked = locked.unwrap_or_else(|| prev.as_ref().map(|p| p["locked"] == true).unwrap_or(false));
    let hidden = hidden.unwrap_or_else(|| prev.as_ref().map(|p| p["hidden"] == true).unwrap_or(false));
    conn.execute(
        "INSERT INTO ws_context_use (holder, item_id, state, actor, reason, locked, hidden, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(holder, item_id) DO UPDATE SET state = excluded.state, actor = excluded.actor, reason = excluded.reason, locked = excluded.locked, hidden = excluded.hidden, updated_at = excluded.updated_at",
        params![holder, item_id, state, actor, reason, locked as i64, hidden as i64, now_ms()],
    )
    .map_err(e2s)?;
    Ok(())
}

fn item(conn: &Connection, id: &str) -> Result<Value, String> {
    registry::get(conn, id).map_err(e2s)?.ok_or_else(|| format!("No item {id}."))
}

/// The user sets `holder`'s state for an item, and may lock it so only the
/// user changes it from then on.
pub fn set_user(conn: &Connection, holder: &str, item_id: &str, state: &str, lock: Option<bool>) -> Result<Value, String> {
    ensure_tables(conn).map_err(e2s)?;
    if !STATES.contains(&state) {
        return Err(format!("Unknown context state {state}. Use in, out or auto."));
    }
    if holder.is_empty() || holder == "user" {
        return Err("Choose whose context this is for.".into());
    }
    let it = item(conn, item_id)?;
    if !refs::can(conn, holder, &it, "view") {
        return Err("That holder can't see this item.".into());
    }
    upsert(conn, holder, item_id, state, "user", "", lock, None)?;
    refs::audit(conn, "user", "context_use", Some(item_id), Some(holder), json!({ "state": state, "locked": lock }));
    effective(conn, holder, &it)
}

/// A group's agent changes the group's state for an item (`group_context`).
/// Allowed only when the group lets the model decide, the item is not locked,
/// and the group has `use` on it. Every change is logged with its reason.
pub fn set_model(conn: &Connection, holder: &str, item_id: &str, state: &str, actor: &str, reason: &str, policy: &str) -> Result<Value, String> {
    ensure_tables(conn).map_err(e2s)?;
    if policy != "model" {
        return Err("In this group only the user decides what the AI uses. Ask them to change it.".into());
    }
    if state != "in" && state != "out" {
        return Err("state must be in or out.".into());
    }
    if reason.trim().is_empty() {
        return Err("Say why in `reason`.".into());
    }
    let it = item(conn, item_id)?;
    if row(conn, holder, item_id)?.is_some_and(|r| r["locked"] == true) {
        return Err("The user locked this item: only they decide whether it is used.".into());
    }
    if !refs::can(conn, holder, &it, "use") {
        return Err("The group can only toggle items it has use permission on.".into());
    }
    upsert(conn, holder, item_id, state, actor, reason.trim(), Some(false), None)?;
    refs::audit(conn, actor, "context_use", Some(item_id), Some(holder), json!({ "state": state, "reason": reason.trim(), "by": "model" }));
    effective(conn, holder, &it)
}

/// Hide an item from `holder`'s view ("move message" hides it in the source)
/// and leave it out of that holder's context.
pub fn hide(conn: &Connection, holder: &str, item_id: &str, actor: &str) -> Result<(), String> {
    ensure_tables(conn).map_err(e2s)?;
    upsert(conn, holder, item_id, "out", actor, "moved", None, Some(true))
}

/// Every item `holder` can see (shared with it or its own), with its state.
pub fn list(conn: &Connection, holder: &str) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(e2s)?;
    let mut out = Vec::new();
    for mut it in refs::visible_to(conn, holder)? {
        it["context"] = effective(conn, holder, &it)?;
        out.push(it);
    }
    for mut it in registry::query(conn, "owner = ?1 AND state IN ('live', 'missing')", &[&holder]).map_err(e2s)? {
        it["context"] = effective(conn, holder, &it)?;
        out.push(it);
    }
    Ok(out)
}

/// What the assembler puts in `holder`'s prompt: every `in` item, then
/// `auto` items newest first while they fit `budget` characters. Returns
/// (item, text) pairs; an item whose text can't be read is carried by title.
pub fn select(conn: &Connection, src: &registry::Sources, holder: &str, budget: usize) -> Result<Vec<(Value, String)>, String> {
    let mut ins = Vec::new();
    let mut autos = Vec::new();
    for it in refs::visible_to(conn, holder)? {
        let st = effective(conn, holder, &it)?;
        if st["hidden"] == true {
            continue;
        }
        match st["state"].as_str() {
            Some("in") => ins.push(it),
            Some("auto") => autos.push(it),
            _ => {}
        }
    }
    autos.sort_by_key(|it| std::cmp::Reverse(it["updatedAt"].as_i64().unwrap_or(0)));
    let text_of = |it: &Value| -> String {
        registry::read(conn, src, it["id"].as_str().unwrap_or(""), Some(&json!({ "limit": 4000 })))
            .ok()
            .and_then(|v| v["text"].as_str().map(str::to_string))
            .unwrap_or_else(|| it["title"].as_str().unwrap_or("").to_string())
    };
    let mut out = Vec::new();
    let mut used = 0usize;
    for it in ins {
        let t = text_of(&it);
        used += t.len();
        out.push((it, t));
    }
    for it in autos {
        let t = text_of(&it);
        if used + t.len() > budget {
            continue;
        }
        used += t.len();
        out.push((it, t));
    }
    Ok(out)
}

/// The prompt block for a group: the shared items the group's AI uses now.
pub fn prompt_block(conn: &Connection, holder: &str, budget: usize) -> String {
    let picked = match super::projection::context_for(conn, holder, budget) {
        Ok(p) => p,
        Err(_) => return String::new(),
    };
    if picked.is_empty() {
        return String::new();
    }
    let mut s = String::from("Shared context for this group (items the group uses now):\n");
    for (it, text) in picked {
        let clipped: String = text.chars().take(1200).collect();
        s.push_str(&format!("- [{}] {} (item {}): {}\n", it["kind"].as_str().unwrap_or(""), it["title"].as_str().unwrap_or(""), it["id"].as_str().unwrap_or(""), clipped.replace('\n', " ")));
    }
    s
}
