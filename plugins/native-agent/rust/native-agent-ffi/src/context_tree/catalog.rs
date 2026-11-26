//! The parts a system prompt is made of, as nodes.
//!
//! The engine builds one big string and sends it. That is fine for a model reading
//! it, and useless for a model that has to *budget* it: "the prompt is 8k tokens"
//! says nothing about which 8k could be unloaded on a phone with a 16k window.
//!
//! This catalog names the parts the engine actually has, measures each one, and
//! files it as a `sys/*` node, so the checklist can show them individually and
//! `ctx(action:"prompt")` can act on them. Two rules:
//!
//! * **`sys/core` is the law.** It is the rules prompt: never unloadable, never
//!   summarised, always counted in the locked set.
//! * **The tool groups are the real budget lever.** Tool schemas cost ~100 tokens
//!   each and this app can carry ~100 tools; unloading the groups a turn does not
//!   need is the biggest win available on a small window. The group names are
//!   taken from the UI's own list (`tools/agent-html-src/40-permissions.js`) and a
//!   test fails if the two ever disagree — this repository has been bitten twice
//!   by exactly that drift.

use super::model::ItemState;
use super::reading::ReadItem;

/// A part of the system prompt, before it is measured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    /// `sys/<id>` suffix: `core`, `memory`, `tools.files`, …
    pub id: &'static str,
    pub title: &'static str,
    /// The text that starts this section in the prompt; empty for `core`, which is
    /// everything before the first marker.
    pub marker: &'static str,
    /// `sys/core` and nothing else.
    pub locked: bool,
}

/// The tool groups the UI groups tools into. Kept in the same order as the UI so a
/// reader comparing the two lists sees a difference immediately.
pub const TOOL_GROUPS: [(&str, &str); 12] = [
    ("files", "Files"),
    ("git", "Git"),
    ("shell", "Commands"),
    ("web", "Web"),
    ("memory", "Memory"),
    ("docs", "Documents"),
    ("auto", "Automations"),
    ("device", "Phone (device)"),
    ("mcp", "MCP servers"),
    ("ui", "Widgets (ui__)"),
    ("agents", "Sub-agents & chats"),
    ("other", "Other"),
];

/// The parts every request has, in the order they are sent.
///
/// `marker` is the text that starts the section; the section runs until the next
/// marker. `core` is everything before the first marker, which is exactly the
/// rules prompt: the engine puts it first and nothing else precedes it.
pub fn parts() -> Vec<Part> {
    vec![
        Part {
            id: "core",
            title: "Rules",
            marker: "",
            locked: true,
        },
        Part {
            id: "memory",
            title: "Chat memory rules",
            marker: "## Chat memory",
            locked: false,
        },
        Part {
            id: "context",
            title: "Context window rules",
            marker: "[native-agent-context-tree-v1]",
            locked: false,
        },
        // The task block of the task context policy: appended last, locked so a
        // running task always knows its goal and what was left out.
        Part {
            id: "task",
            title: "Task context",
            marker: crate::context_policy::TASK_BLOCK_MARKER,
            locked: true,
        },
    ]
}

/// Measure the parts that are actually present and turn them into items.
///
/// `measure` is the caller's tokenizer (`meter.text`), passed in so this module has
/// no dependency on the engine and can be tested with a character counter. A part
/// that is not in the prompt is not invented: the model must not see a checklist
/// entry for something that is not being sent.
pub fn items(
    system_prompt: &str,
    measure: &dyn Fn(&str) -> usize,
    tool_tokens: u32,
) -> Vec<ReadItem> {
    let mut marks: Vec<(usize, Part)> = Vec::new();
    let mut out: Vec<ReadItem> = Vec::new();
    for part in parts() {
        if part.marker.is_empty() {
            // `core` is measured after the other markers are known, below.
            continue;
        }
        if let Some(pos) = system_prompt.find(part.marker) {
            marks.push((pos, part));
        }
    }
    marks.sort_by_key(|(pos, _)| *pos);
    let first_mark = marks
        .first()
        .map(|(pos, _)| *pos)
        .unwrap_or(system_prompt.len());
    let core_text = &system_prompt[..first_mark];
    let core = parts()
        .into_iter()
        .find(|p| p.id == "core")
        .expect("core part");
    if !core_text.trim().is_empty() {
        out.push(sys_item(
            core.id,
            core.title,
            measure(core_text),
            core.locked,
        ));
    }
    for (i, (start, part)) in marks.iter().enumerate() {
        let end = marks
            .get(i + 1)
            .map(|(pos, _)| *pos)
            .unwrap_or(system_prompt.len());
        let slice = &system_prompt[*start..end];
        out.push(sys_item(part.id, part.title, measure(slice), part.locked));
    }
    // Tool schemas are not part of the prompt string but are paid on every request:
    // filing them as their own node is what makes the biggest fixed cost visible.
    if tool_tokens > 0 {
        out.push(sys_item(
            "tools",
            "Tool schemas",
            tool_tokens as usize,
            false,
        ));
    }
    out
}

fn sys_item(id: &str, title: &str, tokens: usize, locked: bool) -> ReadItem {
    let mut item = ReadItem::sys_part(id, title, tokens.min(u32::MAX as usize) as u32);
    item.initial_state = ItemState::In;
    // The rules prompt and the task block are hard pins; everything else may be
    // unloaded by the model when the window is tight.
    item.initial_pin = if locked {
        super::model::Pin::Locked
    } else {
        super::model::Pin::Ai
    };
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::model::Pin;

    /// The UI's group list, read from the file that defines it. A drift here is a
    /// real bug: the settings screen would offer a group the engine does not have.
    const PERMISSIONS_JS: &str =
        include_str!("../../../../../../tools/agent-html-src/40-permissions.js");

    fn ui_groups() -> Vec<String> {
        let start = PERMISSIONS_JS
            .find("const GROUPS = [")
            .expect("GROUPS in 40-permissions.js");
        // The array ends at `];`, not at the first `]` (each entry is `['id', 'Title']`).
        let end = PERMISSIONS_JS[start..]
            .find("];")
            .map(|i| start + i)
            .expect("end of GROUPS");
        let block = &PERMISSIONS_JS[start..end];
        let mut out = Vec::new();
        let mut rest = block;
        while let Some(open) = rest.find("['") {
            let after = &rest[open + 2..];
            let Some(close) = after.find('\'') else { break };
            out.push(after[..close].to_string());
            rest = &after[close..];
        }
        out
    }

    #[test]
    fn the_rust_group_list_matches_the_ui() {
        let ui = ui_groups();
        let rust: Vec<&str> = TOOL_GROUPS.iter().map(|(id, _)| *id).collect();
        assert_eq!(
            rust, ui,
            "tool groups drifted from 40-permissions.js:\nrust {rust:?}\nui   {ui:?}"
        );
    }

    #[test]
    fn every_group_has_a_human_title() {
        for (id, title) in TOOL_GROUPS {
            assert!(
                !id.is_empty() && !title.is_empty(),
                "group {id} has no title"
            );
            assert!(
                id.chars().all(|c| c.is_ascii_lowercase()),
                "group ids are lowercase ASCII: {id}"
            );
        }
    }

    #[test]
    fn only_the_rules_prompt_is_locked() {
        let locked: Vec<&str> = parts().iter().filter(|p| p.locked).map(|p| p.id).collect();
        assert_eq!(locked, vec!["core", "task"]);
    }

    #[test]
    fn parts_that_are_not_in_the_prompt_are_not_invented() {
        let count = |s: &str| s.chars().count();
        let bare = items("you are an agent. non-negotiable: be honest.", &count, 0);
        assert!(bare.iter().any(|i| i.id == "sys/core"));
        assert!(
            !bare.iter().any(|i| i.id == "sys/memory"),
            "no memory section, no memory node"
        );
        assert!(
            !bare.iter().any(|i| i.id == "sys/tools"),
            "no tool tokens, no tool node"
        );
    }

    #[test]
    fn the_law_is_pinned_and_the_rest_is_the_models_to_move() {
        let count = |s: &str| s.chars().count();
        let prompt = "non-negotiable: be honest.\n## Chat memory\nstuff";
        let items = items(prompt, &count, 4_000);
        let core = items.iter().find(|i| i.id == "sys/core").expect("core");
        assert_eq!(core.initial_pin, Pin::Locked);
        assert_eq!(core.initial_state, ItemState::In);
        let memory = items.iter().find(|i| i.id == "sys/memory").expect("memory");
        assert_eq!(memory.initial_pin, Pin::Ai);
        let tools = items.iter().find(|i| i.id == "sys/tools").expect("tools");
        assert_eq!(
            tools.tokens, 4_000,
            "the tool schemas are counted, not estimated"
        );
    }

    #[test]
    fn the_context_rules_part_follows_the_checklist_it_describes() {
        let count = |s: &str| s.chars().count();
        let prompt = "[native-agent-context-tree-v1] Your context window";
        let items = items(prompt, &count, 0);
        assert!(items.iter().any(|i| i.id == "sys/context"));
    }

    #[test]
    fn the_task_block_is_a_locked_part_only_while_it_is_sent() {
        let count = |s: &str| s.chars().count();
        let without = items("rules\n[native-agent-context-tree-v1] window", &count, 0);
        assert!(
            !without.iter().any(|i| i.id == "sys/task"),
            "no task block, no task node"
        );
        let prompt = format!(
            "rules\n[native-agent-context-tree-v1] window\n{} goal",
            crate::context_policy::TASK_BLOCK_MARKER
        );
        let with = items(&prompt, &count, 0);
        let task = with.iter().find(|i| i.id == "sys/task").expect("task part");
        assert_eq!(task.initial_pin, Pin::Locked);
        let ctx = with
            .iter()
            .find(|i| i.id == "sys/context")
            .expect("context part");
        assert!(
            ctx.tokens < count(&prompt) as u32,
            "the context part ends where the task block starts"
        );
    }
}
