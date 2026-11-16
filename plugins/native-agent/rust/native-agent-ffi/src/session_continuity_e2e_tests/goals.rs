//! Goal lifecycle, selective memory injection and the assembly audit,
//! end to end through `NativeAgentHandle::send_message` (the app's entry
//! point) against the mock provider: every turn is typed by the "user",
//! goal commands are detected on the turn they are made, the 7+7 window
//! summarizes turns 1-7 and 8-14, and each main request's memory block is
//! read from the body the provider received.

use super::*;

const KEY: &str = "chat-goals-e2e";

/// The turns of the scripted chat, in order (turn N is `SCRIPT[N - 1]`).
const SCRIPT: &[&str] = &[
    "New goal: build the payment page",                                   // 1  G001
    "Use the Stripe card form for payments",                              // 2  D1 (G001)
    "Add a task: write the checkout tests",                               // 3  task (G001)
    "The server port is 8742 (ORIG-T4)",                                  // 4  fact
    "What's the weather like in Dhaka today?",                            // 5  unrelated
    "Pause this and switch to fixing the login bug",                      // 6  G002, G001 paused
    "For login use the OAuth device flow and reproduce the login timeout", // 7  D2 + task (G002)
    "Change the server port to 9150",                                     // 8  fact supersedes
    "Go back to the payment page",                                        // 9  G001 resumed
    "Use Stripe Elements instead of the plain card form",                 // 10 D3 supersedes D1
    "The checkout tests are written now",                                 // 11 task done
    "Mark the goal as done",                                              // 12 G001 completed
    "New goal: migrate the database to Postgres",                         // 13 G003
    "Cancel the goal",                                                    // 14 G003 cancelled
    "Start a new goal: write the release notes",                          // 15 G004 (fold 1-7 runs)
    "Pause this and switch to updating the docs site",                    // 16 G005, G004 paused
    "Go back to the release notes",                                       // 17 G004 resumed
    "Read the payment notes file",                                        // 18 read_file -> R1
    "List the release notes sections",                                    // 19
    "Tell me a joke",                                                     // 20 unrelated
    "RECALL: what was the original server port?",                         // 21 recall_turns turn 4
    "How do I boil an egg?",                                              // 22 unrelated (fold 8-14 runs)
    "Why did we change the card form before? Compare the old and new choice", // 23 history
    "What was the plan for the login bug?",                               // 24 paused goal named
];

fn summary_turns(text: &str) -> Vec<u32> {
    text.split("### Turn ").skip(1).filter_map(|t| t.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).collect()
}

fn last_user_text(body: &serde_json::Value) -> (String, bool) {
    let msgs = body["messages"].as_array().cloned().unwrap_or_default();
    let Some(i) = msgs.iter().rposition(|m| m["role"] == "user") else { return (String::new(), false) };
    let tool_after = msgs[i..].iter().any(|m| m["role"] == "tool");
    (msgs[i]["content"].as_str().unwrap_or_default().to_string(), tool_after)
}

const BATCH_A: &str = r#"{"segments":[{"fromTurn":1,"toTurn":5,"topic":"payment","title":"payment page","summary":"Stripe card form, checkout tests, server port 8742"},{"fromTurn":6,"toTurn":7,"topic":"login","title":"login bug","summary":"OAuth device flow; login timeout to reproduce"}],
"decisions":{"current":[{"id":"N1","key":"card form","text":"Use the Stripe card form","turn":2},{"id":"N2","key":"login flow","text":"Login uses the OAuth device flow","turn":7}]},
"items":{"add":[{"kind":"fact","key":"server port","text":"server port 8742","turn":4},{"kind":"openItem","text":"write the checkout tests","turn":3},{"kind":"preference","text":"keep answers short","turn":1},{"kind":"openItem","text":"reproduce the login timeout","turn":7}]}}"#;

const BATCH_B: &str = r#"{"segments":[{"fromTurn":8,"toTurn":8,"topic":"server","title":"port change","summary":"server port moved to 9150"},{"fromTurn":9,"toTurn":12,"topic":"payment","title":"payment page finished","summary":"Stripe Elements replaces the card form; checkout tests written; goal done"},{"fromTurn":13,"toTurn":14,"topic":"database","title":"postgres migration","summary":"started and cancelled"}],
"decisions":{"current":[{"id":"D2"},{"id":"N3","key":"card form","text":"Use Stripe Elements for the card form","turn":10}],"superseded":[{"id":"D1","supersededBy":"N3","turn":10,"reason":"user switched to Stripe Elements"}]},
"items":{"add":[{"kind":"fact","key":"server port","text":"server port 9150","turn":8,"supersedes":"F1","reason":"port changed"}],"close":[{"id":"O2","status":"done","turn":11,"reason":"checkout tests written"}]}}"#;

/// Overflow errors still to return for the "OVERFLOW:" turn (no numbers in
/// them, so recovery shrinks from what was sent).
static OVERFLOWS_LEFT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn goals_responder(body: &serde_json::Value) -> (Option<(String, String)>, String) {
    let text = body["messages"].to_string();
    if text.contains("long-term memory of a chat") {
        let turns = summary_turns(&text);
        let answer = match turns.iter().min() {
            Some(1) => BATCH_A.to_string(),
            Some(8) => BATCH_B.to_string(),
            _ => {
                let (from, to) = (turns.iter().min().copied().unwrap_or(1), turns.iter().max().copied().unwrap_or(1));
                format!("{{\"segments\":[{{\"fromTurn\":{from},\"toTurn\":{to},\"topic\":\"misc\",\"title\":\"t\",\"summary\":\"turns {from}-{to}\"}}],\"decisions\":{{\"current\":[]}}}}")
            }
        };
        return (None, answer);
    }
    if text.contains("You are a recall sub-agent") {
        return (None, format!("RECALLED saw_original={}", text.contains("ORIG-T4")));
    }
    let (user, tool_after) = last_user_text(body);
    if user.starts_with("OVERFLOW:") && OVERFLOWS_LEFT.load(std::sync::atomic::Ordering::SeqCst) > 0 {
        OVERFLOWS_LEFT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        return (Some(("__http_error__".into(), BARE_OVERFLOW_BODY.to_string())), String::new());
    }
    if !tool_after && user.starts_with("Read the payment notes") {
        return (Some(("read_file".into(), r#"{"path":"payment-notes.txt"}"#.into())), String::new());
    }
    if !tool_after && user.starts_with("RECALL:") {
        return (Some(("recall_turns".into(), r#"{"from_turn":4,"to_turn":4,"question":"what was the original server port?"}"#.into())), String::new());
    }
    (None, if tool_after { "MAIN-GOT tool".into() } else { "MAIN-OK".into() })
}

/// One turn through the handle: approves any tool, returns its events.
fn run_turn(handle: &NativeAgentHandle, events: &std_mpsc::Receiver<(String, String)>, prompt: &str) -> Vec<(String, String)> {
    ask(handle, KEY, prompt);
    let mut seen = Vec::new();
    loop {
        let (event, payload) = events.recv_timeout(Duration::from_secs(30)).expect("turn must finish");
        if event == "approval_request" {
            let p: serde_json::Value = serde_json::from_str(&payload).unwrap();
            handle.respond_to_approval(p["toolCallId"].as_str().unwrap().into(), true, None).unwrap();
        }
        if event == "agent.error" {
            panic!("turn {prompt:?} failed: {payload}");
        }
        let done = event == "agent.completed";
        seen.push((event, payload));
        if done {
            return seen;
        }
    }
}

fn statuses(st: &turn_memory::goals::GoalState) -> Vec<(String, String)> {
    st.goals.iter().map(|g| (g.goal_id.clone(), g.status.clone())).collect()
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

/// The memory block of a main request body (empty when none).
fn memory_block(body: &serde_json::Value) -> String {
    body["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).filter(|c| c.contains("native-agent-turn-memory-v1") && c.contains("Conversation memory")).last().unwrap_or_default().to_string()
}

fn is_main(body: &serde_json::Value) -> bool {
    let t = body["messages"].to_string();
    !t.contains("long-term memory of a chat") && !t.contains("You are a recall sub-agent")
}

#[test]
fn goal_lifecycle_selective_memory_and_audit_through_the_agent_loop() {
    let config = sandbox("goals-e2e");
    std::fs::write(std::path::Path::new(&config.workspace_path).join("payment-notes.txt"), "PAYMENT-NOTES line\n".repeat(200)).unwrap();
    // Retention would prune an unreferenced result at once if it ran on its
    // own; with the default (no automatic pruning) nothing goes.
    turn_memory::save_settings(&config.workspace_path, &serde_json::json!({"keepUnreferencedResultDays": 0}));
    let (base, requests) = spawn_mock_provider_with(MockProviderScript { response_model: None, first_response_tool_call: None, responder: Some(goals_responder) });
    let (handle, events) = launch(config.clone(), &base);
    let conn = db::open_db(&config.db_path).unwrap();
    let state = || turn_memory::goals::load_state(&conn, KEY);

    let mut all_events: Vec<(String, String)> = Vec::new();
    let mut bodies_by_turn: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut current_by_turn: Vec<Option<String>> = Vec::new();
    for (i, prompt) in SCRIPT.iter().enumerate() {
        let seen = run_turn(&handle, &events, prompt);
        let mut bodies = Vec::new();
        while let Ok(b) = requests.recv_timeout(Duration::from_millis(150)) {
            bodies.push(b);
        }
        let st = state();
        // Never more than one active goal, after every turn.
        assert!(st.goals.iter().filter(|g| g.status == "active").count() <= 1, "turn {}: {:?}", i + 1, statuses(&st));
        current_by_turn.push(st.current_goal_id.clone());
        all_events.extend(seen);
        bodies_by_turn.push(bodies);
    }
    let cur = |turn: usize| current_by_turn[turn - 1].clone();
    let g = |s: &str| Some(s.to_string());

    // ── Goal lifecycle, one command per turn ───────────────────────────────
    assert_eq!(cur(1), g("G001"));
    assert_eq!((cur(2), cur(5)), (g("G001"), g("G001")), "unrelated talk keeps the goal");
    assert_eq!(cur(6), g("G002"));
    assert_eq!(cur(9), g("G001"), "resuming keeps the same ID");
    assert_eq!((cur(10), cur(11)), (g("G001"), g("G001")));
    assert_eq!(cur(12), None, "completed: no current goal");
    assert_eq!(cur(13), g("G003"));
    assert_eq!(cur(14), None);
    assert_eq!(cur(15), g("G004"));
    assert_eq!(cur(16), g("G005"));
    assert_eq!(cur(17), g("G004"));
    for t in 18..=24 {
        assert_eq!(cur(t), g("G004"), "turn {t} does not change the goal");
    }
    let st = state();
    assert_eq!(statuses(&st), pairs(&[("G001", "completed"), ("G002", "paused"), ("G003", "cancelled"), ("G004", "active"), ("G005", "paused")]));
    let g1 = st.get("G001").unwrap();
    assert!(g1.completed_at.is_some(), "completed_at set");
    assert_eq!(g1.title, "build the payment page");
    let g3 = st.get("G003").unwrap();
    assert!(g3.completed_at.is_none(), "cancelled is not completed");
    // History kept: every command is an event, none voided.
    let events_n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_goal_events WHERE session_key = ?1 AND voided_at IS NULL", [KEY], |r| r.get(0)).unwrap();
    assert_eq!(events_n, 9, "one event per command (switch = create, the pause is implied)");
    let resumed: i64 = conn.query_row("SELECT COUNT(*) FROM memory_goal_events WHERE session_key = ?1 AND goal_id = 'G001' AND op = 'resume'", [KEY], |r| r.get(0)).unwrap();
    assert_eq!(resumed, 1);
    let goal_events: Vec<serde_json::Value> = all_events.iter().filter(|(e, _)| e == "memory.goals").map(|(_, p)| serde_json::from_str(p).unwrap()).collect();
    assert_eq!(goal_events.len(), 9, "memory.goals emitted for each applied command");

    // ── 7+7 rolling compaction, exactly as before ──────────────────────────
    let updated: Vec<serde_json::Value> = all_events.iter().filter(|(e, _)| e == "memory.updated").map(|(_, p)| serde_json::from_str(p).unwrap()).collect();
    let ranges: Vec<(u64, u64)> = updated.iter().map(|u| (u["fromTurn"].as_u64().unwrap(), u["toTurn"].as_u64().unwrap())).collect();
    assert_eq!(ranges, vec![(1, 7), (8, 14)], "one batch of 7 at turn 15, the next at turn 22");
    let all_bodies: Vec<&serde_json::Value> = bodies_by_turn.iter().flatten().collect();
    let summarized: Vec<Vec<u32>> = all_bodies.iter().map(|b| b["messages"].to_string()).filter(|t| t.contains("long-term memory of a chat")).map(|t| summary_turns(&t)).collect();
    assert_eq!(summarized.len(), 2, "each turn summarized once, never again: {summarized:?}");
    assert_eq!(summarized[0], (1..=7).collect::<Vec<_>>());
    assert_eq!(summarized[1], (8..=14).collect::<Vec<_>>());
    let mem = turn_memory::load_memory(&conn, KEY);
    assert_eq!((mem.through_turn, mem.version), (14, 2));
    assert_eq!(turn_memory::list_versions(&conn, KEY).len(), 2);
    let segs: Vec<(u32, u32, &str)> = mem.segments.iter().map(|s| (s.from_turn, s.to_turn, s.topic.as_str())).collect();
    assert_eq!(segs, vec![(1, 5, "payment"), (6, 7, "login"), (8, 8, "server"), (9, 12, "payment"), (13, 14, "database")]);
    assert!(mem.segments.iter().all(|s| !s.title.is_empty() && !s.summary.is_empty()));
    // Turn 22's main request: memory block, then turns 15-22 verbatim.
    let main22: Vec<&serde_json::Value> = bodies_by_turn[21].iter().filter(|b| is_main(b)).collect();
    let t22 = main22[0]["messages"].to_string();
    assert!(t22.contains("Turns 1-14") || t22.contains("turns 1-14") || memory_block(main22[0]).contains("14"), "block covers 1-14");
    assert!(t22.contains(SCRIPT[14]) && t22.contains(SCRIPT[20]), "turns 15-21 verbatim");
    assert!(!t22.contains("ORIG-T4") && !t22.contains(SCRIPT[9]), "folded turns are not sent verbatim");

    // ── Originals stay: archive, transcript, recall, stored results ───────
    assert_eq!(turn_memory::load_turns(&conn, KEY, 1, 14).len(), 14, "every folded turn archived");
    let stored = serde_json::to_string(&db::load_session_messages_raw(&conn, KEY).unwrap()).unwrap();
    assert!(stored.contains("ORIG-T4") && stored.contains(SCRIPT[0]) && !stored.contains("native-agent-turn-memory-v1"));
    let recall = all_events.iter().find(|(e, p)| e == "tool_result" && p.contains("RECALLED")).expect("recall result");
    assert!(recall.1.contains("saw_original=true"), "recall read the archived turn 4: {}", recall.1);
    let r1 = turn_memory::load_result(&conn, KEY, "R1").expect("R1 stored at turn 18");
    assert!(r1.content.contains("PAYMENT-NOTES"));
    assert_eq!(r1.turn, Some(18));
    let live = turn_memory::list_results(&conn, KEY);
    assert!(live["results"].to_string().contains("\"R1\""), "no automatic pruning after six more turns: {live}");
    let shown: serde_json::Value = serde_json::from_str(&handle.subagents(format!(r#"{{"action":"memory.result","sessionKey":"{KEY}","resultId":"R1"}}"#)).unwrap()).unwrap();
    assert_ne!(shown["unavailable"], true, "{shown}");

    // ── Decisions and tasks linked to the goal of their turn ──────────────
    let dec = |id: &str| mem.decisions.current.iter().chain(mem.decisions.superseded.iter()).find(|d| d.id == id).cloned().unwrap_or_else(|| panic!("{id} missing: {:?}", mem.decisions));
    assert_eq!(dec("D1").goal_id.as_deref(), Some("G001"), "superseded keeps its goal");
    assert_eq!(dec("D1").superseded_by.as_deref(), Some("D3"));
    assert_eq!(dec("D2").goal_id.as_deref(), Some("G002"));
    assert_eq!(dec("D3").goal_id.as_deref(), Some("G001"));
    let task = |text: &str| mem.items.iter().find(|i| i.text == text).cloned().unwrap();
    let checkout = task("write the checkout tests");
    assert_eq!((checkout.goal_id.as_deref(), checkout.status.as_str()), (Some("G001"), "done"));
    let timeout = task("reproduce the login timeout");
    assert_eq!((timeout.goal_id.as_deref(), timeout.status.as_str()), (Some("G002"), "current"), "a paused goal's task stays pending");
    assert_eq!(task("server port 8742").status, "superseded");

    // ── Selective injection ───────────────────────────────────────────────
    let block_of = |turn: usize| -> String {
        let mains: Vec<&serde_json::Value> = bodies_by_turn[turn - 1].iter().filter(|b| is_main(b)).collect();
        memory_block(mains[0])
    };
    // 22, unrelated: the active goal, not all history.
    let b22 = block_of(22);
    assert!(b22.contains("Current goal: G004 [active") && b22.contains("write the release notes"), "{b22}");
    assert!(!b22.contains("[SUPERSEDED"), "no replaced decision by default: {b22}");
    assert!(!b22.contains("Use the Stripe card form"), "{b22}");
    // Unrelated segments are left out; only the newest one bridges to the
    // verbatim turns (source "newest_segment").
    assert!(!b22.contains("[login]") && !b22.contains("[payment]") && !b22.contains("[server]"), "unrelated segments left out: {b22}");
    assert!(b22.contains("- Turns 13-14 [database]"), "{b22}");
    assert!(b22.contains("Not shown here") && b22.contains("D1"), "what is left out is listed by ID: {b22}");
    assert!(b22.contains("keep answers short"), "preferences always");
    // 23, a historical comparison: the replaced decision with its link.
    let b23 = block_of(23);
    assert!(b23.contains("- D1 [SUPERSEDED by D3 at turn 10; made turn 2; G001] Use the Stripe card form"), "{b23}");
    assert!(b23.contains("Current goal: G004 [active"));
    // 24, a paused goal named by its words: that goal and its records.
    let b24 = block_of(24);
    assert!(b24.contains("- G002 [paused") && b24.contains("Login uses the OAuth device flow") && b24.contains("reproduce the login timeout"), "{b24}");
    assert!(!b24.contains("[SUPERSEDED"), "{b24}");
    assert!(b24.contains("Current goal: G004 [active"), "a named paused goal is not made current");
    // Before the first summary the block holds only the goals.
    let b3 = block_of(3);
    assert!(b3.contains("Current goal: G001 [active") && b3.contains("No turns are summarized yet"), "{b3}");

    // ── Audit: one row per main request, the same as its event ────────────
    let assembly: Vec<serde_json::Value> = all_events.iter().filter(|(e, _)| e == "context.assembly").map(|(_, p)| serde_json::from_str(p).unwrap()).collect();
    let mains_n = all_bodies.iter().filter(|b| is_main(b)).count();
    assert_eq!(assembly.len(), mains_n, "one context.assembly per main model request");
    let rows = turn_memory::audit::recent(&conn, KEY, 1000);
    assert_eq!(rows.len(), assembly.len(), "one audit row per request");
    for ev in &assembly {
        let id = ev["assemblyId"].as_str().unwrap();
        let row = rows.iter().find(|r| r.assembly_id == id).unwrap_or_else(|| panic!("no row for {id}"));
        assert_eq!(turn_memory::audit::event_fields(row), ev["audit"], "row == event");
        assert_eq!(row.estimated_input_tokens as u64, ev["estimatedInputTokens"].as_u64().unwrap());
        assert!(row.estimated_input_tokens <= row.input_token_budget, "token budget respected");
    }
    // Turn 22's row names exactly what its block holds.
    let ev22 = assembly.iter().find(|e| e["audit"]["summaryThroughTurn"] == 14 && e["audit"]["includedRecentTurns"].as_array().map(|a| a.last() == Some(&serde_json::json!(22))).unwrap_or(false)).expect("turn 22 row");
    let a = &ev22["audit"];
    assert_eq!(a["includedRecentTurns"], serde_json::json!((15..=22).collect::<Vec<u32>>()));
    assert_eq!(a["memoryVersion"], 2);
    assert!(a["includedGoalIds"].as_array().unwrap().contains(&serde_json::json!("G004")));
    for list in ["includedGoalIds", "includedDecisionIds", "includedTaskIds", "includedMemoryIds"] {
        for id in a[list].as_array().unwrap() {
            assert!(b22.contains(&format!("{} [", id.as_str().unwrap())), "{list} {id} is in the block: {b22}");
        }
    }
    assert!(!a["includedDecisionIds"].as_array().unwrap().contains(&serde_json::json!("D1")));
    assert!(a["compactionActions"].as_array().unwrap().contains(&serde_json::json!("memory_fold:turns_1-14")));
    let ev23 = assembly.iter().filter(|e| e["audit"]["includedRecentTurns"].as_array().map(|a| a.last() == Some(&serde_json::json!(23))).unwrap_or(false)).next().expect("turn 23 row");
    assert!(ev23["audit"]["includedDecisionIds"].as_array().unwrap().contains(&serde_json::json!("D1")));
    assert!(ev23["audit"]["retrievalSources"].as_array().unwrap().contains(&serde_json::json!("history")));

    // ── memory.get (the Memory screen's bridge) ─────────────────────────────
    let got: serde_json::Value = serde_json::from_str(&handle.subagents(format!(r#"{{"action":"memory.get","sessionKey":"{KEY}"}}"#)).unwrap()).unwrap();
    assert_eq!(got["goals"]["currentGoalId"], "G004");
    let listed: Vec<(String, String)> = got["goals"]["goals"].as_array().unwrap().iter().map(|g| (g["goalId"].as_str().unwrap().into(), g["status"].as_str().unwrap().into())).collect();
    assert_eq!(listed, statuses(&st));
    assert_eq!(got["goals"]["events"].as_array().unwrap().len(), 9);
    assert_eq!(got["goals"]["events"][0]["goalId"], "G004", "newest first");
    assert!(got["goals"]["goals"][0]["completedAt"].is_i64());
    let audit = got["audit"].as_array().unwrap();
    assert_eq!(audit.len(), 20, "the newest 20 assemblies");
    assert_eq!(audit[0], assembly.last().unwrap()["audit"], "newest first, the same record as the event");
    assert_eq!(got["memory"]["decisions"]["superseded"][0]["goalId"], "G001");

    // ── Overflow recovery with a selected memory block ─────────────────────
    // A history question pulls many optional records in; the provider then
    // rejects the request once. The retry drops optional memory first and
    // keeps the essential part (current goal, preferences, the prompt).
    OVERFLOWS_LEFT.store(1, std::sync::atomic::Ordering::SeqCst);
    let prompt = "OVERFLOW: compare the history of the payment page, the login bug, the postgres database and the server port decisions";
    let seen = run_turn(&handle, &events, prompt);
    let mut mains = Vec::new();
    while let Ok(b) = requests.recv_timeout(Duration::from_millis(300)) {
        if is_main(&b) { mains.push(b); }
    }
    assert_eq!(mains.len(), 2, "one rejected request, one smaller retry");
    assert_ne!(mains[0]["messages"], mains[1]["messages"], "never an identical resend");
    let size = |b: &serde_json::Value| b["messages"].to_string().len();
    assert!(size(&mains[1]) < size(&mains[0]), "{} vs {}", size(&mains[1]), size(&mains[0]));
    let (first, retry) = (memory_block(&mains[0]), memory_block(&mains[1]));
    assert!(first.contains("[SUPERSEDED") && first.contains("- G002 [paused"), "the history question selected optional records: {first}");
    assert!(retry.len() < first.len(), "the retry's memory block is smaller");
    assert!(retry.contains("Current goal: G004 [active") && retry.contains("keep answers short"), "essential memory kept: {retry}");
    assert_eq!(last_user_text(&mains[1]).0, prompt, "the user's prompt survives");
    let overflow: Vec<serde_json::Value> = seen.iter().filter(|(e, _)| e == "context.overflow").map(|(_, p)| serde_json::from_str(p).unwrap()).collect();
    assert_eq!(overflow.len(), 1);
    let asm: Vec<serde_json::Value> = seen.iter().filter(|(e, _)| e == "context.assembly").map(|(_, p)| serde_json::from_str(p).unwrap()).collect();
    assert_eq!(asm.len(), 2);
    let (a0, a1) = (&asm[0]["audit"], &asm[1]["audit"]);
    assert_eq!((a0["attempt"].as_u64(), a1["attempt"].as_u64()), (Some(0), Some(1)));
    assert!(a1["estimatedInputTokens"].as_u64() < a0["estimatedInputTokens"].as_u64());
    let ids = |a: &serde_json::Value| -> Vec<String> { ["includedGoalIds", "includedDecisionIds", "includedTaskIds", "includedMemoryIds", "includedSummarySegmentIds"].iter().flat_map(|k| a[*k].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string())).collect() };
    let (i0, i1) = (ids(a0), ids(a1));
    assert!(i1.len() < i0.len() && i1.iter().all(|id| i0.contains(id)), "retry selects a subset: {i0:?} -> {i1:?}");
    assert!(asm[1]["actions"].to_string().contains("memory_reselected") || a1["truncationActions"].to_string().contains("memory"), "{}", asm[1]);
    let rows = turn_memory::audit::recent(&conn, KEY, 1000);
    for ev in &asm {
        let row = rows.iter().find(|r| r.assembly_id == ev["assemblyId"].as_str().unwrap()).expect("a row for each attempt");
        assert_eq!(turn_memory::audit::event_fields(row), ev["audit"]);
    }
}
