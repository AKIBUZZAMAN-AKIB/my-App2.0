//! Safe deletion (plan.md, Phase 4, rules 5 to 8): the delete policy, Trash,
//! purging at the source, deleting a holder, and the sweep.
//!
//! - Policy modes: `timed` (Trash, purged when the retention ends, or never
//!   automatically when `retain_secs` is NULL = "until I empty the Trash")
//!   and `direct` (purged at once). Resolution, most specific first: the
//!   choice for this one action, the holder being deleted from, the item's
//!   kind, the global policy. First install: timed, 30 days.
//! - Trashing an item suspends its refs; restoring makes them live again and
//!   gives the item back to its owner if that holder still exists, otherwise
//!   to the user's library marked "from deleted".
//! - Deleting a holder: items it owns with live refs elsewhere are detached
//!   (`owner = 'detached'`, origin kept); the rest follow the policy; refs it
//!   holds are revoked. "Delete everywhere" removes shared items too (Trash
//!   with refs suspended, or purge with refs revoked). Both modes keep
//!   shared items unless "everywhere" is chosen.
//! - Purge deletes the bytes where they live (`loc`). A failed purge leaves
//!   the item in Trash with `meta.purge_error`, retried by the next sweep.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::ids::new_id;
use super::registry::{self, Sources};
use super::{now_ms, refs};

pub const DEFAULT_RETAIN_SECS: i64 = 30 * 86_400;
/// 1 hour to 10 years.
pub const MIN_RETAIN_SECS: i64 = 3_600;
pub const MAX_RETAIN_SECS: i64 = 10 * 365 * 86_400;
/// The sweep runs at most once every 10 minutes.
pub const SWEEP_EVERY_MS: i64 = 10 * 60_000;
const SWEEP_BATCH: usize = 200;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    refs::ensure_tables(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_delete_policy (
            scope       TEXT PRIMARY KEY,
            mode        TEXT NOT NULL,
            retain_secs INTEGER,
            updated_at  INTEGER NOT NULL,
            updated_by  TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS ws_pending_client_purges (
            item_id   TEXT PRIMARY KEY,
            loc       TEXT NOT NULL,
            queued_at INTEGER NOT NULL
         );",
    )?;
    for (col, ty) in [("trashed_at", "INTEGER"), ("purge_after", "INTEGER"), ("trashed_by", "TEXT"), ("restore_owner", "TEXT"), ("trash_batch", "TEXT")] {
        if conn.prepare(&format!("SELECT {col} FROM ws_items LIMIT 0")).is_err() {
            conn.execute(&format!("ALTER TABLE ws_items ADD COLUMN {col} {ty}"), [])?;
        }
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS ws_items_purge ON ws_items(state, purge_after);")?;
    conn.execute(
        "INSERT OR IGNORE INTO ws_delete_policy (scope, mode, retain_secs, updated_at, updated_by) VALUES ('global', 'timed', ?1, ?2, 'system')",
        params![DEFAULT_RETAIN_SECS, now_ms()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub mode: String,
    /// None = keep until the user empties the Trash.
    pub retain_secs: Option<i64>,
    pub scope: String,
}

impl Policy {
    pub fn json(&self) -> Value {
        json!({ "mode": self.mode, "retainSecs": self.retain_secs, "scope": self.scope })
    }
    pub fn direct(&self) -> bool {
        self.mode == "direct"
    }
    pub fn purge_after(&self, from: i64) -> Option<i64> {
        self.retain_secs.map(|s| from + s * 1000)
    }
}

/// The per-action choice in the delete dialog.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Override {
    pub mode: Option<String>,
    pub retain_secs: Option<Option<i64>>,
}

impl Override {
    pub fn from_req(req: &Value) -> Self {
        let mode = req.get("mode").and_then(Value::as_str).filter(|m| *m == "direct" || *m == "timed").map(str::to_string);
        let retain_secs = match req.get("retainSecs") {
            Some(Value::Null) => Some(None),
            Some(v) => v.as_i64().map(|n| Some(n.clamp(MIN_RETAIN_SECS, MAX_RETAIN_SECS))),
            None => None,
        };
        Override { mode, retain_secs }
    }
    fn is_set(&self) -> bool {
        self.mode.is_some()
    }
}

fn policy_row(conn: &Connection, scope: &str) -> Option<Policy> {
    conn.query_row("SELECT mode, retain_secs FROM ws_delete_policy WHERE scope = ?1", params![scope], |r| {
        Ok(Policy { mode: r.get(0)?, retain_secs: r.get(1)?, scope: scope.to_string() })
    })
    .ok()
}

/// The policy for deleting `item` from `holder` (rule 8): action override >
/// holder > kind > global > first-install default.
pub fn policy_for(conn: &Connection, item: &Value, holder: Option<&str>, action: &Override) -> Policy {
    if action.is_set() {
        let mode = action.mode.clone().unwrap_or_default();
        let retain = if mode == "direct" { None } else { action.retain_secs.unwrap_or(Some(DEFAULT_RETAIN_SECS)) };
        return Policy { mode, retain_secs: retain, scope: "action".into() };
    }
    let owner = item["owner"].as_str().unwrap_or("");
    let holder = holder.filter(|h| !h.is_empty()).unwrap_or(owner);
    let kind = item["kind"].as_str().unwrap_or("");
    policy_row(conn, &format!("holder:{holder}"))
        .or_else(|| policy_row(conn, &format!("kind:{kind}")))
        .or_else(|| policy_row(conn, "global"))
        .unwrap_or(Policy { mode: "timed".into(), retain_secs: Some(DEFAULT_RETAIN_SECS), scope: "default".into() })
}

pub fn list_policies(conn: &Connection) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut st = conn.prepare("SELECT scope, mode, retain_secs, updated_at, updated_by FROM ws_delete_policy ORDER BY scope").map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            Ok(json!({ "scope": r.get::<_, String>(0)?, "mode": r.get::<_, String>(1)?, "retainSecs": r.get::<_, Option<i64>>(2)?, "updatedAt": r.get::<_, i64>(3)?, "updatedBy": r.get::<_, String>(4)? }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn valid_scope(scope: &str) -> bool {
    scope == "global" || scope.strip_prefix("kind:").is_some_and(|k| !k.is_empty()) || scope.strip_prefix("holder:").is_some_and(|h| !h.is_empty())
}

fn col_i64(conn: &Connection, id: &str, col: &str) -> Option<i64> {
    conn.query_row(&format!("SELECT {col} FROM ws_items WHERE id = ?1"), params![id], |r| r.get::<_, Option<i64>>(0)).ok().flatten()
}

/// Set a policy. New deletions follow it. With `apply_to_existing`, items in
/// Trash it governs get a new removal time; when that makes some due now,
/// nothing is saved unless `confirm` is set, and the reply carries the count
/// ("12 items will be removed now"). Switching to direct never empties the
/// Trash without that confirmation.
#[allow(clippy::too_many_arguments)]
pub fn set_policy(conn: &Connection, src: &Sources, actor: &str, scope: &str, mode: &str, retain_secs: Option<i64>, apply_to_existing: bool, confirm: bool) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    if !valid_scope(scope) {
        return Err(format!("Unknown policy scope {scope}. Use global, kind:<kind> or holder:<id>."));
    }
    if mode != "timed" && mode != "direct" {
        return Err("The delete mode is timed or direct.".into());
    }
    let retain = if mode == "timed" { retain_secs.map(|s| s.clamp(MIN_RETAIN_SECS, MAX_RETAIN_SECS)) } else { None };
    let mut moved: Vec<(String, Option<i64>)> = Vec::new();
    let mut due: Vec<String> = Vec::new();
    if apply_to_existing {
        let now = now_ms();
        for it in registry::query(conn, "state = 'trashed'", &[]).map_err(|e| e.to_string())? {
            let owner = it["owner"].as_str().unwrap_or("").to_string();
            let kind = it["kind"].as_str().unwrap_or("");
            let has_holder = policy_row(conn, &format!("holder:{owner}")).is_some();
            let has_kind = policy_row(conn, &format!("kind:{kind}")).is_some();
            let governs = match scope.split_once(':') {
                Some(("holder", h)) => owner == h,
                Some(("kind", k)) => kind == k && !has_holder,
                _ => !has_holder && !has_kind,
            };
            if !governs {
                continue;
            }
            let id = it["id"].as_str().unwrap_or("").to_string();
            let at = col_i64(conn, &id, "trashed_at").unwrap_or(now);
            let after = retain.map(|s| at + s * 1000);
            if mode == "direct" || after.is_some_and(|a| a <= now) {
                due.push(id);
            } else {
                moved.push((id, after));
            }
        }
        if !due.is_empty() && !confirm {
            return Ok(json!({ "saved": false, "needsConfirm": true, "due": due.len(), "moved": moved.len(), "message": format!("{} item(s) will be removed now.", due.len()) }));
        }
    }
    conn.execute(
        "INSERT INTO ws_delete_policy (scope, mode, retain_secs, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(scope) DO UPDATE SET mode = excluded.mode, retain_secs = excluded.retain_secs, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
        params![scope, mode, retain, now_ms(), actor],
    )
    .map_err(|e| e.to_string())?;
    refs::audit(conn, actor, "set_policy", None, None, json!({ "scope": scope, "mode": mode, "retainSecs": retain, "applyToExisting": apply_to_existing }));
    for (id, after) in &moved {
        let _ = conn.execute("UPDATE ws_items SET purge_after = ?2 WHERE id = ?1", params![id, after]);
    }
    let mut purged = 0;
    let mut failed = Vec::new();
    for id in &due {
        match purge(conn, src, actor, id) {
            Ok(()) => purged += 1,
            Err(e) => failed.push(json!({ "id": id, "error": e })),
        }
    }
    Ok(json!({ "saved": true, "policy": { "scope": scope, "mode": mode, "retainSecs": retain }, "moved": moved.len(), "purged": purged, "failed": failed }))
}

pub fn clear_policy(conn: &Connection, actor: &str, scope: &str) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    if scope == "global" {
        return Err("The global policy can be changed, not removed.".into());
    }
    let n = conn.execute("DELETE FROM ws_delete_policy WHERE scope = ?1", params![scope]).map_err(|e| e.to_string())?;
    refs::audit(conn, actor, "clear_policy", None, None, json!({ "scope": scope }));
    Ok(json!({ "removed": n > 0 }))
}

fn get(conn: &Connection, id: &str) -> Result<Value, String> {
    registry::get(conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("No item {id}."))
}

fn set_meta(conn: &Connection, id: &str, path: &str, json_value: &str) {
    let _ = conn.execute(&format!("UPDATE ws_items SET meta_json = json_set(meta_json, '$.{path}', json(?2)) WHERE id = ?1"), params![id, json_value]);
}

fn del_meta(conn: &Connection, id: &str, path: &str) {
    let _ = conn.execute(&format!("UPDATE ws_items SET meta_json = json_remove(meta_json, '$.{path}') WHERE id = ?1"), params![id]);
}

/// Merge host flags into a main-memory entry; queued when the host is away.
/// The engine tables are the source of truth, so a pending flag is retried
/// by the sweep.
pub fn host_flag(conn: &Connection, it: &Value, flags: Value) {
    if it["kind"] != "memory_longterm" {
        return;
    }
    let id = it["id"].as_str().unwrap_or("");
    let key = it["meta"]["key"].as_str().unwrap_or("");
    if super::host::merge_flags(key, flags.clone()).is_ok() {
        del_meta(conn, id, "hostPending");
    } else {
        set_meta(conn, id, "hostPending", &flags.to_string());
    }
}

/// Move one item to Trash under `policy` (direct = purge). `suspend` marks
/// its live refs suspended (they come back on restore).
fn trash_with(conn: &Connection, src: &Sources, actor: &str, id: &str, policy: &Policy, batch: Option<&str>) -> Result<Value, String> {
    let it = get(conn, id)?;
    if it["state"] == "purged" {
        return Ok(json!({ "id": id, "already": "purged" }));
    }
    if policy.direct() {
        purge(conn, src, actor, id)?;
        return Ok(json!({ "id": id, "purged": true }));
    }
    if it["state"] == "trashed" {
        return Ok(json!({ "id": id, "already": "trashed" }));
    }
    let now = now_ms();
    mark_trashed(conn, actor, &it, policy.purge_after(now), batch, policy.json())
}

/// Put a live item in Trash with a removal time (None = until emptied):
/// its shares are suspended and the host is told. Bulk delete uses it with
/// `purge_after = now` for items it purges after the batch commits.
pub(crate) fn mark_trashed(conn: &Connection, actor: &str, it: &Value, after: Option<i64>, batch: Option<&str>, policy: Value) -> Result<Value, String> {
    let id = it["id"].as_str().unwrap_or("");
    let now = now_ms();
    conn.execute(
        "UPDATE ws_items SET state = 'trashed', trashed_at = ?2, purge_after = ?3, trashed_by = ?4, restore_owner = owner, trash_batch = ?5 WHERE id = ?1",
        params![id, now, after, actor, batch],
    )
    .map_err(|e| e.to_string())?;
    del_meta(conn, id, "purge_error");
    conn.execute("UPDATE ws_refs SET state = 'suspended', updated_at = ?2 WHERE item_id = ?1 AND state = 'live' AND mode <> 'owner'", params![id, now])
        .map_err(|e| e.to_string())?;
    host_flag(conn, it, json!({ "trashed_at": now }));
    refs::sync_pin(conn, it);
    refs::audit(conn, actor, "trash", Some(id), None, json!({ "policy": policy, "batch": batch }));
    Ok(json!({ "id": id, "trashed": true, "purgeAfter": after }))
}

/// Does `holder` still exist?
fn holder_exists(conn: &Connection, holder: &str) -> bool {
    if holder == "user" || holder == "agent:main" {
        return true;
    }
    if holder == "detached" {
        return false;
    }
    if super::meta_get(conn, &format!("deleted_holder:{holder}")).ok().flatten().is_some() {
        return false;
    }
    match super::principals::get(conn, holder) {
        Ok(Some(p)) => p["state"].as_str().is_none_or(|s| s != "deleted"),
        // Chats are not principals; they exist until deleted.
        _ => true,
    }
}

pub fn restore(conn: &Connection, actor: &str, id: &str) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let it = get(conn, id)?;
    if it["state"] != "trashed" {
        return Err("That item is not in Trash.".into());
    }
    let back_to: Option<String> = conn.query_row("SELECT restore_owner FROM ws_items WHERE id = ?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let back_to = back_to.unwrap_or_else(|| it["owner"].as_str().unwrap_or("").to_string());
    let mut detached = false;
    if !holder_exists(conn, &back_to) {
        let origin = it["meta"]["origin"].as_str().map(str::to_string).unwrap_or_else(|| back_to.clone());
        detach(conn, id, &origin)?;
        detached = true;
    } else if it["owner"].as_str() != Some(back_to.as_str()) {
        reown(conn, id, &back_to)?;
    }
    conn.execute(
        "UPDATE ws_items SET state = 'live', trashed_at = NULL, purge_after = NULL, trashed_by = NULL, restore_owner = NULL, trash_batch = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    del_meta(conn, id, "purge_error");
    let refs_back = conn
        .execute("UPDATE ws_refs SET state = 'live', updated_at = ?2 WHERE item_id = ?1 AND state = 'suspended'", params![id, now_ms()])
        .map_err(|e| e.to_string())?;
    let it = get(conn, id)?;
    host_flag(conn, &it, json!({ "trashed_at": null }));
    if it["kind"] == "memory_longterm" && table_exists(conn, "ctx_mem_longterm") {
        let _ = conn.execute("UPDATE ctx_mem_longterm SET removed = 0 WHERE key = ?1", params![it["meta"]["key"].as_str().unwrap_or("")]);
    }
    refs::sync_pin(conn, &it);
    refs::audit(conn, actor, "restore", Some(id), None, json!({ "owner": it["owner"], "refs": refs_back }));
    Ok(json!({ "id": id, "restored": true, "owner": it["owner"], "fromDeleted": detached, "refs": refs_back }))
}

/// Restore everything one delete changed (the 10-second Undo toast).
pub fn restore_batch(conn: &Connection, actor: &str, batch: &str) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let trashed = registry::query(conn, "trash_batch = ?1 AND state = 'trashed'", &[&batch]).map_err(|e| e.to_string())?;
    let detached = registry::query(conn, "json_extract(meta_json, '$.detachBatch') = ?1", &[&batch]).map_err(|e| e.to_string())?;
    let revoked: Vec<String> = {
        let mut st = conn
            .prepare("SELECT holder, json_extract(detail_json, '$.ref') FROM ws_audit WHERE action = 'revoke_on_delete' AND json_extract(detail_json, '$.batch') = ?1")
            .map_err(|e| e.to_string())?;
        let rows = st.query_map(params![batch], |r| r.get::<_, Option<String>>(1)).map_err(|e| e.to_string())?.filter_map(|r| r.ok().flatten()).collect();
        rows
    };
    // The holder comes back first, so its items return to it. The batch's
    // `delete_holder` audit row names it even when nothing was detached (a
    // chat with no shared items), so Undo never sends them to the library.
    let deleted_holder: Option<String> = conn
        .query_row(
            "SELECT holder FROM ws_audit WHERE action = 'delete_holder' AND json_extract(detail_json, '$.batch') = ?1 ORDER BY at DESC LIMIT 1",
            params![batch],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .or_else(|| detached.first().and_then(|it| it["meta"]["origin"].as_str()).map(str::to_string));
    if let Some(h) = deleted_holder.as_deref() {
        conn.execute("DELETE FROM ws_meta WHERE k = ?1", params![format!("deleted_holder:{h}")]).map_err(|e| e.to_string())?;
        let _ = conn.execute("UPDATE ws_principals SET state = 'active' WHERE pid = ?1 AND state = 'deleted'", params![h]);
    }
    for it in &detached {
        let id = it["id"].as_str().unwrap_or("");
        if let Some(prev) = it["meta"]["origin"].as_str() {
            reown(conn, id, prev)?;
            del_meta(conn, id, "detachBatch");
            del_meta(conn, id, "fromDeleted");
        }
    }
    let mut back = 0;
    for rid in &revoked {
        back += conn.execute("UPDATE ws_refs SET state = 'live' WHERE id = ?1 AND state = 'revoked'", params![rid]).unwrap_or(0);
    }
    for it in &trashed {
        restore(conn, actor, it["id"].as_str().unwrap_or(""))?;
    }
    refs::audit(conn, actor, "undo", None, None, json!({ "batch": batch, "restored": trashed.len(), "reattached": detached.len(), "refs": back }));
    Ok(json!({ "restored": trashed.len(), "reattached": detached.len(), "refs": back }))
}

/// Change the owner and its owner ref (rule 6). Others' refs point at the id
/// and stay valid.
pub fn reown(conn: &Connection, id: &str, owner: &str) -> Result<(), String> {
    let old: String = conn.query_row("SELECT owner FROM ws_items WHERE id = ?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
    conn.execute("UPDATE ws_items SET owner = ?2 WHERE id = ?1", params![id, owner]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM ws_refs WHERE item_id = ?1 AND holder = ?2 AND mode = 'owner'", params![id, old]).map_err(|e| e.to_string())?;
    refs::add_owner(conn, id, owner).map_err(|e| e.to_string())?;
    Ok(())
}

/// Hand an item to the user's library: `owner = 'detached'`, origin kept.
pub(crate) fn detach(conn: &Connection, id: &str, origin: &str) -> Result<(), String> {
    reown(conn, id, "detached")?;
    let name = super::principals::get(conn, origin).ok().flatten().and_then(|p| p["name"].as_str().map(str::to_string)).unwrap_or_else(|| origin.to_string());
    conn.execute("UPDATE ws_items SET meta_json = json_set(meta_json, '$.origin', ?2, '$.fromDeleted', ?3) WHERE id = ?1", params![id, origin, name])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete the bytes at the source, then mark the item purged and revoke its
/// refs. On failure the item stays in Trash with `meta.purge_error`.
pub fn purge(conn: &Connection, src: &Sources, actor: &str, id: &str) -> Result<(), String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let it = get(conn, id)?;
    if it["state"] == "purged" {
        return Ok(());
    }
    let loc = it["loc"].as_str().unwrap_or("").to_string();
    if let Err(e) = purge_source(conn, src, &it, &loc) {
        let now = now_ms();
        let _ = conn.execute(
            "UPDATE ws_items SET state = 'trashed', trashed_at = COALESCE(trashed_at, ?2), purge_after = COALESCE(purge_after, ?2), restore_owner = COALESCE(restore_owner, owner) WHERE id = ?1",
            params![id, now],
        );
        set_meta(conn, id, "purge_error", &json!(e).to_string());
        refs::audit(conn, actor, "purge_failed", Some(id), None, json!({ "error": e }));
        return Err(e);
    }
    let now = now_ms();
    conn.execute("UPDATE ws_items SET state = 'purged', updated_at = ?2 WHERE id = ?1", params![id, now]).map_err(|e| e.to_string())?;
    del_meta(conn, id, "purge_error");
    conn.execute("UPDATE ws_refs SET state = 'revoked', updated_at = ?2 WHERE item_id = ?1 AND mode <> 'owner'", params![id, now]).map_err(|e| e.to_string())?;
    refs::audit(conn, actor, "purge", Some(id), None, json!({ "loc": loc }));
    gc_blobs(conn);
    Ok(())
}

fn table_exists(conn: &Connection, t: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", params![t], |_| Ok(())).is_ok()
}

/// Rule 7: a `ctx_mem_file_store` blob goes only when no live file item or
/// checklist file row points at its hash.
pub fn gc_blobs(conn: &Connection) -> usize {
    if !table_exists(conn, "ctx_mem_file_store") {
        return 0;
    }
    let files = if table_exists(conn, "ctx_mem_files") { "AND hash NOT IN (SELECT hash FROM ctx_mem_files)" } else { "" };
    conn.execute(
        &format!(
            "DELETE FROM ctx_mem_file_store WHERE hash IN (
               SELECT substr(loc, length('db:ctx_mem_file_store/') + 1) FROM ws_items
               WHERE loc LIKE 'db:ctx_mem_file_store/%' AND state = 'purged')
             AND hash NOT IN (
               SELECT substr(loc, length('db:ctx_mem_file_store/') + 1) FROM ws_items
               WHERE loc LIKE 'db:ctx_mem_file_store/%' AND state <> 'purged')
             {files}"
        ),
        [],
    )
    .unwrap_or(0)
}

fn purge_source(conn: &Connection, src: &Sources, it: &Value, loc: &str) -> Result<(), String> {
    let e = |x: rusqlite::Error| x.to_string();
    let pair = |rest: &str| -> Result<(String, String), String> { rest.rsplit_once('/').map(|(a, b)| (a.to_string(), b.to_string())).ok_or_else(|| format!("bad loc {loc}")) };
    if let Some(key) = loc.strip_prefix("db:sessions/") {
        purge_session(conn, key)?;
    } else if let Some(key) = loc.strip_prefix("db:turn_memory/") {
        if table_exists(conn, "turn_memory") {
            conn.execute("DELETE FROM turn_memory WHERE session_key = ?1", params![key]).map_err(e)?;
        }
    } else if let Some(rest) = loc.strip_prefix("db:tool_results/") {
        let (key, no) = pair(rest)?;
        conn.execute("DELETE FROM tool_results WHERE session_key = ?1 AND result_no = ?2", params![key, no.parse::<i64>().unwrap_or(-1)]).map_err(e)?;
    } else if let Some(rest) = loc.strip_prefix("db:ctx_notes/") {
        let (key, nid) = pair(rest)?;
        conn.execute("DELETE FROM ctx_notes WHERE session_key = ?1 AND id = ?2", params![key, nid]).map_err(e)?;
    } else if let Some(rest) = loc.strip_prefix("db:ctx_temp_summaries/") {
        let (key, sid) = pair(rest)?;
        conn.execute("DELETE FROM ctx_temp_summaries WHERE session_key = ?1 AND id = ?2", params![key, sid]).map_err(e)?;
    } else if loc.starts_with("db:ctx_mem_file_store/") {
        // Bytes go in `gc_blobs`, only when nothing else points at the hash.
    } else if let Some(mid) = loc.strip_prefix("db:ws_messages/") {
        // A message always leaves its tombstone; the thread keeps its place.
        conn.execute("UPDATE ws_messages SET state = 'deleted', text = '', attachments_json = '[]', deleted_at = ?2 WHERE id = ?1", params![mid, now_ms()]).map_err(e)?;
    } else if let Some(fork_key) = loc.strip_prefix("db:fork/") {
        // The range a fork references: the fork keeps only its own messages
        // from now on; a container nobody reads any more goes with it.
        crate::fork_refs::break_link(conn, fork_key).map_err(|x| x.to_string())?;
    } else if loc.starts_with("db:fork_summary/") {
        // The summary text lives in the item itself.
    } else if let Some(mid) = loc.strip_prefix("db:hub_messages/") {
        conn.execute("DELETE FROM hub_messages WHERE id = ?1", params![mid]).map_err(e)?;
    } else if let Some(pid) = loc.strip_prefix("db:hub_posts/") {
        conn.execute("DELETE FROM hub_posts WHERE id = ?1", params![pid]).map_err(e)?;
    } else if let Some(gid) = loc.strip_prefix("db:ws_groups/") {
        if table_exists(conn, "ws_groups") {
            conn.execute("UPDATE ws_groups SET state = 'deleted' WHERE id = ?1", params![gid]).map_err(e)?;
        }
    } else if let Some(rest) = loc.strip_prefix("fs:subagents/") {
        if let Some((aid, eid)) = rest.split_once("/memory.json#") {
            let dir = src.state_dir.ok_or("The sub-agent store is not available.")?;
            let p = dir.join("memory").join(format!("{}.json", registry::sanitize(aid)));
            if p.exists() {
                let raw = std::fs::read(&p).map_err(|x| x.to_string())?;
                let mut entries: Vec<Value> = serde_json::from_slice(&raw).unwrap_or_default();
                entries.retain(|x| !registry::memory_entry_is(x, eid));
                std::fs::write(&p, serde_json::to_vec(&entries).map_err(|x| x.to_string())?).map_err(|x| x.to_string())?;
            }
        }
        // The sub-agent record itself is removed by the sub-agent manager,
        // which calls `delete_holder` first.
    } else if let Some(rel) = loc.strip_prefix("fs:workspace/") {
        let root = src.workspace_dir.ok_or("The workspace is not available.")?;
        let p = registry::safe_join(root, rel).ok_or("That path is outside the workspace.")?;
        if p.is_file() {
            std::fs::remove_file(&p).map_err(|x| format!("{rel}: {x}"))?;
        }
    } else if loc.starts_with("host:memory@key:") {
        return Err("This memory came from an older app build and can't be deleted from here until the app updates it.".into());
    } else if loc.starts_with("host:memory#") {
        let key = it["meta"]["key"].as_str().unwrap_or("");
        let host = super::host::current().ok_or("Main memory is not available right now; it will be deleted on the next sweep.")?;
        match host.forget(key) {
            Ok(()) => {}
            Err(m) if m.to_lowercase().contains("no memory") || m.to_lowercase().contains("not found") => {}
            Err(m) => return Err(m),
        }
        if table_exists(conn, "ctx_mem_longterm") {
            let _ = conn.execute("UPDATE ctx_mem_longterm SET removed = 1 WHERE key = ?1", params![key]);
        }
    } else if loc.starts_with("idb:") {
        // The WebView deletes it (`items.purgeClient`), retried on next open.
        conn.execute(
            "INSERT OR IGNORE INTO ws_pending_client_purges (item_id, loc, queued_at) VALUES (?1, ?2, ?3)",
            params![it["id"].as_str().unwrap_or(""), loc, now_ms()],
        )
        .map_err(e)?;
    }
    Ok(())
}

/// A chat's transcript is purged as one unit with `db::clear_session`. If
/// messages of that chat are referenced elsewhere, the session is kept as a
/// hidden `detached` container holding only those messages.
fn purge_session(conn: &Connection, key: &str) -> Result<(), String> {
    let kept: Vec<(i64, String)> = if table_exists(conn, "ws_messages") {
        let mut st = conn
            .prepare(
                "SELECT m.rowid, m.id FROM ws_messages m JOIN ws_items i ON i.loc = 'db:ws_messages/' || m.id
                 JOIN ws_refs r ON r.item_id = i.id AND r.state = 'live' AND r.mode <> 'owner'
                 WHERE m.conversation = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = st.query_map(params![format!("chat:{key}")], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        rows
    } else {
        Vec::new()
    };
    crate::db::clear_session(conn, key).map_err(|x| x.to_string())?;
    if table_exists(conn, "ws_messages") {
        if kept.is_empty() {
            conn.execute("DELETE FROM ws_messages WHERE conversation = ?1", params![format!("chat:{key}")]).map_err(|e| e.to_string())?;
        } else {
            let ids: Vec<String> = kept.iter().map(|k| format!("'{}'", k.1.replace('\'', "''"))).collect();
            conn.execute(&format!("DELETE FROM ws_messages WHERE conversation = ?1 AND id NOT IN ({})", ids.join(",")), params![format!("chat:{key}")])
                .map_err(|e| e.to_string())?;
            super::meta_set(conn, &format!("detached_container:{key}"), &kept.len().to_string()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Purge what is due (batches of 200), and retry pending host flags.
pub fn sweep(conn: &Connection, src: &Sources, now: i64) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut purged = 0;
    let mut failed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    loop {
        let due = registry::query(conn, "state = 'trashed' AND purge_after IS NOT NULL AND purge_after <= ?1 ORDER BY purge_after LIMIT 200", &[&now]).map_err(|e| e.to_string())?;
        let batch: Vec<Value> = due.into_iter().filter(|it| seen.insert(it["id"].as_str().unwrap_or("").to_string())).collect();
        if batch.is_empty() {
            break;
        }
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for it in &batch {
            let id = it["id"].as_str().unwrap_or("");
            match purge(&tx, src, "system", id) {
                Ok(()) => purged += 1,
                Err(e) => failed.push(json!({ "id": id, "error": e })),
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        if batch.len() < SWEEP_BATCH {
            break;
        }
    }
    let mut flags = 0;
    if super::host::current().is_some() {
        for it in registry::query(conn, "json_extract(meta_json, '$.hostPending') IS NOT NULL", &[]).map_err(|e| e.to_string())? {
            let f: Value = match &it["meta"]["hostPending"] {
                Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
                v => v.clone(),
            };
            host_flag(conn, &it, f);
            flags += 1;
        }
        for it in registry::query(conn, "json_extract(meta_json, '$.pinPending') = 1", &[]).map_err(|e| e.to_string())? {
            refs::sync_pin(conn, &it);
            flags += 1;
        }
    }
    super::meta_set(conn, "trash_swept_at", &now.to_string()).map_err(|e| e.to_string())?;
    if purged > 0 {
        let prev: i64 = super::meta_get(conn, "trash_auto_purged").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
        super::meta_set(conn, "trash_auto_purged", &(prev + purged).to_string()).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "purged": purged, "failed": failed, "flagsRetried": flags }))
}

/// Sweep when the last one is older than ten minutes.
pub fn maybe_sweep(conn: &Connection, src: &Sources) {
    let at: i64 = super::meta_get(conn, "trash_swept_at").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
    let now = now_ms();
    if now - at >= SWEEP_EVERY_MS {
        let _ = sweep(conn, src, now);
    }
}

/// The count of items the sweep removed since the user last saw the notice
/// ("12 items were removed from Trash (their time ended)"); reading clears it.
pub fn take_auto_purged(conn: &Connection) -> i64 {
    let n: i64 = super::meta_get(conn, "trash_auto_purged").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
    if n > 0 {
        let _ = super::meta_set(conn, "trash_auto_purged", "0");
    }
    n
}

/// One Trash row: id, trashed_at, purge_after, trashed_by, restore_owner.
type TrashRow = (String, Option<i64>, Option<i64>, Option<String>, Option<String>);

/// The items in Trash, newest first.
pub fn list_trash(conn: &Connection) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut st = conn
        .prepare("SELECT id, trashed_at, purge_after, trashed_by, restore_owner FROM ws_items WHERE state = 'trashed' ORDER BY trashed_at DESC LIMIT 1000")
        .map_err(|e| e.to_string())?;
    let rows: Vec<TrashRow> =
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, at, after, by, owner) in rows {
        if let Some(mut it) = registry::get(conn, &id).map_err(|e| e.to_string())? {
            it["trashedAt"] = json!(at);
            it["purgeAfter"] = json!(after);
            it["trashedBy"] = json!(by);
            it["restoreOwner"] = json!(owner);
            it["purgeError"] = it["meta"]["purge_error"].clone();
            out.push(it);
        }
    }
    Ok(out)
}

/// Options for deleting a holder or an item.
#[derive(Debug, Clone, Default)]
pub struct DeleteOpts {
    pub dry_run: bool,
    /// Remove shared items for every holder too (owner only).
    pub everywhere: bool,
    pub action: Override,
}

impl DeleteOpts {
    pub fn from_req(req: &Value) -> Self {
        DeleteOpts {
            dry_run: req.get("dryRun").and_then(Value::as_bool).unwrap_or(false),
            everywhere: req.get("everywhere").and_then(Value::as_bool).unwrap_or(false),
            action: Override::from_req(req.get("policy").unwrap_or(req)),
        }
    }
}

/// Delete what `holder` owns, by rule 5. A dry run returns the same counts
/// and changes nothing.
pub fn delete_holder(conn: &Connection, src: &Sources, actor: &str, holder: &str, opts: &DeleteOpts) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    if holder.is_empty() || holder == "user" || holder == "agent:main" || holder == "detached" {
        return Err("That holder can't be deleted.".into());
    }
    let owned = registry::query(conn, "owner = ?1 AND state IN ('live', 'missing')", &[&holder]).map_err(|e| e.to_string())?;
    let held = refs::live_refs_for(conn, holder)?;
    let mut plan_trash = Vec::new();
    let mut plan_purge = Vec::new();
    let mut plan_detach = Vec::new();
    let mut affected_holders = std::collections::BTreeSet::new();
    let mut keeping_holders = std::collections::BTreeSet::new();
    let mut sample: Option<Value> = None;
    for it in &owned {
        let id = it["id"].as_str().unwrap_or("").to_string();
        let shares = refs::live_shares(conn, &id)?;
        let policy = policy_for(conn, it, Some(holder), &opts.action);
        if sample.is_none() {
            sample = Some(policy.json());
        }
        if !shares.is_empty() && !opts.everywhere {
            for r in &shares {
                keeping_holders.insert(r["holder"].as_str().unwrap_or("").to_string());
            }
            plan_detach.push(id);
            continue;
        }
        for r in &shares {
            affected_holders.insert(r["holder"].as_str().unwrap_or("").to_string());
        }
        if policy.direct() {
            plan_purge.push((id, shares.len()));
        } else {
            plan_trash.push((id, policy));
        }
    }
    let policy = sample.unwrap_or_else(|| policy_for(conn, &json!({ "owner": holder, "kind": "" }), Some(holder), &opts.action).json());
    let counts = json!({
        "trash": plan_trash.len(), "purge": plan_purge.len(), "detach": plan_detach.len(),
        "revoke": held.len(), "affectedHolders": affected_holders.len(),
    });
    if opts.dry_run {
        // Names for the dialog: who keeps the shared items, and (for "Delete
        // everywhere") who loses them.
        let names = |set: &std::collections::BTreeSet<String>| -> Vec<Value> {
            set.iter().filter(|h| !h.is_empty()).map(|h| json!({ "holder": h, "name": super::principals::display_name(conn, h) })).collect()
        };
        return Ok(json!({
            "dryRun": true, "holder": holder, "counts": counts, "policy": policy, "everywhere": opts.everywhere,
            "keptBy": names(&keeping_holders), "affected": names(&affected_holders),
        }));
    }
    let batch = new_id("tb");
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for id in &plan_detach {
        detach(&tx, id, holder)?;
        let _ = tx.execute("UPDATE ws_items SET meta_json = json_set(meta_json, '$.detachBatch', ?2) WHERE id = ?1", params![id, batch]);
        refs::audit(&tx, actor, "detach", Some(id), Some(holder), json!({ "batch": batch }));
    }
    let mut failed = Vec::new();
    for (id, policy) in &plan_trash {
        if let Err(e) = trash_with(&tx, src, actor, id, policy, Some(&batch)) {
            failed.push(json!({ "id": id, "error": e }));
        }
    }
    for (id, _) in &plan_purge {
        if let Err(e) = purge(&tx, src, actor, id) {
            failed.push(json!({ "id": id, "error": e }));
        }
    }
    for r in &held {
        let rid = r["id"].as_str().unwrap_or("");
        tx.execute("UPDATE ws_refs SET state = 'revoked', updated_at = ?2 WHERE id = ?1", params![rid, now_ms()]).map_err(|e| e.to_string())?;
        refs::audit(&tx, actor, "revoke_on_delete", r["itemId"].as_str(), Some(holder), json!({ "batch": batch, "ref": rid }));
        if let Ok(Some(it)) = registry::get(&tx, r["itemId"].as_str().unwrap_or("")) {
            refs::sync_pin(&tx, &it);
        }
    }
    let _ = tx.execute("UPDATE ws_principals SET state = 'deleted' WHERE pid = ?1", params![holder]);
    super::meta_set(&tx, &format!("deleted_holder:{holder}"), &now_ms().to_string()).map_err(|e| e.to_string())?;
    refs::audit(&tx, actor, "delete_holder", None, Some(holder), json!({ "batch": batch, "counts": counts }));
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({ "holder": holder, "batch": batch, "counts": counts, "policy": policy, "failed": failed }))
}

/// Delete one item by the policy. An item someone else references is kept
/// unless `everywhere` is set (owner or manage only); the dry run names the
/// holders and the policy.
pub fn delete_item(conn: &Connection, src: &Sources, actor: &str, id: &str, opts: &DeleteOpts) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let it = get(conn, id)?;
    if refs::holder_perm(conn, actor, &it) != Some("manage") {
        return Err("Deleting needs manage permission on the item.".into());
    }
    let shares = refs::live_shares(conn, id)?;
    let policy = policy_for(conn, &it, None, &opts.action);
    if opts.dry_run {
        return Ok(json!({ "dryRun": true, "id": id, "policy": policy.json(), "sharedWith": shares }));
    }
    if !shares.is_empty() && !opts.everywhere {
        return Err(format!("Shared with {} other holder(s). Choose Delete everywhere, or revoke the shares first.", shares.len()));
    }
    let batch = new_id("tb");
    let mut out = trash_with(conn, src, actor, id, &policy, Some(&batch))?;
    out["batch"] = json!(batch);
    out["policy"] = policy.json();
    Ok(out)
}

/// Move one item to Trash by its policy (used by group delete and tools).
pub fn trash(conn: &Connection, src: &Sources, actor: &str, id: &str) -> Result<Value, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let it = get(conn, id)?;
    let policy = policy_for(conn, &it, None, &Override::default());
    trash_with(conn, src, actor, id, &policy, None)
}

/// Items queued for the WebView to delete.
pub fn client_purges(conn: &Connection) -> Result<Vec<Value>, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut st = conn.prepare("SELECT item_id, loc, queued_at FROM ws_pending_client_purges ORDER BY queued_at").map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| Ok(json!({ "itemId": r.get::<_, String>(0)?, "loc": r.get::<_, String>(1)?, "queuedAt": r.get::<_, i64>(2)? })))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn client_purged(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let mut n = 0;
    for id in ids {
        n += conn.execute("DELETE FROM ws_pending_client_purges WHERE item_id = ?1", params![id]).map_err(|e| e.to_string())?;
    }
    Ok(n)
}
