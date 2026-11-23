//! References (plan.md, Phase 4): one item, many holders.
//!
//! Every item has exactly one `owner` reference (written on insert and by a
//! one-time migration for items indexed before this phase). Sharing adds a
//! reference for another holder; nothing is copied. A reference has a mode
//! (`reference`: shown under "Shared with me", used in context only when the
//! holder turns it on; `mount`: lives with the holder's own memory) and a
//! permission (`view` < `use` < `edit` < `manage`). Only the owner or a
//! `manage` holder grants, never above its own level. Changing or revoking a
//! permission touches only the ref row; re-granting restores the same item.
//! Trashing an item suspends its refs; restoring makes them live again.
//! Every change is written to `ws_audit`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::ids::new_id;
use super::{now_ms, registry};

pub const PERMS: [&str; 4] = ["view", "use", "edit", "manage"];
pub const MODES: [&str; 3] = ["owner", "reference", "mount"];

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    registry::ensure_tables(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_refs (
            id          TEXT PRIMARY KEY,
            item_id     TEXT NOT NULL,
            holder      TEXT NOT NULL,
            mode        TEXT NOT NULL,
            perm        TEXT NOT NULL,
            folder      TEXT NOT NULL DEFAULT '',
            granted_by  TEXT NOT NULL DEFAULT 'user',
            state       TEXT NOT NULL DEFAULT 'live',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            UNIQUE (item_id, holder)
         );
         CREATE INDEX IF NOT EXISTS ws_refs_holder ON ws_refs(holder, state);
         CREATE TABLE IF NOT EXISTS ws_audit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            at          INTEGER NOT NULL,
            actor       TEXT NOT NULL,
            action      TEXT NOT NULL,
            item_id     TEXT,
            holder      TEXT,
            detail_json TEXT NOT NULL DEFAULT '{}'
         );
         CREATE INDEX IF NOT EXISTS ws_audit_item ON ws_audit(item_id);",
    )?;
    if super::meta_get(conn, "refs_owner_migrated")?.is_none() {
        migrate_owner_refs(conn)?;
        super::meta_set(conn, "refs_owner_migrated", "1")?;
    }
    Ok(())
}

/// One owner reference for every item that has none.
fn migrate_owner_refs(conn: &Connection) -> rusqlite::Result<usize> {
    let ids: Vec<(String, String)> = {
        let mut st = conn.prepare(
            "SELECT id, owner FROM ws_items i WHERE NOT EXISTS (SELECT 1 FROM ws_refs r WHERE r.item_id = i.id AND r.mode = 'owner')",
        )?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (id, owner) in &ids {
        add_owner(conn, id, owner)?;
    }
    Ok(ids.len())
}

/// The owner reference for a new item (called by `registry::touch`).
pub fn add_owner(conn: &Connection, item_id: &str, owner: &str) -> rusqlite::Result<()> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO ws_refs (id, item_id, holder, mode, perm, granted_by, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'owner', 'manage', 'system', 'live', ?4, ?4)
         ON CONFLICT(item_id, holder) DO UPDATE SET mode = 'owner', perm = 'manage', state = 'live', updated_at = ?4",
        params![new_id("rf"), item_id, owner, now],
    )?;
    Ok(())
}

pub fn perm_rank(p: &str) -> Option<usize> {
    PERMS.iter().position(|x| *x == p)
}

pub fn audit(conn: &Connection, actor: &str, action: &str, item_id: Option<&str>, holder: Option<&str>, detail: Value) {
    let _ = conn.execute(
        "INSERT INTO ws_audit (at, actor, action, item_id, holder, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now_ms(), actor, action, item_id, holder, detail.to_string()],
    );
}

fn ref_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "itemId": r.get::<_, String>("item_id")?,
        "holder": r.get::<_, String>("holder")?,
        "mode": r.get::<_, String>("mode")?,
        "perm": r.get::<_, String>("perm")?,
        "folder": r.get::<_, String>("folder")?,
        "grantedBy": r.get::<_, String>("granted_by")?,
        "state": r.get::<_, String>("state")?,
        "createdAt": r.get::<_, i64>("created_at")?,
        "updatedAt": r.get::<_, i64>("updated_at")?,
    }))
}

pub fn get_ref(conn: &Connection, ref_id: &str) -> Result<Option<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    conn.query_row("SELECT * FROM ws_refs WHERE id = ?1", params![ref_id], ref_json).optional().map_err(|e| e.to_string())
}

fn ref_of(conn: &Connection, item_id: &str, holder: &str) -> Result<Option<Value>, String> {
    conn.query_row("SELECT * FROM ws_refs WHERE item_id = ?1 AND holder = ?2", params![item_id, holder], ref_json)
        .optional()
        .map_err(|e| e.to_string())
}

/// The permission `holder` has on `item`, ignoring the item's state.
pub fn holder_perm(conn: &Connection, holder: &str, item: &Value) -> Option<&'static str> {
    if holder == "user" || holder.is_empty() {
        return Some("manage");
    }
    if item["owner"].as_str() == Some(holder) {
        return Some("manage");
    }
    let id = item["id"].as_str()?;
    let r = ref_of(conn, id, holder).ok().flatten()?;
    if r["state"] != "live" {
        return None;
    }
    PERMS.iter().copied().find(|p| r["perm"].as_str() == Some(*p))
}

/// May `holder` do `need` on `item`? A trashed or purged item is visible only
/// to the user (in Trash); a missing one stays readable by its holders.
pub fn can(conn: &Connection, holder: &str, item: &Value, need: &str) -> bool {
    if holder == "user" || holder.is_empty() {
        return true;
    }
    if matches!(item["state"].as_str(), Some("trashed") | Some("purged")) {
        return false;
    }
    if item["meta"]["mainHidden"] == true && holder == "agent:main" {
        return false;
    }
    match (holder_perm(conn, holder, item).and_then(perm_rank), perm_rank(need)) {
        (Some(have), Some(want)) => have >= want,
        _ => false,
    }
}

fn item(conn: &Connection, id: &str) -> Result<Value, String> {
    registry::get(conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("No item {id}."))
}

/// Share `item_id` with `holder`. Re-sharing an existing (or revoked)
/// reference updates it.
pub fn share(conn: &Connection, actor: &str, item_id: &str, holder: &str, mode: &str, perm: &str, folder: &str) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let it = item(conn, item_id)?;
    if matches!(it["state"].as_str(), Some("trashed") | Some("purged")) {
        return Err("That item is in Trash. Restore it first.".into());
    }
    let mode = if mode.is_empty() { "reference" } else { mode };
    let perm = if perm.is_empty() { "view" } else { perm };
    if mode == "owner" || !MODES.contains(&mode) {
        return Err(format!("Unknown share mode {mode}. Use reference or mount."));
    }
    let want = perm_rank(perm).ok_or_else(|| format!("Unknown permission {perm}. Use view, use, edit or manage."))?;
    if holder.is_empty() || holder == "user" {
        return Err("Choose who to share it with.".into());
    }
    if it["owner"].as_str() == Some(holder) {
        return Err("That holder already owns it.".into());
    }
    let have = holder_perm(conn, actor, &it).and_then(perm_rank);
    if have != perm_rank("manage") {
        return Err("Sharing needs manage permission on the item.".into());
    }
    if have.unwrap_or(0) < want {
        return Err("You can't give more permission than you have.".into());
    }
    let now = now_ms();
    let prev = ref_of(conn, item_id, holder)?;
    match &prev {
        Some(r) => {
            conn.execute(
                "UPDATE ws_refs SET mode = ?2, perm = ?3, folder = ?4, granted_by = ?5, state = 'live', updated_at = ?6 WHERE id = ?1",
                params![r["id"].as_str().unwrap_or(""), mode, perm, folder, actor, now],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            conn.execute(
                "INSERT INTO ws_refs (id, item_id, holder, mode, perm, folder, granted_by, state, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'live', ?8, ?8)",
                params![new_id("rf"), item_id, holder, mode, perm, folder, actor, now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    audit(conn, actor, "share", Some(item_id), Some(holder), json!({ "mode": mode, "perm": perm, "folder": folder }));
    let pinned = sync_pin(conn, &it);
    let r = ref_of(conn, item_id, holder)?.ok_or("The reference was not saved.")?;
    Ok(json!({ "ref": r, "pinned": pinned }))
}

fn change_check(conn: &Connection, actor: &str, ref_id: &str) -> Result<(Value, Value), String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let r = get_ref(conn, ref_id)?.ok_or("No such reference.")?;
    if r["mode"] == "owner" {
        return Err("The owner's reference can't be changed.".into());
    }
    let it = item(conn, r["itemId"].as_str().unwrap_or(""))?;
    if holder_perm(conn, actor, &it) != Some("manage") {
        return Err("Changing a share needs manage permission on the item.".into());
    }
    Ok((r, it))
}

pub fn set_perm(conn: &Connection, actor: &str, ref_id: &str, perm: &str) -> Result<Value, String> {
    let (r, _) = change_check(conn, actor, ref_id)?;
    perm_rank(perm).ok_or_else(|| format!("Unknown permission {perm}."))?;
    conn.execute("UPDATE ws_refs SET perm = ?2, updated_at = ?3 WHERE id = ?1", params![ref_id, perm, now_ms()]).map_err(|e| e.to_string())?;
    audit(conn, actor, "set_perm", r["itemId"].as_str(), r["holder"].as_str(), json!({ "from": r["perm"], "to": perm }));
    get_ref(conn, ref_id)?.ok_or_else(|| "No such reference.".into()).map(|r| json!({ "ref": r }))
}

pub fn set_mode(conn: &Connection, actor: &str, ref_id: &str, mode: &str) -> Result<Value, String> {
    let (r, _) = change_check(conn, actor, ref_id)?;
    if mode == "owner" || !MODES.contains(&mode) {
        return Err(format!("Unknown share mode {mode}."));
    }
    conn.execute("UPDATE ws_refs SET mode = ?2, updated_at = ?3 WHERE id = ?1", params![ref_id, mode, now_ms()]).map_err(|e| e.to_string())?;
    audit(conn, actor, "set_mode", r["itemId"].as_str(), r["holder"].as_str(), json!({ "from": r["mode"], "to": mode }));
    get_ref(conn, ref_id)?.ok_or_else(|| "No such reference.".into()).map(|r| json!({ "ref": r }))
}

pub fn revoke(conn: &Connection, actor: &str, ref_id: &str) -> Result<Value, String> {
    let (r, it) = change_check(conn, actor, ref_id)?;
    conn.execute("UPDATE ws_refs SET state = 'revoked', updated_at = ?2 WHERE id = ?1", params![ref_id, now_ms()]).map_err(|e| e.to_string())?;
    audit(conn, actor, "revoke", r["itemId"].as_str(), r["holder"].as_str(), json!({}));
    let pinned = sync_pin(conn, &it);
    Ok(json!({ "revoked": ref_id, "pinned": pinned }))
}

/// Every reference to `item_id` (owner first), with the holder's name.
pub fn holders_of(conn: &Connection, item_id: &str) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut st = conn
        .prepare("SELECT * FROM ws_refs WHERE item_id = ?1 ORDER BY CASE mode WHEN 'owner' THEN 0 ELSE 1 END, created_at")
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<Value> = st.query_map(params![item_id], ref_json).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    for r in rows.iter_mut() {
        let h = r["holder"].as_str().unwrap_or("").to_string();
        r["holderName"] = json!(super::principals::get(conn, &h).ok().flatten().and_then(|p| p["name"].as_str().map(str::to_string)).unwrap_or(h));
    }
    Ok(rows)
}

/// Live references `holder` has to other holders' items (not its own).
pub fn live_refs_for(conn: &Connection, holder: &str) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut st = conn
        .prepare("SELECT * FROM ws_refs WHERE holder = ?1 AND state = 'live' AND mode <> 'owner' ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = st.query_map(params![holder], ref_json).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The items shared with `holder` that it may see now, each with `ref`.
pub fn visible_to(conn: &Connection, holder: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for r in live_refs_for(conn, holder)? {
        let Some(mut it) = registry::get(conn, r["itemId"].as_str().unwrap_or("")).map_err(|e| e.to_string())? else { continue };
        if !can(conn, holder, &it, "view") {
            continue;
        }
        it["ref"] = r;
        out.push(it);
    }
    Ok(out)
}

/// Live references held by anyone other than the owner.
pub fn live_shares(conn: &Connection, item_id: &str) -> Result<Vec<Value>, String> {
    Ok(holders_of(conn, item_id)?.into_iter().filter(|r| r["state"] == "live" && r["mode"] != "owner").collect())
}

/// Main memory shared with a sub-agent is pinned in the host store, so the
/// host's eviction (oldest first past its cap) never drops it. The pin is
/// cleared when the last such reference goes. Returns the pin state, or
/// null when the item is not main memory or the host is unavailable.
pub fn sync_pin(conn: &Connection, it: &Value) -> Value {
    if it["kind"] != "memory_longterm" {
        return Value::Null;
    }
    let id = it["id"].as_str().unwrap_or("");
    let need = live_shares(conn, id).unwrap_or_default().iter().any(|r| r["holder"] != "agent:main");
    let was = it["meta"]["pinned"] == true;
    if need == was {
        return json!(need);
    }
    let key = it["meta"]["key"].as_str().unwrap_or("");
    match super::host::merge_flags(key, json!({ "pinned": if need { json!(true) } else { Value::Null } })) {
        Ok(()) => {
            let _ = conn.execute(
                "UPDATE ws_items SET meta_json = json_remove(json_set(meta_json, '$.pinned', json(?2)), '$.pinPending') WHERE id = ?1",
                params![id, if need { "true" } else { "false" }],
            );
            json!(need)
        }
        Err(_) => {
            // Retried by the next sweep.
            let _ = conn.execute("UPDATE ws_items SET meta_json = json_set(meta_json, '$.pinPending', json('true')) WHERE id = ?1", params![id]);
            Value::Null
        }
    }
}

/// Items mounted into `holder`'s own memory (plan.md, Phase 4 item 5): live
/// `mount` refs with `use` or more, on items that are not in Trash. Each is
/// (item, text). The text is read where it lives (no copy).
pub fn mounted_for(conn: &Connection, holder: &str) -> Vec<(Value, String)> {
    if ensure_tables(conn).is_err() {
        return Vec::new();
    }
    let ids: Vec<String> = conn
        .prepare("SELECT item_id FROM ws_refs WHERE holder = ?1 AND state = 'live' AND mode = 'mount' AND perm IN ('use', 'edit', 'manage') ORDER BY created_at")
        .and_then(|mut st| st.query_map(params![holder], |r| r.get(0))?.collect::<Result<Vec<String>, _>>())
        .unwrap_or_default();
    let dir = super::meta_get(conn, "subagents_state_dir").ok().flatten().map(std::path::PathBuf::from);
    let src = registry::Sources { state_dir: dir.as_deref(), ..Default::default() };
    let mut out = Vec::new();
    for id in ids {
        let Ok(Some(it)) = registry::get(conn, &id) else { continue };
        if !can(conn, holder, &it, "use") {
            continue;
        }
        let Ok(v) = registry::read(conn, &src, &id, None) else { continue };
        let text = v["text"].as_str().or(v["content"]["text"].as_str()).map(str::to_string).unwrap_or_else(|| {
            let c = &v["content"];
            c.as_str().map(str::to_string).unwrap_or_else(|| c.to_string())
        });
        out.push((it, text));
    }
    out
}

/// Register a fork by reference (plan.md Phase 4, "forkChat"): the source
/// chat's message range `[0, upto)` becomes an item owned by the source chat,
/// the new chat holds a `reference` ref (perm `use`) to it, and gets a short
/// summary item of what it branched from. Nothing is copied. Returns the ref
/// id, which `fork_refs` keeps so a suspended or revoked ref hides the range.
pub fn record_fork(conn: &Connection, source_key: &str, fork_key: &str, upto: usize, summary: &str) -> Result<String, String> {
    registry::ensure_tables(conn).map_err(|e| e.to_string())?;
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let e = |x: rusqlite::Error| x.to_string();
    let source_loc = format!("db:sessions/{source_key}");
    let source_title = registry::get_by_loc(conn, &source_loc)
        .map_err(e)?
        .and_then(|it| it["title"].as_str().map(str::to_string))
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| source_key.to_string());
    let mut source = registry::Entry::new("chat", source_loc.clone(), registry::session_holder(source_key), source_title.clone());
    source.meta = json!({ "sessionKey": source_key });
    registry::touch(conn, &source).map_err(e)?;

    let mut chat = registry::Entry::new("chat", format!("db:sessions/{fork_key}"), registry::session_holder(fork_key), format!("Branch of {source_title}"));
    chat.meta = json!({ "sessionKey": fork_key, "forkOf": source_key, "referencedMessages": upto });
    registry::touch(conn, &chat).map_err(e)?;

    let mut range = registry::Entry::new(
        "message_range",
        format!("db:fork/{fork_key}"),
        registry::session_holder(source_key),
        format!("Messages 1\u{2013}{upto} of {source_title}"),
    );
    range.parent_loc = Some(source_loc);
    range.meta = json!({ "sourceSessionKey": source_key, "forkSessionKey": fork_key, "from": 0, "upto": upto });
    let range_id = registry::touch(conn, &range).map_err(e)?;

    let mut sum = registry::Entry::new("summary", format!("db:fork_summary/{fork_key}"), registry::session_holder(fork_key), format!("Branched from {source_title}"));
    sum.parent_loc = Some(format!("db:sessions/{fork_key}"));
    sum.size = summary.len() as i64;
    sum.meta = json!({ "text": summary, "sourceSessionKey": source_key, "rangeItemId": range_id });
    registry::touch(conn, &sum).map_err(e)?;

    let shared = share(conn, "user", &range_id, &registry::session_holder(fork_key), "reference", "use", "")?;
    let ref_id = shared["ref"]["id"].as_str().unwrap_or("").to_string();
    audit(conn, "user", "fork", Some(&range_id), Some(&registry::session_holder(fork_key)), json!({ "source": source_key, "upto": upto }));
    Ok(ref_id)
}
