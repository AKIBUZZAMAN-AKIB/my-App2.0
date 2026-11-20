//! Immutable, append-only turn-range summaries (Akib's rule, Nov 2026).
//!
//! Once turns a-b have a summary it is never edited, regenerated, merged or
//! re-versioned. The essentials (goal, decisions, facts) keep updating. The
//! prompt shows fewer summaries when the budget is tight, never shorter ones,
//! and every range keeps its original summary and its original turns.

use super::*;
use crate::turn_memory::goals::GoalState;
use crate::types::Message;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Mutex;

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    c
}

fn cnt(s: &str) -> usize {
    s.chars().count() / 4 + 1
}

struct Script<F: Fn(&str, &str) -> Result<String, String>> {
    f: F,
    calls: Mutex<u32>,
}

impl<F: Fn(&str, &str) -> Result<String, String>> TextModel for Script<F> {
    async fn complete(&self, system: &str, user: String, _max: u32) -> Result<String, String> {
        *self.calls.lock().unwrap() += 1;
        (self.f)(system, &user)
    }
}

fn new_turns(user: &str) -> Vec<u32> {
    let body = user.split("\nNEW ").nth(1).unwrap_or(user);
    let mut v: Vec<u32> = body.lines().filter_map(|l| l.strip_prefix("### Turn ")).filter_map(|r| r.split_whitespace().next()?.parse().ok()).collect();
    v.dedup();
    v
}

fn turns(n: u32) -> Vec<(u32, Vec<Message>)> {
    (1..=n).map(|i| (i, vec![Message::user(&format!("question {i}: the port for service {i} is {}", 8000 + i)), Message::assistant_text(&format!("answer {i}"))])).collect()
}

fn flat(t: &[(u32, Vec<Message>)]) -> Vec<Message> {
    t.iter().flat_map(|(_, m)| m.clone()).collect()
}

/// One segment for the whole new range, a new goal, and a new fact each batch
/// (the essentials keep updating).
fn answer(user: &str) -> String {
    let nt = new_turns(user);
    let (a, b) = (*nt.first().unwrap(), *nt.last().unwrap());
    json!({
        "goal": format!("goal as of turn {b}"),
        "segments": [{"fromTurn": a, "toTurn": b, "topic": format!("topic{a}"), "title": format!("turns {a}-{b}"), "summary": format!("ORIGINAL summary of {a}-{b}: ports {}..{}", 8000 + a, 8000 + b)}],
        "decisions": {"current": [], "superseded": []},
        "facts": [{"key": format!("port batch {b}"), "text": format!("batch ending {b} uses port {}", 8000 + b), "turn": b}]
    })
    .to_string()
}

async fn summarize_batch<M: TextModel>(model: &M, base: &TurnMemory, all: &[(u32, Vec<Message>)], from: u32, to: u32, now: i64) -> Result<SummarizeOutcome, String> {
    let ids = HashMap::new();
    let slice: Vec<(u32, Vec<Message>)> = all.iter().filter(|(n, _)| *n >= from && *n <= to).cloned().collect();
    let job = SummarizeJob { turns: &slice, from, to, input_limit: 120_000, max_output: 2_048, result_ids: &ids, now_ms: now, parts: None };
    summarize_range(model, base, &job, &cnt).await
}

fn archive_and_save(conn: &Connection, mem: &TurnMemory, all: &[(u32, Vec<Message>)], to: u32, now: i64) -> TurnMemory {
    let cur = load_memory(conn, "c");
    let upto: Vec<(u32, Vec<Message>)> = all.iter().filter(|(n, _)| *n <= to).cloned().collect();
    let msgs = flat(&upto);
    let split = split_turns(&msgs);
    save_version(conn, "c", cur.version, mem, "summary", &json!({}), Some(ArchiveTurns { messages: &msgs, turns: &split }), now).unwrap();
    load_memory(conn, "c")
}

fn seg_json(m: &TurnMemory, a: u32, b: u32) -> String {
    serde_json::to_string(m.segments.iter().find(|s| s.from_turn == a && s.to_turn == b).expect("segment")).unwrap()
}

async fn build(conn: &Connection, batches: &[(u32, u32)], all: &[(u32, Vec<Message>)]) -> Vec<TurnMemory> {
    let model = Script { f: |_: &str, u: &str| Ok(answer(u)), calls: Mutex::new(0) };
    let mut mem = load_memory(conn, "c");
    let mut history = Vec::new();
    for (i, (a, b)) in batches.iter().enumerate() {
        let out = summarize_batch(&model, &mem, all, *a, *b, 1_000 + i as i64).await.unwrap();
        mem = archive_and_save(conn, &out.memory, all, *b, 1_000 + i as i64);
        history.push(mem.clone());
    }
    history
}

#[tokio::test]
async fn summarizing_21_28_leaves_1_7_byte_identical_and_essentials_update() {
    let conn = db();
    let all = turns(28);
    let hist = build(&conn, &[(1, 7), (8, 14), (15, 20), (21, 28)], &all).await;
    let first = seg_json(&hist[0], 1, 7);
    for m in &hist {
        assert_eq!(seg_json(m, 1, 7), first, "the summary of 1-7 changed at version {}", m.version);
    }
    let last = hist.last().unwrap();
    assert_eq!(last.segments.len(), 4, "one segment per batch, none merged");
    let s17 = last.segments.iter().find(|s| s.from_turn == 1).unwrap();
    assert_eq!(s17.created_at, 1_000, "stamped once, when written");
    assert!(s17.summary.starts_with("ORIGINAL summary of 1-7"));
    // Essentials keep updating.
    assert_eq!(last.goal, "goal as of turn 28");
    assert!(last.facts.iter().any(|f| f.text.contains("8028")), "{:?}", last.facts);
    assert!(last.facts.iter().any(|f| f.text.contains("8007")), "{:?}", last.facts);
}

#[tokio::test]
async fn a_summarizer_answer_that_rewrites_an_old_range_is_refused() {
    let conn = db();
    let all = turns(28);
    let hist = build(&conn, &[(1, 7), (8, 20)], &all).await;
    let base = hist.last().unwrap().clone();
    // The batch may only use turns 21-28; one that also rewrites 1-7 fails
    // validation every time and nothing is saved.
    let bad = Script {
        f: |_: &str, u: &str| {
            let mut v: Value = serde_json::from_str(&answer(u)).unwrap();
            v["segments"].as_array_mut().unwrap().push(json!({"fromTurn": 1, "toTurn": 7, "topic": "x", "title": "x", "summary": "REWRITTEN"}));
            Ok(v.to_string())
        },
        calls: Mutex::new(0),
    };
    assert!(summarize_batch(&bad, &base, &all, 21, 28, 9).await.is_err());
    assert_eq!(seg_json(&load_memory(&conn, "c"), 1, 7), seg_json(&hist[0], 1, 7));
}

#[test]
fn the_gate_refuses_changed_merged_removed_or_overlapping_summaries() {
    let seg = |a: u32, b: u32, s: &str| Segment { from_turn: a, to_turn: b, topic: "t".into(), title: "t".into(), summary: s.into(), created_at: 5 };
    let prev = TurnMemory { through_turn: 14, segments: vec![seg(1, 7, "one"), seg(8, 14, "two")], ..Default::default() };
    let mut changed = prev.clone();
    changed.segments[0].summary = "one, shorter".into();
    assert!(check_segments_append_only(&prev, &changed).unwrap_err()[0].contains("changed"));
    let mut restamped = prev.clone();
    restamped.segments[0].created_at = 6;
    assert!(check_segments_append_only(&prev, &restamped).is_err(), "even the timestamp is immutable");
    let merged = TurnMemory { through_turn: 14, segments: vec![seg(1, 14, "one two")], ..Default::default() };
    assert!(check_segments_append_only(&prev, &merged).is_err());
    assert!(validate_transition(&prev, &merged, &[]).is_err());
    let mut overlap = prev.clone();
    overlap.through_turn = 20;
    overlap.segments.push(seg(14, 20, "three"));
    assert!(check_segments_append_only(&prev, &overlap).unwrap_err()[0].contains("overlaps"));
    let mut ok = prev.clone();
    ok.through_turn = 20;
    ok.segments.push(seg(15, 20, "three"));
    assert!(check_segments_append_only(&prev, &ok).is_ok());
}

#[tokio::test]
async fn many_batches_over_a_small_budget_never_modify_older_summaries_and_all_stay_recallable() {
    let conn = db();
    let all = turns(60);
    let batches: Vec<(u32, u32)> = (0..12).map(|i| (i * 5 + 1, i * 5 + 5)).collect();
    let hist = build(&conn, &batches, &all).await;
    let last = hist.last().unwrap().clone();
    assert_eq!(last.segments.len(), 12);
    for (i, (a, b)) in batches.iter().enumerate() {
        let original = seg_json(&hist[i], *a, *b);
        for m in &hist[i..] {
            assert_eq!(seg_json(m, *a, *b), original);
        }
    }
    // A tiny prompt budget: fewer summaries are shown, never shortened ones.
    let g = GoalState::default();
    let sel = select::select(&select::Input { mem: &last, goals: &g, query: "what next?", previous: "", fts_turns: &[], max_tokens: 60 }, &cnt);
    for s in &last.segments {
        if sel.text.contains(&format!("ORIGINAL summary of {}-{}", s.from_turn, s.to_turn)) {
            assert!(sel.text.contains(&s.summary), "a shown summary is shown whole");
        }
    }
    assert!(!sel.text.contains("ORIGINAL summary of 1-5"), "the oldest range is left out of a tiny prompt");
    // coarsen works on a view and never touches range summaries.
    let mut view = last.clone();
    coarsen(&mut view, 10, &cnt);
    assert_eq!(view.segments, last.segments);
    // The stored record is unchanged after building the prompt.
    assert_eq!(load_memory(&conn, "c").segments, last.segments);
    // Recall: the original turns and the original summary of 1-5, after 12 folds.
    let t = load_turns(&conn, "c", 1, 5);
    assert_eq!(t.len(), 5);
    assert!(serde_json::to_string(&t[0].1).unwrap().contains("the port for service 1 is 8001"));
    let note = stored_summaries_note(&last, &[(1, 5)]);
    assert!(note.contains("ORIGINAL summary of 1-5: ports 8001..8005") && note.contains("never changed"), "{note}");
    let (txt, err) = inspect::inspect(&conn, "c", &json!({"section": "segments"}));
    assert!(!err);
    for (a, b) in &batches {
        assert!(txt.contains(&format!("ORIGINAL summary of {a}-{b}")), "{txt}");
    }
    assert!(txt.contains("never changed"));
}

#[tokio::test]
async fn retention_never_removes_the_original_turns_behind_a_summary() {
    let conn = db();
    let all = turns(20);
    build(&conn, &[(1, 7), (8, 14), (15, 20)], &all).await;
    let policy = retention::Policy { budget_bytes: 0, keep_unreferenced_ms: 0, grace_ms: 0 };
    let _ = retention::prune_results(&conn, "c", policy, i64::MAX / 2, false);
    let t = load_turns(&conn, "c", 1, 20);
    assert_eq!(t.len(), 20);
    assert!(serde_json::to_string(&t[6].1).unwrap().contains("8007"));
}

#[test]
fn repairs_cannot_rewrite_a_range_summary_and_old_segment_repairs_are_not_reverted() {
    let seg = Segment { from_turn: 1, to_turn: 7, topic: "t".into(), title: "t".into(), summary: "live text".into(), created_at: 0 };
    let mem = TurnMemory { through_turn: 7, segments: vec![seg], ..Default::default() };
    let p = repair::parse_proposal(&json!({"kind": "segment", "fromTurn": 1, "toTurn": 7, "summary": "new", "evidence": [{"turn": 3, "quote": "some exact words"}]})).unwrap();
    assert!(repair::check_proposal(&mem, &p, &[]).unwrap_err().contains("immutable"));
    assert!(repair::apply_proposal(&mem, &p, 1).unwrap_err().contains("immutable"));
    // A segment repair saved by an older build: the live text is now the
    // immutable record, so reverting it is refused.
    let old_detail = json!({"kind": "segment", "fromTurn": 1, "toTurn": 7, "before": "older text", "after": "live text"});
    assert!(repair::revert_detail(&mem, &old_detail, 2).is_err());
}

#[test]
fn migration_keeps_stored_summaries_without_a_timestamp_unchanged() {
    let conn = db();
    // A memory row written by an older build (no createdAt on segments).
    let old = json!({"throughTurn": 7, "goal": "g", "segments": [{"fromTurn": 1, "toTurn": 7, "topic": "setup", "title": "start", "summary": "old build summary"}]});
    let m: TurnMemory = serde_json::from_value(old).unwrap();
    assert_eq!(m.segments[0].created_at, 0);
    save_version(&conn, "c", 0, &m, "summary", &json!({}), None, 1).unwrap();
    let loaded = load_memory(&conn, "c");
    assert_eq!(loaded.segments[0].summary, "old build summary");
    let back = serde_json::to_value(&loaded.segments[0]).unwrap();
    assert!(back.get("createdAt").is_none(), "an older record is not rewritten to add a timestamp");
    // A later batch keeps it byte for byte.
    let mut next = loaded.clone();
    next.through_turn = 9;
    next.segments.push(Segment { from_turn: 8, to_turn: 9, topic: "x".into(), title: "x".into(), summary: "new".into(), created_at: 2 });
    assert!(validate_transition(&loaded, &next, &[]).is_ok());
}

#[tokio::test]
async fn sub_agent_sessions_follow_the_same_rule() {
    // Sub-agents and cross-session asks run through the same run_agent_turn
    // and the same memory store, keyed by their own session key.
    let conn = db();
    let key = "subagent:sa_42";
    let all = turns(16);
    let model = Script { f: |_: &str, u: &str| Ok(answer(u)), calls: Mutex::new(0) };
    let mut mem = load_memory(&conn, key);
    let mut first = String::new();
    for (i, (a, b)) in [(1u32, 7u32), (8, 12), (13, 16)].into_iter().enumerate() {
        let out = summarize_batch(&model, &mem, &all, a, b, 50 + i as i64).await.unwrap();
        save_version(&conn, key, mem.version, &out.memory, "summary", &json!({}), None, 50 + i as i64).unwrap();
        mem = load_memory(&conn, key);
        if i == 0 {
            first = seg_json(&mem, 1, 7);
        }
        assert_eq!(seg_json(&mem, 1, 7), first);
    }
    assert_eq!(mem.segments.len(), 3);
    assert_eq!(mem.goal, "goal as of turn 16");
    assert!(load_memory(&conn, "c").segments.is_empty(), "sessions stay separate");
}

// ---- Scope: each range summary describes only its own turns ----

fn clean_summary(user: &str) -> String {
    let nt = new_turns(user);
    let (a, b) = (*nt.first().unwrap(), *nt.last().unwrap());
    let mut v: Value = serde_json::from_str(&answer(user)).unwrap();
    if a == 21 {
        v["segments"][0]["summary"] = Value::String(format!("ORIGINAL summary of {a}-{b}: ports {}..{}\nChanges to turns 1-7: service 1 port 8001 -> 9001", 8000 + a, 8000 + b));
    }
    v.to_string()
}

#[tokio::test]
async fn the_21_28_summary_sees_and_holds_only_its_own_turns_plus_a_change_note() {
    let conn = db();
    let all = turns(28);
    let hist = build(&conn, &[(1, 7), (8, 20)], &all).await;
    let base = hist.last().unwrap().clone();
    let seen = Mutex::new(Vec::<(String, String)>::new());
    let model = Script {
        f: |sys: &str, u: &str| {
            seen.lock().unwrap().push((sys.to_string(), u.to_string()));
            Ok(clean_summary(u))
        },
        calls: Mutex::new(0),
    };
    let out = summarize_batch(&model, &base, &all, 21, 28, 77).await.unwrap();
    let (sys, user) = seen.lock().unwrap()[0].clone();
    // What the summarizer gets: only turns 21-28; the earlier memory only as
    // marked context, with the earlier ranges as an index without their text.
    assert!(sys.contains("SCOPE") && sys.contains("Changes to turns A-B:"));
    assert!(user.contains("CONTEXT ONLY"));
    assert!(user.contains("earlierRanges"));
    for n in 1..=20 {
        assert!(!user.contains(&format!("the port for service {n} is")), "turn {n} leaked into the 21-28 call");
    }
    assert!(!user.contains("ORIGINAL summary of 1-7") && !user.contains("ORIGINAL summary of 8-20"), "earlier summary text leaked into the call");
    assert_eq!(new_turns(&user), (21..=28).collect::<Vec<_>>());
    // What is stored.
    let mem = archive_and_save(&conn, &out.memory, &all, 28, 77);
    let s21 = mem.segments.iter().find(|s| s.from_turn == 21).unwrap();
    let (body, notes): (Vec<&str>, Vec<&str>) = s21.summary.lines().partition(|l| !l.starts_with(CHANGE_NOTE_PREFIX));
    assert_eq!(notes, vec!["Changes to turns 1-7: service 1 port 8001 -> 9001"]);
    let body = body.join("\n");
    for n in 1..=7 {
        assert!(!body.contains(&format!("{}", 8000 + n)), "1-7 content in the 21-28 summary outside the change note: {body}");
    }
    assert!(!body.contains("1-7"));
    let s17 = mem.segments.iter().find(|s| s.from_turn == 1).unwrap();
    assert_eq!(seg_json(&mem, 1, 7), seg_json(&hist[0], 1, 7), "1-7 byte-identical");
    for n in 21..=28 {
        assert!(!s17.summary.contains(&format!("{}", 8000 + n)), "21-28 content in the 1-7 summary");
    }
    assert!(!s17.summary.contains("Changes to turns"));
}

#[tokio::test]
async fn a_summary_that_drags_in_earlier_turns_is_rejected_and_corrected() {
    let conn = db();
    let all = turns(28);
    let hist = build(&conn, &[(1, 7), (8, 20)], &all).await;
    let base = hist.last().unwrap().clone();
    let model = Script {
        f: |_: &str, u: &str| {
            let mut v: Value = serde_json::from_str(&clean_summary(u)).unwrap();
            if !u.contains("REJECTED") {
                v["segments"][0]["summary"] = Value::String("Continuing turns 1-7 (ports 8001..8007), turns 21-28 add ports 8021..8028".into());
            }
            Ok(v.to_string())
        },
        calls: Mutex::new(0),
    };
    let out = summarize_batch(&model, &base, &all, 21, 28, 78).await.unwrap();
    assert_eq!(out.corrections, 1, "the leaking answer was sent back once");
    let s = out.memory.segments.iter().find(|s| s.from_turn == 21).unwrap();
    assert!(!s.summary.contains("Continuing turns 1-7"));
    assert_eq!(seg_json(&out.memory, 1, 7), seg_json(&hist[0], 1, 7));
    // A model that never stops leaking: nothing is saved.
    let bad = Script { f: |_: &str, u: &str| { let mut v: Value = serde_json::from_str(&clean_summary(u)).unwrap(); v["segments"][0]["summary"] = Value::String("As in turns 1-7, more ports".into()); Ok(v.to_string()) }, calls: Mutex::new(0) };
    assert!(summarize_batch(&bad, &base, &all, 21, 28, 79).await.is_err());
}

#[test]
fn scope_check_rules() {
    let seg = |a: u32, b: u32, s: &str| Segment { from_turn: a, to_turn: b, topic: "t".into(), title: "t".into(), summary: s.into(), created_at: 0 };
    let earlier = vec![seg(1, 7, "The user chose PostgreSQL 16 for the main database with pgvector enabled. Port 5432.")];
    assert!(check_segment_scope(&seg(21, 28, "In turn 23 the user asked to turn on logging; turns 24-28 tuned it."), &earlier).is_ok());
    assert!(check_segment_scope(&seg(21, 28, "Logging set up.\nChanges to turns 1-7: database PostgreSQL -> SQLite"), &earlier).is_ok());
    assert!(check_segment_scope(&seg(21, 28, "- changes to turns 1-7: port 5432 -> 6543"), &earlier).is_ok());
    assert!(check_segment_scope(&seg(21, 28, "Back in turn 3 the user had chosen a database."), &earlier).is_err());
    assert!(check_segment_scope(&seg(21, 28, "Turns 20-28: logging."), &earlier).is_err());
    assert!(check_segment_scope(&seg(21, 28, "Logging. The user chose PostgreSQL 16 for the main database with pgvector enabled."), &earlier).is_err(), "copying an earlier summary");
    let mut titled = seg(21, 28, "Logging.");
    titled.title = "Since turn 2".into();
    assert!(check_segment_scope(&titled, &earlier).is_err());
}
