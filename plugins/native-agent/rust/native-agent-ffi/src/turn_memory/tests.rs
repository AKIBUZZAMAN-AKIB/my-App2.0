//! Turn memory tests: decisions by ID, validation, versions and concurrency,
//! crash safety, large results, references, repair and revert, edge cases.

use super::commit::{self, CommitJob, CommitOutcome, Rebuild};
use super::repair;
use super::results;
use super::*;
use crate::types::{ContentBlock, Message};
use rusqlite::Connection;
use serde_json::json;
use std::sync::Mutex;

fn cnt(s: &str) -> usize {
    s.len() / 4 + 1
}

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    c
}

/// A model whose answers come from a closure (system prompt, user prompt).
struct Script<F: Fn(&str, &str) -> Result<String, String>> {
    f: F,
    calls: Mutex<Vec<(String, String)>>,
}

impl<F: Fn(&str, &str) -> Result<String, String>> Script<F> {
    fn new(f: F) -> Self {
        Self { f, calls: Mutex::new(Vec::new()) }
    }
    fn count(&self, prefix: &str) -> usize {
        self.calls.lock().unwrap().iter().filter(|(s, _)| s.starts_with(prefix)).count()
    }
    fn prompts(&self, prefix: &str) -> Vec<String> {
        self.calls.lock().unwrap().iter().filter(|(s, _)| s.starts_with(prefix)).map(|(_, u)| u.clone()).collect()
    }
}

impl<F: Fn(&str, &str) -> Result<String, String>> TextModel for Script<F> {
    async fn complete(&self, system: &str, user: String, _max: u32) -> Result<String, String> {
        self.calls.lock().unwrap().push((system.to_string(), user.clone()));
        (self.f)(system, &user)
    }
}

const SUMMARIZER: &str = "You maintain the long-term memory";
const READER: &str = "You are a reader sub-agent";

/// Turn numbers from the "### Turn N" headings of the NEW turns.
fn new_turns(user: &str) -> Vec<u32> {
    let body = user.split("\nNEW ").nth(1).unwrap_or(user);
    let mut v: Vec<u32> = body.lines().filter_map(|l| l.strip_prefix("### Turn ")).filter_map(|r| r.split_whitespace().next()?.parse().ok()).collect();
    v.dedup();
    v
}

/// The IDs of the decisions currently in force in the EARLIER SUMMARY.
fn current_ids(user: &str) -> Vec<String> {
    let Some(start) = user.find("EARLIER SUMMARY (turns") else { return Vec::new() };
    let rest = &user[start..];
    let Some(j) = rest.find('{') else { return Vec::new() };
    let mut depth = 0;
    let mut end = 0;
    for (i, c) in rest[j..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = j + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    let v: Value = serde_json::from_str(&rest[j..end]).unwrap();
    v["decisions"]["current"].as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap().to_string()).collect()
}

/// A well-behaved summarizer answer: one segment per new turn, all current
/// decisions kept, plus `extra` merged into the decisions object.
fn good_answer(user: &str, extra_current: Vec<Value>, superseded: Vec<Value>, keep_except: &[&str]) -> String {
    let turns = new_turns(user);
    let segs: Vec<Value> = turns.iter().map(|n| json!({"fromTurn": n, "toTurn": n, "topic": if n % 2 == 0 { "database" } else { "setup" }, "title": format!("t{}", n), "summary": format!("did {}", n)})).collect();
    let mut cur: Vec<Value> = current_ids(user).into_iter().filter(|id| !keep_except.contains(&id.as_str())).map(|id| json!({"id": id})).collect();
    cur.extend(extra_current);
    json!({"goal": "ship the app", "segments": segs, "decisions": {"current": cur, "superseded": superseded}}).to_string()
}

fn turn_msgs(n: u32, text: &str) -> (u32, Vec<Message>) {
    (n, vec![Message::user(text), Message::assistant_text(&format!("answer {}", n))])
}

fn convo(n: u32) -> Vec<(u32, Vec<Message>)> {
    (1..=n).map(|i| turn_msgs(i, &format!("question {}", i))).collect()
}

fn flat(turns: &[(u32, Vec<Message>)]) -> Vec<Message> {
    turns.iter().flat_map(|(_, m)| m.clone()).collect()
}

async fn summarize<M: TextModel>(model: &M, base: &TurnMemory, turns: &[(u32, Vec<Message>)], from: u32, to: u32) -> Result<SummarizeOutcome, String> {
    let ids = HashMap::new();
    let slice: Vec<(u32, Vec<Message>)> = turns.iter().filter(|(n, _)| *n >= from && *n <= to).cloned().collect();
    let job = SummarizeJob { turns: &slice, from, to, input_limit: 120_000, max_output: 2_048, result_ids: &ids, now_ms: 1 };
    summarize_range(model, base, &job, &cnt).await
}

fn save(conn: &Connection, key: &str, mem: &TurnMemory, kind: &str) -> u64 {
    let cur = load_memory(conn, key);
    save_version(conn, key, cur.version, mem, kind, &json!({}), None, 1).unwrap()
}

fn mem_with(through: u32, current: &[(&str, &str, u32)]) -> TurnMemory {
    let mut m = TurnMemory { through_turn: through, ..Default::default() };
    if through > 0 {
        m.segments.push(Segment { from_turn: 1, to_turn: through, topic: "setup".into(), title: "start".into(), summary: "earlier work".into() });
    }
    for (id, text, turn) in current {
        m.decisions.current.push(Decision { id: id.to_string(), text: text.to_string(), turn: *turn, origin: "summary".into(), ..Default::default() });
    }
    m.normalize();
    m
}

// ── Review question 1: decisions stay correct (PostgreSQL → SQLite) ───────────

#[tokio::test]
async fn postgres_to_sqlite_at_turn_25_sqlite_is_current_and_postgres_superseded_by_it() {
    let mut turns = convo(25);
    turns[2] = turn_msgs(3, "Let's use PostgreSQL for the database");
    turns[24] = turn_msgs(25, "Change of plan: use SQLite instead of PostgreSQL");
    let model = Script::new(|sys, user| {
        assert!(sys.starts_with(SUMMARIZER));
        let nt = new_turns(user);
        if nt.contains(&3) {
            return Ok(good_answer(user, vec![json!({"id": "N1", "text": "Use PostgreSQL for the database", "turn": 3})], vec![], &[]));
        }
        if nt.contains(&25) {
            return Ok(good_answer(user, vec![json!({"id": "N1", "text": "Use SQLite for the database", "turn": 25})], vec![json!({"id": "D1", "supersededBy": "N1", "turn": 25})], &["D1"]));
        }
        Ok(good_answer(user, vec![], vec![], &[]))
    });
    let conn = db();
    let mut mem = TurnMemory::default();
    for (a, b) in [(1, 7), (8, 14), (15, 21), (22, 25)] {
        let out = summarize(&model, &mem, &turns, a, b).await.unwrap();
        save(&conn, "c", &out.memory, "summary");
        mem = load_memory(&conn, "c");
    }
    assert_eq!(mem.through_turn, 25);
    assert_eq!(mem.version, 4);
    assert_eq!(mem.decisions.current.len(), 1);
    let cur = &mem.decisions.current[0];
    assert_eq!((cur.id.as_str(), cur.text.as_str(), cur.turn), ("D2", "Use SQLite for the database", 25));
    assert_eq!(mem.decisions.superseded.len(), 1);
    let old = &mem.decisions.superseded[0];
    assert_eq!((old.id.as_str(), old.turn), ("D1", 3));
    assert_eq!(old.superseded_by.as_deref(), Some("D2"));
    assert_eq!(old.superseded_at, Some(25));
    // The model sees what is in force apart from what was replaced.
    let r = render(&mem);
    let now = r.find("Decisions in force NOW").unwrap();
    let before = r.find("REPLACED").unwrap();
    assert!(now < before);
    assert!(r[now..before].contains("D2 (turn 25): Use SQLite"));
    assert!(!r[now..before].contains("PostgreSQL"));
    assert!(r[before..].contains("D1 (turn 3): Use PostgreSQL for the database → superseded by D2 at turn 25"));
    // Recall status for turn 3 says it was replaced.
    let st = status_lines(&mem, &[3]);
    assert!(st.iter().any(|l| l.contains("D1") && l.contains("SUPERSEDED by D2") && l.contains("SQLite") && l.contains("D2 is current")), "{:?}", st);
    // The summary of 22-25 was told about D1 and the rule.
    let last = model.prompts(SUMMARIZER).pop().unwrap();
    assert!(last.contains("\"id\": \"D1\""));
    assert!(summarizer_system().contains("supersededBy"));
}

#[test]
fn superseding_through_the_supersedes_field_of_a_new_decision_works_too() {
    let base = mem_with(7, &[("D1", "Use PostgreSQL", 3)]);
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"switch"}],"decisions":{"current":[{"id":"N1","text":"Use SQLite","turn":8,"supersedes":["D1"]}]}}"#).unwrap();
    let m = apply_update(&base, &up, 8, 8, 2).unwrap();
    assert_eq!(m.decisions.current[0].id, "D2");
    assert_eq!(m.decisions.superseded[0].superseded_by.as_deref(), Some("D2"));
}

#[test]
fn a_chain_of_replacements_keeps_every_link() {
    let mut mem = mem_with(1, &[("D1", "PostgreSQL", 1)]);
    for (t, text) in [(2u32, "SQLite"), (3, "DuckDB")] {
        let prev = mem.decisions.current[0].id.clone();
        let up = parse_update(&json!({"segments":[{"fromTurn":t,"toTurn":t,"summary":"x"}],"decisions":{"current":[{"id":"N1","text":text,"turn":t}],"superseded":[{"id":prev,"supersededBy":"N1"}]}}).to_string()).unwrap();
        mem = apply_update(&mem, &up, t, t, 1).unwrap();
    }
    assert_eq!(mem.decisions.current.iter().map(|d| (d.id.as_str(), d.text.as_str())).collect::<Vec<_>>(), vec![("D3", "DuckDB")]);
    let sup: Vec<_> = mem.decisions.superseded.iter().map(|d| (d.id.as_str(), d.superseded_by.as_deref().unwrap(), d.superseded_at.unwrap())).collect();
    assert_eq!(sup, vec![("D1", "D2", 2), ("D2", "D3", 3)]);
    let st = status_lines(&mem, &[2]);
    assert!(st.iter().any(|l| l.contains("D2") && l.contains("also replaced later") == false && l.contains("SUPERSEDED by D3")), "{:?}", st);
    let st1 = status_lines(&mem, &[1]);
    assert!(st1.iter().any(|l| l.starts_with("D1") && l.contains("D2 is also replaced later")), "{:?}", st1);
}

// ── Validation by ID (point A) ────────────────────────────────────────────────────────

#[test]
fn a_dropped_decision_id_is_rejected_even_when_the_count_matches() {
    let base = mem_with(7, &[("D1", "Use PostgreSQL", 3), ("D2", "Deploy on Fly", 5)]);
    // Two current decisions again, but D2 silently replaced by a new one.
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}],"decisions":{"current":[{"id":"D1"},{"id":"N1","text":"Deploy on Render","turn":8}]}}"#).unwrap();
    let errs = apply_update(&base, &up, 8, 8, 1).unwrap_err();
    assert!(errs.iter().any(|e| e.contains("decision D2") && e.contains("missing")), "{:?}", errs);
}

#[test]
fn superseded_without_naming_the_replacement_is_rejected() {
    let base = mem_with(7, &[("D1", "Use PostgreSQL", 3)]);
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}],"decisions":{"current":[],"superseded":[{"id":"D1"}]}}"#).unwrap();
    let errs = apply_update(&base, &up, 8, 8, 1).unwrap_err();
    assert!(errs.iter().any(|e| e.contains("D1") && e.contains("does not name the decision that replaced it")), "{:?}", errs);
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}],"decisions":{"current":[],"superseded":[{"id":"D1","supersededBy":"D9"}]}}"#).unwrap();
    assert!(apply_update(&base, &up, 8, 8, 1).is_err());
}

#[test]
fn invented_ids_revived_decisions_and_self_supersede_are_rejected() {
    let mut base = mem_with(7, &[("D2", "SQLite", 6)]);
    base.decisions.superseded.push(Decision { id: "D1".into(), text: "PostgreSQL".into(), turn: 3, superseded_by: Some("D2".into()), superseded_at: Some(6), origin: "summary".into() });
    base.normalize();
    let seg = r#""segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}]"#;
    for (bad, needle) in [
        (r#"{"id":"D2"},{"id":"D7","text":"made up","turn":8}"#, "unknown decision ID D7"),
        (r#"{"id":"D2"},{"id":"D1"}"#, "already superseded"),
        (r#"{"id":"N1","text":"from the past","turn":2},{"id":"D2"}"#, "must come from one of the new turns"),
    ] {
        let up = parse_update(&format!("{{{},\"decisions\":{{\"current\":[{}]}}}}", seg, bad)).unwrap();
        let errs = apply_update(&base, &up, 8, 8, 1).unwrap_err();
        assert!(errs.iter().any(|e| e.contains(needle)), "{} -> {:?}", needle, errs);
    }
    let up = parse_update(&format!("{{{},\"decisions\":{{\"current\":[],\"superseded\":[{{\"id\":\"D2\",\"supersededBy\":\"D2\"}}]}}}}", seg)).unwrap();
    assert!(apply_update(&base, &up, 8, 8, 1).unwrap_err().iter().any(|e| e.contains("supersede itself")));
}

#[test]
fn every_turn_must_be_covered_and_turn_numbers_must_be_in_range() {
    let base = mem_with(7, &[]);
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":9,"summary":"a"},{"fromTurn":11,"toTurn":14,"summary":"b"}]}"#).unwrap();
    let errs = apply_update(&base, &up, 8, 14, 1).unwrap_err();
    assert_eq!(errs, vec!["turn 10 is not covered by any segment".to_string()]);
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":15,"summary":"a"}]}"#).unwrap();
    assert!(apply_update(&base, &up, 8, 14, 1).unwrap_err()[0].contains("outside the new turns 8-14"));
    let up = parse_update(r#"{"segments":[{"fromTurn":3,"toTurn":14,"summary":"a"}]}"#).unwrap();
    assert!(apply_update(&base, &up, 8, 14, 1).is_err());
    // Facts need a source turn inside the summary.
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":14,"summary":"a"}],"facts":[{"text":"port 8443","turn":99}]}"#).unwrap();
    assert!(apply_update(&base, &up, 8, 14, 1).unwrap_err()[0].contains("source turn"));
    let up = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":14,"summary":"a"}],"facts":[{"text":"port 8443","turn":9}],"preferences":[{"text":"answers in Bengali","turn":8}]}"#).unwrap();
    let m = apply_update(&base, &up, 8, 14, 1).unwrap();
    assert_eq!(m.facts, vec![Note { text: "port 8443".into(), turn: 9 }]);
    assert_eq!(m.preferences[0].turn, 8);
    assert!(render(&m).contains("- (turn 9) port 8443"));
}

#[test]
fn validate_transition_catches_lost_and_rewritten_history() {
    let mut prev = mem_with(7, &[("D2", "SQLite", 6)]);
    prev.decisions.superseded.push(Decision { id: "D1".into(), text: "PG".into(), turn: 3, superseded_by: Some("D2".into()), superseded_at: Some(6), origin: "summary".into() });
    let mut next = prev.clone();
    next.decisions.superseded.clear();
    assert!(validate_transition(&prev, &next, &[]).unwrap_err().iter().any(|e| e.contains("D1")));
    let mut next = prev.clone();
    next.decisions.current.clear();
    assert!(validate_transition(&prev, &next, &[]).unwrap_err().iter().any(|e| e.contains("D2") && e.contains("lost")));
    let mut next = prev.clone();
    next.decisions.superseded[0].superseded_by = Some("D9".into());
    assert!(validate_transition(&prev, &next, &[]).is_err());
    let mut next = prev.clone();
    next.through_turn = 5;
    assert!(validate_transition(&prev, &next, &[]).is_err());
    assert!(validate_transition(&prev, &prev.clone(), &[]).is_ok());
}

// ── Corrective call; malformed summarizer JSON ───────────────────────────────────────

#[tokio::test]
async fn a_summarizer_that_drops_a_decision_is_corrected_once_then_accepted() {
    let turns = convo(14);
    let base = mem_with(7, &[("D1", "Use PostgreSQL", 3)]);
    let model = Script::new(|_, user| {
        if user.contains("YOUR PREVIOUS ANSWER WAS REJECTED") {
            assert!(user.contains("decision D1"), "the validator's error is fed back");
            Ok(good_answer(user, vec![], vec![], &[]))
        } else {
            Ok(good_answer(user, vec![], vec![], &["D1"]))
        }
    });
    let out = summarize(&model, &base, &turns, 8, 14).await.unwrap();
    assert_eq!(out.corrections, 1);
    assert_eq!(out.calls, 2);
    assert_eq!(out.memory.decisions.current[0].id, "D1");
}

#[tokio::test]
async fn a_summary_that_keeps_dropping_a_decision_is_rejected_and_the_old_version_stays() {
    let conn = db();
    let turns = convo(14);
    save(&conn, "c", &mem_with(7, &[("D1", "Use PostgreSQL", 3)]), "summary");
    let base = load_memory(&conn, "c");
    let model = Script::new(|_, user| Ok(good_answer(user, vec![], vec![], &["D1"])));
    let err = summarize(&model, &base, &turns, 8, 14).await.err().unwrap();
    assert!(err.contains("rejected by validation") && err.contains("D1"), "{}", err);
    assert_eq!(model.count(SUMMARIZER), MAX_SUMMARY_ATTEMPTS);
    let after = load_memory(&conn, "c");
    assert_eq!((after.version, after.through_turn), (1, 7));
    assert_eq!(after.decisions.current[0].id, "D1");
    // The next turn plans the same batch again.
    assert_eq!(plan_batches(21, after.through_turn, &MemorySettings::default()), vec![(8, 14)]);
}

#[tokio::test]
async fn malformed_summarizer_json_is_never_turned_into_a_version() {
    let turns = convo(7);
    for bad in ["Sure! Here is the summary: turns went well.", "{\"segments\": [ {\"fromTurn\": 1, ", "[1,2,3]", "", "{\"segments\": \"oops\"}"] {
        let model = Script::new(move |_, _| Ok(bad.to_string()));
        let err = summarize(&model, &TurnMemory::default(), &turns, 1, 7).await.err().unwrap();
        assert!(err.contains("rejected"), "{:?} -> {}", bad, err);
    }
    // Fenced JSON with prose around it is fine.
    let model = Script::new(|_, user| Ok(format!("Here you go:\n```json\n{}\n```\nDone.", good_answer(user, vec![], vec![], &[]))));
    assert_eq!(summarize(&model, &TurnMemory::default(), &turns, 1, 7).await.unwrap().memory.through_turn, 7);
}

// ── Review question 3/4: atomic checkpoint, crash mid-summary, idempotency ──

#[tokio::test]
async fn a_crash_mid_summary_keeps_the_checkpoint_and_the_retry_does_not_duplicate() {
    let conn = db();
    let turns = convo(21);
    let model = Script::new(|_, user| Ok(good_answer(user, vec![], vec![], &[])));
    let out = summarize(&model, &TurnMemory::default(), &turns, 1, 7).await.unwrap();
    save(&conn, "c", &out.memory, "summary");
    let v1 = load_memory(&conn, "c");
    // The model fails half way (a provider error) on the next batch.
    let failing = Script::new(|_, _| Err("503 upstream".into()));
    assert!(summarize(&failing, &v1, &turns, 8, 14).await.is_err());
    assert_eq!(load_memory(&conn, "c"), v1, "nothing moved");
    let batches = plan_batches(21, v1.through_turn, &MemorySettings::default());
    assert_eq!(batches, vec![(8, 14)], "the retry starts at through_turn + 1");
    let out = summarize(&model, &v1, &turns, 8, 14).await.unwrap();
    save(&conn, "c", &out.memory, "summary");
    let v2 = load_memory(&conn, "c");
    for n in 1..=14 {
        assert_eq!(v2.segments.iter().filter(|s| s.from_turn <= n && n <= s.to_turn).count(), 1, "turn {} covered exactly once", n);
    }
    // Running the same batch again is refused by validation (it starts
    // before the checkpoint), so a double run cannot duplicate.
    assert!(apply_update(&v2, &out.update, 8, 14, 1).is_err());
}

#[test]
fn archive_and_summary_roll_back_together_when_the_transaction_fails() {
    let conn = db();
    let turns = convo(14);
    let msgs = flat(&turns);
    let split = split_turns(&msgs);
    let v1 = mem_with(7, &[("D1", "x", 2)]);
    save_version(&conn, "c", 0, &v1, "summary", &json!({}), Some(ArchiveTurns { messages: &msgs, turns: &split[..7] }), 1).unwrap();
    let mut v2 = v1.clone();
    v2.through_turn = 14;
    v2.segments.push(Segment { from_turn: 8, to_turn: 14, topic: "t".into(), title: "t".into(), summary: "s".into() });
    for step in ["archive", "memory", "history"] {
        store::FAIL_AFTER.with(|f| *f.borrow_mut() = Some(step));
        let r = save_version(&conn, "c", 1, &v2, "summary", &json!({}), Some(ArchiveTurns { messages: &msgs, turns: &split[7..14] }), 2);
        store::FAIL_AFTER.with(|f| *f.borrow_mut() = None);
        assert!(r.is_err(), "{}", step);
        let m = load_memory(&conn, "c");
        assert_eq!((m.version, m.through_turn), (1, 7), "after {}", step);
        assert_eq!(load_turns(&conn, "c", 1, 14).len(), 7, "no archive rows for 8-14 after {}", step);
        assert_eq!(list_versions(&conn, "c").len(), 1, "no history row after {}", step);
    }
    assert_eq!(save_version(&conn, "c", 1, &v2, "summary", &json!({}), Some(ArchiveTurns { messages: &msgs, turns: &split[7..14] }), 2).unwrap(), 2);
    assert_eq!(load_turns(&conn, "c", 1, 14).len(), 14);
    assert_eq!(load_memory(&conn, "c").through_turn, 14);
}

#[test]
fn the_checkpoint_and_the_summary_are_one_row() {
    let conn = db();
    save(&conn, "c", &mem_with(7, &[]), "summary");
    let (json, through, version): (String, i64, i64) = conn.query_row("SELECT memory_json, through_turn, version FROM turn_memory WHERE session_key='c'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    let m: TurnMemory = serde_json::from_str(&json).unwrap();
    assert_eq!((m.through_turn as i64, m.version as i64), (through, version));
}

// ── Versions and optimistic concurrency (point B) ───────────────────────────────────

#[test]
fn version_history_keeps_exactly_the_last_ten() {
    let conn = db();
    for i in 1..=15 {
        let mut m = mem_with(i, &[]);
        m.goal = format!("g{}", i);
        assert_eq!(save(&conn, "c", &m, "summary"), i as u64);
    }
    let v = list_versions(&conn, "c");
    assert_eq!(v.len(), 10);
    assert_eq!(v.iter().map(|x| x["version"].as_i64().unwrap()).collect::<Vec<_>>(), (6..=15).rev().collect::<Vec<i64>>());
    assert!(load_version(&conn, "c", 5).is_none());
    assert_eq!(load_version(&conn, "c", 6).unwrap().0.goal, "g6");
    assert_eq!(load_memory(&conn, "c").version, 15);
    // Another chat's history is separate.
    save(&conn, "other", &mem_with(1, &[]), "summary");
    assert_eq!(list_versions(&conn, "c").len(), 10);
    assert_eq!(list_versions(&conn, "other").len(), 1);
}

#[test]
fn a_stale_writer_gets_a_conflict_not_an_overwrite() {
    let conn = db();
    save(&conn, "c", &mem_with(7, &[]), "summary");
    save(&conn, "c", &mem_with(7, &[]), "repair");
    match save_version(&conn, "c", 1, &mem_with(14, &[]), "summary", &json!({}), None, 1) {
        Err(SaveError::Conflict { current }) => assert_eq!(current, 2),
        other => panic!("{:?}", other),
    }
    match save_version(&conn, "new", 3, &mem_with(1, &[]), "summary", &json!({}), None, 1) {
        Err(SaveError::Conflict { current }) => assert_eq!(current, 0),
        other => panic!("{:?}", other),
    }
    assert_eq!(load_memory(&conn, "c").through_turn, 7);
}

/// A and B both read v10; A saves v11 (a repair adding a fact and a
/// decision); B (a summary) conflicts, reloads v11, rebuilds and saves v12
/// that keeps A's change.
#[tokio::test]
async fn two_concurrent_updates_bounded_retry_rebuilds_on_the_latest_version() {
    let conn = db();
    let turns = convo(14);
    for _ in 0..10 {
        save(&conn, "c", &mem_with(7, &[("D1", "Use PostgreSQL", 3)]), "summary");
    }
    let v10 = load_memory(&conn, "c");
    assert_eq!(v10.version, 10);
    let model = Script::new(|_, user| Ok(good_answer(user, vec![json!({"id": "N1", "text": "Cache in Redis", "turn": 9})], vec![], &[])));
    let out = summarize(&model, &v10, &turns, 8, 14).await.unwrap();
    let mut a = v10.clone();
    a.facts.push(Note { text: "the port is 8443".into(), turn: 2 });
    a.next_decision += 1;
    a.decisions.current.push(Decision { id: format!("D{}", a.next_decision), text: "Repo is my-App2.0".into(), turn: 4, origin: "repair".into(), ..Default::default() });
    let mut attempts = Vec::new();
    let job = CommitJob { session_key: "c", kind: "summary", detail: json!({}), archive: None, now_ms: 5 };
    let outcome = commit::commit_with(&conn, job, v10.version, out.memory.clone(), commit::summary_rebuild(&v10, &out.update, 8, 14, 5), |n| {
        attempts.push(n);
        if n == 1 {
            assert_eq!(save_version(&conn, "c", 10, &a, "repair", &json!({}), None, 4).unwrap(), 11);
        }
    });
    assert_eq!(outcome, CommitOutcome::Saved { version: 12, tries: 2 });
    assert_eq!(attempts, vec![1, 2]);
    let v12 = load_memory(&conn, "c");
    assert_eq!((v12.version, v12.through_turn), (12, 14));
    assert!(v12.facts.iter().any(|f| f.text == "the port is 8443"), "A's fact survives B's rebuild");
    let ids: Vec<&str> = v12.decisions.current.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, vec!["D1", "D2", "D3"], "A's D2 kept, B's new decision renumbered to D3");
    assert_eq!(v12.decisions.current[2].text, "Cache in Redis");
    assert_eq!(load_status(&conn, "c").status, "ok");
}

#[tokio::test]
async fn when_retries_run_out_the_memory_goes_to_the_pending_state_and_recovers_later() {
    let conn = db();
    let turns = convo(14);
    save(&conn, "c", &mem_with(7, &[]), "summary");
    let v1 = load_memory(&conn, "c");
    let model = Script::new(|_, user| Ok(good_answer(user, vec![], vec![], &[])));
    let out = summarize(&model, &v1, &turns, 8, 14).await.unwrap();
    let mut rebuilds = 0;
    let job = CommitJob { session_key: "c", kind: "summary", detail: json!({}), archive: None, now_ms: 9 };
    let rb = commit::summary_rebuild(&v1, &out.update, 8, 14, 9);
    let mut rb = rb;
    let outcome = commit::commit_with(
        &conn,
        job,
        v1.version,
        out.memory.clone(),
        |l| {
            rebuilds += 1;
            rb(l)
        },
        |_| {
            // Another writer wins every race.
            let cur = load_memory(&conn, "c");
            save_version(&conn, "c", cur.version, &cur, "repair", &json!({}), None, 8).unwrap();
        },
    );
    match outcome {
        CommitOutcome::Pending { tries, reason } => {
            assert_eq!(tries, commit::MAX_SAVE_TRIES);
            assert!(reason.contains("after 3 tries"), "{}", reason);
        }
        other => panic!("{:?}", other),
    }
    assert_eq!(rebuilds, 2, "three saves, two rebuilds");
    let st = load_status(&conn, "c");
    assert_eq!(st.status, "pending");
    assert!(st.detail.unwrap().contains("summary failed, will retry"));
    let m = load_memory(&conn, "c");
    assert_eq!(m.through_turn, 7, "checkpoint did not move");
    // Next turn: the same batch is planned again and this time it saves.
    assert_eq!(plan_batches(21, m.through_turn, &MemorySettings::default()), vec![(8, 14)]);
    let out = summarize(&model, &m, &turns, 8, 14).await.unwrap();
    let job = CommitJob { session_key: "c", kind: "summary", detail: json!({}), archive: None, now_ms: 10 };
    let outcome = commit::commit(&conn, job, m.version, out.memory, commit::summary_rebuild(&m, &out.update, 8, 14, 10));
    assert!(matches!(outcome, CommitOutcome::Saved { tries: 1, .. }));
    assert_eq!(load_status(&conn, "c").status, "ok", "a saved version clears the pending state");
    assert_eq!(load_memory(&conn, "c").through_turn, 14);
}

#[tokio::test]
async fn a_concurrent_writer_that_already_summarized_the_batch_means_nothing_to_save() {
    let conn = db();
    let turns = convo(14);
    save(&conn, "c", &mem_with(7, &[]), "summary");
    let v1 = load_memory(&conn, "c");
    let model = Script::new(|_, user| Ok(good_answer(user, vec![], vec![], &[])));
    let out = summarize(&model, &v1, &turns, 8, 14).await.unwrap();
    let other = out.memory.clone();
    let job = CommitJob { session_key: "c", kind: "summary", detail: json!({}), archive: None, now_ms: 9 };
    let outcome = commit::commit_with(&conn, job, 1, out.memory.clone(), commit::summary_rebuild(&v1, &out.update, 8, 14, 9), |n| {
        if n == 1 {
            save_version(&conn, "c", 1, &other, "summary", &json!({}), None, 8).unwrap();
        }
    });
    assert_eq!(outcome, CommitOutcome::AlreadyDone { version: 2 });
    assert_eq!(list_versions(&conn, "c").len(), 2, "no duplicate version");
}

#[test]
fn a_rebuild_that_no_longer_fits_goes_to_pending_at_once() {
    let conn = db();
    save(&conn, "c", &mem_with(7, &[]), "summary");
    let job = CommitJob { session_key: "c", kind: "summary", detail: json!({}), archive: None, now_ms: 9 };
    let outcome = commit::commit_with(&conn, job, 1, mem_with(14, &[]), |_| Rebuild::Invalid("gap".into()), |n| {
        if n == 1 {
            save_version(&conn, "c", 1, &mem_with(7, &[]), "repair", &json!({}), None, 8).unwrap();
        }
    });
    assert!(matches!(outcome, CommitOutcome::Pending { tries: 1, .. }));
    assert_eq!(load_status(&conn, "c").status, "pending");
}

// ── Large tool results ────────────────────────────────────────────────────────

fn five_mb_with_needle() -> String {
    let line = "2026-11-14 INFO worker=7 processed batch ok latency=12ms\n";
    let mut s = String::with_capacity(5 << 20);
    while s.len() < (5 << 20) / 2 {
        s.push_str(line);
    }
    s.push_str("2026-11-14 ERROR NEEDLE-7731 db password rotated; new pool size = 48\n");
    while s.len() < 5 << 20 {
        s.push_str(line);
    }
    s
}

fn tool_turn(no: u32, id: &str, name: &str, input: Value, content: &str) -> (u32, Vec<Message>) {
    (
        no,
        vec![
            Message::user(&format!("turn {} please run {}", no, name)),
            Message::assistant_blocks(vec![ContentBlock::ToolUse { id: id.into(), name: name.into(), input, provider_metadata: None }]),
            Message::tool_result(id, content, false),
            Message::assistant_text("done"),
        ],
    )
}

#[tokio::test]
async fn a_5mb_result_is_read_in_full_and_the_middle_is_not_lost() {
    let big = five_mb_with_needle();
    let mut turns = convo(7);
    turns[3] = tool_turn(4, "toolu_big", "read_file", json!({"path": "logs/app.log"}), &big);
    let model = Script::new(|sys, user| {
        if sys.starts_with(READER) {
            assert!(user.contains("[result #R5 · read_file logs/app.log · chunk "), "chunk header: {}", &user[..300.min(user.len())]);
            return Ok(if user.contains("NEEDLE-7731") { "ERROR NEEDLE-7731: db password rotated, pool size 48".into() } else { "routine INFO lines, nothing notable".into() });
        }
        assert!(user.len() < 200_000, "the summarizer never gets the raw 5 MB");
        let mut a: Value = serde_json::from_str(&good_answer(user, vec![], vec![], &[])).unwrap();
        if user.contains("NEEDLE-7731") {
            a["facts"] = json!([{"text": "pool size is 48 after NEEDLE-7731", "turn": 4}]);
        }
        Ok(a.to_string())
    });
    let mut ids = HashMap::new();
    ids.insert("toolu_big".to_string(), "R5".to_string());
    let job = SummarizeJob { turns: &turns, from: 1, to: 7, input_limit: 120_000, max_output: 2_048, result_ids: &ids, now_ms: 1 };
    let out = summarize_range(&model, &TurnMemory::default(), &job, &cnt).await.unwrap();
    assert!(out.memory.facts.iter().any(|f| f.text.contains("48") && f.turn == 4), "{:?}", out.memory.facts);
    let chunks = model.count(READER);
    assert!(chunks >= 2, "read in several chunks, got {}", chunks);
    assert_eq!(out.reader_calls as usize, chunks);
    let summ = model.prompts(SUMMARIZER).pop().unwrap();
    assert!(summ.contains(&format!("all {} chunks read", chunks)), "the digest says it was read in full");
    // The chunks cover every byte, in order, with no gap or overlap.
    let cs = results::chunk_text(&big, 20_000, &cnt);
    assert_eq!(cs[0].start, 0);
    assert_eq!(cs.last().unwrap().end, big.len());
    for w in cs.windows(2) {
        assert_eq!(w[0].end, w[1].start);
    }
    assert_eq!(cs.iter().map(|c| c.text.as_str()).collect::<String>(), big);
    assert!(cs.iter().filter(|c| c.text.contains("NEEDLE-7731")).count() == 1);
}

#[tokio::test]
async fn a_reader_budget_that_cannot_cover_everything_says_exactly_what_was_not_read() {
    let big = five_mb_with_needle();
    let model = Script::new(|_, _| Ok("notes".into()));
    let b = results::BigResult { tool_use_id: "t".into(), result_id: "R1".into(), tool_name: "web_fetch".into(), source: Some("https://example.com/big".into()), content: big.clone() };
    let (d, calls) = results::digest_large_results(&model, "ctx", &[b], 100_000, 512, &cnt, 3).await.unwrap();
    assert_eq!(calls, 3);
    let digest = &d["t"];
    assert!(digest.contains("NOT read in full: 3 of"), "{}", &digest[..200]);
    assert!(digest.contains("unread bytes"));
    assert!(digest.contains("https://example.com/big"));
}

#[tokio::test]
async fn asking_a_question_about_a_stored_result_reads_every_chunk() {
    let big = five_mb_with_needle();
    let model = Script::new(|_, user| Ok(if user.contains("NEEDLE-7731") { "pool size = 48".into() } else { "NOT IN THIS CHUNK".into() }));
    let b = results::BigResult { tool_use_id: "t".into(), result_id: "R2".into(), tool_name: "execute_command".into(), source: Some("cat app.log".into()), content: big };
    let (answer, read) = results::ask_result(&model, &b, "what is the new pool size?", 120_000, 512, &cnt, 32).await.unwrap();
    assert!(answer.contains("pool size = 48"));
    assert!(answer.contains(&format!("all {} chunks read", read)));
    assert!(read >= 2);
}

#[test]
fn large_result_detection_dedupes_the_same_call() {
    let big = "x\n".repeat(50_000);
    let mut t = tool_turn(1, "same", "grep_files", json!({"pattern": "TODO"}), &big);
    t.1.push(Message::tool_result("same", &big, false));
    let found = results::find_large_results(&[t], 1_000, &cnt, &HashMap::new());
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].source.as_deref(), Some("TODO"));
}

// ── Tool result references (point C) ───────────────────────────────────────────────

#[test]
fn stored_results_have_stable_ids_dedupe_and_vanish_only_with_the_chat() {
    let conn = db();
    let (a, new_a) = store_result(&conn, "c", "toolu_1", "read_file", Some("a.txt"), "AAA", false, Some(3), 1).unwrap();
    let (b, _) = store_result(&conn, "c", "toolu_2", "web_fetch", Some("https://x"), "BBB", false, Some(3), 1).unwrap();
    let (a2, new_a2) = store_result(&conn, "c", "toolu_1", "read_file", Some("a.txt"), "CHANGED", false, Some(4), 2).unwrap();
    assert_eq!((a.as_str(), b.as_str(), a2.as_str()), ("R1", "R2", "R1"));
    assert!(new_a && !new_a2);
    assert_eq!(load_result(&conn, "c", "R1").unwrap().content, "AAA", "the first copy is the original");
    assert_eq!(load_result(&conn, "c", "#R2").unwrap().tool_name, "web_fetch");
    assert_eq!(load_result(&conn, "c", "toolu_2").unwrap().id, "R2");
    // Another chat with the same provider id gets its own result.
    let (o, _) = store_result(&conn, "other", "toolu_1", "read_file", None, "OTHER", false, None, 1).unwrap();
    assert_eq!(o, "R1");
    assert_eq!(load_result(&conn, "c", "R1").unwrap().content, "AAA");
    // A reset keeps them (keyed by tool call, not turn); deleting the chat removes them.
    reset_memory(&conn, "c", "test", 3).unwrap();
    assert!(load_result(&conn, "c", "R1").is_some());
    delete_memory(&conn, "c").unwrap();
    assert!(load_result(&conn, "c", "R1").is_none());
    assert!(load_result(&conn, "other", "R1").is_some());
    assert!(load_result(&conn, "c", "R99").is_none());
}

// ── Repair (point D) ─────────────────────────────────────────────────────────────

fn repair_fixture() -> (Connection, Vec<(u32, Vec<Message>)>) {
    let conn = db();
    let mut turns = convo(7);
    turns[2] = turn_msgs(3, "সার্ভারের port হবে 8443, আর domain api.example.com");
    let msgs = flat(&turns);
    let split = split_turns(&msgs);
    let mut m = mem_with(7, &[("D1", "Use PostgreSQL", 2)]);
    m.facts.push(Note { text: "port is 8080".into(), turn: 3 });
    save_version(&conn, "c", 0, &m, "summary", &json!({}), Some(ArchiveTurns { messages: &msgs, turns: &split }), 1).unwrap();
    (conn, turns)
}

#[test]
fn a_repair_with_a_fake_quote_is_dropped() {
    let (conn, _) = repair_fixture();
    let mem = load_memory(&conn, "c");
    let originals = load_turns(&conn, "c", 1, 7);
    let cases = [
        (json!({"kind": "fact", "text": "port is 9000", "turn": 3, "replaces": "port is 8080", "evidence": [{"turn": 3, "quote": "port হবে 9000"}]}), "does not appear"),
        (json!({"kind": "fact", "text": "port is 8443", "turn": 3, "evidence": [{"turn": 12, "quote": "port হবে 8443"}]}), "not a summarized turn"),
        (json!({"kind": "fact", "text": "port is 8443", "turn": 3, "evidence": []}), "no quoted evidence"),
        (json!({"kind": "fact", "text": "port is 8443", "turn": 3, "evidence": [{"turn": 3, "quote": "8443"}]}), "too short"),
        (json!({"kind": "fact", "text": "port is 8443", "turn": 5, "evidence": [{"turn": 3, "quote": "port হবে 8443"}]}), "not one of the cited turns"),
        (json!({"kind": "fact", "text": "port is 8443", "turn": 3, "replaces": "no such fact", "evidence": [{"turn": 3, "quote": "port হবে 8443"}]}), "cannot be replaced"),
        (json!({"kind": "segment", "fromTurn": 2, "toTurn": 4, "summary": "x", "evidence": [{"turn": 3, "quote": "port হবে 8443"}]}), "no segment for turns 2-4"),
    ];
    for (raw, needle) in cases {
        let p = repair::parse_proposal(&raw).unwrap();
        let e = repair::check_proposal(&mem, &p, &originals).unwrap_err();
        assert!(e.contains(needle), "{} -> {}", needle, e);
    }
    // A repair may never change or supersede a decision.
    for raw in [
        json!({"kind": "decision", "text": "Use SQLite", "turn": 3, "supersedes": "D1", "evidence": [{"turn": 3, "quote": "port হবে 8443"}]}),
        json!({"kind": "decision", "id": "D1", "text": "Use SQLite", "turn": 3, "evidence": []}),
        json!({"kind": "rename", "evidence": []}),
    ] {
        assert!(repair::parse_proposal(&raw).is_err());
    }
    assert_eq!(load_memory(&conn, "c").version, 1, "nothing was saved");
}

#[test]
fn a_valid_repair_creates_a_logged_version_and_can_be_reverted() {
    let (conn, _) = repair_fixture();
    let mem = load_memory(&conn, "c");
    let originals = load_turns(&conn, "c", 3, 3);
    // Quote with different spacing still matches (whitespace collapsed).
    let raw = json!({"kind": "fact", "text": "port is 8443", "turn": 3, "replaces": "port is 8080", "evidence": [{"turn": 3, "quote": "সার্ভারের  port হবে   8443"}], "reason": "the summary had the wrong port"});
    let p = repair::parse_proposal(&raw).unwrap();
    repair::check_proposal(&mem, &p, &originals).unwrap();
    let (next, detail) = repair::apply_proposal(&mem, &p, 5).unwrap();
    let job = CommitJob { session_key: "c", kind: "repair", detail: detail.clone(), archive: None, now_ms: 5 };
    assert_eq!(commit::commit(&conn, job, mem.version, next, |_| Rebuild::Invalid("x".into())), CommitOutcome::Saved { version: 2, tries: 1 });
    let v2 = load_memory(&conn, "c");
    assert_eq!(v2.facts, vec![Note { text: "port is 8443".into(), turn: 3 }]);
    assert_eq!(v2.decisions, mem.decisions, "decisions untouched");
    let hist = list_versions(&conn, "c");
    assert_eq!(hist[0]["kind"], "repair");
    assert_eq!(hist[0]["detail"]["evidence"][0]["turn"], 3);
    assert_eq!(hist[0]["detail"]["removed"]["text"], "port is 8080");
    // Revert from the UI (the same code the memory.revert action runs).
    let (_, kind, d) = load_version(&conn, "c", 2).unwrap();
    assert_eq!(kind, "repair");
    let reverted = repair::revert_detail(&v2, &d, 6).unwrap();
    save_version(&conn, "c", 2, &reverted, "revert", &json!({"revertedVersion": 2}), None, 6).unwrap();
    let v3 = load_memory(&conn, "c");
    assert_eq!(v3.version, 3);
    assert_eq!(v3.facts, vec![Note { text: "port is 8080".into(), turn: 3 }]);
    // Reverting the same repair twice is refused.
    assert!(repair::revert_detail(&v3, &d, 7).is_err());
}

#[test]
fn decision_and_segment_repairs_add_without_touching_old_decisions_and_revert_cleanly() {
    let (conn, _) = repair_fixture();
    let mem = load_memory(&conn, "c");
    let originals = load_turns(&conn, "c", 1, 7);
    let p = repair::parse_proposal(&json!({"kind": "decision", "text": "Serve the API on api.example.com", "turn": 3, "evidence": [{"turn": 3, "quote": "domain api.example.com"}]})).unwrap();
    repair::check_proposal(&mem, &p, &originals).unwrap();
    let (next, detail) = repair::apply_proposal(&mem, &p, 5).unwrap();
    assert_eq!(next.decisions.current.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec!["D1", "D2"]);
    assert_eq!(next.decisions.current[1].origin, "repair");
    let back = repair::revert_detail(&next, &detail, 6).unwrap();
    assert_eq!(back.decisions.current, mem.decisions.current);
    assert_eq!(back.next_decision, 2, "the number is not reused");
    let p = repair::parse_proposal(&json!({"kind": "segment", "fromTurn": 1, "toTurn": 7, "summary": "setup; port 8443 chosen in turn 3", "evidence": [{"turn": 3, "quote": "port হবে 8443"}]})).unwrap();
    repair::check_proposal(&mem, &p, &originals).unwrap();
    let (next, detail) = repair::apply_proposal(&mem, &p, 5).unwrap();
    assert_eq!(next.segments[0].summary, "setup; port 8443 chosen in turn 3");
    assert_eq!(repair::revert_detail(&next, &detail, 6).unwrap().segments[0].summary, "earlier work");
}

#[test]
fn reverting_a_repair_decision_that_later_replaced_another_is_refused() {
    let mut m = mem_with(7, &[("D1", "a", 2)]);
    m.next_decision = 2;
    m.decisions.current.push(Decision { id: "D2".into(), text: "b".into(), turn: 3, origin: "repair".into(), ..Default::default() });
    let detail = json!({"kind": "decision", "added": "D2"});
    let mut later = m.clone();
    let d2 = later.decisions.current.remove(1);
    later.decisions.superseded.push(Decision { superseded_by: Some("D3".into()), superseded_at: Some(8), ..d2 });
    later.decisions.current.push(Decision { id: "D3".into(), text: "c".into(), turn: 8, origin: "summary".into(), ..Default::default() });
    later.through_turn = 8;
    later.segments.push(Segment { from_turn: 8, to_turn: 8, ..Default::default() });
    assert!(repair::revert_detail(&later, &detail, 1).is_err());
}

// ── Recall: index first, status lines ──────────────────────────────────────────────

#[test]
fn recall_picks_the_matching_segments_from_the_index_in_turn_order() {
    let mut m = TurnMemory { through_turn: 30, ..Default::default() };
    for (a, b, topic, s) in [(1, 7, "setup", "repo layout and CI"), (8, 14, "database", "chose PostgreSQL schema"), (15, 21, "ui", "dropdown styling"), (22, 30, "database", "migrated to SQLite")] {
        m.segments.push(Segment { from_turn: a, to_turn: b, topic: topic.into(), title: String::new(), summary: s.into() });
    }
    let picked = select_segments(&m, "which database did we pick?", 40);
    assert_eq!(picked, vec![(8, 14), (22, 30)]);
    assert_eq!(select_segments(&m, "dropdown", 40), vec![(15, 21)]);
    assert!(select_segments(&m, "kubernetes", 40).is_empty());
    assert_eq!(select_segments(&m, "database", 7), vec![(22, 28)], "the budget caps the turns read");
    // Bengali words match too.
    m.segments[2].summary = "ড্রপডাউনের রং ঠিক করা".into();
    assert_eq!(select_segments(&m, "ড্রপডাউনের রং কী ছিল?", 40), vec![(15, 21)]);
    // Topic grouping keeps turn order inside a topic.
    let g = topic_groups(&m);
    assert_eq!(g[1], ("database".to_string(), vec![(8, 14), (22, 30)]));
    assert!(render(&m).contains("database (turns 8-14, 22-30)"));
}

#[tokio::test]
async fn recall_answers_carry_citations_and_repair_proposals_separately() {
    let mem = mem_with(7, &[]);
    let model = Script::new(|_, user| {
        assert!(user.contains("ORIGINAL MESSAGES") && user.contains("### Turn 3"));
        Ok(json!({"answer": "Port 8443 (turn 3, current).", "citations": [{"turn": 3, "quote": "port 8443"}], "repair": {"kind": "fact", "text": "port is 8443", "turn": 3, "evidence": [{"turn": 3, "quote": "port 8443"}]}}).to_string())
    });
    let texts = vec![(3, render_turn(3, &[Message::user("we use port 8443")]))];
    let out = recall(&model, &mem, &texts, "which port?", 50_000, 512, &cnt).await.unwrap();
    assert_eq!(out.answer, "Port 8443 (turn 3, current).");
    assert_eq!(out.citations, vec![Citation { turn: 3, quote: "port 8443".into() }]);
    assert_eq!(out.repairs.len(), 1);
    // Plain text (no JSON) still comes back as the answer.
    let model = Script::new(|_, _| Ok("just text".into()));
    assert_eq!(recall(&model, &mem, &texts, "q", 50_000, 512, &cnt).await.unwrap().answer, "just text");
}

// ── Edge cases ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn empty_turns_are_still_turns_and_must_be_covered() {
    let turns: Vec<(u32, Vec<Message>)> = (1..=7).map(|n| (n, vec![Message::user("")])).collect();
    let msgs = flat(&turns);
    assert_eq!(split_turns(&msgs).len(), 7);
    let model = Script::new(|_, user| Ok(good_answer(user, vec![], vec![], &[])));
    let out = summarize(&model, &TurnMemory::default(), &turns, 1, 7).await.unwrap();
    assert_eq!(out.memory.segments.len(), 7);
    assert!(split_turns(&[]).is_empty());
    assert!(plan_batches(0, 0, &MemorySettings::default()).is_empty());
}

#[tokio::test]
async fn a_huge_single_bengali_turn_is_split_into_portions_without_breaking_characters() {
    let para = "আমরা ডাটাবেস হিসেবে SQLite ব্যবহার করব কারণ এটা ফোনে চলে। ";
    let mut huge = String::new();
    while huge.len() < 600_000 {
        huge.push_str(para);
        if huge.len() % 7 == 0 {
            huge.push('\n');
        }
    }
    huge.push_str("শেষের কথা: পোর্ট 8443");
    let turns = vec![(1u32, vec![Message::user(&huge), Message::assistant_text("ঠিক আছে")])];
    let texts: Vec<(u32, String)> = turns.iter().map(|(n, m)| (*n, render_turn(*n, m))).collect();
    let parts = portions(&texts, 20_000, &cnt);
    assert!(parts.len() > 5);
    for (a, b, body) in &parts {
        assert_eq!((*a, *b), (1, 1));
        assert!(cnt(body) <= 20_000 + 50, "portion within budget");
    }
    let joined: String = parts.iter().map(|p| p.2.split_once(")\n").filter(|_| p.2.starts_with("### Turn 1 (continued")).map(|x| x.1.to_string()).unwrap_or(p.2.clone())).collect();
    assert_eq!(joined, texts[0].1, "nothing lost, nothing broken");
    // Summarized through portion sub-agents and a merge call.
    let model = Script::new(|sys, user| {
        if sys.starts_with("You are one of several summarizer") {
            return Ok(r#"{"segments":[{"fromTurn":1,"toTurn":1,"summary":"part"}]}"#.into());
        }
        assert!(sys.starts_with("You merge"));
        assert!(user.contains("Notes from"));
        Ok(json!({"segments": [{"fromTurn": 1, "toTurn": 1, "topic": "ডাটাবেস", "summary": "SQLite ব্যবহার হবে"}], "decisions": {"current": [{"id": "N1", "text": "SQLite ব্যবহার করা হবে", "turn": 1}]}}).to_string())
    });
    let ids = HashMap::new();
    let job = SummarizeJob { turns: &turns, from: 1, to: 1, input_limit: 20_000, max_output: 1_024, result_ids: &ids, now_ms: 1 };
    let out = summarize_range(&model, &TurnMemory::default(), &job, &cnt).await.unwrap();
    assert!(out.portions > 1 && out.portions <= 12);
    assert_eq!(out.memory.decisions.current[0].text, "SQLite ব্যবহার করা হবে");
    assert_eq!(out.memory.segments[0].topic, "ডাটাবেস");
}

#[test]
fn the_earlier_memory_format_loads_and_its_decisions_are_protected() {
    let conn = db();
    let old = r#"{"throughTurn":7,"goal":"g","segments":[{"fromTurn":1,"toTurn":7,"title":"setup","summary":"s"}],"decisions":["use rust","deploy on fly"],"facts":["port 8443"],"preferences":[],"openItems":[],"files":[],"updatedAt":1,"calls":1}"#;
    conn.execute("INSERT INTO turn_memory (session_key, memory_json, through_turn, updated_at) VALUES ('c', ?1, 7, 1)", [old]).unwrap();
    let m = load_memory(&conn, "c");
    assert_eq!(m.version, 0);
    assert_eq!(m.decisions.current.iter().map(|d| (d.id.as_str(), d.turn)).collect::<Vec<_>>(), vec![("D1", 0), ("D2", 0)]);
    assert_eq!(m.next_decision, 2);
    assert_eq!(m.facts[0], Note { text: "port 8443".into(), turn: 0 });
    assert_eq!(m.segments[0].topic, "");
    assert!(render(&m).contains("[setup]"), "a missing topic falls back to the title");
    // Keeping both legacy decisions is valid; dropping one is not.
    let keep = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}],"decisions":{"current":[{"id":"D1"},{"id":"D2"}]},"facts":[{"text":"port 8443","turn":0}]}"#).unwrap();
    let next = apply_update(&m, &keep, 8, 8, 2).unwrap();
    assert_eq!(next.facts[0].turn, 0, "a carried-over fact keeps its unknown turn");
    let drop = parse_update(r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}],"decisions":{"current":[{"id":"D1"}]}}"#).unwrap();
    assert!(apply_update(&m, &drop, 8, 8, 2).is_err());
    // The first save on a row from the older schema works (version 0 → 1).
    assert_eq!(save_version(&conn, "c", 0, &next, "summary", &json!({}), None, 2).unwrap(), 1);
}

#[test]
fn an_older_table_without_the_new_columns_is_migrated() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE turn_memory (session_key TEXT PRIMARY KEY, memory_json TEXT NOT NULL, through_turn INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0); INSERT INTO turn_memory VALUES ('c', '{\"throughTurn\":3}', 3, 1);").unwrap();
    let m = load_memory(&conn, "c");
    assert_eq!((m.through_turn, m.version), (3, 0));
    assert_eq!(load_status(&conn, "c").status, "ok");
    set_status(&conn, "c", "pending", "summary failed, will retry", 2).unwrap();
    assert_eq!(load_status(&conn, "c").retries, 1);
    set_status(&conn, "c", "pending", "summary failed, will retry", 3).unwrap();
    assert_eq!(load_status(&conn, "c").retries, 2);
}

#[test]
fn coarsen_never_drops_current_decisions() {
    let mut m = mem_with(0, &[]);
    m.through_turn = 200;
    for i in 0..40u32 {
        m.segments.push(Segment { from_turn: i * 5 + 1, to_turn: i * 5 + 5, topic: "t".into(), title: "x".repeat(50), summary: "y".repeat(600) });
        m.decisions.current.push(Decision { id: format!("D{}", i + 1), text: format!("decision {}", i), turn: i * 5 + 1, ..Default::default() });
        m.decisions.superseded.push(Decision { id: format!("D{}", i + 100), text: "old".into(), turn: 1, superseded_by: Some("D1".into()), superseded_at: Some(2), ..Default::default() });
    }
    coarsen(&mut m, 2_000, &cnt);
    assert_eq!(m.decisions.current.len(), 40);
    assert!(m.decisions.superseded.is_empty() || cnt(&render(&m)) <= 2_000);
    assert_eq!(m.segments.first().unwrap().from_turn, 1);
    assert_eq!(m.segments.last().unwrap().to_turn, 200);
}

#[test]
fn reset_is_a_version_and_clears_the_archive() {
    let (conn, _) = repair_fixture();
    let v = reset_memory(&conn, "c", "user reset", 9).unwrap();
    assert_eq!(v, 2);
    let m = load_memory(&conn, "c");
    assert_eq!((m.through_turn, m.decisions.current.len()), (0, 0));
    assert!(load_turns(&conn, "c", 1, 7).is_empty());
    assert_eq!(list_versions(&conn, "c")[0]["kind"], "reset");
}

// ── The memory screen's result list and in-progress marker ──

#[test]
fn referenced_result_ids_reads_only_real_references() {
    assert_eq!(referenced_result_ids("see [result #R12, 2.0 MB] and #R3, #R12 again"), vec![3, 12]);
    assert_eq!(referenced_result_ids("#R #Rx #R0 R7 #R5abc"), Vec::<u64>::new());
    assert_eq!(referenced_result_ids("\u{9AB}\u{9B2} #R4\u{964}"), vec![4], "Bengali text around a reference");
}

#[test]
fn list_results_marks_missing_ids_unavailable() {
    let c = db();
    for (i, id) in ["t1", "t2", "t3"].iter().enumerate() {
        store_result(&c, "s", id, "read_file", Some("/a.txt"), &format!("body {i} {}", "x".repeat(400)), false, Some(2), 1).unwrap();
    }
    store_result(&c, "other", "t9", "web_fetch", None, "other chat", false, None, 1).unwrap();
    // R2 is gone, and the summary still mentions a never-seen R7.
    c.execute("DELETE FROM tool_results WHERE session_key = 's' AND result_no = 2", []).unwrap();
    let mut mem = TurnMemory::default();
    mem.facts.push(Note { text: "see #R7".into(), turn: 1 });
    save(&c, "s", &mem, "summary");
    let v = list_results(&c, "s");
    let ids: Vec<&str> = v["results"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["R1", "R3"]);
    assert!(v["results"][0]["preview"].as_str().unwrap().chars().count() <= 161);
    assert_eq!(v["results"][0]["tool"], "read_file");
    let un: Vec<&str> = v["unavailable"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(un, vec!["R2", "R7"]);
    assert_eq!(v["unavailable"][1]["referencedIn"][0], "summary");
    assert!(list_results(&c, "nobody")["results"].as_array().unwrap().is_empty());
}

#[test]
fn summarizing_marker_clears_when_its_guard_drops() {
    assert_eq!(summarizing("chat-x"), None);
    let g = mark_summarizing("chat-x", 1, 7);
    assert_eq!(summarizing("chat-x"), Some((1, 7)));
    let g2 = mark_summarizing("chat-x", 8, 14);
    drop(g);
    assert_eq!(summarizing("chat-x"), Some((8, 14)), "an older guard leaves the newer batch");
    drop(g2);
    assert_eq!(summarizing("chat-x"), None);
}
