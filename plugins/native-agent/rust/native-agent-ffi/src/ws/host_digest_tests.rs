//! Unified plan, Phase 4: the main agent as host, and the main-chat digest.

use super::envelope::Party;
use super::groups::{self, AgentInfo, PostReq};
use super::{digest, test_seed};
use serde_json::json;

fn agent(id: &str, name: &str, root: &str) -> AgentInfo {
    AgentInfo { pid: format!("agent:{id}"), name: name.into(), status: "done".into(), shareable: false, root: root.into(), ..Default::default() }
}

fn agents() -> Vec<AgentInfo> {
    vec![agent("a", "Researcher", "chat1"), agent("b", "Writer", "chat1"), agent("c", "Critic", "chat1")]
}

fn make_hosted(conn: &rusqlite::Connection) -> String {
    let g = groups::create(conn, &json!({"name": "launch", "members": ["a", "b", "c"], "homeRoot": "chat1", "host": true}), &agents()).unwrap();
    g["group"]["id"].as_str().unwrap().to_string()
}

fn post_as<'a>(pid: &str, name: &str, text: &'a str) -> PostReq<'a> {
    PostReq { from: Party::new(pid, name), text, reply_to: None, to: vec![], attachments: vec![], comms_paused: false, pending: vec![] }
}

#[test]
fn main_agent_host_is_not_counted_or_woken() {
    let c = test_seed::empty_db();
    // The host never makes up for a missing agent.
    let e = groups::create(&c, &json!({"name": "x", "members": ["a", "b", "main"], "homeRoot": "chat1", "host": true}), &agents()).unwrap_err();
    assert!(e.contains("at least 3"), "{e}");
    let gid = make_hosted(&c);
    let g = groups::get(&c, &gid, &agents()).unwrap();
    let host: Vec<_> = g["members"].as_array().unwrap().iter().filter(|m| m["pid"] == groups::HOST_PID).collect();
    assert_eq!(host.len(), 1);
    assert_eq!(host[0]["presence"], "host");
    assert!(groups::has_host(&c, &gid));
    // A user message to everyone wakes the three agents, never the host.
    let out = groups::post(&c, &gid, &post_as("user", "You", "@all ideas?"), &agents()).unwrap();
    let woken: Vec<String> = out.dispatch.wake.iter().map(|p| p.pid.clone()).collect();
    assert!(!woken.contains(&groups::HOST_PID.to_string()), "{woken:?}");
    // The host posts like a member.
    groups::post(&c, &gid, &post_as(groups::HOST_PID, "Main agent", "Writer, draft it"), &agents()).unwrap();
    // It cannot be added as a plain member.
    assert!(groups::add_member(&c, &gid, "main", None, &agents()).is_err());
    // The main prompt names the group.
    let p = groups::for_main(&c, "chat1", &agents());
    assert!(p.contains("#launch") && p.contains("you are host"), "{p}");
    assert!(groups::for_main(&c, "chat9", &agents()).contains("no groups"));
}

#[test]
fn ensure_host_only_in_own_chat() {
    let c = test_seed::empty_db();
    let g = groups::create(&c, &json!({"name": "panel", "members": ["a", "b", "c"], "homeRoot": "chat1"}), &agents()).unwrap();
    let gid = g["group"]["id"].as_str().unwrap().to_string();
    assert!(!groups::has_host(&c, &gid));
    assert!(groups::ensure_host(&c, &gid, "chat2").is_err());
    groups::ensure_host(&c, &gid, "chat1").unwrap();
    groups::ensure_host(&c, &gid, "chat1").unwrap();
    assert!(groups::has_host(&c, &gid));
}

#[test]
fn digest_debounces_and_caps() {
    let c = test_seed::empty_db();
    let gid = make_hosted(&c);
    groups::post(&c, &gid, &post_as("agent:a", "Researcher", "first finding"), &agents()).unwrap();
    let t0 = super::now_ms();
    // One message, just now: not due yet.
    assert!(digest::tick(&c, &gid, t0, false).unwrap().is_none());
    // Two minutes later it is.
    let d = digest::tick(&c, &gid, t0 + digest::DEBOUNCE_MS, false).unwrap().expect("due after the debounce");
    assert!(d.starts_with("#launch: Researcher: first finding"), "{d}");
    assert!(digest::tick(&c, &gid, t0 + 2 * digest::DEBOUNCE_MS, false).unwrap().is_none(), "nothing new");
    // Five messages make it due at once, and it stays under the cap: each
    // line is cut to its own limit, so it takes more lines than fit (seven)
    // for the "more" marker to show.
    let long = "x".repeat(400);
    for _ in 0..digest::DEBOUNCE_COUNT + 2 {
        groups::post(&c, &gid, &post_as("agent:b", "Writer", &long), &agents()).unwrap();
    }
    let d = digest::tick(&c, &gid, super::now_ms(), false).unwrap().expect("due by count");
    assert!(d.chars().count() <= digest::DIGEST_CAP, "{}", d.chars().count());
    assert!(d.contains("more (group_read)"), "{d}");
    // The main chat sees each digest once.
    let seen = digest::take_unseen(&c, "chat1", "chat1", false).unwrap();
    assert_eq!(seen.len(), 2);
    assert!(digest::take_unseen(&c, "chat1", "chat1", false).unwrap().is_empty());
}

#[test]
fn digest_is_immediate_on_main_mention() {
    let c = test_seed::empty_db();
    let gid = make_hosted(&c);
    groups::post(&c, &gid, &post_as("agent:c", "Critic", "@main please decide"), &agents()).unwrap();
    let d = digest::tick(&c, &gid, super::now_ms(), false).unwrap().expect("mention is immediate");
    assert!(d.contains("Critic: @main please decide"), "{d}");
    // The host's own posts never show in its digest.
    groups::post(&c, &gid, &post_as(groups::HOST_PID, "Main agent", "@main note to self"), &agents()).unwrap();
    assert!(digest::tick(&c, &gid, super::now_ms(), true).unwrap().is_none());
}
