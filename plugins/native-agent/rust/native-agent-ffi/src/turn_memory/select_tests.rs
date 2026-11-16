//! Selective injection over a chat with one active goal, paused and
//! completed goals, current and superseded decisions, open and closed tasks
//! and segments on different topics.

use super::*;
use crate::turn_memory::goals::{self, Proposal};
use crate::turn_memory::{store, Decision, Decisions, Segment, TurnMemory};
use rusqlite::Connection;

fn words(s: &str) -> usize {
    s.split_whitespace().count()
}

fn dec(id: &str, text: &str, turn: u32, goal: Option<&str>) -> Decision {
    Decision { id: id.into(), text: text.into(), turn, goal_id: goal.map(str::to_string), ..Default::default() }
}

fn item(id: &str, kind: &str, text: &str, status: &str, turn: u32, goal: Option<&str>) -> MemoryItem {
    let mut v = serde_json::json!({"id": id, "kind": kind, "text": text, "status": status, "sourceTurns": [turn], "updatedTurn": turn});
    if let Some(g) = goal {
        v["goalId"] = serde_json::json!(g);
    }
    serde_json::from_value(v).unwrap()
}

fn seg(from: u32, to: u32, topic: &str, title: &str, summary: &str) -> Segment {
    Segment { from_turn: from, to_turn: to, topic: topic.into(), title: title.into(), summary: summary.into() }
}

/// G001 billing (paused), G002 onboarding emails (completed), G003 login
/// crash (cancelled), G004 analytics (paused), G005 mobile release (active).
fn goals() -> GoalState {
    let c = Connection::open_in_memory().unwrap();
    store::ensure_tables(&c).unwrap();
    let pr = |op: &str, target: Option<&str>, title: &str, turn: u32| Proposal { op: op.into(), target: target.map(str::to_string), title: title.into(), description: String::new(), turn, origin: goals::ORIGIN_USER.into(), evidence: "x".into() };
    let steps = [
        pr("create", None, "Billing page with Stripe invoices", 1),
        pr("create", None, "Onboarding email sequence", 8),
        pr("complete", None, "", 14),
        pr("create", None, "Fix the login crash", 15),
        pr("cancel", None, "", 18),
        pr("create", None, "Analytics dashboard charts", 19),
        pr("create", None, "Mobile release 2.0 on the Play Store", 24),
    ];
    let (out, st) = goals::apply(&c, "k", &steps, 1000).unwrap();
    assert!(out.iter().all(|o| o.applied), "{out:?}");
    st
}

fn memory() -> TurnMemory {
    TurnMemory {
        version: 6,
        through_turn: 28,
        goal: "Mobile release".into(),
        segments: vec![
            seg(1, 7, "billing", "Stripe billing", "Chose Stripe for invoices; invoice PDF export planned."),
            seg(8, 14, "email", "Onboarding emails", "Wrote three onboarding emails with Mailgun; sent on day 1, 3, 7."),
            seg(15, 18, "login", "Login crash", "Crash on Android 12 login; cancelled because the SDK update fixed it."),
            seg(19, 23, "analytics", "Analytics charts", "Monthly revenue chart with Chart.js, weekly active users."),
            seg(24, 28, "release", "Mobile release", "Signing keys, Play Store listing, version code 200."),
        ],
        decisions: Decisions {
            current: vec![
                dec("D1", "Use Stripe for invoices", 3, Some("G001")),
                dec("D3", "Send onboarding emails with Mailgun", 9, Some("G002")),
                dec("D5", "Charts use Chart.js", 20, Some("G004")),
                dec("D6", "Release version code is 200", 25, Some("G005")),
                dec("D7", "Upload the bundle with fastlane", 26, Some("G005")),
                dec("D8", "Indent with tabs", 1, None),
            ],
            superseded: vec![Decision {
                id: "D2".into(),
                text: "Release version code is 150".into(),
                turn: 24,
                superseded_by: Some("D6".into()),
                superseded_at: Some(25),
                reason: Some("150 was already used by the beta".into()),
                goal_id: Some("G005".into()),
                ..Default::default()
            }],
        },
        items: vec![
            item("O1", "openItem", "Add invoice PDF export", "current", 5, Some("G001")),
            item("O2", "openItem", "Write the welcome email", "done", 10, Some("G002")),
            item("O3", "openItem", "Upload screenshots to the Play Store listing", "current", 27, Some("G005")),
            item("O4", "openItem", "Create the signing key", "done", 25, Some("G005")),
            item("O5", "openItem", "Rename the repo", "current", 2, None),
            item("P1", "preference", "Answers in Bangla", "current", 1, None),
            item("F1", "fact", "Staging host is kakatua-17.lan", "current", 6, None),
            item("F2", "fact", "Mailgun domain is mg.example.com", "current", 9, None),
        ],
        ..Default::default()
    }
}

fn run(query: &str, fts: &[u32], max: usize) -> Selection {
    let (m, g) = (memory(), goals());
    select(&Input { mem: &m, goals: &g, query, previous: "", fts_turns: fts, max_tokens: max }, &words)
}

fn has(v: &[String], id: &str) -> bool {
    v.iter().any(|x| x == id)
}

#[test]
fn an_unrelated_question_gets_the_active_goal_and_no_history() {
    let s = run("How do I center a div?", &[], 2000);
    assert_eq!(s.goal_ids, vec!["G005"], "{}", s.text);
    assert!(s.text.contains("Current goal: G005 [active, since turn 24] Mobile release 2.0"));
    // Its decisions and open tasks, and records of no goal.
    for id in ["D6", "D7", "D8"] {
        assert!(has(&s.decision_ids, id), "{id}: {}", s.text);
    }
    assert!(has(&s.task_ids, "O3") && has(&s.task_ids, "O5"));
    // Other goals' decisions, closed tasks, superseded decisions: not shown.
    for id in ["D1", "D3", "D5", "D2"] {
        assert!(!has(&s.decision_ids, id), "{id}: {}", s.text);
    }
    assert!(!has(&s.task_ids, "O1") && !has(&s.task_ids, "O2") && !has(&s.task_ids, "O4"));
    assert!(!s.text.contains("Stripe") && !s.text.contains("Mailgun") && !s.text.contains("150"), "{}", s.text);
    // Only the newest segment (it leads into the recent turns).
    assert_eq!(s.segment_ids, vec!["S24-28"]);
    // What exists but is not shown is listed for recall.
    assert!(s.text.contains("Not shown here"));
    assert!(s.text.contains("G001 (paused)") && s.text.contains("G002 (completed)") && s.text.contains("G003 (cancelled)"));
    assert!(s.text.contains("superseded decisions: D2"));
    assert!(s.text.contains("D1 (G001)"));
    assert!(s.text.contains("recall_turns"));
    // The preference is always there.
    assert!(has(&s.memory_ids, "P1"));
}

#[test]
fn a_question_about_a_paused_goal_brings_that_goal_and_its_records() {
    let s = run("Where were we with the Stripe billing page invoices?", &[3], 2000);
    assert!(has(&s.goal_ids, "G001"), "{}", s.text);
    assert!(s.text.contains("- G001 [paused, since turn 1] Billing page with Stripe invoices"));
    assert!(has(&s.decision_ids, "D1") && has(&s.task_ids, "O1"));
    assert!(has(&s.segment_ids, "S1-7"));
    // Still not shown as current; the active goal is still the current one.
    assert!(s.text.contains("Current goal: G005"));
    assert!(!s.text.contains("Current goal: G001"));
    // Unrelated segments stay out.
    assert!(!has(&s.segment_ids, "S8-14") && !has(&s.segment_ids, "S15-18"), "{:?}", s.segment_ids);
}

#[test]
fn a_goal_named_by_id_is_included_with_its_status() {
    let s = run("What did we decide in G002?", &[], 2000);
    assert!(has(&s.goal_ids, "G002"));
    assert!(s.text.contains("- G002 [completed, since turn 8] Onboarding email sequence"));
    assert!(has(&s.decision_ids, "D3"));
    // Its closed task shows as completed, never as pending.
    let s = run("What did we finish for G002 before?", &[], 2000);
    assert!(s.text.contains("- O2 [completed at turn 10"), "{}", s.text);
    assert!(!s.text.contains("- O2 [pending"));
}

#[test]
fn superseded_decisions_only_for_history_questions() {
    let s = run("What is the release version code?", &[], 2000);
    assert!(has(&s.decision_ids, "D6"));
    assert!(!has(&s.decision_ids, "D2"), "{}", s.text);
    let s = run("Why did the release version code change from before?", &[], 2000);
    assert!(has(&s.decision_ids, "D2"), "{}", s.text);
    assert!(s.text.contains("- D2 [SUPERSEDED by D6 at turn 25; made turn 24; G005] Release version code is 150 (reason: 150 was already used by the beta)"));
    // The decision in force comes first and is marked as such.
    let now = s.text.find("Decisions in force NOW").unwrap();
    let old = s.text.find("REPLACED").unwrap();
    assert!(now < old);
    assert!(s.history_mode);
}

#[test]
fn listing_goals_shows_every_goal_with_its_status() {
    let s = run("Which goals have we worked on?", &[], 2000);
    for (id, st) in [("G001", "paused"), ("G002", "completed"), ("G003", "cancelled"), ("G004", "paused")] {
        assert!(s.text.contains(&format!("- {} [{}", id, st)), "{id}: {}", s.text);
    }
    assert!(!s.text.contains("G001 [active") && !s.text.contains("G004 [active"));
}

#[test]
fn fts_hits_bring_their_segment() {
    // The words match no segment, but the turn index found turn 21.
    let s = run("the purple thing from earlier", &[21], 2000);
    assert!(has(&s.segment_ids, "S19-23"), "{:?}", s.segment_ids);
    assert!(s.sources.iter().any(|x| x == "fts"));
}

#[test]
fn the_token_cap_drops_optional_records_never_the_active_goal() {
    let full = run("Where were we with the Stripe billing page invoices?", &[3], 2000);
    let fixed = run("Where were we with the Stripe billing page invoices?", &[3], 0);
    assert!(fixed.text.contains("Current goal: G005"));
    for id in ["D6", "D7", "D8"] {
        assert!(has(&fixed.decision_ids, id));
    }
    assert!(has(&fixed.task_ids, "O3"));
    assert!(!has(&fixed.goal_ids, "G001"));
    // What matched but did not fit is named, so it can be recalled.
    assert!(has(&fixed.truncated, "G001") && has(&fixed.truncated, "D1"), "{:?}", fixed.truncated);
    assert!(fixed.text.contains("Left out for length although they matched"));
    assert!(words(&fixed.text) < words(&full.text));
    // A middle cap: some optional records fit, some do not, and the whole
    // block stays within the cap.
    let cap = (words(&fixed.text) + words(&full.text)) / 2;
    let mid = run("Where were we with the Stripe billing page invoices?", &[3], cap);
    assert!(words(&mid.text) <= cap, "{} > {cap}", words(&mid.text));
    assert!(mid.goal_ids.len() + mid.segment_ids.len() + mid.decision_ids.len() > 1 + fixed.segment_ids.len() + fixed.decision_ids.len() - 1);
    assert!(!mid.truncated.is_empty());
    assert!(words(&full.text) <= 2000);
}

#[test]
fn without_an_active_goal_none_is_shown_as_current() {
    let c = Connection::open_in_memory().unwrap();
    store::ensure_tables(&c).unwrap();
    let pr = |op: &str, title: &str, turn: u32| Proposal { op: op.into(), target: None, title: title.into(), description: String::new(), turn, origin: goals::ORIGIN_USER.into(), evidence: "x".into() };
    let (_, g) = goals::apply(&c, "k", &[pr("create", "Billing page", 1), pr("complete", "", 3)], 1).unwrap();
    let m = memory();
    let s = select(&Input { mem: &m, goals: &g, query: "hello", previous: "", fts_turns: &[], max_tokens: 2000 }, &words);
    assert!(s.text.contains("Current goal: none is active"));
    assert!(s.goal_ids.is_empty());
}

#[test]
fn source_ids_and_turns_are_kept_on_every_line() {
    let s = run("Why did the release version code change from before?", &[], 2000);
    for line in s.text.lines().filter(|l| l.starts_with("- D") || l.starts_with("- O")) {
        assert!(line.contains("turn "), "{line}");
    }
    assert!(s.text.contains("- D6 [current; turn 25; G005] Release version code is 200"));
    assert!(s.text.contains("- O3 [pending; turn 27; G005] Upload screenshots"));
}

#[test]
fn bengali_queries_match_bengali_records() {
    let mut m = memory();
    m.segments.push(seg(29, 30, "সার্ভার", "পোর্ট", "সার্ভারের পোর্ট 9150 ঠিক হলো।"));
    m.segments.push(seg(31, 32, "আবহাওয়া", "আবহাওয়া", "মেঘলা আবহাওয়া।"));
    m.through_turn = 32;
    let g = goals();
    let s = select(&Input { mem: &m, goals: &g, query: "সার্ভারের পোর্ট কত?", previous: "", fts_turns: &[], max_tokens: 2000 }, &words);
    assert!(has(&s.segment_ids, "S29-30"), "{:?}", s.segment_ids);
    // The weather segment is the newest one, so it leads into the recent
    // turns; nothing else unrelated comes in.
    assert!(!has(&s.segment_ids, "S8-14"));
}
