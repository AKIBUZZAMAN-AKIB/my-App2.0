//! Phase 3 tests: groups, membership, posting and dispatch.

use super::envelope::Party;
use super::groups::{self, AgentInfo, PostReq};
use super::test_seed;
use serde_json::{json, Value};

fn agent(id: &str, name: &str, root: &str, shareable: bool) -> AgentInfo {
    AgentInfo { pid: format!("agent:{id}"), name: name.into(), status: "done".into(), shareable, root: root.into(), ..Default::default() }
}

fn agents() -> Vec<AgentInfo> {
    vec![
        agent("a", "Researcher", "chat1", false),
        agent("b", "Writer", "chat1", false),
        agent("c", "Critic", "chat2", true),
        agent("d", "Dee", "chat2", false),
    ]
}

fn make(conn: &rusqlite::Connection, preset: &str) -> String {
    let g = groups::create(conn, &json!({"name": "launch", "purpose": "ship it", "members": ["a", "b", "c"], "preset": preset, "homeRoot": "chat1"}), &agents()).unwrap();
    g["group"]["id"].as_str().unwrap().to_string()
}

fn user_post<'a>(text: &'a str) -> PostReq<'a> {
    PostReq { from: Party::new("user", "You"), text, reply_to: None, to: vec![], attachments: vec![], comms_paused: false, pending: vec![] }
}

fn woken(d: &groups::PostOutcome) -> Vec<String> {
    d.dispatch.wake.iter().map(|p| p.pid.clone()).collect()
}

#[test]
fn create_needs_three_qualifying_agents() {
    let c = test_seed::empty_db();
    let e = groups::create(&c, &json!({"name": "x", "members": ["a", "b"]}), &agents()).unwrap_err();
    assert!(e.contains("at least 3"));
    // Dee is in another chat and not shareable.
    let e = groups::create(&c, &json!({"name": "x", "members": ["a", "b", "d"], "homeRoot": "chat1"}), &agents()).unwrap_err();
    assert!(e.contains("not shareable"), "{e}");
    let gid = make(&c, "social");
    let g = groups::get(&c, &gid, &agents()).unwrap();
    assert_eq!(g["members"].as_array().unwrap().len(), 4, "user + 3 agents");
    assert_eq!(g["group"]["preset"], "social");
    assert!(g["rules"].as_array().unwrap().len() >= 5);
    // Registered in the registry and as a principal.
    let n: i64 = c.query_row("SELECT COUNT(*) FROM ws_items WHERE kind = 'group'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    assert_eq!(super::principals::display_name(&c, &format!("group:{gid}")), "launch");
    assert_eq!(groups::resolve(&c, "#launch").unwrap(), gid);
}

#[test]
fn post_mention_wakes_and_logs_dispatch() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    let out = groups::post(&c, &gid, &user_post("@Writer draft the intro"), &agents()).unwrap();
    assert_eq!(woken(&out), vec!["agent:b"]);
    let log = groups::dispatch_log(&c, &out.posted.id).unwrap();
    assert_eq!(log.len(), 3);
    let b = log.iter().find(|r| r["pid"] == "agent:b").unwrap();
    assert_eq!(b["decision"], "wake");
    assert_eq!(b["text"], "Writer: woken, you mentioned it");
    let st = groups::load_state(&c, &gid).unwrap();
    assert_eq!(st.unanswered, 1);
    assert_eq!(st.wakes_in_window, 1);
    // The preview gives the same answer without writing.
    let p = groups::preview(&c, &gid, &user_post("@Writer again"), &agents()).unwrap();
    assert_eq!(p["wake"][0]["pid"], "agent:b");
    assert_eq!(groups::load_state(&c, &gid).unwrap().unanswered, 1);
}

#[test]
fn wait_your_turn_counts_and_agent_reply_resets() {
    let c = test_seed::empty_db();
    let gid = make(&c, "wait_your_turn");
    assert!(woken(&groups::post(&c, &gid, &user_post("one"), &agents()).unwrap()).is_empty());
    assert!(woken(&groups::post(&c, &gid, &user_post("two"), &agents()).unwrap()).is_empty());
    let third = groups::post(&c, &gid, &user_post("three"), &agents()).unwrap();
    assert_eq!(third.dispatch.wake.len(), 1);
    let who = third.dispatch.wake[0].pid.clone();
    let reply = PostReq { from: Party::new(&who, "x"), ..user_post("here is my answer") };
    groups::post(&c, &gid, &reply, &agents()).unwrap();
    assert_eq!(groups::load_state(&c, &gid).unwrap().unanswered, 0);
    let log = groups::dispatch_log(&c, &groups::post(&c, &gid, &user_post("four"), &agents()).unwrap().posted.id).unwrap();
    assert!(log.iter().any(|r| r["text"].as_str().unwrap().contains("Wait your turn (1 of 3 unanswered)")), "{log:?}");
}

#[test]
fn reply_wakes_author_and_note_has_header() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    let a_msg = groups::post(&c, &gid, &PostReq { from: Party::new("agent:a", "Researcher"), ..user_post("Found 3 sources.") }, &agents()).unwrap();
    let r = PostReq { reply_to: Some(a_msg.posted.id.clone()), ..user_post("which is best?") };
    let out = groups::post(&c, &gid, &r, &agents()).unwrap();
    assert_eq!(woken(&out), vec!["agent:a"]);
    let note = groups::member_note(&c, &gid, "agent:a", &out.posted, &out.group_name).unwrap();
    assert!(note.contains("⟦#launch · from: You (user) · replying to: you"), "{note}");
    assert!(note.contains("which is best?"));
    assert!(note.contains("group_pass"));
}

#[test]
fn agents_cannot_post_where_they_are_not_members_or_ambiguous() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    let e = groups::post(&c, &gid, &PostReq { from: Party::new("agent:d", "Dee"), ..user_post("hi") }, &agents()).map(|_| ()).unwrap_err();
    assert!(e.contains("not a member"));
    let mut ag = agents();
    ag[1].name = "Researcher".into();
    let e = groups::post(&c, &gid, &PostReq { from: Party::new("agent:c", "Critic"), ..user_post("@Researcher look") }, &ag).map(|_| ()).unwrap_err();
    assert!(e.contains("Two members are called researcher"), "{e}");
}

#[test]
fn suspension_on_unshare_and_pause_below_three() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    let mut ag = agents();
    ag[2].shareable = false; // Critic is from chat2: no longer qualifies.
    let changed = groups::recheck_member(&c, "agent:c", &ag).unwrap();
    assert_eq!(changed, vec![gid.clone()]);
    let g = groups::get(&c, &gid, &ag).unwrap();
    let critic = g["members"].as_array().unwrap().iter().find(|m| m["pid"] == "agent:c").unwrap().clone();
    assert_eq!(critic["membership"], "suspended");
    assert_eq!(critic["suspendedReason"], "not_shareable");
    assert_eq!(g["group"]["state"], "paused");
    // A suspended member gets nothing, even when mentioned.
    let e = groups::post(&c, &gid, &PostReq { from: Party::new("agent:c", "Critic"), ..user_post("hi") }, &ag).map(|_| ()).unwrap_err();
    assert!(e.contains("suspended"));
    // Sharing again restores it and the group resumes.
    groups::recheck_member(&c, "agent:c", &agents()).unwrap();
    let g = groups::get(&c, &gid, &agents()).unwrap();
    assert_eq!(g["group"]["state"], "active");
    let out = groups::post(&c, &gid, &user_post("@Critic thoughts"), &agents()).unwrap();
    assert_eq!(woken(&out), vec!["agent:c"]);
}

#[test]
fn remove_member_disables_its_rules_and_add_restores() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    let mut rules: Vec<Value> = groups::get(&c, &gid, &agents()).unwrap()["rules"].as_array().unwrap().clone();
    rules.push(json!({"scope": "agent:c", "kind": "cooldown", "params": {"secs": 30}}));
    let saved = groups::save_rules(&c, &gid, &rules, &|p| p.to_string()).unwrap();
    assert_eq!(saved["saved"], true);
    groups::remove_member(&c, &gid, "agent:c", &agents()).unwrap();
    let g = groups::get(&c, &gid, &agents()).unwrap();
    let r = g["rules"].as_array().unwrap().iter().find(|r| r["kind"] == "cooldown").unwrap().clone();
    assert_eq!(r["enabled"], false);
    assert!(r["params"]["disabledReason"].as_str().unwrap().contains("left"));
    assert_eq!(g["group"]["state"], "paused", "two agents left");
    groups::add_member(&c, &gid, "agent:c", None, &agents()).unwrap();
    let g = groups::get(&c, &gid, &agents()).unwrap();
    assert_eq!(g["rules"].as_array().unwrap().iter().find(|r| r["kind"] == "cooldown").unwrap()["enabled"], true);
    assert_eq!(g["group"]["state"], "active");
}

#[test]
fn invalid_rules_are_not_saved() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    let out = groups::save_rules(&c, &gid, &[json!({"scope": "agent:zz", "kind": "cooldown", "params": {"secs": 5}})], &|p| p.to_string()).unwrap();
    assert_eq!(out["saved"], false);
    assert!(groups::get(&c, &gid, &agents()).unwrap()["rules"].as_array().unwrap().len() >= 5, "old rules kept");
}

#[test]
fn pass_edit_delete_pin_and_archive() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    let m = groups::post(&c, &gid, &user_post("@Writer hi"), &agents()).unwrap();
    groups::pass(&c, &gid, "agent:b", "nothing to add", None).unwrap();
    let log = groups::dispatch_log(&c, &m.posted.id).unwrap();
    assert_eq!(log.iter().find(|r| r["pid"] == "agent:b").unwrap()["decision"], "pass");
    groups::pin(&c, &gid, &m.posted.id, "user", true).unwrap();
    assert_eq!(groups::pins(&c, &gid).unwrap().len(), 1);
    groups::edit_message(&c, &m.posted.id, "user", Some("@Writer hello")).unwrap();
    assert!(groups::edit_message(&c, &m.posted.id, "agent:a", None).is_err(), "only one's own");
    groups::edit_message(&c, &m.posted.id, "user", None).unwrap();
    let read = groups::read(&c, &gid, None, None, 50).unwrap();
    let msg = read["messages"].as_array().unwrap().iter().find(|x| x["id"] == m.posted.id.as_str()).unwrap().clone();
    assert_eq!(msg["text"], "message deleted");
    groups::set_group(&c, &gid, "archive", "").unwrap();
    assert!(groups::post(&c, &gid, &user_post("x"), &agents()).is_err());
    groups::set_group(&c, &gid, "unarchive", "").unwrap();
    groups::set_group(&c, &gid, "rename", "#ship").unwrap();
    assert_eq!(groups::resolve(&c, "ship").unwrap(), gid);
}

#[test]
fn budget_tokens_and_silence_nudge() {
    let c = test_seed::empty_db();
    let gid = make(&c, "social");
    groups::add_tokens(&c, &gid, 500).unwrap();
    groups::add_tokens(&c, &gid, 250).unwrap();
    assert_eq!(groups::get(&c, &gid, &agents()).unwrap()["tokensToday"], 750);
    let m = groups::post_at(&c, &gid, &user_post("anyone?"), &agents(), 1_000).unwrap();
    let s = groups::silence(&c, &gid, 1_000 + 121_000).unwrap();
    assert_eq!(s["messageId"], m.posted.id.as_str());
    groups::mark_nudged(&c, &gid, &m.posted.id).unwrap();
    assert!(groups::silence(&c, &gid, 1_000 + 300_000).unwrap().is_null());
}

#[test]
fn agent_prompt_lists_groups() {
    let c = test_seed::empty_db();
    make(&c, "round_table");
    let p = groups::for_agent(&c, "agent:a", &agents());
    assert!(p.contains("#launch") && p.contains("Writer") && p.contains("Round table"), "{p}");
    assert!(groups::for_agent(&c, "agent:d", &agents()).is_empty());
    assert_eq!(groups::day_of(0), "1970-01-01");
    assert_eq!(groups::day_of(1_795_000_000_000), "2026-11-18");
}
