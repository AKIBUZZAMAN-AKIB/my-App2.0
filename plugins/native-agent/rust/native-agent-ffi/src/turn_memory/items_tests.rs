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
    let r = render(&next);
    assert!(!r.contains("8443"), "only current items reach the model as text");
    assert!(r.contains("- F1, from turn 2: superseded by F2 at turn 9 (reason: user moved the server)"), "{}", r);
}

#[test]
fn closed_items_beyond_the_render_cap_are_counted() {
    let facts: Vec<(String, u32)> = (1..=14).map(|i| (format!("fact {}", i), (i - 1) % 7 + 1)).collect();
    let refs: Vec<(&str, u32)> = facts.iter().map(|(t, n)| (t.as_str(), *n)).collect();
    let base = mem_with(&refs);
    let close: Vec<serde_json::Value> = (1..=12).map(|i| json!({"id": format!("F{}", i), "status": "done", "turn": 9, "reason": "finished"})).collect();
    let up = update(json!({"items": {"close": close}}));
    let next = apply_update(&base, &up, 8, 9, 1).unwrap();
    let r = render(&next);
    assert_eq!(r.matches(": done at turn 9 (reason: finished)").count(), super::items::MAX_RENDERED_CLOSED);
    assert!(r.contains("and 2 older closed items"), "{}", r);
    assert!(r.contains("- F13 (turn 6): fact 13"), "{}", r);
    assert!(!r.contains("fact 1\n") && !r.contains(": fact 12"), "closed text is not shown");
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
        (json!({"close": [{"id": "F1", "status": "deleted", "turn": 8, "reason": "x"}]}), "status"),
        (json!({"update": [{"id": "F1", "text": "b", "turn": 99}]}), "source turn"),
        (json!({"add": [{"kind": "fact", "text": "b", "turn": 0}]}), "source turn"),
        (json!({"add": [{"kind": "gossip", "text": "b", "turn": 8}]}), "unknown kind"),
        (json!({"update": [{"id": "F1", "text": "b", "turn": 8}], "close": [{"id": "F1", "status": "done", "turn": 8, "reason": "x"}]}), "twice"),
    ] {
        let up = update(json!({"items": ops}));
        let err = apply_update(&base, &up, 8, 9, 1).expect_err(why).join("; ");
        assert!(err.to_lowercase().contains(why), "{why}: {err}");
    }
}

#[test]
fn references_to_unknown_items_are_dropped_and_logged_not_rejected() {
    let base = mem_with(&[("a", 1)]);
    let up = update(json!({"items": {
        "close": [{"id": "F9", "status": "done", "turn": 8, "reason": "x"}],
        "update": [{"id": "P4", "text": "zz", "turn": 8}],
        "add": [{"kind": "fact", "text": "b", "turn": 8, "supersedes": "F7"}],
    }}));
    let mut dropped = Vec::new();
    let next = crate::turn_memory::apply_update_logged(&base, &up, 8, 9, 1, &mut dropped).expect("accepted");
    assert_eq!(dropped.len(), 3, "{dropped:?}");
    assert!(dropped.iter().any(|d| d.contains("F9")) && dropped.iter().any(|d| d.contains("P4")) && dropped.iter().any(|d| d.contains("F7")));
    assert_eq!(next.items[0].status, "current", "F1 untouched");
    assert!(next.items.iter().any(|i| i.text == "b" && i.is_current()));
    // Repairs stay strict: an unknown ID is an error there.
    let mut errs = Vec::new();
    let ops = up.items.clone();
    crate::turn_memory::items::apply_ops(&base, &ops, 9, "repair", &mut errs);
    assert!(errs.iter().any(|e| e.contains("unknown item")), "{errs:?}");
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

/// Plan acceptance for W-4 (Phase 1e): for 1 000 random summarizer outputs,
/// every accepted version keeps every current item of the previous version,
/// or records a reason for the change. Accepted = `apply_update` and
/// `validate_transition` both pass, exactly the commit gate. The answers are
/// deliberately messy (unknown IDs, empty reasons, bad statuses and turns,
/// earlier-format lists); accepted versions are chained so later answers act
/// on items with history. Deterministic: a fixed-seed xorshift, no new dependency.
#[test]
fn property_1000_random_answers_never_lose_a_current_item_without_a_reason() {
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n.max(1)
        }
        fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
            xs[self.below(xs.len() as u64) as usize]
        }
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let kinds = ["fact", "preference", "file", "openItem", "facts", "bogus", ""];
    let statuses = ["done", "retired", "superseded", "current", "resolved", "obsolete", "", "nonsense"];
    let reasons = ["", "", "user changed it", "finished in this turn", "  "];
    let mut base = mem_with(&[("port 8443", 2), ("uses sqlite", 3), ("deploy on fridays", 5)]);
    let (mut accepted, mut rejected) = (0u32, 0u32);
    for round in 0..1000u32 {
        let from = base.through_turn + 1;
        let to = from + rng.below(3) as u32;
        // IDs to aim at: existing ones (any status) plus unknown ones.
        let mut targets: Vec<String> = base.items.iter().map(|i| i.id.clone()).collect();
        targets.extend(["F999".to_string(), "X1".to_string(), String::new()]);
        let target = |rng: &mut Rng| targets[rng.below(targets.len() as u64) as usize].clone();
        let turn = |rng: &mut Rng| if rng.below(8) == 0 { to + 5 } else { 1 + rng.below(to as u64) as u32 };
        let (mut add, mut upd, mut close) = (vec![], vec![], vec![]);
        for _ in 0..rng.below(3) {
            let mut a = json!({"kind": rng.pick(&kinds), "text": format!("item r{round} {}", rng.below(4)), "turn": turn(&mut rng), "reason": rng.pick(&reasons)});
            if rng.below(3) == 0 {
                a["supersedes"] = json!([target(&mut rng)]);
            }
            add.push(a);
        }
        for _ in 0..rng.below(3) {
            let text = if rng.below(5) == 0 { String::new() } else { format!("reworded r{round}") };
            upd.push(json!({"id": target(&mut rng), "text": text, "turn": turn(&mut rng), "reason": rng.pick(&reasons)}));
        }
        for _ in 0..rng.below(3) {
            close.push(json!({"id": target(&mut rng), "status": rng.pick(&statuses), "turn": turn(&mut rng), "reason": rng.pick(&reasons)}));
        }
        let mut ans = json!({
            "segments": [{"fromTurn": from, "toTurn": to, "topic": "t", "title": "t", "summary": format!("round {round}")}],
            "items": {"add": add, "update": upd, "close": close},
        });
        if rng.below(6) == 0 {
            // An earlier-format full list that leaves most items out.
            ans["facts"] = json!([{"text": format!("listed r{round}"), "turn": from}]);
        }
        let Ok(up) = parse_update(&ans.to_string()) else {
            rejected += 1;
            continue;
        };
        let next = match apply_update(&base, &up, from, to, round as i64) {
            Ok(n) if validate_transition(&base, &n, &[]).is_ok() => n,
            _ => {
                rejected += 1;
                continue;
            }
        };
        accepted += 1;
        for p in &base.items {
            let n = next.items.iter().find(|i| i.id.eq_ignore_ascii_case(&p.id)).unwrap_or_else(|| panic!("round {round}: item {} vanished", p.id));
            if !p.is_current() {
                assert_eq!(n.status, p.status, "round {round}: closed item {} changed status (revived?)", p.id);
                continue;
            }
            if !n.is_current() || n.text != p.text {
                assert!(!n.reason.trim().is_empty(), "round {round}: {} changed ({} -> {}) without a reason", p.id, p.status, n.status);
                assert!(n.history.last().map(|h| !h.reason.trim().is_empty()).unwrap_or(false), "round {round}: {} changed without a history entry", p.id);
            }
            if n.status == items::SUPERSEDED {
                let by = n.superseded_by.as_deref().unwrap_or_else(|| panic!("round {round}: {} superseded by nothing", p.id));
                assert!(next.items.iter().any(|i| i.id.eq_ignore_ascii_case(by)), "round {round}: {} superseded by missing {by}", p.id);
            }
        }
        base = next;
    }
    eprintln!("property: {accepted} accepted, {rejected} rejected of 1000");
    // Not vacuous: both outcomes happened many times.
    assert!(accepted >= 100, "only {accepted} of 1000 answers were accepted");
    assert!(rejected >= 100, "only {rejected} of 1000 answers were rejected");
}
