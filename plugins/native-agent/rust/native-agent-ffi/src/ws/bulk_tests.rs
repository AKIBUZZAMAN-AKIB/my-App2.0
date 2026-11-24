//! Phase 5 tests: bulk actions, per-holder context use, the group tool
//! `group_context`, the group prompt's context, and the rules test box.

use super::envelope::Party;
use super::groups::{self, AgentInfo, PostReq};
use super::registry::{self, Entry, Sources};
use super::{bulk, context_use, refs, test_seed, trash};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn item(conn: &Connection, kind: &str, loc: &str, owner: &str, title: &str) -> String {
    let e = Entry::new(kind, loc.into(), owner.into(), title);
    registry::touch(conn, &e).unwrap()
}

fn get(conn: &Connection, id: &str) -> Value {
    registry::get(conn, id).unwrap().unwrap()
}

fn db() -> Connection {
    let c = test_seed::empty_db();
    trash::ensure_tables(&c).unwrap();
    context_use::ensure_tables(&c).unwrap();
    c
}

fn req(ids: &[&str], op: &str, targets: &[&str], extra: Value) -> bulk::BulkReq {
    let mut v = json!({ "ids": ids, "op": op, "targets": targets });
    if let Value::Object(m) = extra {
        for (k, x) in m {
            v[k] = x;
        }
    }
    bulk::BulkReq::from_req(&v)
}

fn live_refs(c: &Connection) -> i64 {
    c.query_row("SELECT COUNT(*) FROM ws_refs WHERE mode <> 'owner' AND state = 'live'", [], |r| r.get(0)).unwrap()
}

fn items_count(c: &Connection) -> i64 {
    c.query_row("SELECT COUNT(*) FROM ws_items", [], |r| r.get(0)).unwrap()
}

#[test]
fn bulk_is_atomic() {
    let c = db();
    let a = item(&c, "note", "db:ctx_notes/s1/a", "agent:a", "a");
    let b = item(&c, "note", "db:ctx_notes/s1/b", "agent:a", "b");
    // Only shared with view to agent:b: it can't share it on.
    let x = item(&c, "note", "db:ctx_notes/s1/x", "agent:z", "x");
    refs::share(&c, "agent:z", &x, "agent:a", "reference", "view", "").unwrap();
    let before = live_refs(&c);
    let e = bulk::run(&c, &Sources::default(), "agent:a", &req(&[&a, &b, &x], "share", &["agent:q"], json!({}))).unwrap_err();
    assert!(e.contains("Nothing was changed") && e.contains("you only have view"), "{e}");
    assert_eq!(live_refs(&c), before, "one failure rolls back the whole batch");
    // Delete: the same, the first two stay live.
    let e = bulk::run(&c, &Sources::default(), "agent:a", &req(&[&a, &b, &x], "delete", &[], json!({}))).unwrap_err();
    assert!(e.contains("can't be deleted"), "{e}");
    assert_eq!(get(&c, &a)["state"], "live");
    assert_eq!(get(&c, &b)["state"], "live");
    // Without the bad item it goes through.
    let ok = bulk::run(&c, &Sources::default(), "agent:a", &req(&[&a, &b], "share", &["agent:q"], json!({}))).unwrap();
    assert_eq!(ok["counts"]["shared"], 2);
    assert_eq!(live_refs(&c), before + 2);
    // Unknown op and empty selection are refused.
    assert!(bulk::run(&c, &Sources::default(), "user", &req(&[&a], "explode", &[], json!({}))).is_err());
    assert!(bulk::run(&c, &Sources::default(), "user", &req(&[], "share", &["agent:q"], json!({}))).is_err());
}

#[test]
fn bulk_dry_run_matches_commit() {
    let c = db();
    let src = Sources::default();
    let a = item(&c, "note", "db:ctx_notes/s1/a", "session:s1", "a");
    let b = item(&c, "note", "db:ctx_notes/s1/b", "session:s1", "b");
    let s = item(&c, "note", "db:ctx_notes/s1/s", "session:s1", "shared");
    refs::share(&c, "user", &s, "agent:x", "reference", "view", "").unwrap();
    let r = req(&[&a, &b, &s], "delete", &[], json!({ "dryRun": true }));
    let dry = bulk::run(&c, &src, "user", &r).unwrap();
    assert_eq!(dry["dryRun"], true);
    assert_eq!(get(&c, &a)["state"], "live", "a dry run changes nothing");
    assert_eq!(get(&c, &s)["owner"], "session:s1");
    assert_eq!(dry["summary"], "1 shared item will be detached (kept for its other holders), 2 trashed");
    let mut r2 = req(&[&a, &b, &s], "delete", &[], json!({}));
    r2.dry_run = false;
    let done = bulk::run(&c, &src, "user", &r2).unwrap();
    assert_eq!(done["counts"], dry["counts"]);
    assert_eq!(done["summary"], dry["summary"]);
    let acts = |v: &Value| v["results"].as_array().unwrap().iter().map(|x| x["action"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(acts(&done), acts(&dry));
    assert_eq!(get(&c, &a)["state"], "trashed");
    assert_eq!(get(&c, &s)["owner"], "detached");
    assert_eq!(get(&c, &s)["state"], "live");
    // A blocked dry run says so without an error, and still changes nothing.
    let x = item(&c, "note", "db:ctx_notes/s1/x", "agent:z", "x");
    refs::share(&c, "agent:z", &x, "agent:a", "reference", "view", "").unwrap();
    let own = item(&c, "note", "db:ctx_notes/s1/o", "agent:a", "own");
    let r3 = bulk::BulkReq::from_req(&json!({ "ids": [own, x], "op": "move", "target": "agent:b", "dryRun": true }));
    let blocked = bulk::run(&c, &src, "agent:a", &r3).unwrap();
    assert_eq!(blocked["ok"], false);
    assert_eq!(blocked["summary"], "1 item moved; 1 item can't be moved: can't be moved because you only have view");
    assert_eq!(get(&c, &own)["owner"], "agent:a");
}

#[test]
fn bulk_share_to_multiple_sessions_creates_refs_only() {
    let c = db();
    let a = item(&c, "memory", "host:mem/k1", "agent:main", "prefers metric");
    let f = item(&c, "file", "ws:docs/plan.md", "session:s1", "plan.md");
    let n0 = items_count(&c);
    let out = bulk::run(&c, &Sources::default(), "user", &req(&[&a, &f], "share", &["session:s2", "session:s3", "session:s4"], json!({ "perm": "use", "mode": "mount" }))).unwrap();
    assert_eq!(out["counts"]["shared"], 6);
    assert_eq!(items_count(&c), n0, "no item is copied");
    for h in ["session:s2", "session:s3", "session:s4"] {
        let (mode, perm): (String, String) = c.query_row("SELECT mode, perm FROM ws_refs WHERE item_id = ?1 AND holder = ?2", params![a, h], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((mode.as_str(), perm.as_str()), ("mount", "use"));
    }
    // Owners are unchanged.
    assert_eq!(get(&c, &a)["owner"], "agent:main");
    assert_eq!(get(&c, &f)["owner"], "session:s1");
    // setPerm / setMode / unshare across the same targets.
    let p = bulk::run(&c, &Sources::default(), "user", &req(&[&a, &f], "setPerm", &["session:s2", "session:s3"], json!({ "perm": "view" }))).unwrap();
    assert_eq!(p["counts"]["permChanged"], 4);
    let m = bulk::run(&c, &Sources::default(), "user", &req(&[&a], "setMode", &["session:s4"], json!({ "mode": "reference" }))).unwrap();
    assert_eq!(m["counts"]["modeChanged"], 1);
    let u = bulk::run(&c, &Sources::default(), "user", &req(&[&a, &f], "unshare", &["session:s2", "session:s3", "session:s4"], json!({}))).unwrap();
    assert_eq!(u["counts"]["revoked"], 6);
    assert_eq!(live_refs(&c), 0);
}

#[test]
fn move_message_is_reference_and_hide() {
    let c = db();
    let msg = item(&c, "message", "db:chat_messages/s1/m1", "session:s1", "hello");
    let note = item(&c, "note", "db:ctx_notes/s1/n", "session:s1", "n");
    let chat = item(&c, "chat", "db:chat/s9", "session:s9", "Trip planning");
    let out = bulk::run(&c, &Sources::default(), "user", &req(&[&msg, &note, &chat], "move", &["group:g1"], json!({}))).unwrap();
    let by: std::collections::HashMap<String, Value> = out["results"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap().to_string(), r.clone())).collect();
    assert_eq!(by[&msg]["as"], "reference_and_hide");
    assert_eq!(by[&note]["as"], "owner");
    assert_eq!(by[&chat]["as"], "reference");
    // The message stays in its transcript, owned by its chat.
    assert_eq!(get(&c, &msg)["owner"], "session:s1");
    let mode: String = c.query_row("SELECT mode FROM ws_refs WHERE item_id = ?1 AND holder = 'group:g1'", params![msg], |r| r.get(0)).unwrap();
    assert_eq!(mode, "reference");
    let st = context_use::row(&c, "session:s1", &msg).unwrap().unwrap();
    assert_eq!(st["hidden"], true);
    assert_eq!(st["state"], "out");
    // The note changed owner; the whole chat is a reference in the group.
    assert_eq!(get(&c, &note)["owner"], "group:g1");
    assert_eq!(get(&c, &chat)["owner"], "session:s9");
    let n: i64 = c.query_row("SELECT COUNT(*) FROM ws_refs WHERE item_id = ?1 AND holder = 'group:g1' AND mode = 'reference'", params![chat], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    // The hidden message is not in the source's prompt.
    assert!(context_use::select(&c, &Sources::default(), "session:s1", 10_000).unwrap().iter().all(|(it, _)| it["id"] != msg.as_str()));
}

#[test]
fn context_use_per_holder_independent() {
    let c = db();
    let id = item(&c, "memory", "host:mem/k1", "agent:main", "budget is 5k");
    refs::share(&c, "user", &id, "group:g1", "mount", "use", "").unwrap();
    refs::share(&c, "user", &id, "session:s1", "reference", "view", "").unwrap();
    refs::share(&c, "user", &id, "agent:a", "mount", "view", "").unwrap();
    let it = get(&c, &id);
    // Defaults follow the mode: mount = in, reference = out.
    assert_eq!(context_use::effective(&c, "group:g1", &it).unwrap()["state"], "in");
    assert_eq!(context_use::effective(&c, "session:s1", &it).unwrap()["state"], "out");
    context_use::set_user(&c, "group:g1", &id, "out", None).unwrap();
    context_use::set_user(&c, "session:s1", &id, "in", None).unwrap();
    assert_eq!(context_use::effective(&c, "group:g1", &it).unwrap()["state"], "out");
    assert_eq!(context_use::effective(&c, "session:s1", &it).unwrap()["state"], "in");
    assert_eq!(context_use::effective(&c, "agent:a", &it).unwrap()["state"], "in", "untouched holder keeps its default");
    let rows: i64 = c.query_row("SELECT COUNT(*) FROM ws_context_use WHERE item_id = ?1", params![id], |r| r.get(0)).unwrap();
    assert_eq!(rows, 2);
    // A holder that can't see the item gets no row.
    assert!(context_use::set_user(&c, "agent:zz", &id, "in", None).is_err());
    assert!(context_use::set_user(&c, "group:g1", &id, "maybe", None).is_err());
    // The request surface sets and lists.
    let state = std::env::temp_dir().join(format!("ws_p5_{}", super::ids::new_id("t")));
    std::fs::create_dir_all(&state).unwrap();
    let rq = |op: &str, body: Value| super::request(&c, std::path::Path::new(""), &state, "s1", op, &body);
    let r = rq("workspace.items.contextUse.set", json!({ "holder": "agent:a", "ids": [id], "state": "auto", "lock": true })).unwrap();
    assert_eq!(r["items"][0]["state"], "auto");
    assert_eq!(r["items"][0]["locked"], true);
    let l = rq("workspace.items.contextUse.list", json!({ "holder": "group:g1" })).unwrap();
    assert_eq!(l["items"][0]["context"]["state"], "out");
    let b = rq("workspace.items.bulk", json!({ "ids": [id], "op": "setPerm", "targets": ["group:g1"], "perm": "view", "dryRun": true })).unwrap();
    assert_eq!(b["counts"]["permChanged"], 1);
    let _ = std::fs::remove_dir_all(&state);
}

#[test]
fn model_toggle_respects_user_lock() {
    let c = db();
    let id = item(&c, "note", "db:ctx_notes/s1/n", "session:s1", "spec");
    let v = item(&c, "note", "db:ctx_notes/s1/v", "session:s1", "view only");
    refs::share(&c, "user", &id, "group:g1", "reference", "use", "").unwrap();
    refs::share(&c, "user", &v, "group:g1", "reference", "view", "").unwrap();
    // The default policy is the user's.
    assert!(context_use::set_model(&c, "group:g1", &id, "in", "agent:a", "needed", "user").unwrap_err().contains("only the user"));
    // Model policy: a reason is required; it is logged and shown.
    assert!(context_use::set_model(&c, "group:g1", &id, "in", "agent:a", "  ", "model").is_err());
    let r = context_use::set_model(&c, "group:g1", &id, "in", "agent:a", "the spec answers the question", "model").unwrap();
    assert_eq!((r["state"].as_str(), r["actor"].as_str(), r["reason"].as_str()), (Some("in"), Some("agent:a"), Some("the spec answers the question")));
    let logged: i64 = c.query_row("SELECT COUNT(*) FROM ws_audit WHERE action = 'context_use' AND actor = 'agent:a'", [], |r| r.get(0)).unwrap();
    assert_eq!(logged, 1);
    // Only items the group has use on.
    assert!(context_use::set_model(&c, "group:g1", &v, "in", "agent:a", "x", "model").unwrap_err().contains("use permission"));
    // The user's lock wins.
    context_use::set_user(&c, "group:g1", &id, "out", Some(true)).unwrap();
    assert!(context_use::set_model(&c, "group:g1", &id, "in", "agent:a", "again", "model").unwrap_err().contains("locked"));
    assert_eq!(context_use::row(&c, "group:g1", &id).unwrap().unwrap()["state"], "out");
    assert!(crate::subagents::GROUP_TOOL_NAMES.contains(&"group_context"));
    // Unlocking hands it back.
    context_use::set_user(&c, "group:g1", &id, "out", Some(false)).unwrap();
    assert!(context_use::set_model(&c, "group:g1", &id, "in", "agent:a", "again", "model").is_ok());
}

fn agents() -> Vec<AgentInfo> {
    [("a", "Researcher"), ("b", "Writer"), ("c", "Critic")]
        .iter()
        .map(|(id, n)| AgentInfo { pid: format!("agent:{id}"), name: (*n).into(), status: "done".into(), shareable: false, root: "chat1".into(), ..Default::default() })
        .collect()
}

fn make_group(c: &Connection) -> String {
    let g = groups::create(c, &json!({"name": "launch", "members": ["a", "b", "c"], "preset": "social", "homeRoot": "chat1"}), &agents()).unwrap();
    g["group"]["id"].as_str().unwrap().to_string()
}

fn user_post(text: &str) -> PostReq<'_> {
    PostReq { from: Party::new("user", "You"), text, reply_to: None, to: vec![], attachments: vec![], comms_paused: false, pending: vec![] }
}

#[test]
fn group_prompt_uses_projection_in_set() {
    let c = db();
    let gid = make_group(&c);
    let h = format!("group:{gid}");
    let mounted = item(&c, "note", "db:ctx_notes/s1/m", "session:s1", "MOUNTED-SPEC");
    let referenced = item(&c, "note", "db:ctx_notes/s1/r", "session:s1", "REFERENCED-ONLY");
    let switched_in = item(&c, "note", "db:ctx_notes/s1/i", "session:s1", "SWITCHED-IN");
    let switched_out = item(&c, "note", "db:ctx_notes/s1/o", "session:s1", "SWITCHED-OUT");
    refs::share(&c, "user", &mounted, &h, "mount", "use", "").unwrap();
    refs::share(&c, "user", &referenced, &h, "reference", "use", "").unwrap();
    refs::share(&c, "user", &switched_in, &h, "reference", "use", "").unwrap();
    refs::share(&c, "user", &switched_out, &h, "mount", "use", "").unwrap();
    context_use::set_user(&c, &h, &switched_in, "in", None).unwrap();
    context_use::set_user(&c, &h, &switched_out, "out", None).unwrap();
    let picked: Vec<String> = super::projection::context_for(&c, &h, 10_000).unwrap().into_iter().map(|(it, _)| it["title"].as_str().unwrap().to_string()).collect();
    assert_eq!(picked.len(), 2);
    assert!(picked.contains(&"MOUNTED-SPEC".to_string()) && picked.contains(&"SWITCHED-IN".to_string()));
    let out = groups::post(&c, &gid, &user_post("@Writer go"), &agents()).unwrap();
    let note = groups::member_note(&c, &gid, "agent:b", &out.posted, "launch").unwrap();
    assert!(note.contains("MOUNTED-SPEC") && note.contains("SWITCHED-IN"), "{note}");
    assert!(!note.contains("REFERENCED-ONLY") && !note.contains("SWITCHED-OUT"), "{note}");
    // `auto` items fit under the budget, newest first; the rest wait.
    context_use::set_user(&c, &h, &referenced, "auto", None).unwrap();
    let tight: Vec<String> = super::projection::context_for(&c, &h, 0).unwrap().into_iter().map(|(it, _)| it["title"].as_str().unwrap().to_string()).collect();
    assert!(!tight.contains(&"REFERENCED-ONLY".to_string()), "auto is left out when over budget");
    let roomy: Vec<String> = super::projection::context_for(&c, &h, 10_000).unwrap().into_iter().map(|(it, _)| it["title"].as_str().unwrap().to_string()).collect();
    assert!(roomy.contains(&"REFERENCED-ONLY".to_string()));
    // The group setting gates the model; its changes show in the history.
    assert_eq!(groups::ai_context_policy(&c, &gid), "user");
    groups::set_settings(&c, &gid, &json!({ "aiContext": "model" })).unwrap();
    assert_eq!(groups::ai_context_policy(&c, &gid), "model");
    assert!(groups::set_settings(&c, &gid, &json!({ "aiContext": "robots" })).is_err());
    let hist = groups::rules_history(&c, &gid, 10).unwrap();
    assert_eq!(hist[0]["action"], "settings.aiContext");
}

#[test]
fn bulk_delete_uses_policy_and_override() {
    let c = db();
    let src = Sources::default();
    trash::set_policy(&c, &src, "user", "global", "direct", None, false, false).unwrap();
    trash::set_policy(&c, &src, "user", "holder:session:s1", "timed", Some(7 * 86_400), false, false).unwrap();
    let here = item(&c, "note", "db:ctx_notes/s1/a", "session:s1", "in s1");
    let there = item(&c, "note", "db:ctx_notes/s2/b", "session:s2", "in s2");
    let mut r = req(&[&here, &there], "delete", &[], json!({}));
    r.dry_run = false;
    let t0 = super::now_ms();
    let out = bulk::run(&c, &src, "user", &r).unwrap();
    let by: std::collections::HashMap<String, Value> = out["results"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap().to_string(), r.clone())).collect();
    // The chat override: Trash for 7 days.
    assert_eq!(by[&here]["trash"], true);
    let after = by[&here]["purgeAfter"].as_i64().unwrap();
    assert!((after - t0 - 7 * 86_400_000).abs() < 60_000, "{after}");
    assert_eq!(get(&c, &here)["state"], "trashed");
    // Elsewhere: Direct, removed permanently after the batch.
    assert_eq!(by[&there]["permanent"], true);
    assert_eq!(get(&c, &there)["state"], "purged");
    // The per-action override wins over both.
    let o = item(&c, "note", "db:ctx_notes/s2/c", "session:s2", "override");
    let r2 = bulk::BulkReq::from_req(&json!({ "ids": [o], "op": "delete", "policy": { "mode": "timed", "retainSecs": null } }));
    let out2 = bulk::run(&c, &src, "user", &r2).unwrap();
    assert_eq!(out2["results"][0]["trash"], true);
    assert!(out2["results"][0]["purgeAfter"].is_null(), "until you empty it");
    // Restore through bulk brings them back.
    let back = bulk::run(&c, &src, "user", &req(&[&here, &o], "restore", &[], json!({}))).unwrap();
    assert_eq!(back["counts"]["restored"], 2);
    assert_eq!(get(&c, &here)["state"], "live");
    assert!(bulk::run(&c, &src, "agent:a", &req(&[&here], "restore", &[], json!({}))).is_err(), "only the user restores");
}

#[test]
fn bulk_dry_run_reports_trash_vs_permanent() {
    let c = db();
    let src = Sources::default();
    trash::set_policy(&c, &src, "user", "kind:file", "direct", None, false, false).unwrap();
    let n = item(&c, "note", "db:ctx_notes/s1/a", "session:s1", "note");
    let f = item(&c, "file", "ws:x/y.txt", "session:s1", "y.txt");
    let dry = bulk::run(&c, &src, "user", &bulk::BulkReq::from_req(&json!({ "ids": [n, f], "op": "delete", "dryRun": true }))).unwrap();
    assert_eq!(dry["counts"]["trashed"], 1);
    assert_eq!(dry["counts"]["permanent"], 1);
    assert_eq!(dry["summary"], "1 trashed, 1 removed permanently");
    let by: std::collections::HashMap<String, Value> = dry["results"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap().to_string(), r.clone())).collect();
    assert!(by[&n]["purgeAfter"].as_i64().is_some(), "Trash with its removal date");
    assert_eq!(by[&f]["permanent"], true);
    assert_eq!(get(&c, &f)["state"], "live");
    assert_eq!(get(&c, &n)["state"], "live");
}

#[test]
fn rules_test_box_matches_post() {
    let c = db();
    let gid = make_group(&c);
    for text in ["@Writer draft the intro", "anyone?", "@Researcher @Critic check this"] {
        let p = groups::preview(&c, &gid, &user_post(text), &agents()).unwrap();
        let out = groups::post(&c, &gid, &user_post(text), &agents()).unwrap();
        let real = out.dispatch.to_json();
        assert_eq!(p["wake"], real["wake"], "{text}");
        assert_eq!(p["estTokens"], real["estTokens"], "{text}");
        let logged: Vec<String> = groups::dispatch_log(&c, &out.posted.id).unwrap().iter().filter(|r| r["decision"] == "wake").map(|r| r["pid"].as_str().unwrap().to_string()).collect();
        let previewed: Vec<String> = p["wake"].as_array().unwrap().iter().map(|w| w["pid"].as_str().unwrap().to_string()).collect();
        let mut a = logged.clone();
        a.sort();
        let mut b = previewed.clone();
        b.sort();
        assert_eq!(a, b, "{text}");
    }
    // Rule edits are in the history.
    groups::apply_preset(&c, &gid, "round_table").unwrap();
    let h = groups::rules_history(&c, &gid, 10).unwrap();
    assert_eq!(h[0]["action"], "rules.preset");
}

#[test]
fn rules_editor_order_is_kept() {
    let c = db();
    let gid = make_group(&c);
    let names = |p: &str| p.to_string();
    let list = vec![
        json!({ "kind": "rate", "params": { "wakes_per_10min": 9 } }),
        json!({ "kind": "respond", "params": { "mode": "mention_only", "on": "user_messages" } }),
        json!({ "kind": "agent_to_agent", "params": { "allowed": true, "max_depth": 1 } }),
        json!({ "kind": "reply_wakes_author", "params": { "on": true } }),
    ];
    let r = groups::save_rules(&c, &gid, &list, &names).unwrap();
    assert_eq!(r["saved"], true, "{r}");
    let g = groups::get(&c, &gid, &agents()).unwrap();
    let kinds: Vec<&str> = g["rules"].as_array().unwrap().iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["rate", "respond", "agent_to_agent", "reply_wakes_author"]);
    assert_eq!(groups::rules_history(&c, &gid, 5).unwrap()[0]["action"], "rules.set");
}
