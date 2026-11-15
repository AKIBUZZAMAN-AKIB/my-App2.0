//! Item lifecycle (ADR-2): stable IDs, explicit operations with reasons,
//! supersession links, legacy conversion, and the validation gate.

use super::items::{self, Kind};
use super::*;
use serde_json::json;

fn mem_with(facts: &[(&str, u32)]) -> TurnMemory {
    let mut m = TurnMemory {
        through_turn: 7,
        segments: vec![Segment { from_turn: 1, to_turn: 7, topic: "t".into(), title: "t".into(), summary: "s".into() }],
        facts: facts.iter().map(|(t, n)| Note { text: t.to_string(), turn: *n }).collect(),
        ..Default::default()
    };
    m.normalize();
    m
}

fn update(v: serde_json::Value) -> SummaryUpdate {
    let mut v = v;
    v["segments"] = json!([{"fromTurn": 8, "toTurn": 9, "topic": "x", "title": "x", "summary": "s"}]);
    parse_update(&v.to_string()).unwrap()
}

#[test]
fn legacy_lists_become_items_with_stable_ids() {
    let mut m = TurnMemory { facts: vec![Note { text: "port 8443".into(), turn: 3 }], files: vec!["src/a.rs".into()], open_items: vec!["write docs".into()], ..Default::default() };
    m.normalize();
    let ids: Vec<&str> = m.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, ["F1", "L2", "O3"]);
    assert!(m.items.iter().all(|i| i.is_current() && i.origin == "legacy"));
    assert_eq!(m.items[0].source_turns, vec![3]);
    assert!(m.items[1].source_turns.is_empty(), "unknown turn stays unknown, not invented");
    assert_eq!(m.next_item, 3);
    // Normalizing again is stable.
    let before = m.items.clone();
    m.normalize();
    assert_eq!(m.items, before);
}

#[test]
fn add_assigns_new_ids_and_never_reuses_one() {
    let base = mem_with(&[("a", 1)]);
    let up = update(json!({"items": {"add": [{"kind": "fact", "text": "b", "turn": 8}, {"kind": "openItem", "text": "c", "turn": 9}]}}));
    let next = apply_update(&base, &up, 8, 9, 1).unwrap();
    let ids: Vec<&str> = next.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, ["F1", "F2", "O3"]);
    assert_eq!(next.open_items, vec!["c".to_string()], "lists mirror current items");
    // Retire F2; a later add gets 4, not 2.
    let up2 = parse_update(&json!({"segments": [{"fromTurn": 10, "toTurn": 10, "topic": "x", "title": "x", "summary": "s"}], "items": {"close": [{"id": "F2", "status": "retired", "turn": 10, "reason": "wrong"}], "add": [{"kind": "fact", "text": "d", "turn": 10}]}}).to_string()).unwrap();
    let n2 = apply_update(&next, &up2, 10, 10, 1).unwrap();
    assert!(n2.items.iter().any(|i| i.id == "F4"));
    let f2 = n2.items.iter().find(|i| i.id == "F2").unwrap();
    assert_eq!(f2.status, "retired");
    assert_eq!(f2.reason, "wrong");
    assert_eq!(f2.history.last().unwrap().change, "retired");
}

#[test]
fn supersede_links_old_to_new_and_keeps_history() {
    let base = mem_with(&[("port is 8443", 2)]);
    let up = update(json!({"items": {"add": [{"kind": "fact", "text": "port is 9000", "turn": 9, "supersedes": "F1", "reason": "user moved the server"}]}}));
    let next = apply_update(&base, &up, 8, 9, 1).unwrap();
    let old = &next.items[0];
    assert_eq!(old.status, "superseded");
    assert_eq!(old.superseded_by.as_deref(), Some("F2"));
    assert_eq!(old.reason, "user moved the server");
    assert_eq!(next.facts.len(), 1);
    assert_eq!(next.facts[0].text, "port is 9000");
    assert!(!render(&next).contains("8443"), "only current items reach the model");
}

#[test]
fn update_rewords_with_history_and_source_turn() {
    let base = mem_with(&[("db is postgres", 2)]);
    let up = update(json!({"items": {"update": [{"id": "F1", "text": "db is postgres 16", "turn": 8, "reason": "version given"}]}}));
    let next = apply_update(&base, &up, 8, 9, 1).unwrap();
    let f = &next.items[0];
    assert_eq!(f.text, "db is postgres 16");
    assert_eq!(f.source_turns, vec![2, 8]);
    assert_eq!(f.history[0].text, "db is postgres");
}

#[test]
fn invalid_operations_are_rejected_not_applied() {
    let base = mem_with(&[("a", 1)]);
    for (ops, why) in [
        (json!({"close": [{"id": "F1", "status": "retired", "turn": 8}]}), "reason"),
        (json!({"close": [{"id": "F9", "status": "done", "turn": 8, "reason": "x"}]}), "unknown"),
        (json!({"close": [{"id": "F1", "status": "deleted", "turn": 8, "reason": "x"}]}), "status"),
        (json!({"update": [{"id": "F1", "text": "b", "turn": 99}]}), "source turn"),
        (json!({"add": [{"kind": "fact", "text": "b", "turn": 0}]}), "source turn"),
        (json!({"add": [{"kind": "gossip", "text": "b", "turn": 8}]}), "unknown kind"),
        (json!({"add": [{"kind": "fact", "text": "b", "turn": 8, "supersedes": "F7"}]}), "unknown item"),
        (json!({"update": [{"id": "F1", "text": "b", "turn": 8}], "close": [{"id": "F1", "status": "done", "turn": 8, "reason": "x"}]}), "twice"),
    ] {
        let up = update(json!({"items": ops}));
        let err = apply_update(&base, &up, 8, 9, 1).expect_err(why).join("; ");
        assert!(err.to_lowercase().contains(why), "{why}: {err}");
    }
}

#[test]
fn closed_items_cannot_be_revived_by_an_old_style_list() {
    let base = mem_with(&[("a", 1)]);
    let up = update(json!({"items": {"close": [{"id": "F1", "status": "retired", "turn": 8, "reason": "no longer true"}]}}));
    let next = apply_update(&base, &up, 8, 9, 1).unwrap();
    let up2 = parse_update(&json!({"segments": [{"fromTurn": 10, "toTurn": 10, "topic": "x", "title": "x", "summary": "s"}], "facts": [{"text": "a", "turn": 1}]}).to_string()).unwrap();
    let n2 = apply_update(&next, &up2, 10, 10, 1).unwrap();
    assert_eq!(n2.items.len(), 1);
    assert_eq!(n2.items[0].status, "retired");
}

#[test]
fn the_gate_rejects_lost_items_and_reasonless_status_changes() {
    let prev = mem_with(&[("a", 1), ("b", 2)]);
    let mut lost = prev.clone();
    lost.items.remove(0);
    let e = validate_transition(&prev, &lost, &[]).unwrap_err().join("; ");
    assert!(e.contains("F1") && e.contains("lost"), "{e}");
    let mut silent = prev.clone();
    silent.items[1].status = "retired".into();
    let e = validate_transition(&prev, &silent, &[]).unwrap_err().join("; ");
    assert!(e.contains("without a reason"), "{e}");
    let mut dangling = prev.clone();
    dangling.items[0].status = "superseded".into();
    dangling.items[0].reason = "x".into();
    dangling.items[0].superseded_by = Some("F42".into());
    assert!(validate_transition(&prev, &dangling, &[]).unwrap_err().join("; ").contains("replacement"));
    // An allowed removal (revert of a repair) passes.
    assert!(validate_transition(&prev, &lost, &["F1".to_string()]).is_ok());
}

#[test]
fn many_items_are_all_kept_and_shown() {
    let facts: Vec<(String, u32)> = (1..=120).map(|i| (format!("FACT-{i:03}"), 1 + i % 7)).collect();
    let refs: Vec<(&str, u32)> = facts.iter().map(|(t, n)| (t.as_str(), *n)).collect();
    let base = mem_with(&refs);
    let up = update(json!({"items": {"add": [{"kind": "fact", "text": "FACT-NEW", "turn": 9}]}}));
    let next = apply_update(&base, &up, 8, 9, 1).unwrap();
    assert_eq!(next.items.iter().filter(|i| i.is_current()).count(), 121);
    let mut view = next.clone();
    coarsen(&mut view, 2_000, &|t: &str| t.len() / 4);
    let r = render(&view);
    for i in 1..=120 {
        assert!(r.contains(&format!("FACT-{i:03}")), "FACT-{i:03} dropped from the view");
    }
}

#[test]
fn kind_parsing_accepts_common_spellings() {
    for (s, k) in [("facts", Kind::Fact), ("open_item", Kind::OpenItem), ("Open Items", Kind::OpenItem), ("identifier", Kind::File), ("pref", Kind::Preference)] {
        assert_eq!(Kind::parse(s), Some(k), "{s}");
    }
    assert_eq!(items::max_item_number(&mem_with(&[("a", 1), ("b", 1)]).items), 2);
}

#[test]
fn the_summarizer_sees_current_items_by_id() {
    let base = mem_with(&[("port 8443", 2)]);
    let p = items::public_items(&base);
    assert_eq!(p[0]["id"], "F1");
    assert_eq!(p[0]["text"], "port 8443");
}
