//! End-to-end scenarios: the stack, not the pieces.
//!
//! Each test here drives the real modules against a real (in-memory) database the
//! way a turn does — index, budget, select, render, apply, answer — and asserts on
//! what the *model* would see and what the *store* ends up holding. They are the
//! tests that answer "does this actually work?", as opposed to "is this function
//! correct?".
//!
//! The eight scenarios come from the plan (§17): a long book-like task, an
//! overflow, an ignored vs an obeyed instruction, a restart, temp-summary cleanup,
//! session isolation, and turn-range purity.

use rusqlite::Connection;

use super::budget::{Budget, BudgetInput, MIN_SELECTABLE_TOKENS};
use super::dispatch::{handle, CtxEnv, NoRecall};
use super::model::{ItemState, NodeId, NodeKind, Owner, Pin, Provenance};
use super::reading::{self, ReadItem};
use super::render::estimate_tokens;
use super::select;
use super::store;

fn db() -> Connection {
    let conn = Connection::open_in_memory().expect("db");
    store::ensure_tables(&conn).expect("tables");
    store::ensure_session(&conn, "s1", 1_000).expect("session");
    conn
}

fn env<'a>(budget: &'a Budget, model: &'a str) -> CtxEnv<'a> {
    CtxEnv::new("s1", 2_000, model, *budget)
}

fn budget(window: u64, locked: usize, used: usize, pct: u64) -> Budget {
    Budget::compute(BudgetInput { window, reserve_out: 1_000, headroom: 0, locked, min_selectable: MIN_SELECTABLE_TOKENS }, used, pct)
}

/// Index a session the way `wiring::before_request` does, and return the nodes.
fn index(conn: &Connection, items: &[ReadItem]) -> Vec<super::model::Node> {
    let existing = store::load_nodes(conn, "s1").expect("nodes");
    let plan = reading::plan("s1", &existing, items, 1_000);
    reading::apply(conn, "s1", &plan, 1_000, true).expect("apply");
    store::load_nodes(conn, "s1").expect("nodes")
}

/// A long chat: `turns` turns of `tokens` each, newest one in the window.
fn long_chat(turns: u32, tokens: u32) -> Vec<ReadItem> {
    (1..=turns)
        .map(|n| ReadItem::turn(n, &format!("turn {n} of the book"), tokens, n == turns))
        .collect()
}

#[test]
fn scenario_a_book_task_keeps_the_newest_and_lists_the_rest() {
    // 200 turns, the last one selected: everything is indexed, the model can see
    // the whole book, but only the newest turn is paid for.
    let conn = db();
    let items = long_chat(200, 1_500);
    let nodes = index(&conn, &items);
    assert_eq!(nodes.len(), 200);
    assert_eq!(nodes.iter().filter(|n| n.state == ItemState::In).count(), 1, "only the newest turn is sent");
    let used: usize = nodes.iter().map(|n| select::sent_tokens(n) as usize).sum();
    assert_eq!(used, 1_500);
    let b = budget(128_000, 10_000, used, 70);
    let e = env(&b, "m");
    let view = handle(&conn, &e, &serde_json::json!({"action": "view"}), &NoRecall);
    assert_eq!(view["ok"], true);
    let text = view["text"].as_str().unwrap();
    assert!(estimate_tokens(text) <= super::render::CHECKLIST_BUDGET_TOKENS + 200, "checklist cost {}", estimate_tokens(text));
    assert!(view["counts"]["out"].as_u64().unwrap() >= 190);
}

#[test]
fn scenario_overflow_compacts_and_logs_the_reason() {
    let conn = db();
    // Four big turns selected; the window cannot hold them.
    let mut nodes = Vec::new();
    for n in 1..=4u32 {
        let mut node = super::model::Node {
            id: NodeId::parse(&format!("turn/t{n}")).unwrap(),
            session_key: "s1".into(),
            kind: NodeKind::Turn,
            parent: "turns".into(),
            tags: vec![],
            order: n as i64,
            title: format!("turn {n}"),
            state: ItemState::In,
            pin: Pin::None,
            owner: Owner::Policy,
            tokens_full: 4_000,
            tokens_note: 400,
            token_model: String::new(),
            note: None,
            provenance: Provenance::default(),
            created_at: 1_000,
            last_used_at: None,
            loaded_at: None,
            turn: Some(n),
            rev: 1,
            deleted: false,
        };
        store::upsert_node(&conn, &node).unwrap();
        node.id = NodeId::parse(&format!("turn/t{n}")).unwrap();
        nodes.push(node);
    }
    let used = 16_000;
    let b = budget(20_000, 2_000, used, 70); // selectable 17k, compact at 11.9k
    assert!(b.used_sel > b.compact_at);
    // All four are among the newest seven, so the normal `compact` pass may
    // not touch them (plan §8.1 step 4); only the `force` pass can, and even it
    // keeps the turn in progress.
    let gentle = select::plan_eviction(&nodes, &b, b.compact_at, 4, 5_000, false, select::Reason::Budget);
    assert!(gentle.evict.is_empty(), "compact must keep the recent turns: {:?}", gentle.evict);
    let plan = select::plan_eviction(&nodes, &b, b.compact_at, 4, 5_000, true, select::Reason::Budget);
    assert!(!plan.evict.is_empty());
    assert!(plan.tokens_after <= b.compact_at, "{} > {}", plan.tokens_after, b.compact_at);
    let (changed, released) = select::apply_evictions(&conn, "s1", &plan, 5_000).unwrap();
    assert!(!changed.is_empty() && released > 0);
    // The store now agrees with the plan, and the newest turn survived.
    let after = store::load_nodes(&conn, "s1").unwrap();
    assert!(after.iter().any(|n| n.turn == Some(4) && n.state == ItemState::In), "the newest turn must survive");
    assert!(after.iter().any(|n| n.state == ItemState::Out));
}

#[test]
fn scenario_an_obeyed_instruction_survives_the_next_turn() {
    let conn = db();
    let items = long_chat(5, 500);
    index(&conn, &items);
    let b = budget(128_000, 1_000, 2_000, 70);
    let e = env(&b, "m");
    // The model excludes turn 2 and pins turn 3.
    let answer = handle(
        &conn,
        &e,
        &serde_json::json!({"action": "set", "ops": [
            {"id": "turn/t2", "action": "note_only", "note": "the user asked for gradle"},
            {"id": "turn/t3", "action": "pin"}
        ]}),
        &NoRecall,
    );
    assert_eq!(answer["applied"], 2, "{answer}");
    // A re-index of the same material must not undo either choice.
    let nodes = index(&conn, &items);
    assert_eq!(nodes.iter().find(|n| n.id.as_str() == "turn/t2").unwrap().state, ItemState::Note);
    assert_eq!(nodes.iter().find(|n| n.id.as_str() == "turn/t3").unwrap().pin, Pin::Ai);
}

#[test]
fn scenario_an_ignored_instruction_is_reported_not_silently_dropped() {
    let conn = db();
    index(&conn, &long_chat(3, 300));
    let b = budget(128_000, 1_000, 1_000, 70);
    let e = env(&b, "m");
    // Asking for something the law forbids: the answer says why, and the state of
    // everything else is unchanged.
    store::upsert_node(
        &conn,
        &super::model::Node {
            id: NodeId::parse("sys/core").unwrap(),
            session_key: "s1".into(),
            kind: NodeKind::SysPart,
            parent: "sys".into(),
            tags: vec![],
            order: 0,
            title: "rules".into(),
            state: ItemState::In,
            pin: Pin::Locked,
            owner: Owner::System,
            tokens_full: 800,
            tokens_note: 0,
            token_model: String::new(),
            note: None,
            provenance: Provenance::default(),
            created_at: 1_000,
            last_used_at: None,
            loaded_at: None,
            turn: None,
            rev: 1,
            deleted: false,
        },
    )
    .unwrap();
    let answer = handle(&conn, &e, &serde_json::json!({"action": "set", "ops": [{"id": "sys/core", "action": "exclude"}]}), &NoRecall);
    assert_eq!(answer["applied"], 0);
    assert_eq!(answer["refused"], 1);
    assert!(answer["results"][0]["message"].as_str().unwrap().contains("locked"), "{answer}");
    assert_eq!(store::load_node(&conn, "s1", "sys/core").unwrap().unwrap().state, ItemState::In);
}

#[test]
fn scenario_a_restart_rebuilds_the_same_tree_and_rev() {
    // A restart is: same rows, a fresh process. The tree must be idempotent and the
    // revision must not move when nothing changed.
    let conn = db();
    let items = long_chat(6, 400);
    index(&conn, &items);
    let first = store::load_nodes(&conn, "s1").unwrap();
    let rev = store::rev(&conn, "s1").unwrap();
    let second_nodes = index(&conn, &items);
    assert_eq!(second_nodes.len(), first.len());
    assert_eq!(store::rev(&conn, "s1").unwrap(), rev, "a no-op re-index must not move the revision");
}

#[test]
fn scenario_a_temp_summary_cleans_up_after_itself() {
    let conn = db();
    index(&conn, &long_chat(4, 900));
    let b = budget(128_000, 1_000, 3_600, 70);
    let e = env(&b, "m");
    let made = handle(
        &conn,
        &e,
        &serde_json::json!({"action": "summarize", "ids": ["turn/t1", "turn/t2"], "text": "they agreed on the plan"}),
        &NoRecall,
    );
    assert_eq!(made["ok"], true, "{made}");
    let temp_id = made["tempId"].as_str().unwrap().to_string();
    // Both sources are out of the window, the summary is in it.
    for id in ["turn/t1", "turn/t2"] {
        assert_eq!(store::load_node(&conn, "s1", id).unwrap().unwrap().state, ItemState::Temp);
    }
    assert_eq!(store::load_node(&conn, "s1", &temp_id).unwrap().unwrap().state, ItemState::In);
    // Putting a source back is allowed, and then the summary has fewer sources.
    let restored = handle(&conn, &e, &serde_json::json!({"action": "set", "ops": [{"id": "turn/t1", "action": "include"}]}), &NoRecall);
    assert_eq!(restored["applied"], 1, "{restored}");
    assert_eq!(store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap().state, ItemState::In);
}

#[test]
fn scenario_two_sessions_never_see_each_other() {
    let conn = db();
    store::ensure_session(&conn, "s2", 1_000).unwrap();
    index(&conn, &long_chat(3, 100));
    let b = budget(128_000, 1_000, 100, 70);
    // A view from s2 must show an empty tree, not s1's.
    let env2 = CtxEnv::new("s2", 2_000, "m", b);
    let view = handle(&conn, &env2, &serde_json::json!({"action": "view"}), &NoRecall);
    assert_eq!(view["ok"], true);
    let counts = &view["counts"];
    assert_eq!(counts["out"], 0);
    assert_eq!(counts["in"], 0);
    // And a recall of an s1 id from s2 finds nothing.
    let recall = handle(&conn, &env2, &serde_json::json!({"action": "recall", "id": "turn/t1"}), &NoRecall);
    assert_eq!(recall["ok"], false);
}

#[test]
fn scenario_a_turn_range_summary_stays_pure() {
    // An immutable policy summary (`sum/A-B`) has no writer among the ops: the model
    // may look at it and exclude it from the window, never change its content.
    let conn = db();
    store::upsert_node(
        &conn,
        &super::model::Node {
            id: NodeId::parse("sum/1-7").unwrap(),
            session_key: "s1".into(),
            kind: NodeKind::Summary,
            parent: "turns".into(),
            tags: vec![],
            order: 1,
            title: "turns 1-7".into(),
            state: ItemState::In,
            pin: Pin::Policy,
            owner: Owner::Policy,
            tokens_full: 600,
            tokens_note: 60,
            token_model: String::new(),
            note: None,
            provenance: Provenance::default(),
            created_at: 1_000,
            last_used_at: None,
            loaded_at: None,
            turn: None,
            rev: 1,
            deleted: false,
        },
    )
    .unwrap();
    let b = budget(128_000, 1_000, 600, 70);
    let e = env(&b, "m");
    let answer = handle(&conn, &e, &serde_json::json!({"action": "set", "ops": [{"id": "sum/1-7", "action": "exclude"}]}), &NoRecall);
    assert_eq!(answer["refused"], 1, "a policy-pinned summary is not the model's to drop");
    let node = store::load_node(&conn, "s1", "sum/1-7").unwrap().unwrap();
    assert_eq!(node.state, ItemState::In);
    assert_eq!(node.title, "turns 1-7", "content untouched");
}

#[test]
fn scenario_the_numbers_the_model_sees_match_what_is_sent() {
    // The invariant that matters most: the checklist's own total equals the sum of
    // the sent nodes, so the model can trust the number it is planning against.
    let conn = db();
    index(&conn, &long_chat(10, 700));
    let nodes = store::load_nodes(&conn, "s1").unwrap();
    let used: usize = nodes.iter().map(|n| select::sent_tokens(n) as usize).sum();
    let b = budget(128_000, 8_000, used, 70);
    let summary = select::summarize(&nodes);
    assert_eq!(summary.sent_tokens, used);
    let e = env(&b, "m");
    let view = handle(&conn, &e, &serde_json::json!({"action": "view"}), &NoRecall);
    assert_eq!(view["tokens"]["sent"].as_u64().unwrap() as usize, used);
    // 700 tokens for the newest turn only.
    assert_eq!(used, 700);
}
