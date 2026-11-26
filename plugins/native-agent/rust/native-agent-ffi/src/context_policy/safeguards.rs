//! Checks a temp view must pass before it is sent. Any failure sends the full
//! T7 view instead and records why: a temp context may make a request smaller,
//! never wrong.

use std::collections::HashSet;

use crate::turn_memory::split_turns;
use crate::types::{ContentBlock, Message, MessageContent};

/// Messages compare by their JSON form (`Message` has no `PartialEq`).
pub fn same_msg(a: &Message, b: &Message) -> bool {
    a.role == b.role
        && serde_json::to_value(&a.content).ok() == serde_json::to_value(&b.content).ok()
}

fn call_ids(msgs: &[Message]) -> (HashSet<String>, HashSet<String>) {
    let mut uses = HashSet::new();
    let mut results = HashSet::new();
    for m in msgs {
        if let MessageContent::Blocks(bs) = &m.content {
            for b in bs {
                match b {
                    ContentBlock::ToolUse { id, .. } => {
                        uses.insert(id.clone());
                    }
                    ContentBlock::ToolResult { tool_use_id, .. } => {
                        results.insert(tool_use_id.clone());
                    }
                    _ => {}
                }
            }
        }
    }
    (uses, results)
}

/// `Ok` when `view` keeps everything a temp view must keep from `full`:
/// the newest user prompt and every step after it, every tool call paired with
/// its result, and no more than `full` had.
pub fn check(
    full: &[Message],
    view: &[Message],
    dropped_calls: &HashSet<String>,
) -> Result<(), String> {
    let Some(newest) = split_turns(full).last().cloned() else {
        return Ok(());
    };
    let prompt = &full[newest.start];
    let Some(at) = view.iter().position(|m| same_msg(m, prompt)) else {
        return Err("the newest user prompt is missing".into());
    };
    // Every message of the running task is there, in order (duplicate calls the
    // policy dropped excepted).
    let mut vi = at;
    for m in &full[newest.start..newest.end] {
        let only_dropped = matches!(&m.content, MessageContent::Blocks(bs) if !bs.is_empty() && bs.iter().all(|b| match b {
            ContentBlock::ToolUse { id, .. } => dropped_calls.contains(id),
            ContentBlock::ToolResult { tool_use_id, .. } => dropped_calls.contains(tool_use_id),
            _ => false,
        }));
        if only_dropped {
            continue;
        }
        let found = view[vi..]
            .iter()
            .position(|v| same_msg(v, m) || same_without(v, m, dropped_calls));
        match found {
            Some(off) => vi += off + 1,
            None => return Err("a step of the running task is missing".into()),
        }
    }
    let (uses, results) = call_ids(view);
    if uses != results {
        return Err("a tool call and its result are not both in the view".into());
    }
    if view.len() > full.len() {
        return Err("the temp view is larger than the full view".into());
    }
    Ok(())
}

fn same_without(v: &Message, m: &Message, dropped: &HashSet<String>) -> bool {
    match (&v.content, &m.content) {
        (MessageContent::Blocks(a), MessageContent::Blocks(b)) => {
            let kept: Vec<&ContentBlock> = b
                .iter()
                .filter(|blk| match blk {
                    ContentBlock::ToolUse { id, .. } => !dropped.contains(id),
                    ContentBlock::ToolResult { tool_use_id, .. } => !dropped.contains(tool_use_id),
                    _ => true,
                })
                .collect();
            v.role == m.role && serde_json::to_value(a).ok() == serde_json::to_value(&kept).ok()
        }
        _ => false,
    }
}

/// Why the model's own calls ask for full context this step: `ctx task
/// id:T7`, or a `ctx recall` of something the temp view left out.
pub fn escalation(calls: &[(String, serde_json::Value)], left_out: &[String]) -> Option<String> {
    for (name, input) in calls {
        if name != crate::context_tree::tools::CTX_TOOL {
            continue;
        }
        let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("");
        if action == "task" && input.get("id").and_then(|v| v.as_str()).map(str::trim) == Some("T7")
        {
            return Some("model_asked_t7".into());
        }
        if action == "recall" {
            let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !id.is_empty()
                && left_out
                    .iter()
                    .any(|l| l == id || id.starts_with(&format!("{l}/")))
            {
                return Some(format!("recall:{id}"));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Role;
    use serde_json::json;

    fn user(t: &str) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Text(t.into()),
        }
    }
    fn call(id: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
                id: id.into(),
                name: "read_file".into(),
                input: json!({}),
                provider_metadata: None,
            }]),
        }
    }
    fn res(id: &str) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: "x".into(),
                is_error: false,
            }]),
        }
    }

    #[test]
    fn a_view_missing_the_prompt_a_step_or_a_pair_fails() {
        let full = vec![
            user("old"),
            user("new"),
            call("a"),
            res("a"),
            call("b"),
            res("b"),
        ];
        let none = HashSet::new();
        assert!(check(&full, &full[1..], &none).is_ok());
        assert!(check(&full, &full[2..], &none)
            .unwrap_err()
            .contains("prompt"));
        let missing_step = vec![full[1].clone(), full[2].clone(), full[3].clone()];
        assert!(check(&full, &missing_step, &none).is_err());
        let unpaired = vec![
            full[1].clone(),
            full[2].clone(),
            full[4].clone(),
            full[5].clone(),
        ];
        assert!(check(&full, &unpaired, &none).is_err());
        let dropped: HashSet<String> = ["a".to_string()].into();
        let ok = vec![full[1].clone(), full[4].clone(), full[5].clone()];
        assert!(
            check(&full, &ok, &dropped).is_ok(),
            "a dropped duplicate pair is allowed"
        );
    }

    #[test]
    fn t7_requests_and_recalls_of_left_out_items_escalate() {
        let left = vec!["turn/t3".to_string()];
        assert_eq!(
            escalation(
                &[("ctx".into(), json!({"action": "task", "id": "T7"}))],
                &left
            )
            .as_deref(),
            Some("model_asked_t7")
        );
        assert_eq!(
            escalation(
                &[("ctx".into(), json!({"action": "recall", "id": "turn/t3"}))],
                &left
            )
            .as_deref(),
            Some("recall:turn/t3")
        );
        assert!(escalation(
            &[("ctx".into(), json!({"action": "recall", "id": "turn/t9"}))],
            &left
        )
        .is_none());
        assert!(escalation(&[("read_file".into(), json!({}))], &left).is_none());
    }
}
