use super::*;

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    c
}

const ROOM: &str = "group:g1";

fn members(n: usize) -> Value {
    json!((1..=n).map(|i| format!("agent:a{i}")).collect::<Vec<_>>())
}

#[test]
fn catalog_is_one_list_of_rooms_and_protocols() {
    // Five group presets and nine protocols, one list.
    assert_eq!(CATALOG.len(), 14);
    for n in ["social", "everyone", "round_table", "wait_your_turn", "moderated"] {
        assert!(mode(n).is_some_and(|m| m.playbook.is_none()), "{n}");
    }
    for n in ["debate", "vote", "market", "election", "handoff", "gossip", "pipeline", "review", "blackboard"] {
        assert!(mode(n).is_some(), "{n}");
    }
    assert_eq!(mode("market").unwrap().playbook, Some("auction"));
    assert_eq!(mode("round-table").unwrap().name, "round_table");
    assert_eq!(catalog_json().as_array().unwrap().len(), 14);
    // Every playbook a mode names is a kind the engine runs.
    for m in CATALOG.iter() {
        if let Some(p) = m.playbook {
            assert!(KINDS.contains(&p), "{p}");
        }
    }
}

#[test]
fn group_vote_steers_dispatch_until_done_then_rules_restore() {
    let c = db();
    let pb = start(&c, ROOM, "vote", &json!({"members": members(3), "options": ["A", "B"], "rule": "majority"}), "user").unwrap();
    // While it runs, the post wakes exactly the voters who have not voted.
    let s = steer(&c, ROOM, "user").unwrap();
    assert!(!s.announce);
    assert_eq!(s.wake.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec!["agent:a1", "agent:a2", "agent:a3"]);
    act(&c, ROOM, &pb.id, "agent:a1", "ballot", &json!({"option": "a"})).unwrap();
    let s = steer(&c, ROOM, "agent:a1").unwrap();
    assert_eq!(s.wake.len(), 2, "a1 voted: {:?}", s.wake);
    // A second ballot from the same voter is refused.
    assert!(act(&c, ROOM, &pb.id, "agent:a1", "ballot", &json!({"option": "B"})).is_err());
    assert!(act(&c, ROOM, &pb.id, "agent:a2", "ballot", &json!({"option": "C"})).unwrap_err().contains("Pick one of"));
    act(&c, ROOM, &pb.id, "agent:a2", "ballot", &json!({"option": "A"})).unwrap();
    let out = act(&c, ROOM, &pb.id, "agent:a3", "ballot", &json!({"option": "B", "reason": "cheaper"})).unwrap();
    assert!(out.finished);
    assert_eq!(out.playbook.state, "done");
    assert_eq!(out.playbook.result["winner"], "A");
    assert_eq!(out.playbook.result["tally"]["A"], 2);
    assert!(result_line(&out.playbook).contains("[vote result] A"));
    // The announcement post: a vote names nobody to wake.
    let s = steer(&c, ROOM, "user").unwrap();
    assert!(s.announce && s.wake.is_empty());
    announced(&c, ROOM);
    // Then the room's own rules decide again.
    assert!(steer(&c, ROOM, "user").is_none());
    assert!(active(&c, ROOM).unwrap().is_none());
    // A new one can start now.
    start(&c, ROOM, "debate", &json!({"members": members(2)}), "user").unwrap();
}

#[test]
fn one_playbook_per_room_and_members_checked() {
    let c = db();
    start(&c, ROOM, "debate", &json!({"members": members(2)}), "user").unwrap();
    assert!(start(&c, ROOM, "vote", &json!({"members": members(2), "options": ["x", "y"]}), "user").unwrap_err().contains("already running"));
    // Another room is free.
    start(&c, "group:g2", "vote", &json!({"members": members(2), "options": ["x", "y"]}), "user").unwrap();
    assert!(start(&c, "group:g3", "debate", &json!({"members": members(1)}), "user").is_err());
    assert!(start(&c, "group:g3", "vote", &json!({"members": members(2), "options": ["x"]}), "user").is_err());
    assert!(start(&c, "group:g3", "juggle", &json!({"members": members(2)}), "user").unwrap_err().contains("Unknown playbook"));
    // A catalog mode name starts its playbook.
    let pb = start(&c, "group:g4", "market", &json!({"members": members(2), "task": "t"}), "user").unwrap();
    assert_eq!(pb.kind, "auction");
}

#[test]
fn debate_turns_in_order_and_converges() {
    let c = db();
    let pb = start(&c, ROOM, "debate", &json!({"members": members(2), "rounds": 2}), "agent:a1").unwrap();
    assert!(act(&c, ROOM, &pb.id, "agent:a2", "turn", &json!({"text": "me first"})).unwrap_err().contains("not your move"));
    let o = act(&c, ROOM, &pb.id, "agent:a1", "turn", &json!({"text": "I propose X"})).unwrap();
    assert_eq!(o.post.as_deref(), Some("I propose X"), "turns are posted in the room");
    assert_eq!(steer(&c, ROOM, "agent:a1").unwrap().wake[0].0, "agent:a2");
    act(&c, ROOM, &pb.id, "agent:a2", "turn", &json!({"text": "I disagree"})).unwrap();
    act(&c, ROOM, &pb.id, "agent:a1", "turn", &json!({"text": "Fine, I agree with the change", "stance": "agree"})).unwrap();
    let o = act(&c, ROOM, &pb.id, "agent:a2", "turn", &json!({"text": "Agreed"})).unwrap();
    assert!(o.finished);
    assert_eq!(o.playbook.result["converged"], true);
    assert_eq!(o.playbook.result["turns"], 4);
}

#[test]
fn auction_awards_best_bid_and_wakes_only_the_winner() {
    let c = db();
    let pb = start(&c, ROOM, "auction", &json!({"members": members(3), "task": "write the summary"}), "user").unwrap();
    assert!(act(&c, ROOM, &pb.id, "agent:a1", "bid", &json!({})).is_err());
    act(&c, ROOM, &pb.id, "agent:a1", "bid", &json!({"cost": 10, "confidence": 0.5})).unwrap();
    let o = act(&c, ROOM, &pb.id, "agent:a2", "bid", &json!({"cost": 6, "confidence": 0.9})).unwrap();
    assert!(o.post.is_none(), "bids stay private until the result");
    let o = act(&c, ROOM, &pb.id, "agent:a3", "bid", &json!({"cost": 6, "confidence": 0.6})).unwrap();
    assert!(o.finished);
    assert_eq!(o.playbook.result["winner"], "agent:a2");
    let s = steer(&c, ROOM, "user").unwrap();
    assert!(s.announce);
    assert_eq!(s.wake, vec![("agent:a2".to_string(), "playbook:auction:result".to_string())]);
}

#[test]
fn election_sets_the_room_coordinator() {
    let c = db();
    let pb = start(&c, ROOM, "election", &json!({"members": members(3)}), "user").unwrap();
    act(&c, ROOM, &pb.id, "agent:a1", "ballot", &json!({"option": "a2"})).unwrap();
    act(&c, ROOM, &pb.id, "agent:a2", "ballot", &json!({"option": "agent:a2"})).unwrap();
    let o = act(&c, ROOM, &pb.id, "agent:a3", "ballot", &json!({"option": "a1"})).unwrap();
    assert_eq!(o.playbook.result["coordinator"], "agent:a2");
    assert_eq!(board::room_meta_get(&c, ROOM, "coordinator").unwrap().as_deref(), Some("agent:a2"));
}

#[test]
fn handoff_follows_the_holder_and_caps_hops() {
    let c = db();
    let pb = start(&c, ROOM, "handoff", &json!({"members": members(3), "maxHandoffs": 1}), "user").unwrap();
    assert!(act(&c, ROOM, &pb.id, "agent:a2", "finish", &json!({"text": "done"})).is_err(), "only the holder");
    assert!(act(&c, ROOM, &pb.id, "agent:a1", "handoff", &json!({"to": "agent:a1"})).is_err(), "not to yourself");
    act(&c, ROOM, &pb.id, "agent:a1", "handoff", &json!({"to": "a2"})).unwrap();
    assert_eq!(steer(&c, ROOM, "agent:a1").unwrap().wake[0].0, "agent:a2");
    let o = act(&c, ROOM, &pb.id, "agent:a2", "handoff", &json!({"to": "a3"})).unwrap();
    assert!(o.finished, "over the cap");
    assert_eq!(o.playbook.result["finished"], false);
    assert_eq!(o.playbook.result["handoffs"], 2);
}

#[test]
fn gossip_spreads_to_everyone() {
    let c = db();
    let pb = start(&c, ROOM, "gossip", &json!({"members": members(4), "fanout": 2, "fact": "ship Friday"}), "user").unwrap();
    act(&c, ROOM, &pb.id, "agent:a1", "spread", &json!({"to": ["a2", "a3"]})).unwrap();
    assert!(act(&c, ROOM, &pb.id, "agent:a4", "spread", &json!({"to": ["a1"]})).is_err(), "a4 has not heard yet");
    let o = act(&c, ROOM, &pb.id, "agent:a3", "spread", &json!({"to": ["a4"]})).unwrap();
    assert!(o.finished);
    assert_eq!(o.playbook.result["reached"], 4);
}

#[test]
fn batch_modes_run_as_playbooks() {
    let c = db();
    let room = batch_room("agent:main:main", "b1");
    assert_eq!(batch_kind("fanout"), "parallel");
    assert_eq!(batch_kind("map_reduce"), "gather");
    // Pipeline: stages count only in order.
    let pb = start(&c, &room, batch_kind("pipeline"), &json!({"members": members(3)}), "agent:main").unwrap();
    assert!(act(&c, &room, &pb.id, "agent:a2", "result", &json!({"text": "early"})).is_err());
    act(&c, &room, &pb.id, "agent:a1", "result", &json!({"text": "draft"})).unwrap();
    act(&c, &room, &pb.id, "agent:a2", "result", &json!({"text": "better"})).unwrap();
    let o = act(&c, &room, &pb.id, "agent:a3", "result", &json!({"text": "final"})).unwrap();
    assert!(o.finished);
    assert_eq!(o.playbook.result["final"], "final");
    // Race: the first result ends it.
    let room2 = batch_room("agent:main:main", "b2");
    let pb = start(&c, &room2, "race", &json!({"members": members(3)}), "agent:main").unwrap();
    let o = act(&c, &room2, &pb.id, "agent:a3", "result", &json!({"text": "first!"})).unwrap();
    assert!(o.finished);
    assert_eq!(o.playbook.result["winner"], "agent:a3");
    // Gather: every result, then a summary.
    let room3 = batch_room("agent:main:main", "b3");
    let pb = start(&c, &room3, "gather", &json!({"members": members(2)}), "agent:main").unwrap();
    act(&c, &room3, &pb.id, "agent:a1", "result", &json!({"text": "one"})).unwrap();
    let o = act(&c, &room3, &pb.id, "agent:a2", "result", &json!({"text": "two"})).unwrap();
    assert!(o.playbook.result["summary"].as_str().unwrap().contains("agent:a2: two"));
}

#[test]
fn review_loops_until_approved_or_out_of_rounds() {
    let c = db();
    let pb = start(&c, ROOM, "review", &json!({"members": members(3), "maxRounds": 2}), "user").unwrap();
    assert!(act(&c, ROOM, &pb.id, "agent:a2", "review", &json!({"approve": true})).is_err(), "no draft yet");
    act(&c, ROOM, &pb.id, "agent:a1", "result", &json!({"text": "v1"})).unwrap();
    act(&c, ROOM, &pb.id, "agent:a2", "review", &json!({"approve": true})).unwrap();
    let o = act(&c, ROOM, &pb.id, "agent:a3", "review", &json!({"approve": false, "text": "fix the intro"})).unwrap();
    assert!(!o.finished);
    assert_eq!(o.post.as_deref(), Some("Changes requested: fix the intro"));
    assert_eq!(steer(&c, ROOM, "agent:a3").unwrap().wake[0].0, "agent:a1", "back to the author");
    act(&c, ROOM, &pb.id, "agent:a1", "result", &json!({"text": "v2"})).unwrap();
    act(&c, ROOM, &pb.id, "agent:a2", "review", &json!({"approve": true})).unwrap();
    let o = act(&c, ROOM, &pb.id, "agent:a3", "review", &json!({"approve": true})).unwrap();
    assert!(o.finished);
    assert_eq!(o.playbook.result["approved"], true);
    assert_eq!(o.playbook.result["text"], "v2");
}

#[test]
fn close_and_cancel_are_for_the_starter_or_the_user() {
    let c = db();
    let pb = start(&c, ROOM, "vote", &json!({"members": members(3), "options": ["A", "B"]}), "agent:a1").unwrap();
    act(&c, ROOM, &pb.id, "agent:a2", "ballot", &json!({"option": "B"})).unwrap();
    assert!(act(&c, ROOM, &pb.id, "agent:a2", "close", &json!({})).is_err());
    let o = act(&c, ROOM, &pb.id, "agent:a1", "close", &json!({})).unwrap();
    assert!(o.finished);
    // One ballot of three is no majority.
    assert!(o.playbook.result["winner"].is_null());
    let pb = start(&c, ROOM, "debate", &json!({"members": members(2)}), "agent:a1").unwrap();
    assert!(cancel(&c, ROOM, &pb.id, "agent:a2").is_err());
    cancel(&c, ROOM, &pb.id, "user").unwrap();
    assert!(active(&c, ROOM).unwrap().is_none());
}

#[test]
fn deadline_closes_with_what_it_has() {
    let c = db();
    let pb = start(&c, ROOM, "vote", &json!({"members": members(2), "options": ["A", "B"], "rule": "plurality"}), "user").unwrap();
    act(&c, ROOM, &pb.id, "agent:a1", "ballot", &json!({"option": "A"})).unwrap();
    c.execute("UPDATE ws_playbooks SET params_json = json_set(params_json, '$.deadlineMs', 1) WHERE id = ?1", params![pb.id]).unwrap();
    assert!(active(&c, ROOM).unwrap().is_none());
    let done = get(&c, ROOM, &pb.id).unwrap().unwrap();
    assert_eq!(done.state, "done");
    assert_eq!(done.result["winner"], "A");
}

#[test]
fn fold_is_a_pure_replay() {
    let c = db();
    let pb = start(&c, ROOM, "vote", &json!({"members": members(2), "options": ["A", "B"]}), "user").unwrap();
    act(&c, ROOM, &pb.id, "agent:a1", "ballot", &json!({"option": "A"})).unwrap();
    let loaded = get(&c, ROOM, &pb.id).unwrap().unwrap();
    assert_eq!(fold(&loaded.kind, &loaded.params, &loaded.events), loaded.view);
    assert_eq!(room_of(&c, &pb.id).unwrap().as_deref(), Some(ROOM));
    assert_eq!(list(&c, ROOM).unwrap().len(), 1);
}

#[test]
fn vote_rules() {
    let t = |pairs: &[(&str, i64)]| pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect::<BTreeMap<_, _>>();
    assert_eq!(winner(&t(&[("A", 2), ("B", 1)]), 3, "majority").as_deref(), Some("A"));
    assert_eq!(winner(&t(&[("A", 2), ("B", 2)]), 4, "plurality"), None);
    assert_eq!(winner(&t(&[("A", 3)]), 3, "unanimous").as_deref(), Some("A"));
    assert_eq!(winner(&t(&[("A", 2), ("B", 1)]), 3, "unanimous"), None);
    assert_eq!(winner(&t(&[("A", 2), ("B", 1)]), 3, "supermajority").as_deref(), Some("A"));
    assert_eq!(winner(&t(&[("A", 3), ("B", 2)]), 5, "supermajority"), None);
}

#[test]
fn unified_graph_links_members_to_rooms() {
    let c = db();
    start(&c, ROOM, "debate", &json!({"members": members(2)}), "user").unwrap();
    let g = unified_graph(&c, None).unwrap();
    let edges = g["edges"].as_array().unwrap();
    assert!(edges.iter().any(|e| e["from"] == "agent:a1" && e["to"] == ROOM && e["kind"] == "playbook:debate"), "{g}");
    assert!(g["nodes"].as_array().unwrap().iter().any(|n| n["pid"] == ROOM && n["kind"] == "group"));
}
