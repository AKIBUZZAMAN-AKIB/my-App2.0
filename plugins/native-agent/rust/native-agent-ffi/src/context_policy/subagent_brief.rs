//! The brief a sub-agent gets of its parent's running task.
//!
//! A sub-agent starts with only its own task text. When the parent is in the
//! middle of a task, the sub-agent should know what the user asked for, what
//! the answer must look like, and what the parent already found, without the
//! parent's whole transcript. The brief is small and capped: the user's
//! request, the goal, constraints and answer requirements, the items the
//! parent keeps, and the newest tool results (each shortened).

use super::task_goal::TaskGoal;
use super::types::PolicyId;
use crate::turn_memory::split_turns;
use crate::types::{ContentBlock, Message, MessageContent};

/// Upper bound of the whole brief, in characters.
pub const BRIEF_CAP: usize = 6_000;
const REQUEST_CAP: usize = 2_000;
const RESULT_CAP: usize = 600;
const RESULTS_MAX: usize = 3;

fn cut(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// The newest successful tool results of the running task, newest last.
fn latest_results(view: &[Message]) -> Vec<(String, String)> {
    let Some(t) = split_turns(view).last().cloned() else {
        return Vec::new();
    };
    let msgs = &view[t.start..t.end];
    let mut names = std::collections::HashMap::new();
    let mut out = Vec::new();
    for m in msgs {
        if let MessageContent::Blocks(bs) = &m.content {
            for b in bs {
                match b {
                    ContentBlock::ToolUse { id, name, .. } => {
                        names.insert(id.clone(), name.clone());
                    }
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error: false,
                    } => {
                        let name = names.get(tool_use_id).cloned().unwrap_or_default();
                        if name != crate::context_tree::tools::CTX_TOOL
                            && !crate::subagents::is_subagent_tool(&name)
                        {
                            out.push((name, content.clone()));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let skip = out.len().saturating_sub(RESULTS_MAX);
    out.into_iter().skip(skip).collect()
}

/// Render the brief. Never longer than [`BRIEF_CAP`] characters.
pub fn render(goal: &TaskGoal, policy: PolicyId, items: &[String], view: &[Message]) -> String {
    let mut s =
        String::from("The main chat is in the middle of a task; your work is one part of it.\n");
    s.push_str(&format!(
        "User request: {}\n",
        cut(&goal.user_request, REQUEST_CAP)
    ));
    if let Some(o) = goal
        .required_outcome
        .as_deref()
        .filter(|o| !o.trim().is_empty())
    {
        s.push_str(&format!("Goal: {}\n", cut(o, 300)));
    }
    for st in &goal.steer_messages {
        s.push_str(&format!("Later instruction: {}\n", cut(st, 500)));
    }
    if !goal.constraints.is_empty() {
        s.push_str(&format!(
            "Constraints: {}\n",
            cut(&goal.constraints.join("; "), 800)
        ));
    }
    if !goal.response_requirements.is_empty() {
        s.push_str(&format!(
            "Answer requirements: {}\n",
            cut(&goal.response_requirements.join("; "), 800)
        ));
    }
    let kept: Vec<&str> = items
        .iter()
        .map(String::as_str)
        .filter(|i| !i.starts_with("user/"))
        .take(24)
        .collect();
    s.push_str(&format!(
        "Parent context: {} {}",
        policy.as_str(),
        policy.name()
    ));
    if !kept.is_empty() {
        s.push_str(&format!("; keeps {}", kept.join(", ")));
    }
    s.push('\n');
    let results = latest_results(view);
    if !results.is_empty() {
        s.push_str("Newest results the parent has:\n");
        for (name, content) in results {
            s.push_str(&format!("- {}: {}\n", name, cut(&content, RESULT_CAP)));
        }
    }
    cut(&s, BRIEF_CAP)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Role;
    use serde_json::json;

    fn msg(role: Role, content: MessageContent) -> Message {
        Message { role, content }
    }

    #[test]
    fn the_brief_names_the_request_constraints_and_newest_results() {
        let g = TaskGoal::new(
            "Compare the two invoices and do not include VAT",
            &["answer in a table".to_string()],
            None,
            1,
        );
        let view = vec![
            msg(
                Role::User,
                MessageContent::Text("Compare the two invoices and do not include VAT".into()),
            ),
            msg(
                Role::Assistant,
                MessageContent::Blocks(vec![ContentBlock::ToolUse {
                    id: "c1".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a.txt"}),
                    provider_metadata: None,
                }]),
            ),
            msg(
                Role::User,
                MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: "c1".into(),
                    content: "INVOICE-A total 120".into(),
                    is_error: false,
                }]),
            ),
        ];
        let b = render(
            &g,
            PolicyId::T1,
            &["user/newest".into(), "res/R1".into()],
            &view,
        );
        assert!(b.contains("Compare the two invoices"));
        assert!(b.contains("answer in a table"));
        assert!(b.contains("INVOICE-A total 120"));
        assert!(b.contains("T1"));
        assert!(b.contains("res/R1"));
        assert!(!b.contains("user/newest"));
    }

    #[test]
    fn the_brief_is_capped() {
        let g = TaskGoal::new(&"x".repeat(20_000), &[], None, 1);
        let b = render(&g, PolicyId::T7, &[], &[]);
        assert!(b.chars().count() <= BRIEF_CAP + 1);
    }
}
