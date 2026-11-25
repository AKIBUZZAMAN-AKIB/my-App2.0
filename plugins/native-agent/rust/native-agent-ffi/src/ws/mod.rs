//! Unified workspace: one item registry, peer identity, groups, references and
//! safe deletion (see `plan.md` at the repo root).
//!
//! The plan calls this module `workspace/`, but `src/workspace.rs` already
//! holds the agent's workspace files (AGENTS.md, SOUL.md, ...). To avoid the
//! clash the module is `ws`, matching the `ws_` table prefix.
//!
//! Every table lives in the engine's `agent.db`, is created with
//! `IF NOT EXISTS`, and every write goes through `turn_memory::write_tx`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub mod board;
pub mod bulk;
pub mod context_use;
pub mod edit;
pub mod envelope;
pub mod group_rules;
pub mod groups;
pub mod host;
pub mod ids;
pub mod longterm;
pub mod principals;
pub mod projection;
pub mod refs;
pub mod registry;
pub mod runs;
pub mod trash;

#[cfg(test)]
pub mod test_seed;
#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod groups_tests;
#[cfg(test)]
mod refs_tests;
#[cfg(test)]
mod bulk_tests;

/// Current schema version of the `ws_*` tables.
pub const SCHEMA_VERSION: i64 = 1;

/// Create the base tables (`ws_meta`). Later phases add their own tables in
/// their `ensure_*` functions; all of them are idempotent.
pub fn ensure_meta(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS ws_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);")
}

pub fn meta_get(conn: &Connection, k: &str) -> rusqlite::Result<Option<String>> {
    ensure_meta(conn)?;
    conn.query_row("SELECT v FROM ws_meta WHERE k = ?1", params![k], |r| r.get(0)).optional()
}

pub fn meta_set(conn: &Connection, k: &str, v: &str) -> rusqlite::Result<()> {
    ensure_meta(conn)?;
    conn.execute("INSERT INTO ws_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params![k, v])?;
    Ok(())
}

/// May `viewer` see `item`? The user sees everything (Trash included); a
/// holder sees what it owns and what is shared with it, while the item is
/// not in Trash (plan.md, Phase 4).
pub fn can_see(conn: &Connection, viewer: &str, item: &Value) -> bool {
    refs::can(conn, viewer, item, "view")
}

/// Items shared with `holder`, each with its reference.
pub fn shared_with(conn: &Connection, holder: &str) -> Result<Vec<Value>, String> {
    refs::visible_to(conn, holder)
}

/// Groups `holder` is a member of (Phase 3).
pub fn groups_of(conn: &Connection, holder: &str) -> Result<Vec<Value>, String> {
    match holder.strip_prefix("session:") {
        // A chat lists the groups made from it.
        Some(root) => Ok(groups::groups_of(conn, "user")?
            .into_iter()
            .filter(|g| conn.query_row("SELECT home_root FROM ws_groups WHERE id = ?1", params![g["id"].as_str().unwrap_or("")], |r| r.get::<_, Option<String>>(0)).ok().flatten().as_deref() == Some(root))
            .collect()),
        None => groups::groups_of(conn, holder),
    }
}

/// Sync if the registry was never built or is older than `max_age_ms`.
pub fn ensure_synced(conn: &Connection, src: &registry::Sources, max_age_ms: i64) -> Result<(), String> {
    let at: i64 = meta_get(conn, "registry_synced_at").map_err(|e| e.to_string())?.and_then(|v| v.parse().ok()).unwrap_or(0);
    if now_ms() - at > max_age_ms {
        registry::sync(conn, src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Registry write hook (plan.md Phase 1): a writer outside `ws/` that
/// creates, renames or removes something the registry indexes (a chat's
/// messages, a sub-agent, a stored file) calls this, and the next workspace
/// request re-indexes at once instead of waiting out `ensure_synced`'s
/// five-second window. Best effort and cheap: one UPDATE, nothing when the
/// workspace tables do not exist yet (the first request indexes anyway).
pub fn mark_stale(conn: &Connection) {
    let _ = conn.execute("UPDATE ws_meta SET v = '0' WHERE k = 'registry_synced_at'", []);
}

/// The `workspace.*` requests from the UI.
pub fn request(conn: &Connection, workspace_dir: &Path, state_dir: &Path, session_key: &str, op: &str, req: &Value) -> Result<Value, String> {
    let host_keys = req.get("hostMemoryKeys").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
    let src = registry::Sources {
        state_dir: Some(state_dir),
        workspace_dir: if workspace_dir.as_os_str().is_empty() { None } else { Some(workspace_dir) },
        host_memory_keys: host_keys,
    };
    let viewer = req.get("viewer").and_then(Value::as_str).unwrap_or("user");
    let s = |v: &str| req.get(v).and_then(Value::as_str).unwrap_or("").to_string();
    let op = op.strip_prefix("workspace.").unwrap_or(op);
    // Who acts: the user, unless a holder acts through a tool.
    let actor = req.get("actor").and_then(Value::as_str).unwrap_or(viewer).to_string();
    let b = |v: &str| req.get(v).and_then(Value::as_bool).unwrap_or(false);
    if op.starts_with("items.") {
        trash::maybe_sweep(conn, &src);
    }
    match op {
        "items.share" => refs::share(conn, &actor, &s("itemId"), &s("holder"), &s("mode"), &s("perm"), &s("folder")),
        "items.setPerm" => refs::set_perm(conn, &actor, &s("refId"), &s("perm")),
        "items.setMode" => refs::set_mode(conn, &actor, &s("refId"), &s("mode")),
        "items.revoke" => refs::revoke(conn, &actor, &s("refId")),
        "items.holders" => {
            let id = s("itemId");
            let mut out = json!({ "refs": refs::holders_of(conn, &id)? });
            // Main memory: who reads it through a memory mode (read-only rows)
            // and whether sharing protects it from automatic removal.
            if let Some(it) = registry::get(conn, &id).map_err(|e| e.to_string())?.filter(|it| it["kind"] == "memory_longterm") {
                out["pinned"] = json!(it["meta"]["pinned"] == true);
                out["implicit"] = json!(implicit_memory_holders(conn)?);
            }
            Ok(out)
        }
        "items.bulk" => bulk::run(conn, &src, &actor, &bulk::BulkReq::from_req(req)),
        "items.contextUse.list" => {
            let holder = if s("holder").is_empty() { registry::session_holder(session_key) } else { s("holder") };
            Ok(json!({ "holder": holder, "items": context_use::list(conn, &holder)? }))
        }
        "items.contextUse.set" => {
            if actor != "user" {
                return Err("Only you set context from the tree; agents in a group use group_context.".into());
            }
            let holder = if s("holder").is_empty() { registry::session_holder(session_key) } else { s("holder") };
            let lock = req.get("lock").and_then(Value::as_bool);
            let mut ids: Vec<String> = req.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
            if ids.is_empty() {
                ids.push(s("itemId"));
            }
            // All or nothing.
            conn.execute_batch("SAVEPOINT ws_ctx_use").map_err(|e| e.to_string())?;
            let r = (|| {
                let mut out = Vec::new();
                for id in &ids {
                    let mut st = context_use::set_user(conn, &holder, id, &s("state"), lock)?;
                    st["itemId"] = json!(id);
                    out.push(st);
                }
                Ok::<_, String>(json!({ "holder": holder, "items": out }))
            })();
            let end = if r.is_ok() { "RELEASE ws_ctx_use" } else { "ROLLBACK TO ws_ctx_use; RELEASE ws_ctx_use" };
            conn.execute_batch(end).map_err(|e| e.to_string())?;
            r
        }
        "items.sharedWith" => {
            let holder = if s("holder").is_empty() { registry::session_holder(session_key) } else { s("holder") };
            Ok(json!({ "items": shared_with(conn, &holder)? }))
        }
        "items.edit" => edit::edit(conn, &src, &actor, &s("id"), &s("text"), &s("via")),
        "items.trash" | "items.delete" => trash::delete_item(conn, &src, &actor, &s("id"), &trash::DeleteOpts::from_req(req)),
        "items.restore" => trash::restore(conn, &actor, &s("id")),
        "items.restoreBatch" => trash::restore_batch(conn, &actor, &s("batch")),
        "items.purge" => {
            if actor != "user" {
                return Err("Only you can remove items from Trash.".into());
            }
            trash::purge(conn, &src, &actor, &s("id")).map(|_| json!({ "purged": s("id") }))
        }
        "items.emptyTrash" => {
            if actor != "user" {
                return Err("Only you can empty the Trash.".into());
            }
            let ids: Vec<String> = trash::list_trash(conn)?.iter().filter_map(|i| i["id"].as_str().map(str::to_string)).collect();
            if !b("confirm") {
                return Ok(json!({ "needsConfirm": true, "count": ids.len() }));
            }
            let mut failed = Vec::new();
            for id in &ids {
                if let Err(e) = trash::purge(conn, &src, &actor, id) {
                    failed.push(json!({ "id": id, "error": e }));
                }
            }
            Ok(json!({ "purged": ids.len() - failed.len(), "failed": failed }))
        }
        "items.trashList" => Ok(json!({ "items": trash::list_trash(conn)?, "autoPurged": trash::take_auto_purged(conn) })),
        "items.deleteHolder" => trash::delete_holder(conn, &src, &actor, &s("holder"), &trash::DeleteOpts::from_req(req)),
        "items.deletePreview" => {
            let mut o = trash::DeleteOpts::from_req(req);
            o.dry_run = true;
            if s("holder").is_empty() { trash::delete_item(conn, &src, &actor, &s("id"), &o) } else { trash::delete_holder(conn, &src, &actor, &s("holder"), &o) }
        }
        "items.policy.get" => {
            let mut out = json!({ "policies": trash::list_policies(conn)? });
            if !s("id").is_empty() {
                let it = registry::get(conn, &s("id")).map_err(|e| e.to_string())?.ok_or("No such item.")?;
                let h = s("holder");
                out["effective"] = trash::policy_for(conn, &it, if h.is_empty() { None } else { Some(h.as_str()) }, &trash::Override::default()).json();
            }
            Ok(out)
        }
        "items.policy.set" => trash::set_policy(
            conn,
            &src,
            &actor,
            &s("scope"),
            &s("mode"),
            match req.get("retainSecs") {
                Some(Value::Null) => None,
                Some(v) => v.as_i64(),
                None => Some(trash::DEFAULT_RETAIN_SECS),
            },
            b("applyToExisting"),
            b("confirm"),
        ),
        "items.policy.clear" => trash::clear_policy(conn, &actor, &s("scope")),
        "items.sweep" => trash::sweep(conn, &src, now_ms()),
        "items.purgeClient" => Ok(json!({ "items": trash::client_purges(conn)? })),
        "items.clientPurged" => {
            let ids: Vec<String> = req.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
            Ok(json!({ "acked": trash::client_purged(conn, &ids)? }))
        }
        "items.audit" => {
            refs::ensure_tables(conn).map_err(|e| e.to_string())?;
            let item = s("itemId");
            let mut st = conn
                .prepare("SELECT at, actor, action, item_id, holder, detail_json FROM ws_audit WHERE (?1 = '' OR item_id = ?1) ORDER BY id DESC LIMIT 200")
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map(params![item], |r| {
                    Ok(json!({ "at": r.get::<_, i64>(0)?, "actor": r.get::<_, String>(1)?, "action": r.get::<_, String>(2)?, "itemId": r.get::<_, Option<String>>(3)?, "holder": r.get::<_, Option<String>>(4)?, "detail": serde_json::from_str::<Value>(&r.get::<_, String>(5)?).unwrap_or(json!({})) }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(json!({ "audit": rows }))
        }
        "items.sync" => {
            let r = registry::sync(conn, &src).map_err(|e| e.to_string())?;
            Ok(json!({ "sync": r }))
        }
        "items.tree" => {
            ensure_synced(conn, &src, 5_000)?;
            let holder = req.get("holder").and_then(Value::as_str).map(str::to_string).or_else(|| {
                if req.get("all").and_then(Value::as_bool) == Some(true) || session_key.is_empty() {
                    None
                } else {
                    Some(registry::session_holder(session_key))
                }
            });
            let limit = req.get("limit").and_then(Value::as_u64).map(|n| n as usize);
            projection::tree(conn, holder.as_deref(), viewer, limit)
        }
        // Same rule as items.read and items.list: the item's metadata (name,
        // owner, loc) is only shown to a viewer that may see the item.
        "items.get" => {
            let item = registry::get(conn, &s("id")).map_err(|e| e.to_string())?.ok_or("No such item.")?;
            if !can_see(conn, viewer, &item) {
                return Err("You cannot see that item.".into());
            }
            Ok(json!({ "item": item }))
        }
        "items.read" => {
            let item = registry::get(conn, &s("id")).map_err(|e| e.to_string())?.ok_or("No such item.")?;
            if !can_see(conn, viewer, &item) {
                return Err("You cannot read that item.".into());
            }
            registry::read(conn, &src, &s("id"), req.get("range"))
        }
        "items.list" => {
            ensure_synced(conn, &src, 5_000)?;
            let kind = s("kind");
            let owner = s("owner");
            let items = registry::query(
                conn,
                "(?1 = '' OR kind = ?1) AND (?2 = '' OR owner = ?2) AND state NOT IN ('purged', 'trashed') ORDER BY created_at DESC LIMIT 500",
                &[&kind, &owner],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "items": items.into_iter().filter(|i| can_see(conn, viewer, i)).collect::<Vec<_>>() }))
        }
        "items.registerClient" => registry::register_client(conn, req),
        "items.fsck" => registry::fsck(conn, &src),
        "principals.list" => {
            principals::sync(conn, Some(state_dir)).map_err(|e| e.to_string())?;
            Ok(json!({ "principals": principals::list(conn).map_err(|e| e.to_string())? }))
        }
        "messages.conversations" => {
            let pid = if s("pid").is_empty() { registry::session_holder(session_key) } else { s("pid") };
            Ok(json!({ "conversations": envelope::conversations_of(conn, &pid)? }))
        }
        "messages.read" => {
            let limit = req.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            let before = req.get("before").and_then(Value::as_str);
            Ok(json!({ "messages": envelope::read_conversation(conn, &s("conversation"), before, limit)? }))
        }
        "messages.thread" => Ok(json!({ "messages": envelope::read_thread(conn, &s("root"))? })),
        other => Err(format!("Unknown workspace request {other}.")),
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Sub-agents whose memory mode is Shared read main memory without a
/// reference row: the permissions editor lists them read-only.
fn implicit_memory_holders(conn: &Connection) -> Result<Vec<Value>, String> {
    Ok(registry::query(conn, "kind = 'subagent' AND state = 'live' AND json_extract(meta_json, '$.memoryMode') = 'shared'", &[])
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|a| {
            let agent = a["meta"]["agentId"].as_str().unwrap_or("").to_string();
            json!({ "holder": format!("agent:{agent}"), "holderName": a["title"], "mode": "implicit", "perm": "view", "implicit": true, "via": "memory mode: Shared" })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(conn: &Connection, table: &str, key: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE session_key = ?1"), [key], |r| r.get(0)).unwrap()
    }

    #[test]
    fn clear_session_removes_ctx_rows() {
        let s = test_seed::seed();
        let key = test_seed::agent_session(test_seed::AGENT_A);
        for t in ["ctx_sessions", "ctx_mem_picks", "ctx_mem_files", "messages", "turn_memory"] {
            assert!(count(&s.conn, t, &key) > 0, "seeded {t}");
        }
        crate::db::clear_session(&s.conn, &key).unwrap();
        for t in ["ctx_sessions", "ctx_nodes", "ctx_notes", "ctx_mem_picks", "ctx_mem_versions", "ctx_mem_tags", "ctx_mem_files", "ctx_mem_status", "messages", "turn_memory"] {
            assert_eq!(count(&s.conn, t, &key), 0, "{t} cleared");
        }
        // other chats untouched, file-store bytes kept
        assert!(count(&s.conn, "ctx_mem_picks", test_seed::CHAT_1) > 0);
        let bytes: i64 = s.conn.query_row("SELECT COUNT(*) FROM ctx_mem_file_store", [], |r| r.get(0)).unwrap();
        assert_eq!(bytes, 1);
    }

    #[test]
    fn hub_id_unique_after_expire() {
        let conn = test_seed::empty_db();
        let mut seen = std::collections::HashSet::new();
        for i in 0..5 {
            let r = crate::agent_hub::send(&conn, &serde_json::json!({"from": "a", "to": "b", "text": format!("m{i}"), "ttlMs": 10}), 0).unwrap();
            assert!(seen.insert(r["message"]["id"].as_str().unwrap().to_string()));
        }
        crate::agent_hub::expire(&conn, 1_000).unwrap();
        let live = crate::agent_hub::send(&conn, &serde_json::json!({"from": "a", "to": "b", "text": "after"}), 2_000).unwrap();
        let id = live["message"]["id"].as_str().unwrap().to_string();
        assert!(!seen.contains(&id), "an id never comes back after expiry");
        let again = crate::agent_hub::send(&conn, &serde_json::json!({"from": "a", "to": "b", "text": "after 2"}), 2_000).unwrap();
        assert_ne!(again["message"]["id"], live["message"]["id"]);
    }

    #[test]
    fn meta_round_trip() {
        let c = Connection::open_in_memory().unwrap();
        assert_eq!(meta_get(&c, "x").unwrap(), None);
        meta_set(&c, "x", "1").unwrap();
        meta_set(&c, "x", "2").unwrap();
        assert_eq!(meta_get(&c, "x").unwrap().as_deref(), Some("2"));
    }
}
