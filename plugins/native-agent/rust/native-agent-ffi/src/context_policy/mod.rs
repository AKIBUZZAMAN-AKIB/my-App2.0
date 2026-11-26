//! Task Context Policy Engine (TCPE).
//!
//! A task starts at the first real tool call of a turn and ends with the model's
//! answer that has no tool call. While it runs, the *transcript* part of each
//! request may be shortened by one of seven presets (T1–T7). Everything else
//! goes exactly as before: the system prompt is only ever *appended to* (the
//! task block), tool schemas are never touched, and T7 — the request unchanged —
//! is the default and the fallback for every doubt.
//!
//! Layout:
//! - `types`, `registry`: the presets and their parameters.
//! - `task_goal`, `temp_checklist`: what the task is for, and what it keeps.
//! - `store`: pins, tasks and events in the session database.

pub mod bridge;
pub mod context_assembler;
pub mod dsl_parser;
pub mod dsl_validator;
pub mod exclusions;
pub mod lifecycle;
pub mod policy_selector;
pub mod registry;
pub mod request_facts;
pub mod rule_evaluator;
pub mod safeguards;
pub mod store;
pub mod task_goal;
pub mod temp_checklist;
pub mod types;

pub use task_goal::TaskGoal;
pub use temp_checklist::TempChecklist;
pub use types::{PolicyId, PolicyMode, PolicyParams, Source, TaskStatus};

/// The marker that starts the task block. It is appended at the very end of the
/// system prompt, after `[native-agent-context-tree-v1]`; nothing before it
/// changes, so the prompt cache prefix stays valid.
pub const TASK_BLOCK_MARKER: &str = "[native-agent-task-context-v1]";

/// What the task block shows about the running task.
#[derive(Debug, Clone, Default)]
pub struct BlockView<'a> {
    pub goal: Option<&'a TaskGoal>,
    pub checklist: Option<&'a TempChecklist>,
    /// Transcript items left out of this request (ids only).
    pub excluded_ids: &'a [String],
    /// One line per finished step: `"1 read_file ok"`.
    pub ledger: &'a [String],
}

/// The task block. It refers to the user's request instead of repeating it:
/// the newest prompt is in every request anyway.
pub fn render_task_block(view: &BlockView<'_>) -> String {
    let mut out = String::new();
    out.push_str(TASK_BLOCK_MARKER);
    out.push_str("\n## Current task\n");
    let goal_line = view
        .goal
        .and_then(|g| g.required_outcome.as_deref())
        .map(|o| format!("Goal: {o}"))
        .unwrap_or_else(|| "Goal: complete the newest user request.".to_string());
    out.push_str(&goal_line);
    out.push('\n');
    let steers = view.goal.map(|g| g.steer_messages.len()).unwrap_or(0);
    if steers > 0 {
        out.push_str(&format!("Request: the newest user message (user/newest) and {steers} later message(s) (user/steer/1..{steers}).\n"));
    } else {
        out.push_str("Request: the newest user message (user/newest), whole and unchanged.\n");
    }
    match view.checklist {
        Some(c) => {
            out.push_str(&format!(
                "Context: {} {} ({})",
                c.policy_id.as_str(),
                c.policy_id.name(),
                c.source.as_str()
            ));
            let kept: Vec<&str> = c
                .item_ids
                .iter()
                .map(|s| s.as_str())
                .filter(|s| !s.starts_with("user/"))
                .collect();
            if !kept.is_empty() {
                out.push_str(&format!("; kept: {}", cap_list(&kept, 24)));
            }
            out.push('\n');
        }
        None => out.push_str("Context: T7 FullContext\n"),
    }
    if !view.excluded_ids.is_empty() {
        let ex: Vec<&str> = view.excluded_ids.iter().map(|s| s.as_str()).collect();
        out.push_str(&format!(
            "Left out of this request (stored; `ctx recall <id>` brings one back): {}\n",
            cap_list(&ex, 24)
        ));
    }
    if !view.ledger.is_empty() {
        out.push_str(&format!("Steps: {}\n", view.ledger.join("; ")));
    }
    out.push_str("Give the full answer, as you normally would. If anything seems missing, call `ctx task id:T7`.\n");
    out
}

fn cap_list(items: &[&str], max: usize) -> String {
    if items.len() <= max {
        items.join(", ")
    } else {
        format!("{} (+{} more)", items[..max].join(", "), items.len() - max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_starts_with_its_marker_and_never_repeats_the_request() {
        let g = TaskGoal::new("please read secret.txt and tell me", &[], None, 1);
        let (c, _) = TempChecklist::build(
            Some("T6"),
            None,
            &["turn/t2".into()],
            &|_| true,
            0,
            Source::Ai,
            1,
        );
        let ex = vec!["turn/t1".to_string()];
        let ledger = vec!["1 read_file ok".to_string()];
        let b = render_task_block(&BlockView {
            goal: Some(&g),
            checklist: Some(&c),
            excluded_ids: &ex,
            ledger: &ledger,
        });
        assert!(b.starts_with(TASK_BLOCK_MARKER));
        assert!(
            !b.contains("secret.txt"),
            "the request is referenced, not copied"
        );
        assert!(b.contains("T6 ChecklistSelection"));
        assert!(b.contains("kept: turn/t2"));
        assert!(b.contains("ctx recall <id>"));
        assert!(b.contains("turn/t1"));
        assert!(b.contains("Steps: 1 read_file ok"));
        assert!(b.contains("ctx task id:T7"));
    }

    #[test]
    fn an_empty_view_is_still_a_valid_block() {
        let b = render_task_block(&BlockView::default());
        assert!(b.contains("T7 FullContext"));
        assert!(b.contains("Goal: complete the newest user request."));
    }
}
