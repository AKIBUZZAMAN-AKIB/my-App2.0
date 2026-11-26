//! The request view: which turns and tool calls go out, by absolute turn
//! number, with and without summarized turns restored as written.

use super::wiring::{self, TurnNumbers};
use crate::types::{ContentBlock, Message, MessageContent, Role};
use std::collections::BTreeSet;

fn user(text: &str) -> Message {
    Message {
        role: Role::User,
        content: MessageContent::Text(text.to_string()),
    }
}

fn call(id: &str) -> Message {
    Message {
        role: Role::Assistant,
        content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
            id: id.into(),
            name: "read".into(),
            input: serde_json::json!({}),
            provider_metadata: None,
        }]),
    }
}

fn result(id: &str) -> Message {
    Message {
        role: Role::User,
        content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
            tool_use_id: id.into(),
            content: format!("result of {id}"),
            is_error: false,
        }]),
    }
}

fn answer(text: &str) -> Message {
    Message {
        role: Role::Assistant,
        content: MessageContent::Text(text.to_string()),
    }
}

/// A turn `n` with one tool call `c<n>` and an answer.
fn turn(n: u32) -> Vec<Message> {
    vec![
        user(&format!("prompt {n}")),
        call(&format!("c{n}")),
        result(&format!("c{n}")),
        answer(&format!("answer {n}")),
    ]
}

fn ids(view: &[Message]) -> Vec<String> {
    let mut out = Vec::new();
    for m in view {
        if let MessageContent::Blocks(b) = &m.content {
            for x in b {
                if let ContentBlock::ToolUse { id, .. } = x {
                    out.push(id.clone());
                }
            }
        }
    }
    out
}

fn prompts(view: &[Message]) -> Vec<String> {
    view.iter()
        .filter(|m| m.is_user_prompt())
        .map(|m| m.text())
        .collect()
}

/// Bug 1: excluding turn 2 and the call of turn 3 must drop c3, not c4.
#[test]
fn excluding_a_turn_does_not_shift_the_calls_after_it() {
    let view: Vec<Message> = (1..=5).flat_map(turn).collect();
    let drop: BTreeSet<u32> = [12].into_iter().collect();
    let calls: BTreeSet<(u32, u32)> = [(13, 1)].into_iter().collect();
    // The view is turns 11-15 of the chat (offset 10).
    let out = wiring::request_view_calls(&view, 10, &drop, &calls);
    assert_eq!(
        prompts(&out),
        vec!["prompt 1", "prompt 3", "prompt 4", "prompt 5"]
    );
    assert_eq!(
        ids(&out),
        vec!["c1", "c4", "c5"],
        "turn 13's call goes, turn 14's stays"
    );
    // Every remaining call still has its result.
    let results = out.iter().filter(|m| matches!(&m.content, MessageContent::Blocks(b) if b.iter().any(|x| matches!(x, ContentBlock::ToolResult { .. })))).count();
    assert_eq!(results, 3);
}

#[test]
fn the_newest_turn_is_never_touched() {
    let view: Vec<Message> = (1..=2).flat_map(turn).collect();
    let drop: BTreeSet<u32> = [2].into_iter().collect();
    let calls: BTreeSet<(u32, u32)> = [(2, 1)].into_iter().collect();
    let out = wiring::request_view_calls(&view, 0, &drop, &calls);
    assert_eq!(ids(&out), vec!["c1", "c2"]);
}

/// Restored originals (raw-vs-summary) keep their real numbers: turns 2 and 3
/// of a chat whose view otherwise holds turns 9-10.
#[test]
fn restored_turns_keep_their_numbers() {
    let mut view = vec![Message {
        role: Role::Context,
        content: MessageContent::Text("memory block".into()),
    }];
    view.extend(turn(2));
    view.extend(turn(3));
    view.extend(turn(9));
    view.extend(turn(10));
    let heads: Vec<(u32, String)> = vec![
        (2, wiring::turn_head(&user("prompt 2"))),
        (3, wiring::turn_head(&user("prompt 3"))),
    ];
    let nums = TurnNumbers::from_view(&view, 10, &heads);
    assert_eq!(nums.restored(), &[2, 3]);
    assert_eq!(
        (nums.abs(1), nums.abs(2), nums.abs(3), nums.abs(4)),
        (2, 3, 9, 10)
    );
    assert_eq!(nums.offset(), 8);
    let drop: BTreeSet<u32> = [3].into_iter().collect();
    let calls: BTreeSet<(u32, u32)> = [(9, 1)].into_iter().collect();
    let out = wiring::request_view_mapped(&view, &nums, &drop, &calls);
    assert_eq!(prompts(&out), vec!["prompt 2", "prompt 9", "prompt 10"]);
    assert_eq!(ids(&out), vec!["c2", "c10"]);
    assert!(
        out[0].text().contains("memory block"),
        "the memory block is never dropped"
    );
}

/// A compaction that trimmed the first restored turn does not shift the rest.
#[test]
fn trimmed_restored_turns_are_matched_by_head() {
    let mut view = turn(3);
    view.extend(turn(9));
    view.extend(turn(10));
    let heads: Vec<(u32, String)> = vec![
        (2, wiring::turn_head(&user("prompt 2"))),
        (3, wiring::turn_head(&user("prompt 3"))),
    ];
    let nums = TurnNumbers::from_view(&view, 10, &heads);
    assert_eq!((nums.abs(1), nums.abs(2), nums.abs(3)), (3, 9, 10));
}

#[test]
fn no_restored_turns_is_the_plain_offset() {
    let view: Vec<Message> = (1..=3).flat_map(turn).collect();
    let nums = TurnNumbers::from_view(&view, 7, &[]);
    assert_eq!(nums, TurnNumbers::contiguous(4));
    assert_eq!(nums.abs(1), 5);
}
