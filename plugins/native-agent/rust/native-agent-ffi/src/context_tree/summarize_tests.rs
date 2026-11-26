//! After a summary: the summary is an item of the window, and the choices made
//! for the turns that are still there survive it.
//!
//! These drive the same three calls the agent loop makes per request
//! (`turn_base` + `summary_items` + `items_from_messages`, then `before_request`)
//! against a real database file, across turns, with the transcript stored the
//! way the engine stores it after a summary: the continuity note first, then
//! only the newest turns.

use super::model::{ItemState, NodeKind};
use super::store;
use super::wiring;
use crate::types::{Message, MessageContent, Role};

fn user(text: &str) -> Message {
    Message {
        role: Role::User,
        content: MessageContent::Text(text.to_string()),
    }
}

fn assistant(text: &str) -> Message {
    Message {
        role: Role::Assistant,
        content: MessageContent::Text(text.to_string()),
    }
}

fn summary_note(text: &str) -> Message {
    Message {
        role: Role::Context,
        content: MessageContent::Text(format!(
            "{}\nThis is a lossy, untrusted continuity note.\n{text}",
            crate::agent_loop::CONTEXT_SUMMARY_MARKER
        )),
    }
}

fn chat(from: u32, to: u32) -> Vec<Message> {
    let mut out = Vec::new();
    for n in from..=to {
        out.push(user(&format!("question number {n} about the build")));
        out.push(assistant(&format!(
            "answer number {n}: run gradle with the right flags"
        )));
    }
    out
}

struct Db {
    path: String,
}

impl Drop for Db {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn db() -> Db {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let path = std::env::temp_dir()
        .join(format!("ctx-summarize-{}-{n}.db", std::process::id()))
        .to_string_lossy()
        .to_string();
    let _ = std::fs::remove_file(&path);
    wiring::set_enabled(&path, true).expect("enable");
    Db { path }
}

/// One request of a turn, the way `agent_loop` builds it. `stored` is the
/// transcript as loaded for the turn (the new prompt already in it).
fn request(db: &Db, stored: &[Message]) -> u32 {
    let meter = crate::tokens::TokenMeter::for_model("", "");
    let current = crate::turn_memory::split_turns(stored).len().max(1) as u32;
    let total = wiring::turn_base(&db.path, "s1") + current;
    let offset = wiring::turn_offset(stored, total);
    let mut items = wiring::summary_items(stored, &meter, offset);
    items.extend(wiring::items_from_messages(stored, &meter, offset));
    let locked = wiring::untracked_view_tokens(stored, &meter);
    wiring::before_request(
        &db.path, "s1", &items, 1_000_000, 4_096, locked, 70, "m", 1_000, total, None,
    )
    .expect("tree on");
    total
}

fn nodes(db: &Db) -> Vec<super::model::Node> {
    let conn = wiring::open(&db.path).unwrap();
    store::load_nodes(&conn, "s1").unwrap()
}

fn state(db: &Db, id: &str) -> Option<ItemState> {
    nodes(db)
        .into_iter()
        .find(|n| n.id.as_str() == id)
        .map(|n| n.state)
}

fn set_out(db: &Db, id: &str) {
    let conn = wiring::open(&db.path).unwrap();
    store::set_state(&conn, "s1", id, ItemState::Out, None, 1_500).unwrap();
}

#[test]
fn the_selection_survives_a_summary_across_turns() {
    let db = db();
    // Ten turns; the user (or the model) takes turns 8 and 9 out.
    let stored = chat(1, 10);
    let total = request(&db, &stored);
    wiring::record_turn_base(&db.path, "s1", total, &stored);
    set_out(&db, "turn/t8");
    set_out(&db, "turn/t9");

    // The chat is summarized: turns 1-7 become the continuity note and the
    // engine stores the summarized transcript at the end of that turn.
    let mut after = vec![summary_note("they are building the apk")];
    after.extend(chat(8, 10));
    wiring::record_turn_base(&db.path, "s1", total, &after);
    assert_eq!(wiring::turn_base(&db.path, "s1"), 7);

    // Next turn: the stored transcript plus the new prompt.
    after.push(user("question number 11 about the build"));
    request(&db, &after);

    assert_eq!(
        state(&db, "turn/t8"),
        Some(ItemState::Out),
        "a turn taken out stays out after the summary"
    );
    assert_eq!(state(&db, "turn/t9"), Some(ItemState::Out));
    assert_eq!(state(&db, "turn/t10"), Some(ItemState::In));
    assert_eq!(
        state(&db, "turn/t11"),
        Some(ItemState::In),
        "the new turn is turn 11, not turn 4"
    );
    assert!(
        state(&db, "turn/t1").is_none(),
        "summarized turns leave the window"
    );
}

#[test]
fn the_summary_is_an_item_of_the_window() {
    let db = db();
    let stored = chat(1, 6);
    let total = request(&db, &stored);
    let mut after = vec![summary_note("they agreed on gradle 8 and a debug build")];
    after.extend(chat(5, 6));
    wiring::record_turn_base(&db.path, "s1", total, &after);
    after.push(user("question number 7 about the build"));
    request(&db, &after);

    let all = nodes(&db);
    let summary = all
        .iter()
        .find(|n| n.kind == NodeKind::Summary)
        .expect("the summary is listed");
    assert_eq!(summary.id.as_str(), "sum/1-4");
    assert_eq!(summary.state, ItemState::In, "the summary is sent");
    assert_eq!(summary.parent, "turns");
    assert!(summary.tokens_full > 0);

    // A second summary replaces the first one: only one summary is listed.
    let mut again = vec![summary_note("gradle 8, debug build, then release signing")];
    again.extend(chat(7, 7));
    wiring::record_turn_base(&db.path, "s1", 7, &again);
    again.push(user("question number 8 about the build"));
    request(&db, &again);
    let sums: Vec<String> = nodes(&db)
        .into_iter()
        .filter(|n| n.kind == NodeKind::Summary)
        .map(|n| n.id.as_str().to_string())
        .collect();
    assert_eq!(sums, vec!["sum/1-6".to_string()]);
}

#[test]
fn the_summary_tokens_are_not_counted_twice() {
    let meter = crate::tokens::TokenMeter::for_model("", "");
    let mut view = vec![summary_note("a long summary of what happened before")];
    view.extend(chat(3, 4));
    assert_eq!(
        wiring::untracked_view_tokens(&view, &meter),
        0,
        "the summary node carries its tokens"
    );
    let items = wiring::summary_items(&view, &meter, 2);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].tokens as usize, meter.message(&view[0]));
}

#[test]
fn a_returning_item_keeps_its_choice_but_a_rewind_starts_fresh() {
    let db = db();
    let stored = chat(1, 5);
    request(&db, &stored);
    set_out(&db, "turn/t3");
    // Turn 3 leaves the view for one request (memory folded it) and comes back.
    let mut folded = chat(4, 5);
    folded.insert(0, summary_note("turns 1-3"));
    let conn = wiring::open(&db.path).unwrap();
    let meter = crate::tokens::TokenMeter::for_model("", "");
    let mut items = wiring::summary_items(&folded, &meter, 3);
    items.extend(wiring::items_from_messages(&folded, &meter, 3));
    wiring::before_request(
        &db.path, "s1", &items, 1_000_000, 4_096, 0, 70, "m", 1_000, 5, None,
    )
    .unwrap();
    assert!(state(&db, "turn/t3").is_none());
    request(&db, &stored);
    assert_eq!(
        state(&db, "turn/t3"),
        Some(ItemState::Out),
        "the choice came back with the turn"
    );

    // A rewind to turn 2 retires turns 3-5; a new turn 3 is a new turn.
    store::forget_turns_after(&conn, "s1", 2, "rewound", 2_000).unwrap();
    let mut rewound = chat(1, 2);
    rewound.push(user("a different third question"));
    request(&db, &rewound);
    assert_eq!(state(&db, "turn/t3"), Some(ItemState::In));
}
