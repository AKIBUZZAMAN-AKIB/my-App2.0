//! Phase 5: source-grounded turns, no silent truncation in recall,
//! `Decision.reason`, deterministic coverage (test strategy G1-G3).

use super::source::{self, Origin};
use super::*;
use crate::types::Message;
use rusqlite::Connection;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn chat(n: u32, tag: &str) -> Vec<Message> {
    let mut v = Vec::new();
    for i in 1..=n {
        v.push(Message::user(&format!("{} question {}", tag, i)));
        v.push(Message::assistant_text(&format!("{} answer {}", tag, i)));
    }
    v
}

fn db_with(messages: &[Message]) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    crate::db::save_session(&conn, "c", "main", &serde_json::to_string(messages).unwrap(), None, None, 1, None).unwrap();
    conn
}

fn archive(conn: &Connection, messages: &[Message], upto: u32) {
    let turns = split_turns(messages);
    let m = TurnMemory { through_turn: upto, segments: vec![Segment { from_turn: 1, to_turn: upto, topic: "t".into(), title: "t".into(), summary: "s".into() }], ..Default::default() };
    store::save_version(conn, "c", 0, &m, "summary", &json!({}), Some(ArchiveTurns { messages, turns: &turns[..upto as usize] }), 1).unwrap();
}

#[test]
fn turns_come_from_the_transcript_and_a_differing_archive_is_reported() {
    let msgs = chat(6, "v1");
    let conn = db_with(&msgs);
    archive(&conn, &msgs, 4);
    let mut edited = msgs.clone();
    edited[3] = Message::assistant_text("v2 answer 2 (edited)");
    crate::db::save_session(&conn, "c", "main", &serde_json::to_string(&edited).unwrap(), None, None, 2, None).unwrap();
    let src = source::load_source_turns(&conn, "c", 1, 6);
    assert_eq!(src.turns.len(), 6, "unsummarized turns are readable too");
    assert!(src.origins.values().all(|o| *o == Origin::Transcript));
    assert_eq!(src.archive_differs, vec![2]);
    let t2 = render_turn(2, &src.turns[1].1);
    assert!(t2.contains("(edited)"), "the transcript wins: {}", t2);
    assert!(src.missing.is_empty());
}

#[test]
fn the_archive_is_a_fallback_and_missing_turns_are_named() {
    let msgs = chat(6, "a");
    let conn = db_with(&msgs);
    archive(&conn, &msgs, 6);
    let short: Vec<Message> = msgs[..6].to_vec();
    crate::db::save_session(&conn, "c", "main", &serde_json::to_string(&short).unwrap(), None, None, 2, None).unwrap();
    let src = source::load_source_turns(&conn, "c", 1, 9);
    assert_eq!(src.turns.len(), 6);
    assert_eq!(src.from_archive(), vec![4, 5, 6]);
    assert_eq!(src.missing, vec![(7, 9)]);
    assert_eq!(source::ranges(&[1, 2, 3, 5, 7, 8]), vec![(1, 3), (5, 5), (7, 8)]);
    assert_eq!(source::ranges_text(&[(1, 3), (5, 5)]), "turns 1-3, turn 5");
}

#[test]
fn the_turn_index_is_deterministic_and_changes_with_the_text() {
    let msgs = chat(3, "x");
    let a = source::turn_index(&msgs);
    assert_eq!(a, source::turn_index(&msgs.clone()));
    assert_eq!(a.iter().map(|t| (t.no, t.start, t.end)).collect::<Vec<_>>(), vec![(1, 0, 2), (2, 2, 4), (3, 4, 6)]);
    let mut b = msgs.clone();
    b[5] = Message::assistant_text("changed");
    let b = source::turn_index(&b);
    assert_eq!(a[..2], b[..2]);
    assert_ne!(a[2].hash, b[2].hash);
}

#[test]
fn coverage_finds_gaps_overlaps_and_sourceless_entries() {
    let mut m = TurnMemory { through_turn: 10, ..Default::default() };
    m.segments = vec![
        Segment { from_turn: 1, to_turn: 4, topic: "a".into(), title: "a".into(), summary: "s".into() },
        Segment { from_turn: 4, to_turn: 6, topic: "a".into(), title: "a".into(), summary: "s".into() },
        Segment { from_turn: 9, to_turn: 12, topic: "a".into(), title: "a".into(), summary: "s".into() },
    ];
    m.decisions.current.push(Decision { id: "D1".into(), text: "x".into(), turn: 0, ..Default::default() });
    m.decisions.current.push(Decision { id: "D2".into(), text: "y".into(), turn: 3, ..Default::default() });
    m.items.push(items::MemoryItem { id: "F1".into(), kind: "fact".into(), text: "t".into(), status: "current".into(), source_turns: vec![11], ..Default::default() });
    m.items.push(items::MemoryItem { id: "F2".into(), kind: "fact".into(), text: "t".into(), status: "current".into(), source_turns: vec![], ..Default::default() });
    let src = source::SourceTurns { missing: vec![(1, 2)], ..Default::default() };
    let c = source::coverage_of(&m, 14, &src);
    assert!(!c.ok);
    assert_eq!(c.gaps, vec![(7, 8)]);
    assert_eq!(c.overlaps, vec![(4, 4)]);
    assert_eq!(c.beyond_summary, vec![(11, 12)]);
    assert_eq!(c.decisions_without_source, vec!["D1".to_string()]);
    assert_eq!(c.items_without_source, vec!["F1".to_string()]);
    assert_eq!(c.legacy_items, 1);
    assert_eq!(c.unsummarized, Some((11, 14)));
    assert_eq!(c.originals_missing, vec![(1, 2)]);
    assert_eq!(c.problems.len(), 6, "{:?}", c.problems);
}

#[test]
fn coverage_of_a_real_summary_is_clean() {
    let msgs = chat(9, "r");
    let conn = db_with(&msgs);
    archive(&conn, &msgs, 7);
    let mem = load_memory(&conn, "c");
    let c = source::coverage(&conn, "c", &mem);
    assert!(c.ok, "{:?}", c.problems);
    assert_eq!((c.through_turn, c.transcript_turns, c.unsummarized), (7, 9, Some((8, 9))));
    assert!(c.archive_only.is_empty() && c.archive_differs.is_empty());
}

fn base_with(id: &str, text: &str, turn: u32, through: u32) -> TurnMemory {
    let mut m = TurnMemory { through_turn: through, ..Default::default() };
    m.segments.push(Segment { from_turn: 1, to_turn: through, topic: "t".into(), title: "t".into(), summary: "s".into() });
    m.decisions.current.push(Decision { id: id.into(), text: text.into(), turn, origin: "summary".into(), ..Default::default() });
    m.normalize();
    m
}

const UP1: &str = r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"switch"}],"decisions":{"current":[{"id":"N1","text":"Use SQLite","turn":8}],"superseded":[{"id":"D1","supersededBy":"N1","turn":8,"reason":"the user wants one file on the phone"}]}}"#;
const UP2: &str = r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}],"decisions":{"current":[{"id":"N1","text":"Use SQLite","turn":8,"supersedes":["D1"],"reason":"simpler"}]}}"#;
const UP3: &str = r#"{"segments":[{"fromTurn":8,"toTurn":8,"summary":"x"}],"decisions":{"current":[{"id":"N1","text":"Use SQLite","turn":8}],"superseded":[{"id":"D1","supersededBy":"N1"}]}}"#;

#[test]
fn a_replaced_decision_keeps_its_reason_and_it_cannot_be_dropped_later() {
    let base = base_with("D1", "Use PostgreSQL", 3, 7);
    let m = apply_update(&base, &parse_update(UP1).unwrap(), 8, 8, 2).unwrap();
    let d1 = m.decisions.superseded.iter().find(|d| d.id == "D1").unwrap();
    assert_eq!(d1.reason.as_deref(), Some("the user wants one file on the phone"));
    assert!(render(&m).contains("(reason: the user wants one file on the phone)"), "{}", render(&m));
    let m2 = apply_update(&base, &parse_update(UP2).unwrap(), 8, 8, 2).unwrap();
    assert_eq!(m2.decisions.superseded[0].reason.as_deref(), Some("simpler"));
    let v = serde_json::to_value(&m.decisions.superseded[0]).unwrap();
    assert_eq!(v["reason"], "the user wants one file on the phone");
    let old: Decision = serde_json::from_value(json!({"id": "D9", "text": "x", "turn": 1})).unwrap();
    assert!(old.reason.is_none());
    let mut tampered = m.clone();
    tampered.decisions.superseded[0].reason = None;
    let errs = validate_transition(&m, &tampered, &[]).unwrap_err();
    assert!(errs.iter().any(|e| e.contains("reason")), "{:?}", errs);
    assert!(apply_update(&base, &parse_update(UP3).unwrap(), 8, 8, 2).unwrap().decisions.superseded[0].reason.is_none());
}

struct Counting(AtomicUsize);
impl TextModel for Counting {
    async fn complete(&self, _s: &str, _user: String, _m: u32) -> Result<String, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"answer": "read", "citations": []}).to_string())
    }
}

#[tokio::test]
async fn recall_reports_the_turns_it_did_not_read_instead_of_dropping_them() {
    let texts: Vec<(u32, String)> = (1..=30).map(|n| (n, format!("### Turn {}\n{}", n, "word ".repeat(1_000)))).collect();
    let model = Counting(AtomicUsize::new(0));
    let count = |s: &str| s.split_whitespace().count();
    let out = recall(&model, &TurnMemory::default(), &texts, "q", 1_500, 512, &count).await.unwrap();
    assert_eq!(model.0.load(Ordering::SeqCst), MAX_RECALL_PORTIONS + 1, "12 portions + the combining call");
    assert!(!out.unread.is_empty(), "turns past the portion limit are reported");
    let unread: u32 = out.unread.iter().map(|(a, b)| b - a + 1).sum();
    assert_eq!(out.unread.last().unwrap().1, 30);
    assert!(unread >= 30 - MAX_RECALL_PORTIONS as u32);
    let out = recall(&model, &TurnMemory::default(), &texts[..2], "q", 50_000, 512, &count).await.unwrap();
    assert!(out.unread.is_empty());
}
