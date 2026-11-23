//! Tests for the swarm comms system (channels.rs, swarm.rs).
//!
//! Scripted agents answer swarm notes on their own (`auto_respond`), driven
//! by markers in their task: `stance=yes` (or `stance=no->yes` to change its
//! mind after round 1), `cost=3`, `conf=0.9`, `nobid`, `vote=B`.

use super::*;

fn marker(task: &str, key: &str) -> Option<String> {
    task.split_whitespace().find_map(|w| w.strip_prefix(&format!("{}=", key)).map(str::to_string))
}

fn id_after(p: &str, tag: &str) -> Option<String> {
    let i = p.rfind(tag)? + tag.len();
    Some(p[i..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect())
}

/// A scripted agent's answer to a swarm note, acting through its own tools.
pub(super) async fn auto_respond(prompt: &str, req: &RunRequest) -> Option<String> {
    let mgr = req.child.manager.clone();
    let me = mgr.record_by_session(&req.params.session_key)?;
    let env = ParentEnv {
        session_key: req.params.session_key.clone(),
        provider: None,
        model: None,
        system_prompt: String::new(),
        tool_names: Vec::new(),
        callback: Some(req.callback.clone()),
        memory: None,
        abort: Some(req.abort.clone()),
    };
    let task = me.task.clone();
    if prompt.contains("[Debate ") {
        let rid = id_after(prompt, "request ")?;
        let round: u32 = prompt.split("round ").nth(1).and_then(|r| r.split('/').next()).and_then(|n| n.parse().ok()).unwrap_or(1);
        let st = marker(&task, "stance").unwrap_or_else(|| "yes".into());
        let stance = match st.split_once("->") {
            Some((a, b)) => if round == 1 { a.to_string() } else { b.to_string() },
            None => st,
        };
        let (out, err) = mgr.handle_team_tool(channels::TOOL_REPLY, &json!({"request_id": rid, "answer": format!("POSITION: {}\nbecause round {}", stance, round)}), env).await;
        return Some(format!("debated(err={err}): {out}"));
    }
    if let Some(rid) = id_after(prompt, "[Request ") {
        let ans = format!("answer from {}", me.name);
        let (out, err) = mgr.handle_team_tool(channels::TOOL_REPLY, &json!({"request_id": rid, "answer": ans}), env).await;
        return Some(format!("replied(err={err}): {out}"));
    }
    if let Some(aid) = id_after(prompt, "[Call for proposals ") {
        let input = if task.contains("nobid") {
            json!({"auction_id": aid, "decline": true})
        } else {
            json!({"auction_id": aid, "proposal": format!("{} will do it", me.name), "cost": marker(&task, "cost").and_then(|c| c.parse::<f64>().ok()), "confidence": marker(&task, "conf").and_then(|c| c.parse::<f64>().ok())})
        };
        let (out, err) = mgr.handle_team_tool(channels::TOOL_BID, &input, env).await;
        return Some(format!("bid(err={err}): {out}"));
    }
    let vid = id_after(prompt, "[Vote ").or_else(|| id_after(prompt, "[Election ballot "));
    if let Some(vid) = vid {
        let opts = prompt.lines().find_map(|l| l.strip_prefix("Options: ")).unwrap_or("").to_string();
        let first = opts.split(" | ").next().unwrap_or("").to_string();
        let option = marker(&task, "vote").unwrap_or(first);
        let (out, err) = mgr.handle_team_tool(channels::TOOL_CAST_VOTE, &json!({"vote_id": vid, "option": option, "reason": "scripted"}), env).await;
        return Some(format!("voted(err={err}): {out}"));
    }
    if prompt.contains("[Handoff from") {
        return Some(format!("took over as {}", me.name));
    }
    if prompt.contains("[Award ") {
        return Some(format!("{} did the awarded task", me.name));
    }
    None
}

fn setup() -> (Arc<SubagentManager>, Arc<Script>, Arc<AppEvents>, ParentEnv) {
    let (m, s, a, e, _) = super::setup();
    (m, s, a, e)
}

/// Spawn finished agents (their task is just markers), wait until all idle.
async fn team(mgr: &Arc<SubagentManager>, env: &ParentEnv, agents: &[(&str, &str)]) -> Vec<SubagentRecord> {
    let mut ids = Vec::new();
    for (name, task) in agents {
        let r = mgr.spawn(0, SpawnSpec { name: Some(name.to_string()), ..spec(task) }, env).unwrap();
        ids.push(r.id);
    }
    mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
    ids.iter().map(|i| mgr.get(i).unwrap()).collect()
}

fn env_of(env: &ParentEnv, r: &SubagentRecord) -> ParentEnv {
    ParentEnv { session_key: r.session_key.clone(), abort: None, ..env.clone() }
}

async fn tool(mgr: &Arc<SubagentManager>, env: &ParentEnv, r: &SubagentRecord, t: &str, input: Value) -> (String, bool) {
    mgr.handle_team_tool(t, &input, env_of(env, r)).await
}

async fn settle(mgr: &Arc<SubagentManager>) {
    for _ in 0..200 {
        if !mgr.list().iter().any(|r| r.is_active()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn names(mgr: &Arc<SubagentManager>, r: &SubagentRecord) -> Vec<String> {
    let mut v: Vec<String> = mgr.reachable(r).into_iter().map(|x| x.name).collect();
    v.sort();
    v
}

#[tokio::test]
async fn comms_config_layers_presets_and_tools() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("alpha", "ok"), ("beta", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    // Default: tree, no comms tools at all.
    assert_eq!(mgr.effective_comms(&root).topology, "tree");
    assert!(mgr.comms_tool_names(&t[0]).is_empty());
    assert!(!mgr.team_tool_names(&t[0]).iter().any(|x| x == team::TOOL_MESSAGE_PEER));
    // Defaults ("*") apply to every chat; the chat's own config wins.
    mgr.set_comms_config(channels::GLOBAL_KEY, &json!({"topology": "mesh", "maxHops": 4}));
    assert_eq!(mgr.effective_comms(&root).topology, "mesh");
    let tools = mgr.team_tool_names(&t[0]);
    for x in [team::TOOL_MESSAGE_PEER, channels::TOOL_BROADCAST_TEAM, channels::TOOL_PUBLISH, channels::TOOL_BB_WRITE, channels::TOOL_REQUEST, team::TOOL_LIST_PEERS] {
        assert!(tools.iter().any(|y| y == x), "{x} in {tools:?}");
    }
    assert!(!tools.iter().any(|y| y == channels::TOOL_HANDOFF), "mesh has no handoff by default");
    let (_, rejected) = mgr.set_comms_config(&root, &json!({"topology": "swarm", "maxHops": 999, "consensusRule": "dictator", "patterns": ["handoff", "vote"]}));
    assert_eq!(rejected, vec!["consensusRule".to_string(), "maxHops".to_string()]);
    let eff = mgr.effective_comms(&root);
    assert_eq!((eff.topology.as_str(), eff.max_hops), ("swarm", 4), "maxHops still from the defaults");
    assert_eq!(mgr.comms_tool_names(&t[0]), vec!["list_peers", "handoff_to_peer", "call_vote", "cast_vote"].into_iter().skip(1).map(String::from).collect::<Vec<_>>());
    // null clears a key back to inherited.
    mgr.set_comms_config(&root, &json!({"patterns": null}));
    assert_eq!(mgr.comms_tool_names(&t[0]).len(), channels::COMMS_TOOL_NAMES.len(), "swarm turns every pattern on");
    // An agent's own topology wins over the chat's.
    mgr.update(&t[0].id, |r| r.topology = Some("bus".into()));
    let a = mgr.get(&t[0].id).unwrap();
    assert_eq!(mgr.topology_of(&a), "bus");
    assert!(mgr.may_message(&a, &t[1]).is_err(), "bus has no direct messages");
    assert!(mgr.may_message(&t[1], &a).is_ok(), "beta follows the chat's swarm");
    // Presets: built-in, saved, applied, deleted; built-in names are reserved.
    let presets = mgr.comms_presets();
    assert!(presets.len() >= 9 && presets.iter().any(|p| p.name == "open-swarm"));
    assert!(mgr.save_comms_preset(&json!({"name": "market", "config": {}})).is_err());
    let p = mgr.save_comms_preset(&json!({"name": "My Lab", "title": "Lab", "config": {"topology": "ring", "patterns": ["direct"], "maxRounds": 2}})).unwrap();
    assert_eq!(p.name, "my-lab");
    mgr.set_comms_config(&root, &json!({"edges": [{"from": "alpha", "to": "beta", "allow": false}]}));
    let cfg = mgr.apply_comms_preset(&root, "my-lab").unwrap();
    assert_eq!(cfg.topology.as_deref(), Some("ring"));
    assert_eq!(cfg.edges.as_ref().map(|e| e.len()), Some(1), "drawn edges survive a preset");
    assert!(mgr.save_comms_preset(&json!({"name": "bad", "config": {"topology": "blob"}})).is_err());
    assert!(mgr.delete_comms_preset("my-lab") && !mgr.delete_comms_preset("my-lab"));
    // Persisted.
    let again = SubagentManager::new(mgr.state_dir.clone(), Arc::new(Arc::new(Script::default())));
    assert_eq!(again.chat_comms_config(&root).topology.as_deref(), Some("ring"));
}

#[tokio::test]
async fn every_topology_decides_who_may_message() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("a", "ok"), ("b", "ok"), ("c", "ok"), ("d", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    let set = |cfg: Value| mgr.set_comms_config(&root, &cfg);
    set(json!({"topology": "mesh"}));
    assert_eq!(names(&mgr, &t[0]), vec!["b", "c", "d"]);
    set(json!({"topology": "chain"}));
    assert_eq!(names(&mgr, &t[0]), vec!["b"]);
    assert_eq!(names(&mgr, &t[1]), vec!["a", "c"]);
    assert_eq!(names(&mgr, &t[3]), vec!["c"], "no wrap");
    set(json!({"topology": "ring"}));
    assert_eq!(names(&mgr, &t[3]), vec!["a"], "ring wraps");
    set(json!({"topology": "bus"}));
    assert!(names(&mgr, &t[0]).is_empty());
    assert!(mgr.comms_tool_names(&t[0]).contains(&channels::TOOL_PUBLISH.to_string()));
    set(json!({"topology": "star"}));
    assert!(names(&mgr, &t[0]).is_empty(), "no hub, no talk");
    mgr.update(&t[2].id, |r| r.comms_role = Some("hub".into()));
    let t: Vec<SubagentRecord> = t.iter().map(|r| mgr.get(&r.id).unwrap()).collect();
    assert_eq!(names(&mgr, &t[0]), vec!["c"]);
    assert_eq!(names(&mgr, &t[2]), vec!["a", "b", "d"], "the hub reaches every spoke");
    set(json!({"topology": "swarm"}));
    assert_eq!(names(&mgr, &t[0]), vec!["b", "c", "d"]);
    set(json!({"topology": "custom"}));
    assert!(names(&mgr, &t[0]).is_empty(), "custom without edges: nobody");
    set(json!({"edges": [{"from": "a", "to": "d", "allow": true, "both": true}, {"from": "*", "to": "b", "allow": true}]}));
    assert_eq!(names(&mgr, &t[0]), vec!["b", "d"]);
    assert_eq!(names(&mgr, &t[3]), vec!["a", "b"], "both ways");
    assert!(names(&mgr, &t[1]).is_empty());
    // Deny wins over the topology, over allow edges, and over canMessage.
    set(json!({"topology": "mesh", "edges": [{"from": "a", "to": "b", "allow": true}, {"from": "a", "to": "b", "allow": false}]}));
    assert_eq!(names(&mgr, &t[0]), vec!["c", "d"]);
    mgr.update(&t[0].id, |r| r.can_message = Some(vec!["b".into(), "c".into()]));
    let a = mgr.get(&t[0].id).unwrap();
    assert_eq!(names(&mgr, &a), vec!["c"]);
    let err = mgr.may_message(&a, &t[1]).unwrap_err();
    assert!(err.contains("blocked"), "{err}");
}

#[tokio::test]
async fn hierarchical_sub_teams_talk_through_their_leads() {
    let (mgr, _s, _a, env) = setup();
    mgr.set_settings(&json!({"maxDepth": 3}));
    let t = team(&mgr, &env, &[("lead1", "ok"), ("lead2", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "hierarchical"}));
    let e1 = env_of(&env, &t[0]);
    let e2 = env_of(&env, &t[1]);
    let w1 = mgr.spawn(1, SpawnSpec { name: Some("w1".into()), ..spec("ok") }, &e1).unwrap();
    let w1b = mgr.spawn(1, SpawnSpec { name: Some("w1b".into()), ..spec("ok") }, &e1).unwrap();
    let w2 = mgr.spawn(1, SpawnSpec { name: Some("w2".into()), ..spec("ok") }, &e2).unwrap();
    mgr.wait_for(&[w1.id.clone(), w1b.id.clone(), w2.id.clone()], None, Duration::from_secs(5)).await;
    let (w1, w2) = (mgr.get(&w1.id).unwrap(), mgr.get(&w2.id).unwrap());
    assert!(mgr.is_lead(&t[0]), "an agent with children leads its sub-team");
    assert!(mgr.may_message(&w1, &mgr.get(&w1b.id).unwrap()).is_ok(), "same sub-team");
    assert!(mgr.may_message(&w1, &t[0]).is_ok(), "up to its lead");
    assert!(mgr.may_message(&t[0], &w1).is_ok(), "down to its member");
    assert!(mgr.may_message(&t[0], &t[1]).is_ok(), "lead to lead");
    let err = mgr.may_message(&w1, &w2).unwrap_err();
    assert!(err.contains("ask your lead"), "{err}");
    // whoCanSpawn: leads only, then nobody.
    mgr.set_comms_config(&root, &json!({"whoCanSpawn": "leads"}));
    let ew1 = env_of(&env, &w1);
    let err = mgr.spawn(2, spec("ok"), &ew1).unwrap_err();
    assert!(err.contains("only leads"), "{err}");
    assert!(mgr.spawn(1, spec("ok"), &e1).is_ok(), "a lead may");
    mgr.set_comms_config(&root, &json!({"whoCanSpawn": "none"}));
    assert!(mgr.spawn(1, spec("ok"), &e1).unwrap_err().contains("no sub-agent"));
    assert!(mgr.spawn(0, spec("ok"), &env).is_ok(), "the main agent is never limited");
    settle(&mgr).await;
}

#[tokio::test]
async fn topics_deliver_to_subscribers_and_keep_history() {
    let (mgr, _s, app, env) = setup();
    let t = team(&mgr, &env, &[("pub", "ok"), ("sub1", "ok"), ("sub2", "ok"), ("other", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "bus"}));
    let (out, err) = tool(&mgr, &env, &t[1], channels::TOOL_SUBSCRIBE, json!({"topic": "#Findings"})).await;
    assert!(!err && out.contains("#findings"), "{out}");
    tool(&mgr, &env, &t[2], channels::TOOL_SUBSCRIBE, json!({"topic": "findings"})).await;
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_PUBLISH, json!({"topic": "findings", "message": "bug in parser.rs:42"})).await;
    assert!(!err && out.contains("2 subscribers"), "{out}");
    assert_eq!(mgr.get(&t[1].id).unwrap().inbox.len(), 1);
    assert!(mgr.get(&t[1].id).unwrap().inbox[0].contains("bug in parser.rs:42"));
    assert!(mgr.get(&t[3].id).unwrap().inbox.is_empty(), "not subscribed");
    tool(&mgr, &env, &t[2], channels::TOOL_UNSUBSCRIBE, json!({"topic": "findings"})).await;
    tool(&mgr, &env, &t[0], channels::TOOL_PUBLISH, json!({"topic": "findings", "message": "second"})).await;
    assert_eq!(mgr.get(&t[2].id).unwrap().inbox.len(), 1);
    // A late subscriber reads the history.
    let (out, _) = tool(&mgr, &env, &t[3], channels::TOOL_SUBSCRIBE, json!({"topic": "findings"})).await;
    assert!(out.contains("bug in parser.rs:42") && out.contains("second"), "{out}");
    let (out, _) = tool(&mgr, &env, &t[3], channels::TOOL_LIST_TOPICS, json!({})).await;
    assert!(out.contains("#findings (2 posts") && out.contains("you are subscribed"), "{out}");
    // The user posts from the app; deny edges keep a publisher from a subscriber.
    let r = mgr.handle_app_request(&json!({"action": "topicPublish", "sessionKey": "chat-1", "topic": "findings", "message": "from me"}), &env, None).unwrap();
    assert_eq!(r["delivered"], 2);
    mgr.set_comms_config(&root, &json!({"edges": [{"from": "pub", "to": "sub1", "allow": false}]}));
    let (out, _) = tool(&mgr, &env, &t[0], channels::TOOL_PUBLISH, json!({"topic": "findings", "message": "third"})).await;
    assert!(out.contains("1 subscriber"), "{out}");
    assert_eq!(app.named("subagent.swarm_topic_post").len(), 3);
}

#[tokio::test]
async fn blackboard_versions_reinforcement_and_evaporation() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("w1", "ok"), ("w2", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "bus"}));
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_BB_WRITE, json!({"key": "plan", "value": "step 1", "tags": ["todo"]})).await;
    assert!(!err && out.contains("version 1"), "{out}");
    let (out, err) = tool(&mgr, &env, &t[1], channels::TOOL_BB_WRITE, json!({"key": "plan", "value": "step 1+2", "expected_version": 1})).await;
    assert!(!err && out.contains("version 2"), "{out}");
    // A stale write is refused with the current value (optimistic concurrency).
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_BB_WRITE, json!({"key": "plan", "value": "mine", "expected_version": 1})).await;
    assert!(err && out.contains("Conflict") && out.contains("step 1+2") && out.contains("by w2"), "{out}");
    let (out, _) = tool(&mgr, &env, &t[0], channels::TOOL_BB_READ, json!({"key": "plan"})).await;
    assert!(out.contains("version 2") && out.contains("step 1+2"), "{out}");
    // Reinforce a mark: weight grows; it evaporates with the half-life.
    tool(&mgr, &env, &t[0], channels::TOOL_BB_WRITE, json!({"key": "trail", "value": "src/net"})).await;
    tool(&mgr, &env, &t[1], channels::TOOL_BB_WRITE, json!({"key": "trail", "reinforce": true})).await;
    let e = mgr.read_chat(&root, |c| c.blackboard.get("trail").cloned()).unwrap();
    assert_eq!(e.version, 1, "reinforcing does not change the value");
    let now = now_ms();
    let w = e.weight_now(30, now);
    assert!(w > 1.9 && w <= 2.0, "{w}");
    let later = e.weight_now(30, now + 30 * 60_000);
    assert!((later - w / 2.0).abs() < 0.01, "halves after a half-life: {later}");
    let (out, _) = tool(&mgr, &env, &t[1], channels::TOOL_BB_READ, json!({})).await;
    assert!(out.find("trail").unwrap() < out.find("plan").unwrap(), "strongest first: {out}");
    let (out, _) = tool(&mgr, &env, &t[1], channels::TOOL_BB_SEARCH, json!({"query": "todo"})).await;
    assert!(out.contains("plan") && !out.contains("trail"), "{out}");
    // Writers rule: leads only.
    mgr.set_comms_config(&root, &json!({"blackboardWriters": "leads"}));
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_BB_WRITE, json!({"key": "x", "value": "y"})).await;
    assert!(err && out.contains("only leads"), "{out}");
    // The user edits and deletes from the app.
    mgr.handle_app_request(&json!({"action": "blackboardWrite", "sessionKey": "chat-1", "key": "plan", "value": "user plan", "expectedVersion": 2}), &env, None).unwrap();
    assert_eq!(mgr.read_chat(&root, |c| c.blackboard.get("plan").map(|e| (e.version, e.author_name.clone()))), Some((3, "You".into())));
    assert!(mgr.handle_app_request(&json!({"action": "blackboardWrite", "sessionKey": "chat-1", "key": "plan", "value": "z", "expectedVersion": 2}), &env, None).is_err());
    mgr.handle_app_request(&json!({"action": "blackboardDelete", "sessionKey": "chat-1", "key": "plan"}), &env, None).unwrap();
    assert!(mgr.read_chat(&root, |c| !c.blackboard.contains_key("plan")));
}

#[tokio::test]
async fn request_reply_waits_wakes_and_avoids_deadlock() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("asker", "ok"), ("expert", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh"}));
    // The idle expert is woken, answers with reply_peer, the asker gets it.
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_REQUEST, json!({"to": "expert", "question": "which file?", "wait": true, "timeout_s": 10})).await;
    assert!(!err && out.contains("expert replies: answer from expert"), "{out}");
    settle(&mgr).await;
    // Without wait the reply arrives in the asker's inbox.
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_REQUEST, json!({"to": "expert", "question": "and now?"})).await;
    assert!(!err && out.contains("arrives as a message"), "{out}");
    settle(&mgr).await;
    let inbox = mgr.get(&t[0].id).unwrap().inbox;
    assert!(inbox.iter().any(|m| m.contains("answer to request rq_") && m.contains("⟦from: expert") && m.contains("answer from expert")), "{inbox:?}");
    // Deadlock avoidance: expert already waits on asker, so asker won't wait on expert.
    let _g = mgr.begin_wait(&t[1].id, std::slice::from_ref(&t[0].id));
    mgr.set_comms_config(&root, &json!({"wakeIdle": false}));
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_REQUEST, json!({"to": "expert", "question": "q", "wait": true})).await;
    assert!(!err && out.contains("would deadlock"), "{out}");
    drop(_g);
    // Timeout when nobody answers.
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_REQUEST, json!({"to": "expert", "question": "q2", "wait": true, "timeout_s": 5})).await;
    assert!(err && out.contains("No reply"), "{out}");
    assert!(mgr.would_deadlock(&t[1].id, std::slice::from_ref(&t[0].id)).is_none(), "the wait-for graph is cleaned up");
    // Replies: only the addressee, only once.
    let open = mgr.open_requests_for(&t[1].id);
    assert!(!open.is_empty());
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_REPLY, json!({"request_id": open[0].0, "answer": "x"})).await;
    assert!(err && out.contains("not sent to you"), "{out}");
    let (_, err) = tool(&mgr, &env, &t[1], channels::TOOL_REPLY, json!({"request_id": open[0].0, "answer": "late"})).await;
    assert!(!err);
    let (out, err) = tool(&mgr, &env, &t[1], channels::TOOL_REPLY, json!({"request_id": open[0].0, "answer": "again"})).await;
    assert!(err && out.contains("No open request"), "{out}");
}

#[tokio::test]
async fn hop_pair_and_chat_limits_and_pause_stop_loops() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("a", "ok"), ("b", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh", "maxHops": 3, "maxPairMessages": 50}));
    // a -> b -> a -> b: the hop count grows with each relay.
    let msg = |from: usize, to: &str| {
        let mgr = mgr.clone();
        let r = t[from].clone();
        let env = env.clone();
        let to = to.to_string();
        async move { tool(&mgr, &env, &r, team::TOOL_MESSAGE_PEER, json!({"to": to, "message": "ping"})).await }
    };
    assert!(!msg(0, "b").await.1);
    assert!(!msg(1, "a").await.1);
    assert!(!msg(0, "b").await.1);
    let (out, err) = msg(1, "a").await;
    assert!(err && out.contains("hop 4") && out.contains("limit is 3"), "{out}");
    // Per-pair limit.
    mgr.swarm_rt.lock().unwrap().hops.clear();
    mgr.set_comms_config(&root, &json!({"maxHops": 50, "maxPairMessages": 2}));
    mgr.swarm_rt.lock().unwrap().pair.clear();
    assert!(!msg(0, "b").await.1);
    mgr.swarm_rt.lock().unwrap().hops.clear();
    assert!(!msg(0, "b").await.1);
    mgr.swarm_rt.lock().unwrap().hops.clear();
    let (out, err) = msg(0, "b").await;
    assert!(err && out.contains("most allowed between two agents"), "{out}");
    // Chat-wide cap.
    let used = mgr.read_chat(&root, |c| c.message_count) as u32;
    mgr.set_comms_config(&root, &json!({"maxPairMessages": 0, "maxMessages": used}));
    let (out, err) = msg(1, "a").await;
    assert!(err && out.contains("the most the user allows"), "{out}");
    // Per-chat pause.
    mgr.set_comms_config(&root, &json!({"maxMessages": 0, "paused": true}));
    let (out, err) = msg(1, "a").await;
    assert!(err && out.contains("paused"), "{out}");
}

#[tokio::test]
async fn handoff_moves_the_task_and_the_report_follows() {
    let (mgr, _s, app, env) = setup();
    let t = team(&mgr, &env, &[("specialist", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "swarm"}));
    let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"name": "triage", "task": "team:handoff_to_peer {\"to\":\"specialist\",\"note\":\"needs SQL\"}"}), &env).await;
    assert!(!err, "{out}");
    assert!(out.contains("handed its task to \"specialist\"") && out.contains("took over as specialist"), "{out}");
    let tri = mgr.list().into_iter().find(|r| r.name == "triage").unwrap();
    assert_eq!(tri.handed_to.as_deref(), Some(t[0].id.as_str()));
    assert_eq!(mgr.get(&t[0].id).unwrap().handed_from.as_deref(), Some(tri.id.as_str()));
    assert_eq!(mgr.read_chat(&root, |c| c.swarm.active_agent.clone()).as_deref(), Some(t[0].id.as_str()));
    assert_eq!(app.named("subagent.swarm_handoff").len(), 1);
    // No handing back (loop), and a cap on the chain.
    settle(&mgr).await;
    let sp = mgr.get(&t[0].id).unwrap();
    let (out, err) = tool(&mgr, &env, &sp, channels::TOOL_HANDOFF, json!({"to": "triage", "note": "back"})).await;
    assert!(err && out.contains("would loop"), "{out}");
    mgr.set_comms_config(&root, &json!({"maxHandoffs": 1}));
    let extra = team(&mgr, &env, &[("third", "ok")]).await;
    let (out, err) = tool(&mgr, &env, &sp, channels::TOOL_HANDOFF, json!({"to": "third", "note": "x"})).await;
    assert!(err && out.contains("handed on 1 times"), "{out}");
    let _ = extra;
    // The graph shows the handoff.
    let g = mgr.handle_app_request(&json!({"action": "graph", "sessionKey": "chat-1"}), &env, None).unwrap();
    assert_eq!(g["handoffEdges"].as_array().unwrap().len(), 1, "{}", g["handoffEdges"]);
    assert_eq!(g["swarm"]["handoffs"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn gossip_spreads_with_fanout_seen_set_and_hop_limit() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("g0", "ok"), ("g1", "ok"), ("g2", "ok"), ("g3", "ok"), ("g4", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh", "patterns": ["gossip"], "gossipFanout": 2, "maxRounds": 1}));
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_GOSSIP, json!({"fact": "the API key rotated"})).await;
    assert!(!err && out.contains("hop 1"), "{out}");
    let r = mgr.read_chat(&root, |c| c.swarm.rumors[0].clone());
    assert_eq!(r.seen.len(), 3, "origin + fanout 2");
    let heard: Vec<&SubagentRecord> = t.iter().filter(|x| mgr.get(&x.id).unwrap().inbox.iter().any(|m| m.contains(&r.id))).collect();
    assert_eq!(heard.len(), 2);
    // A receiver passes it on: only to agents that haven't seen it.
    let (out, err) = tool(&mgr, &env, heard[0], channels::TOOL_GOSSIP, json!({"rumor_id": r.id})).await;
    assert!(!err && out.contains("hop 2"), "{out}");
    let r2 = mgr.read_chat(&root, |c| c.swarm.rumors[0].clone());
    assert_eq!(r2.seen.len(), 5, "everyone has heard it");
    let (out, _) = tool(&mgr, &env, heard[1], channels::TOOL_GOSSIP, json!({"rumor_id": r.id})).await;
    assert!(out.contains("already heard"), "{out}");
    // Hop limit: maxRounds + 2 hops.
    mgr.with_chat(&root, |c| c.swarm.rumors[0].hops = 3);
    let (out, err) = tool(&mgr, &env, heard[1], channels::TOOL_GOSSIP, json!({"rumor_id": r.id})).await;
    assert!(err && out.contains("most allowed"), "{out}");
}

#[test]
fn bids_are_picked_by_policy() {
    let b = |n: &str, cost: Option<f64>, conf: Option<f64>, at: i64| swarm::Bid { bidder_id: n.into(), bidder_name: n.into(), proposal: "p".into(), cost, confidence: conf, declined: false, at };
    let bids = vec![b("slow-sure", Some(9.0), Some(0.95), 1), b("cheap-unsure", Some(1.0), Some(0.3), 2), b("balanced", Some(2.0), Some(0.9), 3)];
    assert_eq!(swarm::pick_bid(&bids, "cheapest").unwrap().bidder_name, "cheap-unsure");
    assert_eq!(swarm::pick_bid(&bids, "confident").unwrap().bidder_name, "slow-sure");
    assert_eq!(swarm::pick_bid(&bids, "first").unwrap().bidder_name, "slow-sure");
    assert_eq!(swarm::pick_bid(&bids, "best").unwrap().bidder_name, "balanced");
    assert!(swarm::pick_bid(&bids, "manager").is_none());
    let declined = vec![swarm::Bid { declined: true, ..b("x", None, None, 1) }];
    assert!(swarm::pick_bid(&declined, "best").is_none());
}

#[tokio::test]
async fn contract_net_announces_collects_bids_and_awards() {
    let (mgr, _s, app, env) = setup();
    let t = team(&mgr, &env, &[("manager", "ok"), ("fast", "ok cost=2 conf=0.6"), ("cheap", "ok cost=1 conf=0.5"), ("busy", "ok nobid")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh", "patterns": ["auction", "direct"], "auctionPolicy": "cheapest"}));
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_ANNOUNCE, json!({"task": "port the parser", "wait_s": 20})).await;
    assert!(!err, "{out}");
    assert!(out.contains("busy: declined") && out.contains("Awarded") && out.contains("to cheap (by the cheapest rule)"), "{out}");
    let a = mgr.read_chat(&root, |c| c.swarm.auctions[0].clone());
    assert_eq!((a.status.as_str(), a.winner_name.as_deref(), a.bids.len()), ("awarded", Some("cheap"), 3));
    settle(&mgr).await;
    // The winner was woken with the award; a loser got a note.
    let cheap_runs = last_assistant_text(&_s.load_messages(&t[2].session_key)).unwrap_or_default();
    assert!(cheap_runs.contains("did the awarded task"), "{cheap_runs}");
    assert!(mgr.get(&t[1].id).unwrap().inbox.iter().any(|m| m.contains("awarded the task to cheap")));
    assert_eq!(app.named("subagent.swarm_bid").len(), 3);
    // Without waiting, the announcer awards by hand; only bidders can win; only once.
    mgr.set_comms_config(&root, &json!({"auctionPolicy": "manager"}));
    let (out, _) = tool(&mgr, &env, &t[0], channels::TOOL_ANNOUNCE, json!({"task": "write docs", "to": ["fast", "busy"]})).await;
    assert!(out.contains("award with award_task"), "{out}");
    settle(&mgr).await;
    let id = mgr.read_chat(&root, |c| c.swarm.auctions.back().unwrap().id.clone());
    let (out, err) = tool(&mgr, &env, &t[1], channels::TOOL_AWARD, json!({"auction_id": id})).await;
    assert!(err && out.contains("Only manager"), "{out}");
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_AWARD, json!({"auction_id": id, "to": "busy"})).await;
    assert!(err && out.contains("did not bid"), "{out}");
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_AWARD, json!({"auction_id": id, "to": "fast"})).await;
    assert!(!err && out.contains("Awarded") && out.contains("your choice"), "{out}");
    let (_, err) = tool(&mgr, &env, &t[0], channels::TOOL_AWARD, json!({"auction_id": id, "to": "fast"})).await;
    assert!(err);
    let (out, err) = tool(&mgr, &env, &t[2], channels::TOOL_BID, json!({"auction_id": id, "proposal": "me"})).await;
    assert!(err && out.contains("closed"), "{out}");
    settle(&mgr).await;
}

#[test]
fn consensus_rules_and_quorum() {
    let opts: Vec<String> = vec!["A".into(), "B".into(), "C".into()];
    let ballots = |v: &[&str]| v.iter().enumerate().map(|(i, o)| swarm::Ballot { voter_id: i.to_string(), voter_name: i.to_string(), option: o.to_string(), ..Default::default() }).collect::<Vec<_>>();
    let s = |b: &[&str], voters: usize, rule: &str, q: u32| {
        let (st, w, _) = swarm::tally(&opts, voters, &ballots(b), rule, q);
        (st, w)
    };
    assert_eq!(s(&["A", "A", "B"], 3, "majority", 50), ("passed".into(), Some("A".into())));
    assert_eq!(s(&["A", "B", "C", "A"], 4, "majority", 50).0, "no_majority", "2 of 4 is not more than half");
    assert_eq!(s(&["A", "B", "C", "A"], 4, "plurality", 50), ("passed".into(), Some("A".into())));
    assert_eq!(s(&["A", "B"], 2, "plurality", 50).0, "tie");
    assert_eq!(s(&["A", "A", "A"], 3, "unanimous", 50).0, "passed");
    assert_eq!(s(&["A", "A"], 3, "unanimous", 50).0, "no_majority", "one voter missing");
    assert_eq!(s(&["A", "A", "B"], 3, "supermajority", 50).0, "passed", "2/3");
    assert_eq!(s(&["A", "A", "B", "B", "A"], 5, "supermajority", 50).0, "no_majority", "3/5 < 2/3");
    assert_eq!(s(&["A"], 4, "majority", 50).0, "no_quorum");
    assert_eq!(s(&[], 4, "majority", 0).0, "no_quorum");
}

#[tokio::test]
async fn votes_are_cast_by_the_team_and_tallied_by_the_chat_rule() {
    let (mgr, _s, app, env) = setup();
    let t = team(&mgr, &env, &[("chair", "ok"), ("v1", "ok vote=Rust"), ("v2", "ok vote=Rust"), ("v3", "ok vote=Go")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh", "patterns": ["vote"]}));
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_CALL_VOTE, json!({"question": "Language?", "options": ["Rust", "Go", "rust"], "wait_s": 20})).await;
    assert!(!err && out.contains("\"Rust\" wins (majority rule)") && out.contains("Rust 2") && out.contains("Go 1"), "{out}");
    let v = mgr.read_chat(&root, |c| c.swarm.votes[0].clone());
    assert_eq!((v.options.len(), v.voters.len(), v.ballots.len()), (2, 4, 3), "duplicate option dropped; the chair may vote but isn't awaited");
    assert_eq!(app.named("subagent.swarm_ballot").len(), 3);
    settle(&mgr).await;
    // Unanimous: the same split fails.
    mgr.set_comms_config(&root, &json!({"consensusRule": "unanimous"}));
    let (out, _) = tool(&mgr, &env, &t[0], channels::TOOL_CALL_VOTE, json!({"question": "Again?", "options": ["Rust", "Go"], "voters": ["v1", "v2", "v3"], "wait_s": 20})).await;
    assert!(out.contains("no unanimous reached"), "{out}");
    settle(&mgr).await;
    // Without wait: everyone casts, the last ballot closes it; bad options are refused.
    let (out, _) = tool(&mgr, &env, &t[0], channels::TOOL_CALL_VOTE, json!({"question": "Ship?", "options": ["Rust", "Go"], "voters": ["v1"]})).await;
    assert!(out.contains("result arrives as a message"), "{out}");
    settle(&mgr).await;
    let vid = mgr.read_chat(&root, |c| c.swarm.votes.back().unwrap().id.clone());
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_CAST_VOTE, json!({"vote_id": vid, "option": "maybe"})).await;
    assert!(err && out.contains("Pick one of"), "{out}");
    let (out, err) = tool(&mgr, &env, &t[3], channels::TOOL_CAST_VOTE, json!({"vote_id": vid, "option": "Go"})).await;
    assert!(err && out.contains("not a voter"), "{out}");
    let (out, _) = tool(&mgr, &env, &t[0], channels::TOOL_CAST_VOTE, json!({"vote_id": vid, "option": "rust"})).await;
    assert!(out.contains("Everyone has voted"), "{out}");
    assert!(mgr.read_chat(&root, |c| c.swarm.votes.back().unwrap().status != "open"));
}

#[tokio::test]
async fn debates_run_rounds_until_they_converge_or_hit_the_limit() {
    let (mgr, _s, app, env) = setup();
    let t = team(&mgr, &env, &[("mod", "ok"), ("pro", "ok stance=yes"), ("con", "ok stance=no->yes"), ("stub", "ok stance=no")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh", "patterns": ["debate"], "maxRounds": 3}));
    // con changes its mind in round 2: converged after 2 rounds.
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_DEBATE, json!({"topic": "ship it?", "participants": ["pro", "con"]})).await;
    assert!(!err && out.contains("They agree after 2 rounds"), "{out}");
    let d = mgr.read_chat(&root, |c| c.swarm.debates[0].clone());
    assert_eq!((d.status.as_str(), d.round, d.turns.len()), ("converged", 2, 4));
    assert_eq!(d.turns[1].stance, "no");
    assert_eq!(d.turns[3].stance, "yes");
    settle(&mgr).await;
    // pro and stub never agree: runs all 3 rounds; round 2 shows each the other's position.
    let (out, _) = tool(&mgr, &env, &t[0], channels::TOOL_DEBATE, json!({"topic": "rewrite?", "participants": ["pro", "stub"], "rounds": 9})).await;
    assert!(out.contains("No agreement after 3 rounds"), "rounds capped by maxRounds: {out}");
    let d = mgr.read_chat(&root, |c| c.swarm.debates[1].clone());
    assert_eq!((d.status.as_str(), d.turns.len()), ("split", 6));
    settle(&mgr).await;
    let prompts: Vec<String> = _s.requests.lock().unwrap().iter().map(|r| r.0.clone()).filter(|p| p.contains("rewrite?") && p.contains("round 2/3")).collect();
    assert!(prompts.iter().any(|p| p.contains("latest positions") && p.contains("POSITION: no")), "{prompts:?}");
    assert!(app.named("subagent.swarm_debate_round").len() >= 5);
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_DEBATE, json!({"topic": "x", "participants": ["pro"]})).await;
    assert!(err && out.contains("at least two"), "{out}");
}

#[tokio::test]
async fn leader_election_by_rank_and_by_vote() {
    let (mgr, _s, app, env) = setup();
    let t = team(&mgr, &env, &[("e1", "ok vote=e3"), ("e2", "ok vote=e3"), ("e3", "ok vote=e3")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "swarm"}));
    // Rank: the oldest of equals wins; a lead outranks everyone.
    let (out, err) = tool(&mgr, &env, &t[1], channels::TOOL_ELECT, json!({"method": "rank"})).await;
    assert!(!err && out.contains("e1 is the coordinator for term 1"), "{out}");
    mgr.update(&t[2].id, |r| r.comms_role = Some("lead".into()));
    let (out, _) = tool(&mgr, &env, &t[1], channels::TOOL_ELECT, json!({"method": "rank"})).await;
    assert!(out.contains("e3 is the coordinator for term 2") && out.contains("already leads"), "{out}");
    mgr.update(&t[2].id, |r| r.comms_role = None);
    // Vote: everyone votes e3; e3 wins term 3, everyone is told, e3 now leads.
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_ELECT, json!({"method": "vote"})).await;
    assert!(!err && out.contains("e3 is the coordinator for term 3") && out.contains("won the vote"), "{out}");
    let (coord, term) = mgr.read_chat(&root, |c| (c.swarm.coordinator.clone(), c.swarm.term));
    assert_eq!((coord.as_deref(), term), (Some(t[2].id.as_str()), 3));
    assert!(mgr.is_lead(&mgr.get(&t[2].id).unwrap()));
    assert!(mgr.get(&t[1].id).unwrap().inbox.iter().any(|m| m.contains("term 3") && m.contains("e3 is now")));
    settle(&mgr).await;
    // The coordinator appears in agents' prompts.
    let sys = mgr.team_prompt(&mgr.get(&t[0].id).unwrap());
    assert!(sys.contains("elected coordinator is e3"), "{sys}");
    assert_eq!(app.named("subagent.swarm_election").len(), 4, "3 results + 1 voting start");
}

#[tokio::test]
async fn app_api_swarm_state_timeline_and_stop_all() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("a", "ok"), ("b", "ok")]).await;
    let app = |req: Value| mgr.handle_app_request(&req, &env, None);
    let cfg = app(json!({"action": "commsConfig", "sessionKey": "chat-1"})).unwrap();
    assert_eq!(cfg["effective"]["topology"], "tree");
    assert_eq!(cfg["topologies"].as_array().unwrap().len(), 9);
    assert_eq!(cfg["defaultPatterns"]["swarm"].as_array().unwrap().len(), 11);
    let cfg = app(json!({"action": "setCommsConfig", "sessionKey": "chat-1", "patch": {"topology": "mesh", "maxRounds": 99}})).unwrap();
    assert_eq!(cfg["effective"]["topology"], "mesh");
    assert_eq!(cfg["rejected"], json!(["maxRounds"]));
    assert!(app(json!({"action": "setCommsConfig", "patch": {"topology": "blob"}})).is_err());
    // Settings page edits the defaults.
    app(json!({"action": "setCommsConfig", "sessionKey": "*", "patch": {"maxHops": 6}})).unwrap();
    assert_eq!(app(json!({"action": "commsConfig", "sessionKey": "chat-1"})).unwrap()["effective"]["maxHops"], 6);
    let cfg = app(json!({"action": "applyCommsPreset", "sessionKey": "chat-1", "name": "open-swarm"})).unwrap();
    assert_eq!(cfg["effective"]["topology"], "swarm");
    app(json!({"action": "saveCommsPreset", "name": "mine", "config": {"topology": "chain"}})).unwrap();
    assert!(app(json!({"action": "commsPresets"})).unwrap()["presets"].as_array().unwrap().iter().any(|p| p["name"] == "mine"));
    app(json!({"action": "deleteCommsPreset", "name": "mine"})).unwrap();
    // Role and per-agent topology.
    let r = app(json!({"action": "setCommsRole", "id": t[0].id, "role": "leader", "topology": "star", "canBroadcast": false})).unwrap();
    assert_eq!((r["subagent"]["commsRole"].as_str(), r["subagent"]["topology"].as_str(), r["subagent"]["canBroadcast"].as_bool()), (Some("lead"), Some("star"), Some(false)));
    assert!(app(json!({"action": "setCommsRole", "id": t[0].id, "topology": "blob"})).is_err());
    // An unknown role is refused, not silently cleared to member.
    assert!(app(json!({"action": "setCommsRole", "id": t[0].id, "role": "observer"})).unwrap_err().contains("`role` must be one of"));
    assert_eq!(mgr.get(&t[0].id).unwrap().comms_role.as_deref(), Some("lead"));
    app(json!({"action": "setCommsRole", "id": t[0].id, "topology": "", "canBroadcast": null})).unwrap();
    // Topics from the app, user subscriptions, then agent activity.
    app(json!({"action": "topicCreate", "topic": "Design Notes"})).unwrap();
    app(json!({"action": "topicSubscribe", "topic": "design-notes", "id": t[1].id})).unwrap();
    let a = mgr.get(&t[0].id).unwrap();
    tool(&mgr, &env, &a, channels::TOOL_PUBLISH, json!({"topic": "design-notes", "message": "use SVG"})).await;
    tool(&mgr, &env, &a, channels::TOOL_BB_WRITE, json!({"key": "k", "value": "v"})).await;
    tool(&mgr, &env, &a, channels::TOOL_BROADCAST_TEAM, json!({"message": "all hands"})).await;
    let s = app(json!({"action": "swarmState", "sessionKey": "chat-1"})).unwrap();
    assert_eq!(s["topics"][0]["name"], "design-notes");
    assert_eq!(s["topics"][0]["subscribers"], json!([t[1].id]));
    assert_eq!(s["blackboard"][0]["key"], "k");
    assert_eq!(s["topologyEdges"].as_array().unwrap().len(), 2, "swarm: both directions");
    let g = app(json!({"action": "graph", "sessionKey": "chat-1"})).unwrap();
    assert_eq!(g["swarm"]["topology"], "swarm");
    assert!(g["nodes"].as_array().unwrap().iter().any(|n| n["commsRole"] == "lead"));
    // The comms timeline lists the swarm events.
    let c = app(json!({"action": "comms", "sessionKey": "chat-1"})).unwrap();
    let kinds: Vec<String> = c["messages"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap_or("").to_string()).collect();
    for k in ["topic_post", "blackboard", "team_broadcast"] {
        assert!(kinds.iter().any(|x| x == k), "{k} in {kinds:?}");
    }
    // Stop all: pauses the chat's comms and stops its running agents.
    let r = mgr.spawn(0, spec("sleep:3000"), &env).unwrap();
    let out = app(json!({"action": "commsStopAll", "sessionKey": "chat-1"})).unwrap();
    assert_eq!(out["stopped"], json!([r.id]));
    assert_eq!(app(json!({"action": "commsConfig"})).unwrap()["effective"]["paused"], true);
    settle(&mgr).await;
}

#[tokio::test]
async fn batch_hub_and_topology_apply_to_every_agent() {
    let (mgr, _s, _a, env) = setup();
    let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"tasks": [{"name": "boss", "task": "ok"}, {"name": "w1", "task": "ok"}, {"name": "w2", "task": "ok"}], "topology": "star", "hub": "boss"}), &env).await;
    assert!(!err, "{out}");
    let recs = mgr.list();
    let boss = recs.iter().find(|r| r.name == "boss").unwrap();
    let w1 = recs.iter().find(|r| r.name == "w1").unwrap();
    assert_eq!(boss.comms_role.as_deref(), Some("hub"));
    assert_eq!(w1.topology.as_deref(), Some("star"));
    assert_eq!(names(&mgr, w1), vec!["boss"]);
    assert_eq!(names(&mgr, boss), vec!["w1", "w2"]);
    let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"tasks": [{"task": "ok"}, {"task": "ok"}], "hub": 7}), &env).await;
    assert!(err && out.contains("`hub` must be"), "{out}");
    let (_, err) = run_tool(&mgr, TOOL_SPAWN, json!({"tasks": [{"name": "l", "task": "ok"}, {"task": "ok"}], "hub": 0, "topology": "hierarchical"}), &env).await;
    assert!(!err);
    assert_eq!(mgr.list().iter().find(|r| r.name == "l").unwrap().comms_role.as_deref(), Some("lead"));
    settle(&mgr).await;
}

#[tokio::test]
async fn coordination_state_auto_compacts_into_digests_the_user_can_tune() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("pub", "ok"), ("late", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    let app = |req: Value| mgr.handle_app_request(&req, &env, None);
    // Out-of-range thresholds are refused; valid ones apply per chat.
    let r = app(json!({"action": "setCommsConfig", "sessionKey": "chat-1", "patch": {"topology": "bus", "compactKeep": 1, "compactAt": 99}})).unwrap();
    assert_eq!(r["rejected"], json!(["compactAt", "compactKeep"]));
    app(json!({"action": "setCommsConfig", "sessionKey": "chat-1", "patch": {"compactKeep": 3, "compactAt": 6}})).unwrap();
    for i in 0..10 {
        tool(&mgr, &env, &t[0], channels::TOOL_PUBLISH, json!({"topic": "log", "message": format!("finding {i}")})).await;
    }
    let (posts, digest) = mgr.read_chat(&root, |c| {
        let t = &c.topics["log"];
        (t.posts.iter().map(|p| p.text.clone()).collect::<Vec<_>>(), t.digest.clone())
    });
    assert!(posts.len() <= 6 && posts.len() >= 3, "{posts:?}");
    assert_eq!(posts.last().unwrap(), "finding 9", "newest stays verbatim");
    assert_eq!(digest.count as usize + posts.len(), 10, "nothing dropped silently");
    assert!(digest.gist.iter().any(|g| g.contains("pub: finding 0")), "{:?}", digest.gist);
    // Agents see that older posts were compacted.
    let (out, _) = tool(&mgr, &env, &t[1], channels::TOOL_LIST_TOPICS, json!({})).await;
    assert!(out.contains("older compacted"), "{out}");
    // The app shows the state and the policy.
    let s = app(json!({"action": "swarmState", "sessionKey": "chat-1"})).unwrap();
    assert_eq!(s["compaction"]["policy"]["keep"], 3);
    assert_eq!(s["compaction"]["policy"]["at"], 6);
    assert!(s["compaction"]["runs"].as_u64().unwrap() >= 1);
    assert_eq!(s["compaction"]["folded"]["topics"].as_u64().unwrap(), digest.count);
    assert!(s["topics"][0]["digest"]["count"].as_u64().unwrap() > 0);
    // Turned off: histories grow verbatim again.
    app(json!({"action": "setCommsConfig", "sessionKey": "chat-1", "patch": {"compact": false}})).unwrap();
    for i in 10..20 {
        tool(&mgr, &env, &t[0], channels::TOOL_PUBLISH, json!({"topic": "log", "message": format!("finding {i}")})).await;
    }
    assert_eq!(mgr.read_chat(&root, |c| c.topics["log"].digest.count), digest.count, "off: no new folding");
}

/// The Explorer's swarm layer reads these exact fields from the real engine (not the mock):
/// nodes[].commsRole, swarm.{topology, topologyEdges[].from/to, rules[].from/to/allow/both,
/// handoffs[].fromId/toId/at, topics[].name/subscribers/total, coordinator, term}. With
/// SWARM_UI_FIXTURE=<path> it also writes the engine's answers so the UI suite can render them.
#[tokio::test]
async fn real_engine_swarm_snapshot_feeds_the_explorer() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("scout", "ok"), ("writer", "ok"), ("checker", "ok"), ("editor", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "swarm"}));
    // A real handoff (triage hands its task to writer).
    let (out, err) = run_tool(&mgr, TOOL_SPAWN, json!({"name": "triage", "task": "team:handoff_to_peer {\"to\":\"writer\",\"note\":\"needs a writer\"}"}), &env).await;
    assert!(!err, "{out}");
    settle(&mgr).await;
    let app = |req: Value| mgr.handle_app_request(&req, &env, None);
    app(json!({"action": "setCommsRole", "id": t[1].id, "role": "lead"})).unwrap();
    // Rank election while the swarm allows it: the lead (writer) wins.
    let (out, err) = tool(&mgr, &env, &mgr.get(&t[2].id).unwrap(), channels::TOOL_ELECT, json!({"method": "rank"})).await;
    assert!(!err && out.contains("writer is the coordinator"), "{out}");
    settle(&mgr).await;
    app(json!({"action": "setCommsRole", "id": t[0].id, "role": "hub"})).unwrap();
    app(json!({"action": "setCommsConfig", "sessionKey": "chat-1", "patch": {"topology": "hierarchical", "edges": [
        {"from": "scout", "to": "editor", "allow": false},
        {"from": "writer", "to": "checker", "allow": true, "both": true}]}})).unwrap();
    app(json!({"action": "topicCreate", "topic": "research"})).unwrap();
    for r in &t[..3] {
        app(json!({"action": "topicSubscribe", "topic": "research", "id": r.id})).unwrap();
    }
    let scout = mgr.get(&t[0].id).unwrap();
    tool(&mgr, &env, &scout, channels::TOOL_PUBLISH, json!({"topic": "research", "message": "three sources found"})).await;
    settle(&mgr).await;

    // A mark written then reinforced: its strength is above 1 (each write adds 1).
    app(json!({"action": "blackboardWrite", "sessionKey": "chat-1", "key": "plan", "value": "draft"})).unwrap();
    app(json!({"action": "blackboardWrite", "sessionKey": "chat-1", "key": "plan", "value": "final", "expectedVersion": 1})).unwrap();
    app(json!({"action": "blackboardWrite", "sessionKey": "chat-1", "key": "sources", "value": "3"})).unwrap();

    let g = app(json!({"action": "graph", "sessionKey": "chat-1"})).unwrap();
    let sw = &g["swarm"];
    assert_eq!(sw["topology"], "hierarchical");
    let st = app(json!({"action": "swarmState", "sessionKey": "chat-1"})).unwrap();
    let plan = st["blackboard"].as_array().unwrap().iter().find(|e| e["key"] == "plan").unwrap().clone();
    assert_eq!(plan["version"], 2);
    assert!(plan["weight"].as_f64().unwrap() > 1.5, "{plan}");
    assert!(g["nodes"].as_array().unwrap().iter().any(|n| n["id"] == t[1].id.as_str() && n["commsRole"] == "lead"), "{}", g["nodes"]);
    let rules = sw["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 2, "{rules:?}");
    assert!(rules.iter().any(|r| r["from"] == "scout" && r["to"] == "editor" && r["allow"] == false));
    assert!(rules.iter().any(|r| r["from"] == "writer" && r["to"] == "checker" && r["allow"] == true && r["both"] == true));
    let ho = sw["handoffs"].as_array().unwrap();
    assert_eq!(ho.len(), 1, "{ho:?}");
    assert_eq!(ho[0]["toId"], t[1].id.as_str());
    assert!(ho[0]["fromId"].as_str().is_some_and(|s| !s.is_empty()) && ho[0]["at"].is_number(), "{}", ho[0]);
    let topics = sw["topics"].as_array().unwrap();
    assert_eq!(topics[0]["name"], "research");
    assert_eq!(topics[0]["subscribers"].as_array().unwrap().len(), 3);
    assert!(topics[0]["total"].as_u64().unwrap_or(0) >= 1, "{}", topics[0]);
    assert_eq!(sw["coordinator"], t[1].id.as_str());
    assert!(sw["term"].as_u64().unwrap_or(0) >= 1);
    let te = sw["topologyEdges"].as_array().unwrap();
    assert!(!te.is_empty() && te.iter().all(|e| e["from"].is_string() && e["to"].is_string()), "{te:?}");

    if let Ok(path) = std::env::var("SWARM_UI_FIXTURE") {
        let fixture = json!({
            "list": app(json!({"action": "list"})).unwrap(),
            "graph": g,
            "swarmState": app(json!({"action": "swarmState", "sessionKey": "chat-1"})).unwrap(),
            "commsConfig": app(json!({"action": "commsConfig", "sessionKey": "chat-1"})).unwrap(),
            "comms": app(json!({"action": "comms", "sessionKey": "chat-1"})).unwrap(),
        });
        std::fs::write(&path, serde_json::to_string_pretty(&fixture).unwrap()).unwrap();
    }
}

#[tokio::test]
async fn list_peers_shows_a_peer_card_with_role_coordinator_and_topics() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("alpha", "ok"), ("beta", "ok"), ("gamma", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh"}));
    mgr.update(&t[1].id, |r| r.comms_role = Some("lead".into()));
    let beta = t[1].id.clone();
    mgr.with_chat(&root, |c| c.swarm.coordinator = Some(beta));
    let (_, err) = tool(&mgr, &env, &t[2], channels::TOOL_SUBSCRIBE, json!({"topic": "research"})).await;
    assert!(!err);
    let (out, err) = tool(&mgr, &env, &t[0], team::TOOL_LIST_PEERS, json!({})).await;
    assert!(!err, "{out}");
    let line = |name: &str| out.lines().find(|l| l.starts_with(&format!("- {} ", name))).unwrap_or_default().to_string();
    assert!(line("beta").contains("coordinator, role lead"), "{out}");
    assert!(line("gamma").contains("follows #research"), "{out}");
    assert!(!line("gamma").contains("coordinator") && !line("beta").contains("follows"), "{out}");
    assert!(line("beta").ends_with("you may message it"), "{out}");
}

#[tokio::test]
async fn stop_all_closes_open_auctions_and_votes() {
    let (mgr, _s, _a, env) = setup();
    let t = team(&mgr, &env, &[("chair", "ok"), ("v1", "ok nobid"), ("v2", "ok")]).await;
    let root = mgr.root_of(&t[0].session_key);
    mgr.set_comms_config(&root, &json!({"topology": "mesh", "patterns": ["auction", "vote", "direct"], "auctionPolicy": "manager"}));
    // Neither waits, so both stay open after the calls return.
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_ANNOUNCE, json!({"task": "write docs", "to": ["v2"]})).await;
    assert!(!err, "{out}");
    let (out, err) = tool(&mgr, &env, &t[0], channels::TOOL_CALL_VOTE, json!({"question": "Ship?", "options": ["yes", "no"], "voters": ["v1", "v2"]})).await;
    assert!(!err, "{out}");
    settle(&mgr).await;
    let open = |m: &Arc<SubagentManager>| m.read_chat(&root, |c| (c.swarm.auctions.iter().filter(|a| a.status == "open").count(), c.swarm.votes.iter().filter(|v| v.status == "open").count()));
    assert_eq!(open(&mgr), (1, 1));
    let app = |req: Value| mgr.handle_app_request(&req, &env, None);
    app(json!({"action": "commsStopAll", "sessionKey": t[0].session_key})).unwrap();
    assert_eq!(open(&mgr), (0, 0), "nothing reads as an open decision after Stop all");
    let s = app(json!({"action": "swarmState", "sessionKey": t[0].session_key})).unwrap();
    assert_eq!(s["auctions"][0]["status"], "cancelled");
    assert_eq!(s["votes"][0]["status"], "cancelled");
    assert!(s["votes"][0]["closedAt"].as_i64().is_some());
    settle(&mgr).await;
}
