//! Phase 5: `items.bulk`, one action across many items, all or nothing.
//!
//! `{ids[], op, target? | targets[]?, perm?, mode?, dryRun?, everywhere?,
//! policy?: {mode, retainSecs}}` with `op` one of `move`, `delete`, `share`,
//! `unshare`, `setPerm`, `setMode`, `restore`.
//!
//! Every database change runs inside one savepoint. When any item fails the
//! savepoint rolls back and nothing changes; the reply names what failed. A
//! dry run does the same work and always rolls back, so its summary is
//! exactly what the commit would do ("2 shared items will be detached, 5
//! trashed; 1 item can't be moved because you only have view").
//!
//! Bytes at the source (a file, a host memory entry) are removed only after
//! the batch commits: items the policy removes permanently are trashed with
//! a removal time of now inside the batch, then purged; one whose source
//! refuses stays in Trash and the sweep retries it.
//!
//! Move by kind: a memory entry, note, file or agent memory changes owner.
//! A whole chat (or sub-agent, or group) moves into the target as a
//! reference. A single message is never moved between transcripts (their
//! order is the model's history): it is shared as a reference with the
//! target and hidden in the source view.

use super::{context_use, now_ms, refs, registry, trash};
use rusqlite::Connection;
use serde_json::{json, Value};

pub const OPS: [&str; 7] = ["move", "delete", "share", "unshare", "setPerm", "setMode", "restore"];

/// Kinds that are part of a transcript: "move" shares them and hides them.
const MESSAGE_KINDS: [&str; 3] = ["message", "tool_result", "summary"];
/// Kinds that are whole conversations: "move" shares them as a reference.
const CONTAINER_KINDS: [&str; 3] = ["chat", "subagent", "group"];

pub struct BulkReq {
    pub ids: Vec<String>,
    pub op: String,
    pub targets: Vec<String>,
    pub perm: String,
    pub mode: String,
    pub dry_run: bool,
    pub everywhere: bool,
    pub action: trash::Override,
}

impl BulkReq {
    pub fn from_req(req: &Value) -> Self {
        let strs = |k: &str| req.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();
        let s = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let mut targets = strs("targets");
        if targets.is_empty() && !s("target").is_empty() {
            targets.push(s("target"));
        }
        let mut ids = Vec::new();
        for id in strs("ids") {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        BulkReq {
            ids,
            op: s("op"),
            targets,
            perm: s("perm"),
            mode: s("mode"),
            dry_run: req.get("dryRun").and_then(Value::as_bool).unwrap_or(false),
            everywhere: req.get("everywhere").and_then(Value::as_bool).unwrap_or(false),
            action: trash::Override::from_req(req.get("policy").unwrap_or(&Value::Null)),
        }
    }
}

#[derive(Default)]
struct Tally {
    shared: usize,
    revoked: usize,
    perm_changed: usize,
    mode_changed: usize,
    moved: usize,
    referenced: usize,
    hidden: usize,
    detached: usize,
    trashed: usize,
    permanent: usize,
    restored: usize,
}

fn ref_id(conn: &Connection, item_id: &str, holder: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM ws_refs WHERE item_id = ?1 AND holder = ?2 AND mode <> 'owner' AND state <> 'revoked'",
        rusqlite::params![item_id, holder],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn holder_name(conn: &Connection, h: &str) -> String {
    super::principals::display_name(conn, h)
}

/// One item's work. Returns its result row, or why it can't be done.
fn one(conn: &Connection, actor: &str, req: &BulkReq, it: &Value, t: &mut Tally, purge_later: &mut Vec<String>, batch: &str) -> Result<Value, String> {
    let id = it["id"].as_str().unwrap_or("").to_string();
    let kind = it["kind"].as_str().unwrap_or("");
    let owner = it["owner"].as_str().unwrap_or("").to_string();
    let perm = refs::holder_perm(conn, actor, it).unwrap_or("none");
    let need_targets = || -> Result<(), String> {
        if req.targets.is_empty() {
            Err("Choose a sub-agent, group or chat first.".into())
        } else {
            Ok(())
        }
    };
    match req.op.as_str() {
        "share" => {
            need_targets()?;
            if perm != "manage" {
                return Err(format!("you only have {perm}"));
            }
            let mut refs_out = Vec::new();
            for h in &req.targets {
                let r = refs::share(conn, actor, &id, h, &req.mode, &req.perm, "")?;
                t.shared += 1;
                refs_out.push(r["ref"].clone());
            }
            Ok(json!({ "action": "share", "refs": refs_out }))
        }
        "unshare" => {
            need_targets()?;
            for h in &req.targets {
                let rid = ref_id(conn, &id, h).ok_or_else(|| format!("not shared with {}", holder_name(conn, h)))?;
                refs::revoke(conn, actor, &rid)?;
                t.revoked += 1;
            }
            Ok(json!({ "action": "unshare" }))
        }
        "setPerm" | "setMode" => {
            need_targets()?;
            for h in &req.targets {
                let rid = ref_id(conn, &id, h).ok_or_else(|| format!("not shared with {}", holder_name(conn, h)))?;
                if req.op == "setPerm" {
                    refs::set_perm(conn, actor, &rid, &req.perm)?;
                    t.perm_changed += 1;
                } else {
                    refs::set_mode(conn, actor, &rid, &req.mode)?;
                    t.mode_changed += 1;
                }
            }
            Ok(json!({ "action": req.op }))
        }
        "restore" => {
            let r = trash::restore(conn, actor, &id)?;
            t.restored += 1;
            Ok(json!({ "action": "restore", "detail": r }))
        }
        "move" => {
            need_targets()?;
            if perm != "manage" {
                return Err(format!("can't be moved because you only have {perm}"));
            }
            if matches!(it["state"].as_str(), Some("trashed") | Some("purged")) {
                return Err("is in Trash; restore it first".into());
            }
            if MESSAGE_KINDS.contains(&kind) {
                // Never moved between transcripts: a reference in the
                // target, hidden in the source view.
                for h in &req.targets {
                    refs::share(conn, actor, &id, h, "reference", if req.perm.is_empty() { "view" } else { &req.perm }, "")?;
                    t.referenced += 1;
                }
                context_use::hide(conn, &owner, &id, actor)?;
                t.hidden += 1;
                refs::audit(conn, actor, "move", Some(&id), Some(&owner), json!({ "as": "reference_and_hide", "to": req.targets }));
                return Ok(json!({ "action": "move", "as": "reference_and_hide", "hiddenIn": owner }));
            }
            if CONTAINER_KINDS.contains(&kind) {
                for h in &req.targets {
                    refs::share(conn, actor, &id, h, "reference", if req.perm.is_empty() { "view" } else { &req.perm }, "")?;
                    t.referenced += 1;
                }
                refs::audit(conn, actor, "move", Some(&id), None, json!({ "as": "reference", "to": req.targets }));
                return Ok(json!({ "action": "move", "as": "reference" }));
            }
            if req.targets.len() != 1 {
                return Err("can move to one place only".into());
            }
            let to = &req.targets[0];
            if *to == owner {
                return Err(format!("is already in {}", holder_name(conn, to)));
            }
            // The new owner keeps no separate reference.
            if let Some(rid) = ref_id(conn, &id, to) {
                conn.execute("DELETE FROM ws_refs WHERE id = ?1", rusqlite::params![rid]).map_err(|e| e.to_string())?;
            }
            trash::reown(conn, &id, to)?;
            t.moved += 1;
            refs::audit(conn, actor, "move", Some(&id), Some(to), json!({ "as": "owner", "from": owner }));
            Ok(json!({ "action": "move", "as": "owner", "from": owner, "to": to }))
        }
        "delete" => {
            if perm != "manage" {
                return Err(format!("can't be deleted because you only have {perm}"));
            }
            if matches!(it["state"].as_str(), Some("trashed") | Some("purged")) {
                return Err("is already in Trash".into());
            }
            let shares = refs::live_shares(conn, &id)?;
            if !shares.is_empty() && !req.everywhere {
                // Kept for the holders it is shared with, in your library.
                trash::detach(conn, &id, &owner)?;
                t.detached += 1;
                refs::audit(conn, actor, "detach", Some(&id), None, json!({ "batch": batch, "keptFor": shares.len() }));
                return Ok(json!({ "action": "detach", "keptFor": shares.iter().map(|r| r["holder"].clone()).collect::<Vec<_>>() }));
            }
            let policy = trash::policy_for(conn, it, None, &req.action);
            if policy.direct() {
                trash::mark_trashed(conn, actor, it, Some(now_ms()), Some(batch), policy.json())?;
                purge_later.push(id.clone());
                t.permanent += 1;
                Ok(json!({ "action": "delete", "permanent": true, "policy": policy.json() }))
            } else {
                let after = policy.purge_after(now_ms());
                trash::mark_trashed(conn, actor, it, after, Some(batch), policy.json())?;
                t.trashed += 1;
                Ok(json!({ "action": "delete", "trash": true, "purgeAfter": after, "policy": policy.json() }))
            }
        }
        other => Err(format!("Unknown bulk action {other}.")),
    }
}

fn summary_text(op: &str, t: &Tally, blocked: &[Value]) -> String {
    let mut parts = Vec::new();
    let mut add = |n: usize, one: &str, many: &str| {
        if n > 0 {
            parts.push(if n == 1 { one.replace("{n}", "1") } else { many.replace("{n}", &n.to_string()) });
        }
    };
    add(t.detached, "1 shared item will be detached (kept for its other holders)", "{n} shared items will be detached (kept for their other holders)");
    add(t.trashed, "1 trashed", "{n} trashed");
    add(t.permanent, "1 removed permanently", "{n} removed permanently");
    add(t.shared, "1 reference added", "{n} references added");
    add(t.revoked, "1 reference revoked", "{n} references revoked");
    add(t.perm_changed, "1 permission changed", "{n} permissions changed");
    add(t.mode_changed, "1 mode changed", "{n} modes changed");
    add(t.moved, "1 item moved", "{n} items moved");
    add(t.referenced, "1 reference in the target", "{n} references in the target");
    add(t.hidden, "1 message hidden in its chat (it stays in the conversation)", "{n} messages hidden in their chats (they stay in the conversation)");
    add(t.restored, "1 restored", "{n} restored");
    let mut s = parts.join(", ");
    if !blocked.is_empty() {
        let verb = match op {
            "move" => "moved",
            "delete" => "deleted",
            "share" => "shared",
            "restore" => "restored",
            _ => "changed",
        };
        let why = blocked[0]["reason"].as_str().unwrap_or("");
        let line = if blocked.len() == 1 { format!("1 item can't be {verb}: {why}") } else { format!("{} items can't be {verb} (first: {why})", blocked.len()) };
        if s.is_empty() {
            s = line;
        } else {
            s = format!("{s}; {line}");
        }
    }
    if s.is_empty() {
        s = "Nothing to change.".into();
    }
    s
}

/// Run a bulk action. A dry run, or any failure, changes nothing.
pub fn run(conn: &Connection, src: &registry::Sources, actor: &str, req: &BulkReq) -> Result<Value, String> {
    refs::ensure_tables(conn).map_err(|e| e.to_string())?;
    trash::ensure_tables(conn).map_err(|e| e.to_string())?;
    context_use::ensure_tables(conn).map_err(|e| e.to_string())?;
    if !OPS.contains(&req.op.as_str()) {
        return Err(format!("Unknown bulk action {}. Use one of: {}.", req.op, OPS.join(", ")));
    }
    if req.ids.is_empty() {
        return Err("Select at least one item.".into());
    }
    if req.op == "restore" && actor != "user" {
        return Err("Only you can restore items from Trash.".into());
    }
    let batch = super::ids::new_id("tb");
    conn.execute_batch("SAVEPOINT ws_bulk").map_err(|e| e.to_string())?;
    let mut tally = Tally::default();
    let mut results = Vec::new();
    let mut blocked = Vec::new();
    let mut purge_later = Vec::new();
    for id in &req.ids {
        let it = match registry::get(conn, id) {
            Ok(Some(it)) => it,
            Ok(None) => {
                blocked.push(json!({ "id": id, "title": "", "reason": "no longer exists" }));
                continue;
            }
            Err(e) => {
                blocked.push(json!({ "id": id, "title": "", "reason": e.to_string() }));
                continue;
            }
        };
        // Each item's partial work goes if that item fails.
        let _ = conn.execute_batch("SAVEPOINT ws_bulk_item");
        match one(conn, actor, req, &it, &mut tally, &mut purge_later, &batch) {
            Ok(mut r) => {
                let _ = conn.execute_batch("RELEASE ws_bulk_item");
                r["id"] = json!(id);
                r["title"] = it["title"].clone();
                r["kind"] = it["kind"].clone();
                results.push(r);
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK TO ws_bulk_item; RELEASE ws_bulk_item");
                blocked.push(json!({ "id": id, "title": it["title"], "kind": it["kind"], "reason": e }));
            }
        }
    }
    let summary = summary_text(&req.op, &tally, &blocked);
    let counts = json!({
        "shared": tally.shared, "revoked": tally.revoked, "permChanged": tally.perm_changed, "modeChanged": tally.mode_changed,
        "moved": tally.moved, "referenced": tally.referenced, "hidden": tally.hidden, "detached": tally.detached,
        "trashed": tally.trashed, "permanent": tally.permanent, "restored": tally.restored, "blocked": blocked.len(),
    });
    let ok = blocked.is_empty();
    if req.dry_run || !ok {
        conn.execute_batch("ROLLBACK TO ws_bulk; RELEASE ws_bulk").map_err(|e| e.to_string())?;
        if !req.dry_run {
            return Err(format!("Nothing was changed: {summary}."));
        }
        return Ok(json!({ "dryRun": true, "ok": ok, "op": req.op, "count": req.ids.len(), "summary": summary, "counts": counts, "results": results, "blocked": blocked }));
    }
    conn.execute_batch("RELEASE ws_bulk").map_err(|e| e.to_string())?;
    refs::audit(conn, actor, "bulk", None, None, json!({ "op": req.op, "ids": req.ids, "targets": req.targets, "batch": batch, "counts": counts }));
    // Bytes at the source go only now that the batch is in.
    let mut purge_failed = Vec::new();
    for id in &purge_later {
        if let Err(e) = trash::purge(conn, src, actor, id) {
            purge_failed.push(json!({ "id": id, "error": e }));
        }
    }
    Ok(json!({ "dryRun": false, "ok": true, "op": req.op, "count": req.ids.len(), "summary": summary, "counts": counts, "results": results, "blocked": [], "batch": batch, "purgeFailed": purge_failed }))
}
