//! Phase 0 regression tests for the defects found by the memory audit
//! (W-2, W-3, W-4, W-5, W-11 in MEMORY_GAP_ANALYSIS.md). Each test states
//! the invariant the fixed code must keep; on the audited commit (aea3dbd)
//! the W-2, W-4, W-5 and W-11 tests fail, which proves the defect.
//! W-1 lives in `agent_loop/memory_loop.rs`, rewind/clear through the host
//! API in `lib.rs`.

use super::*;
use crate::types::Message;
use rusqlite::Connection;
use serde_json::json;

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    c
}

fn turn(n: u32, user: &str, answer: &str) -> Vec<Message> {
    vec![
        Message::user(user),
        Message { role: crate::types::Role::Assistant, content: crate::types::MessageContent::Text(format!("{answer} (turn {n})")) },
    ]
}

fn archive_one(conn: &Connection, key: &str, n: u32, msgs: &[Message]) {
    let t = Turn { no: n, start: 0, end: msgs.len() };
    archive_turns(conn, key, msgs, &[t], 1).unwrap();
}

fn base_with_notes(through: u32, facts: &[(&str, u32)]) -> TurnMemory {
    TurnMemory {
        through_turn: through,
        segments: vec![Segment { from_turn: 1, to_turn: through, topic: "t".into(), title: "t".into(), summary: "s".into(), created_at: 0, ..Default::default() }],
        facts: facts.iter().map(|(t, n)| Note { text: t.to_string(), turn: *n }).collect(),
        ..Default::default()
    }
}

/// W-2: a turn number re-archived with different content (the transcript
/// was rewound and the turn re-asked) must replace the old row, even when
/// the new turn is shorter. The old guard kept the longer, stale row.
#[test]
fn w2_rearchiving_a_rewound_turn_replaces_the_stale_longer_row() {
    let conn = db();
    let old = turn(9, "old question with a very long body that was later rewound away STALE-TEXT", &"x".repeat(4_000));
    archive_one(&conn, "c", 9, &old);
    let new = turn(9, "new short question", "short");
    archive_one(&conn, "c", 9, &new);
    let got = load_turns(&conn, "c", 9, 9);
    assert_eq!(got.len(), 1);
    let text = serde_json::to_string(&got[0].1).unwrap();
    assert!(!text.contains("STALE-TEXT"), "stale archived turn served after a rewind: {}", clip(&text, 200));
    assert!(text.contains("new short question"));
}

/// W-3: the real chat-clear path (`db::clear_session`) removes every memory
/// row of the chat, not only the transcript.
#[test]
fn w3_clearing_a_chat_removes_memory_versions_archive_and_results() {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    let mem = base_with_notes(1, &[("fact", 1)]);
    save_version(&conn, "c", 0, &mem, "summary", &json!({}), None, 1).unwrap();
    archive_one(&conn, "c", 1, &turn(1, "q", "a"));
    store_result(&conn, "c", "tu1", "read_file", None, &"r".repeat(2_000), false, Some(1), 1).unwrap();
    crate::db::clear_session(&conn, "c").unwrap();
    for t in ["turn_memory", "turn_memory_versions", "turn_archive", "tool_results"] {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {t} WHERE session_key = 'c'"), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{t} still has rows after clear_session");
    }
}

/// W-4: a fact the summarizer leaves out of its answer is not removed; a
/// current item only leaves the current set through an explicit operation.
#[test]
fn w4_facts_left_out_of_a_summary_stay_current() {
    let base = base_with_notes(7, &[("FACT-A the server runs on port 8443", 2), ("FACT-B the database is sqlite", 4), ("FACT-C deploys on fridays", 6)]);
    let up = parse_update(&json!({
        "segments": [{"fromTurn": 8, "toTurn": 9, "topic": "x", "title": "x", "summary": "more work"}],
        "facts": [{"text": "FACT-B the database is sqlite", "turn": 4}]
    }).to_string()).unwrap();
    let next = apply_update(&base, &up, 8, 9, 1).expect("valid update");
    let all = serde_json::to_string(&next).unwrap();
    for f in ["FACT-A", "FACT-B", "FACT-C"] {
        assert!(all.contains(f), "{f} silently disappeared from the memory");
    }
}

/// W-4: more than 40 notes are never cut silently by the list cap.
#[test]
fn w4_the_list_cap_never_drops_current_facts() {
    let facts: Vec<(String, u32)> = (1..=40).map(|i| (format!("FACT-{i:02} detail"), 1)).collect();
    let refs: Vec<(&str, u32)> = facts.iter().map(|(t, n)| (t.as_str(), *n)).collect();
    let base = base_with_notes(7, &refs);
    let mut list: Vec<serde_json::Value> = facts.iter().map(|(t, n)| json!({"text": t, "turn": n})).collect();
    for i in 41..=45 {
        list.push(json!({"text": format!("FACT-{i:02} detail"), "turn": 8}));
    }
    let up = parse_update(&json!({
        "segments": [{"fromTurn": 8, "toTurn": 8, "topic": "x", "title": "x", "summary": "five new facts"}],
        "facts": list
    }).to_string()).unwrap();
    let next = apply_update(&base, &up, 8, 8, 1).expect("valid update");
    let all = serde_json::to_string(&next).unwrap();
    for i in 1..=45 {
        assert!(all.contains(&format!("FACT-{i:02} detail")), "FACT-{i:02} was dropped by the list cap");
    }
}

/// W-4: open items and files are protected the same way.
#[test]
fn w4_open_items_and_files_left_out_stay_current() {
    let mut base = base_with_notes(7, &[]);
    base.open_items = vec!["OPEN-1 write the migration".into(), "OPEN-2 add tests".into()];
    base.files = vec!["src/a.rs".into(), "src/b.rs".into()];
    let up = parse_update(&json!({
        "segments": [{"fromTurn": 8, "toTurn": 8, "topic": "x", "title": "x", "summary": "s"}],
        "openItems": ["OPEN-2 add tests"],
        "files": ["src/b.rs"]
    }).to_string()).unwrap();
    let next = apply_update(&base, &up, 8, 8, 1).expect("valid update");
    let all = serde_json::to_string(&next).unwrap();
    for x in ["OPEN-1", "OPEN-2", "src/a.rs", "src/b.rs"] {
        assert!(all.contains(x), "{x} silently disappeared");
    }
}

/// W-5: a reset is one transaction. When saving the reset version fails,
/// the archived turns must still be there (nothing half-done).
#[test]
fn w5_a_failed_reset_leaves_memory_and_archive_untouched() {
    let conn = db();
    let mem = base_with_notes(2, &[("fact", 1)]);
    save_version(&conn, "c", 0, &mem, "summary", &json!({}), None, 1).unwrap();
    archive_one(&conn, "c", 1, &turn(1, "q1", "a1"));
    archive_one(&conn, "c", 2, &turn(2, "q2", "a2"));
    store::FAIL_AFTER.with(|f| *f.borrow_mut() = Some("memory"));
    let r = reset_memory(&conn, "c", "test", 2);
    store::FAIL_AFTER.with(|f| *f.borrow_mut() = None);
    assert!(r.is_err(), "the injected failure must surface");
    assert_eq!(load_memory(&conn, "c").version, 1, "memory unchanged");
    assert_eq!(load_turns(&conn, "c", 1, 2).len(), 2, "archive deleted although the reset failed");
}

/// W-11: a corrupt live row is not loaded as an empty memory while a good
/// version exists in the history.
#[test]
fn w11_corrupt_memory_json_falls_back_to_the_last_good_version() {
    let conn = db();
    let mem = base_with_notes(7, &[("FACT-KEEP", 3)]);
    save_version(&conn, "c", 0, &mem, "summary", &json!({}), None, 1).unwrap();
    conn.execute("UPDATE turn_memory SET memory_json = '{not json' WHERE session_key = 'c'", []).unwrap();
    let got = load_memory(&conn, "c");
    assert_eq!(got.through_turn, 7, "corrupt row loaded as an empty memory");
    assert!(serde_json::to_string(&got).unwrap().contains("FACT-KEEP"));
}
