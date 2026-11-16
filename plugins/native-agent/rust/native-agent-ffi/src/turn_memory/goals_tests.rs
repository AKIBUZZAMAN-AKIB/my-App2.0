//! Goal lifecycle: transitions, validation, detection, links, migration.

use super::*;
use crate::turn_memory::items::MemoryItem;
use crate::turn_memory::{store, Decision, Decisions, TurnMemory};
use rusqlite::Connection;

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    store::ensure_tables(&c).unwrap();
    c
}

fn p(op: &str, target: Option<&str>, title: &str, turn: u32) -> Proposal {
    Proposal {
        op: op.into(),
        target: target.map(str::to_string),
        title: title.into(),
        description: String::new(),
        turn,
        origin: ORIGIN_USER.into(),
        evidence: format!("{op} {title}"),
    }
}

fn one(c: &Connection, pr: Proposal) -> (Outcome, GoalState) {
    let (o, st) = apply(c, "k", &[pr], 1000).unwrap();
    (o.into_iter().next().unwrap(), st)
}

fn status(st: &GoalState, id: &str) -> String {
    st.get(id).unwrap().status.clone()
}

fn actives(st: &GoalState) -> usize {
    st.goals.iter().filter(|g| g.status == ACTIVE).count()
}

#[test]
fn creates_g001_as_the_active_current_goal() {
    let c = db();
    let (o, st) = one(&c, p("create", None, "Build the billing page", 3));
    assert!(o.applied, "{o:?}");
    assert_eq!(o.goal_id.as_deref(), Some("G001"));
    let g = st.get("G001").unwrap();
    assert_eq!(
        (g.status.as_str(), g.source_turn, g.completed_at),
        (ACTIVE, 3, None)
    );
    assert_eq!(st.current_goal_id.as_deref(), Some("G001"));
    // Stored and read back the same.
    let back = load_state(&c, "k");
    assert_eq!(back.goals, st.goals);
    let row: (String, String) = c
        .query_row(
            "SELECT status, title FROM memory_goals WHERE session_key='k' AND goal_id='G001'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("active".into(), "Build the billing page".into()));
}

#[test]
fn switching_to_g002_pauses_g001_and_resume_keeps_the_same_id() {
    let c = db();
    one(&c, p("create", None, "Build the billing page", 1));
    let (o, st) = one(&c, p("create", None, "Fix the login crash", 5));
    assert_eq!(o.goal_id.as_deref(), Some("G002"));
    assert_eq!(status(&st, "G001"), PAUSED);
    assert_eq!(status(&st, "G002"), ACTIVE);
    assert_eq!(st.current_goal_id.as_deref(), Some("G002"));
    assert_eq!(actives(&st), 1);

    // Resume by words, not by ID: same goal, no duplicate.
    let (o, st) = one(&c, p("resume", Some("the billing page"), "", 9));
    assert!(o.applied, "{o:?}");
    assert_eq!(o.goal_id.as_deref(), Some("G001"));
    assert_eq!(st.goals.len(), 2);
    assert_eq!(status(&st, "G001"), ACTIVE);
    assert_eq!(status(&st, "G002"), PAUSED);
    assert_eq!(st.current_goal_id.as_deref(), Some("G001"));
    assert_eq!(actives(&st), 1);
    // "New goal" naming an open goal is a resume, not a second G001.
    one(&c, p("switch", Some("G002"), "", 10));
    let (o, st) = one(&c, p("create", None, "Build the billing page", 11));
    assert_eq!(
        (o.op.as_str(), o.goal_id.as_deref()),
        ("resume", Some("G001"))
    );
    assert_eq!(st.goals.len(), 2);
}

#[test]
fn completing_keeps_history_and_clears_the_current_goal() {
    let c = db();
    one(&c, p("create", None, "Build the billing page", 1));
    one(&c, p("create", None, "Fix the login crash", 4));
    let (o, st) = one(&c, p("complete", None, "", 6));
    assert!(o.applied);
    assert_eq!(o.goal_id.as_deref(), Some("G002"));
    let g = st.get("G002").unwrap();
    assert_eq!(g.status, COMPLETED);
    assert!(g.completed_at.is_some());
    // The paused goal is not activated on the user's behalf.
    assert_eq!(status(&st, "G001"), PAUSED);
    assert_eq!(st.current_goal_id, None);
    assert!(st.current().is_none());
    assert_eq!(st.goals.len(), 2);
    // A completed goal cannot be resumed or completed again.
    let (o, _) = one(&c, p("resume", Some("G002"), "", 7));
    assert!(!o.applied && o.note.contains("completed"), "{o:?}");
    let (o, _) = one(&c, p("complete", Some("G002"), "", 7));
    assert!(!o.applied);
    // The history keeps every step.
    let ops: Vec<String> = load_state(&c, "k")
        .events
        .iter()
        .map(|e| format!("{}:{}", e.op, e.goal_id))
        .collect();
    assert_eq!(ops, vec!["create:G001", "create:G002", "complete:G002"]);
}

#[test]
fn cancelled_and_superseded_are_not_completed() {
    let c = db();
    one(&c, p("create", None, "Migrate to Postgres", 1));
    let (_, st) = one(&c, p("cancel", None, "", 2));
    let g = st.get("G001").unwrap();
    assert_eq!(g.status, CANCELLED);
    assert_eq!(g.completed_at, None);
    one(&c, p("create", None, "Ship the web app", 3));
    let (o, st) = one(&c, p("supersede", None, "Ship the mobile app instead", 4));
    assert!(o.applied, "{o:?}");
    let old = st.get("G002").unwrap();
    assert_eq!(old.status, SUPERSEDED);
    assert_eq!(old.completed_at, None);
    assert_eq!(old.metadata.as_ref().unwrap()["supersededBy"], "G003");
    assert_eq!(st.current_goal_id.as_deref(), Some("G003"));
    assert_eq!(actives(&st), 1);
}

#[test]
fn unrelated_discussion_never_changes_the_goal() {
    let c = db();
    one(&c, p("create", None, "Build the billing page", 1));
    for (n, text) in [
        (2, "What's the weather like in Dhaka today?"),
        (3, "btw, can you explain how Rust lifetimes work?"),
        (
            4,
            "Let's talk about something else for a minute: favourite books?",
        ),
        (5, "Is the goal done yet?"),
        (6, "The goal is not done yet, keep going."),
        (7, "switch to dark mode in the UI please"),
        (8, "আজকে আবহাওয়া কেমন?"),
        (9, "let's continue"),
    ] {
        detect_turn(&c, "k", n, text, 1000).unwrap();
    }
    let st = load_state(&c, "k");
    assert_eq!(st.goals.len(), 1, "{:?}", st.goals);
    assert_eq!(status(&st, "G001"), ACTIVE);
    assert_eq!(st.current_goal_id.as_deref(), Some("G001"));
}

#[test]
fn detector_reads_explicit_commands_in_english_and_bengali() {
    let d = |s: &str| {
        detect(s)
            .into_iter()
            .map(|i| (i.op, i.target, i.title))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        d("New goal: build the billing page"),
        vec![("create".into(), None, "build the billing page".into())]
    );
    assert_eq!(
        d("Our goal is to ship v2 by Friday."),
        vec![("create".into(), None, "ship v2 by Friday".into())]
    );
    assert_eq!(
        d("নতুন লক্ষ্য: রিপোর্ট পেজ বানানো"),
        vec![("create".into(), None, "রিপোর্ট পেজ বানানো".into())]
    );
    assert_eq!(
        d("Let's pause this and switch to the login crash")[0].0,
        "switch"
    );
    assert_eq!(
        d("let's go back to the billing page")[0],
        ("resume".into(), Some("billing page".into()), String::new())
    );
    assert_eq!(d("বিলিং পেজে আবার ফিরে যাই")[0].0, "resume");
    assert_eq!(d("Mark the goal as done")[0].0, "complete");
    assert_eq!(
        d("G002 is done")[0],
        ("complete".into(), Some("G002".into()), String::new())
    );
    assert_eq!(d("লক্ষ্য শেষ হয়েছে")[0].0, "complete");
    assert_eq!(d("cancel the goal")[0].0, "cancel");
    assert_eq!(d("লক্ষ্যটা বাতিল")[0].0, "cancel");
    assert_eq!(
        d("Replace the goal with shipping the mobile app")[0].0,
        "supersede"
    );
    for none in [
        "is the goal done?",
        "don't mark the goal as done",
        "the goal isn't finished",
        "what is our goal?",
        "I finished lunch",
        "let's continue",
        "the build is done",
    ] {
        assert!(d(none).is_empty(), "{none}: {:?}", d(none));
    }
}

#[test]
fn a_plain_switch_never_invents_a_goal() {
    let c = db();
    one(&c, p("create", None, "Build the billing page", 1));
    // "switch to X" without the word goal: only an existing goal.
    detect_turn(&c, "k", 2, "switch to the new font", 1000).unwrap();
    assert_eq!(load_state(&c, "k").goals.len(), 1);
    // With "goal" it is a new goal.
    detect_turn(&c, "k", 3, "switch to the goal fix the login crash", 1000).unwrap();
    let st = load_state(&c, "k");
    assert_eq!(st.goals.len(), 2);
    assert_eq!(status(&st, "G001"), PAUSED);
}

#[test]
fn detection_runs_once_per_turn() {
    let c = db();
    detect_turn(&c, "k", 1, "New goal: build the billing page", 1000).unwrap();
    detect_turn(&c, "k", 1, "New goal: build the billing page", 1000).unwrap();
    detect_turn(&c, "k", 2, "New goal: fix the login crash", 1000).unwrap();
    // A retried turn 2 is not read again (it would create nothing new, but
    // must not even be planned).
    let out = detect_turn(&c, "k", 2, "New goal: something else", 1000).unwrap();
    assert!(out.is_empty());
    assert_eq!(load_state(&c, "k").goals.len(), 2);
}

#[test]
fn an_ambiguous_or_unknown_target_changes_nothing() {
    let c = db();
    one(&c, p("create", None, "billing page design", 1));
    one(&c, p("create", None, "billing page backend", 2));
    let before = load_state(&c, "k");
    let (o, st) = one(&c, p("resume", Some("billing page"), "", 3));
    assert!(!o.applied && o.note.contains("could mean"), "{o:?}");
    assert_eq!(st.goals, before.goals);
    let (o, _) = one(&c, p("complete", Some("G009"), "", 3));
    assert!(!o.applied && o.note.contains("G009"));
}

#[test]
fn a_late_event_lands_in_its_place_in_history() {
    // The fold for turns 1-7 reports a goal created in turn 2 after the
    // detector already recorded a switch in turn 9: the current goal stays
    // the one of turn 9.
    let c = db();
    one(&c, p("create", None, "Fix the login crash", 9));
    let mut late = p("create", None, "Build the billing page", 2);
    late.origin = ORIGIN_SUMMARY.into();
    let (o, st) = one(&c, late);
    assert!(o.applied, "{o:?}");
    assert_eq!(st.current_goal_id.as_deref(), Some("G001"));
    assert_eq!(status(&st, "G002"), PAUSED);
    assert_eq!(status(&st, "G001"), ACTIVE);
    assert_eq!(st.goal_at(5), Some("G002".into()));
    assert_eq!(st.goal_at(9), Some("G001".into()));
    assert_eq!(st.goal_at(1), None);
}

#[test]
fn summary_ops_need_the_users_own_words() {
    let user = |t: u32| match t {
        3 => Some("Okay, the billing page is finished, thanks!".to_string()),
        4 => Some("what about the weather".to_string()),
        _ => None,
    };
    let ops = parse_summary_ops(Some(&serde_json::json!([
        {"op": "complete", "goal": "G001", "turn": 3, "evidence": "the billing page is finished"},
        {"op": "complete", "goal": "G001", "turn": 4, "evidence": "what about the weather"},
        {"op": "create", "title": "Made up", "turn": 3, "evidence": "the user wants a new thing"},
        {"op": "create", "title": "Out of range", "turn": 12, "evidence": "billing page"},
        {"op": "delete", "goal": "G001", "turn": 3, "evidence": "finished"}
    ])));
    assert_eq!(ops.len(), 4, "unknown ops are dropped");
    let (ok, rejected) = validate_summary_ops(ops, 1, 7, &user);
    assert_eq!(ok.len(), 1, "{rejected:?}");
    assert_eq!((ok[0].op.as_str(), ok[0].turn), ("complete", 3));
    assert_eq!(rejected.len(), 3);
    assert!(rejected.iter().any(|r| r.contains("does not say")));
    assert!(rejected
        .iter()
        .any(|r| r.contains("not in the user's words")));
    assert!(rejected.iter().any(|r| r.contains("outside")));
}

fn dec(id: &str, text: &str, turn: u32) -> Decision {
    Decision {
        id: id.into(),
        text: text.into(),
        turn,
        ..Default::default()
    }
}

fn task(id: &str, text: &str, turn: u32) -> MemoryItem {
    serde_json::from_value(serde_json::json!({"id": id, "kind": "openItem", "text": text, "status": "current", "sourceTurns": [turn], "updatedTurn": turn})).unwrap()
}

#[test]
fn new_decisions_and_tasks_link_to_the_goal_of_their_turn() {
    let c = db();
    one(&c, p("create", None, "Build the billing page", 2));
    one(&c, p("create", None, "Fix the login crash", 6));
    let st = load_state(&c, "k");
    let base = TurnMemory::default();
    let mut mem = TurnMemory {
        through_turn: 7,
        decisions: Decisions {
            current: vec![
                dec("D1", "use Stripe", 3),
                dec("D2", "log in with email", 7),
                dec("D3", "tabs not spaces", 1),
            ],
            superseded: vec![],
        },
        items: vec![
            task("O1", "add invoice export", 4),
            task("O2", "reproduce the crash", 6),
        ],
        ..Default::default()
    };
    let n = link_records(&base, &mut mem, &st);
    assert_eq!(n, 4);
    let g = |id: &str| {
        mem.decisions
            .current
            .iter()
            .find(|d| d.id == id)
            .unwrap()
            .goal_id
            .clone()
    };
    assert_eq!(g("D1").as_deref(), Some("G001"));
    assert_eq!(g("D2").as_deref(), Some("G002"));
    assert_eq!(
        g("D3"),
        None,
        "no goal was active in turn 1: NULL, not a guess"
    );
    assert_eq!(mem.items[0].goal_id.as_deref(), Some("G001"));
    assert_eq!(mem.items[1].goal_id.as_deref(), Some("G002"));
}

#[test]
fn superseding_keeps_the_old_decisions_goal_and_status_changes_touch_nothing() {
    let c = db();
    one(&c, p("create", None, "Build the billing page", 1));
    let st = load_state(&c, "k");
    let mut v1 = TurnMemory {
        through_turn: 7,
        decisions: Decisions {
            current: vec![dec("D1", "port 8742", 3)],
            superseded: vec![],
        },
        items: vec![task("O1", "add export", 4)],
        ..Default::default()
    };
    link_records(&TurnMemory::default(), &mut v1, &st);
    // The goal changes (switch, then the old one is completed): the records
    // are not edited by that.
    one(&c, p("create", None, "Fix the login crash", 9));
    one(&c, p("complete", Some("G001"), "", 10));
    let st = load_state(&c, "k");
    let mut old = v1.decisions.current[0].clone();
    old.goal_id = None; // the model's copy carries no link
    old.superseded_by = Some("D2".into());
    old.superseded_at = Some(12);
    let mut item = v1.items[0].clone();
    item.goal_id = None;
    let mut v2 = TurnMemory {
        through_turn: 14,
        decisions: Decisions {
            current: vec![dec("D2", "port 9150", 12)],
            superseded: vec![old],
        },
        items: vec![item],
        ..Default::default()
    };
    link_records(&v1, &mut v2, &st);
    assert_eq!(
        v2.decisions.superseded[0].goal_id.as_deref(),
        Some("G001"),
        "superseded keeps its goal"
    );
    assert_eq!(v2.decisions.current[0].goal_id.as_deref(), Some("G002"));
    assert_eq!(v2.items[0].goal_id.as_deref(), Some("G001"));
    assert_eq!(
        v2.items[0].status, "current",
        "a task's status does not follow its goal's"
    );
}

#[test]
fn rewinding_voids_later_goal_events_without_deleting_them() {
    let c = db();
    one(&c, p("create", None, "Build the billing page", 1));
    one(&c, p("create", None, "Fix the login crash", 5));
    store::write_tx(&c, |tx| void_after(tx, "k", 3, "rewound", 2000)).unwrap();
    let st = load_state(&c, "k");
    assert_eq!(st.goals.len(), 1);
    assert_eq!(st.current_goal_id.as_deref(), Some("G001"));
    assert_eq!(status(&st, "G001"), ACTIVE);
    let kept: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM memory_goal_events WHERE voided_at IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, 1);
    // Turn 5 can be read again after the rewind.
    detect_turn(&c, "k", 5, "New goal: fix the login crash", 3000).unwrap();
    assert_eq!(load_state(&c, "k").goals.len(), 2);
}

#[test]
fn replay_rejects_two_active_goals_by_construction() {
    let e = |seq: i64, op: &str, id: &str, turn: u32| GoalEvent {
        seq,
        goal_id: id.into(),
        op: op.into(),
        turn,
        title: "t".into(),
        ..Default::default()
    };
    let st = replay(&[
        e(1, "create", "G001", 1),
        e(2, "create", "G002", 2),
        e(3, "resume", "G001", 3),
        e(4, "switch", "G002", 4),
    ])
    .unwrap();
    assert_eq!(actives(&st), 1);
    assert_eq!(st.current_goal_id.as_deref(), Some("G002"));
    assert!(replay(&[e(1, "create", "G001", 1), e(2, "create", "G001", 2)]).is_err());
    assert!(replay(&[e(1, "resume", "G004", 1)]).is_err());
}
