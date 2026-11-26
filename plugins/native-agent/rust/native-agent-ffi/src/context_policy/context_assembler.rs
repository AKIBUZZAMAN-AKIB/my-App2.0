//! Build the request view of one task step from the T7 view and the temp
//! checklist. Pure: messages in, messages out.
//!
//! What never changes, whatever the policy: the system prompt and the tool
//! definitions (they are not passed here at all), the newest user prompt, the
//! steer messages, and every step of the running task (the newest turn) with
//! each tool call and its result kept as a pair. Only older turns, the memory
//! block and (T4) older search results are left out or shortened, and each one
//! left out is named so `ctx recall` can bring it back.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::request_facts::is_search_tool;
use super::temp_checklist::TempChecklist;
use super::types::PolicyId;
use crate::turn_memory::{is_memory_message, split_turns};
use crate::types::{ContentBlock, Message, MessageContent, Role};

/// The view and what it left out.
#[derive(Debug, Clone, Default)]
pub struct View {
    pub messages: Vec<Message>,
    /// Item IDs left out (`turn/t3`, `res/R7`, `mem.block`).
    pub left_out: Vec<String>,
}

pub struct AssembleInput<'a> {
    pub view: &'a [Message],
    pub list: &'a TempChecklist,
    /// View turn number to the chat's turn number (`TurnNumbers::abs`).
    pub abs: &'a dyn Fn(u32) -> u32,
    /// tool_use_id to stored result id (`R7`).
    pub result_ids: &'a HashMap<String, String>,
}

fn str_param<'a>(list: &'a TempChecklist, key: &str) -> Option<&'a str> {
    list.params.get(key).and_then(Value::as_str)
}

fn ids_param(list: &TempChecklist, key: &str) -> Vec<String> {
    list.params
        .get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// The bare record id of an item id: `mem/D12` and `#D12` both give `D12`.
fn bare(id: &str) -> String {
    id.trim()
        .trim_start_matches("mem/")
        .trim_start_matches('#')
        .trim_start_matches("range/")
        .to_string()
}

fn has_token(line: &str, tok: &str) -> bool {
    if tok.is_empty() {
        return false;
    }
    line.match_indices(tok).any(|(i, _)| {
        let before = line[..i].chars().last();
        let after = line[i + tok.len()..].chars().next();
        !before.is_some_and(|c| c.is_alphanumeric()) && !after.is_some_and(|c| c.is_alphanumeric())
    })
}

/// Which sections of the memory block a policy keeps.
#[derive(Clone, Copy, PartialEq)]
pub enum MemPart {
    /// Only the turn index (range summaries): T2.
    Ranges,
    /// Every section but the turn index: T3.
    Records,
    /// Every section: T6 explicit memory ids.
    All,
}

/// Filter the memory block's sections. The intro (marker, current goal) and
/// the closing recall note always stay. `ids` (when not empty) keeps only the
/// lines that name one of them.
pub fn filter_memory(text: &str, part: MemPart, ids: &[String]) -> String {
    let toks: Vec<String> = ids
        .iter()
        .map(|i| bare(i))
        .filter(|t| !t.is_empty())
        .collect();
    let mut out: Vec<&str> = Vec::new();
    let mut section: Option<bool> = None; // None: intro/footer; Some(keep)
    let mut prev_blank = true;
    for line in text.lines() {
        let blank = line.trim().is_empty();
        if blank {
            out.push(line);
            prev_blank = true;
            continue;
        }
        if prev_blank && line.trim_end().ends_with(':') && !line.starts_with("- ") {
            let is_turns =
                line.starts_with("Relevant earlier turns") || line.starts_with("Turn index");
            let keep = match part {
                MemPart::Ranges => is_turns,
                MemPart::Records => !is_turns,
                MemPart::All => true,
            };
            section = Some(keep);
            if keep {
                out.push(line);
            }
        } else if prev_blank && !line.starts_with("- ") {
            section = None;
            out.push(line);
        } else {
            match section {
                None => out.push(line),
                Some(true) if toks.is_empty() || toks.iter().any(|t| has_token(line, t)) => {
                    out.push(line)
                }
                _ => {}
            }
        }
        prev_blank = false;
    }
    // Drop headers left with no line under them.
    let mut cleaned: Vec<&str> = Vec::new();
    for (i, l) in out.iter().enumerate() {
        let header = l.trim_end().ends_with(':')
            && !l.starts_with("- ")
            && i > 0
            && out[i - 1].trim().is_empty();
        if header
            && out.get(i + 1).is_none_or(|n| n.trim().is_empty())
            && section_header_is_listy(l)
        {
            continue;
        }
        cleaned.push(l);
    }
    let mut s = cleaned.join("\n");
    while s.contains("\n\n\n") {
        s = s.replace("\n\n\n", "\n\n");
    }
    s
}

fn section_header_is_listy(l: &str) -> bool {
    // Section titles are sentences; the intro never ends a paragraph with ':' and
    // a blank line under it, so any such empty header is a section.
    !l.starts_with('[')
}

/// Ids of the tool calls in `msgs` that repeat an earlier successful call
/// with the same name and input (the earlier one is dropped), never touching
/// the last assistant step or a failed call.
fn duplicate_calls(msgs: &[Message]) -> HashSet<String> {
    let last_assistant = msgs.iter().rposition(|m| m.role == Role::Assistant);
    let mut failed: HashSet<&str> = HashSet::new();
    for m in msgs {
        if let MessageContent::Blocks(bs) = &m.content {
            for b in bs {
                if let ContentBlock::ToolResult {
                    tool_use_id,
                    is_error: true,
                    ..
                } = b
                {
                    failed.insert(tool_use_id.as_str());
                }
            }
        }
    }
    let mut seen: HashMap<String, (usize, String)> = HashMap::new();
    let mut drop = HashSet::new();
    for (i, m) in msgs.iter().enumerate() {
        if m.role != Role::Assistant {
            continue;
        }
        if let MessageContent::Blocks(bs) = &m.content {
            for b in bs {
                if let ContentBlock::ToolUse {
                    id, name, input, ..
                } = b
                {
                    if failed.contains(id.as_str()) {
                        continue;
                    }
                    let key = format!("{name}\u{1}{input}");
                    if let Some((pi, pid)) = seen.insert(key, (i, id.clone())) {
                        if Some(pi) != last_assistant {
                            drop.insert(pid);
                        }
                    }
                }
            }
        }
    }
    drop
}

/// Remove the given tool calls and their results from `msgs`; a message left
/// empty is removed.
fn drop_calls(msgs: Vec<Message>, ids: &HashSet<String>) -> Vec<Message> {
    if ids.is_empty() {
        return msgs;
    }
    msgs.into_iter()
        .filter_map(|mut m| {
            if let MessageContent::Blocks(bs) = &mut m.content {
                bs.retain(|b| match b {
                    ContentBlock::ToolUse { id, .. } => !ids.contains(id),
                    ContentBlock::ToolResult { tool_use_id, .. } => !ids.contains(tool_use_id),
                    _ => true,
                });
                if bs.is_empty() {
                    return None;
                }
            }
            Some(m)
        })
        .collect()
}

/// T4: replace every search result but the newest with a one-line note.
fn shorten_search(
    msgs: &mut [Message],
    result_ids: &HashMap<String, String>,
    left_out: &mut Vec<String>,
) {
    let mut names: HashMap<String, String> = HashMap::new();
    for m in msgs.iter() {
        if let MessageContent::Blocks(bs) = &m.content {
            for b in bs {
                if let ContentBlock::ToolUse { id, name, .. } = b {
                    names.insert(id.clone(), name.clone());
                }
            }
        }
    }
    let mut search: Vec<(usize, usize)> = Vec::new();
    for (mi, m) in msgs.iter().enumerate() {
        if let MessageContent::Blocks(bs) = &m.content {
            for (bi, b) in bs.iter().enumerate() {
                if let ContentBlock::ToolResult {
                    tool_use_id,
                    is_error: false,
                    ..
                } = b
                {
                    if names.get(tool_use_id).is_some_and(|n| is_search_tool(n)) {
                        search.push((mi, bi));
                    }
                }
            }
        }
    }
    search.pop(); // the newest search result stays whole
    for (mi, bi) in search {
        if let MessageContent::Blocks(bs) = &mut msgs[mi].content {
            if let ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } = &mut bs[bi]
            {
                let rid = result_ids.get(tool_use_id.as_str()).cloned();
                let label = rid
                    .clone()
                    .map(|r| format!("res/{r}"))
                    .unwrap_or_else(|| "this search result".into());
                *content = match &rid {
                    Some(r) => format!("[search result {label} left out by policy T4; ctx recall res/{r} reads it]"),
                    None => "[search result left out by policy T4; ctx task id:T7 brings it back]".into(),
                };
                left_out.push(
                    rid.map(|r| format!("res/{r}"))
                        .unwrap_or_else(|| format!("call/{tool_use_id}")),
                );
            }
        }
    }
}

/// Build the view. T7 returns the input unchanged.
pub fn assemble(inp: &AssembleInput<'_>) -> View {
    let list = inp.list;
    let policy = list.policy_id;
    if policy == PolicyId::T7 {
        return View {
            messages: inp.view.to_vec(),
            left_out: Vec::new(),
        };
    }
    let turns = split_turns(inp.view);
    let Some(newest) = turns.last().cloned() else {
        return View {
            messages: inp.view.to_vec(),
            left_out: Vec::new(),
        };
    };
    let older = &turns[..turns.len() - 1];
    let lead_end = turns.first().map(|t| t.start).unwrap_or(0);
    let mut left_out = Vec::new();

    // Which older turns stay.
    let keep_turn: Box<dyn Fn(usize, u32) -> bool> = match policy {
        PolicyId::T4 => Box::new(|_, _| true),
        PolicyId::T5 => {
            let n = list
                .params
                .get("recent_turns")
                .and_then(Value::as_u64)
                .unwrap_or(2) as usize;
            let first_kept = older.len().saturating_sub(n);
            Box::new(move |i, _| i >= first_kept)
        }
        PolicyId::T6 => {
            let mut ids = ids_param(list, "item_ids");
            ids.extend(list.item_ids.iter().cloned());
            let wanted: HashSet<u32> = ids
                .iter()
                .filter_map(|id| {
                    id.strip_prefix("turn/t")
                        .map(|r| r.split('/').next().unwrap_or_default().to_string())
                })
                .filter_map(|n| n.parse().ok())
                .collect();
            Box::new(move |_, abs| wanted.contains(&abs))
        }
        _ => Box::new(|_, _| false),
    };

    // Memory block handling.
    let mem_part = match policy {
        PolicyId::T2 => Some((
            MemPart::Ranges,
            if str_param(list, "ranges") == Some("explicit") {
                ids_param(list, "range_ids")
            } else {
                Vec::new()
            },
        )),
        PolicyId::T3 => Some((
            MemPart::Records,
            if str_param(list, "memory_scope") == Some("explicit") {
                ids_param(list, "memory_ids")
            } else {
                Vec::new()
            },
        )),
        PolicyId::T4 => Some((MemPart::All, Vec::new())),
        PolicyId::T6 => {
            let mut ids = ids_param(list, "item_ids");
            ids.extend(list.item_ids.iter().cloned());
            let mem: Vec<String> = ids
                .into_iter()
                .filter(|i| i.starts_with("mem/") || i.starts_with('#'))
                .collect();
            if mem.is_empty() {
                None
            } else {
                Some((MemPart::All, mem))
            }
        }
        _ => None,
    };

    let mut out: Vec<Message> = Vec::new();
    for m in &inp.view[..lead_end] {
        if is_memory_message(m) {
            match (&mem_part, &m.content) {
                (Some((MemPart::All, ids)), _) if ids.is_empty() => out.push(m.clone()),
                (Some((part, ids)), MessageContent::Text(t)) => {
                    out.push(Message {
                        role: m.role,
                        content: MessageContent::Text(filter_memory(t, *part, ids)),
                    });
                    if !(matches!(part, MemPart::All) && ids.is_empty()) {
                        left_out.push("mem.block (part)".into());
                    }
                }
                _ => left_out.push("mem.block".into()),
            }
        } else if m.role == Role::Context {
            // A continuity summary of older turns: kept only where older turns are.
            if matches!(policy, PolicyId::T4 | PolicyId::T5) {
                out.push(m.clone());
            } else {
                left_out.push("summary".into());
            }
        } else {
            out.push(m.clone());
        }
    }
    for (i, t) in older.iter().enumerate() {
        let abs = (inp.abs)(t.no);
        if keep_turn(i, abs) {
            out.extend(inp.view[t.start..t.end].iter().cloned());
        } else {
            left_out.push(format!("turn/t{abs}"));
        }
    }
    let mut newest_msgs: Vec<Message> = inp.view[newest.start..newest.end].to_vec();
    if policy == PolicyId::T1 {
        let dups = duplicate_calls(&newest_msgs);
        for d in &dups {
            left_out.push(format!("call/{d}"));
        }
        newest_msgs = drop_calls(newest_msgs, &dups);
    }
    out.extend(newest_msgs);
    // Anything after the newest turn's range (none in practice) is kept.
    out.extend(inp.view[newest.end..].iter().cloned());
    if policy == PolicyId::T4 {
        shorten_search(&mut out, inp.result_ids, &mut left_out);
    }
    View {
        messages: out,
        left_out,
    }
}

/// The short block the model reads with a temp view: the policy, what was left
/// out, and how to get it back.
pub fn task_block(list: &TempChecklist, goal: &str, left_out: &[String]) -> String {
    let mut s = format!(
        "[task-context] This step uses policy {} ({}), chosen by {}. Goal: {}.",
        list.policy_id,
        list.policy_id.name(),
        list.source.as_str(),
        if goal.trim().is_empty() {
            "the newest request"
        } else {
            goal.trim()
        }
    );
    if !left_out.is_empty() {
        let shown: Vec<&str> = left_out.iter().take(20).map(String::as_str).collect();
        s.push_str(&format!(
            " Left out for this task only (nothing is deleted): {}{}.",
            shown.join(", "),
            if left_out.len() > 20 { ", ..." } else { "" }
        ));
    }
    s.push_str(" If something you need is missing: ctx recall <id>, or ctx task id:T7 for full context. Answer fully as usual.");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_policy::types::Source;
    use serde_json::json;

    fn user(t: &str) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Text(t.into()),
        }
    }
    fn asst(t: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Text(t.into()),
        }
    }
    fn call(id: &str, name: &str, input: Value) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
                id: id.into(),
                name: name.into(),
                input,
                provider_metadata: None,
            }]),
        }
    }
    fn res(id: &str, text: &str, err: bool) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: text.into(),
                is_error: err,
            }]),
        }
    }
    fn mem() -> Message {
        let t = format!("{}\nConversation memory (version 3).\n\nDecisions in force NOW (act on these):\n- D1: use rust\n- D2: dark theme\n\nRelevant earlier turns (turn index, by topic):\n- S1-2: setup\n\nFor anything not shown, call recall_turns.", crate::turn_memory::MEMORY_MARKER);
        Message {
            role: Role::Context,
            content: MessageContent::Text(t),
        }
    }
    fn chat() -> Vec<Message> {
        vec![
            mem(),
            user("first"),
            asst("a1"),
            user("second"),
            asst("a2"),
            user("third"),
            asst("a3"),
            user("search the web twice"),
            call("c1", "web_search", json!({"q": "x"})),
            res("c1", "old results", false),
            call("c2", "web_search", json!({"q": "y"})),
            res("c2", "new results", false),
            call("c3", "web_search", json!({"q": "y"})),
            res("c3", "new results", false),
        ]
    }
    fn list(p: &str, params: Option<Value>) -> TempChecklist {
        TempChecklist::build(Some(p), params.as_ref(), &[], &|_| true, 0, Source::Ai, 0).0
    }
    fn run(l: &TempChecklist) -> View {
        let v = chat();
        let ids: HashMap<String, String> = [
            ("c1".to_string(), "R1".to_string()),
            ("c2".into(), "R2".into()),
        ]
        .into();
        assemble(&AssembleInput {
            view: &v,
            list: l,
            abs: &|n| n,
            result_ids: &ids,
        })
    }
    fn texts(v: &View) -> String {
        v.messages
            .iter()
            .map(|m| format!("{:?}", m.content))
            .collect::<Vec<_>>()
            .join("|")
    }
    fn newest_intact(v: &View) {
        assert!(texts(v).contains("search the web twice"));
        assert!(texts(v).contains("c3"), "the last step stays");
    }

    #[test]
    fn t7_is_unchanged_and_t1_keeps_only_the_task() {
        let v = run(&list("T7", None));
        assert_eq!(v.messages.len(), chat().len());
        let v = run(&list("T1", None));
        newest_intact(&v);
        assert!(!texts(&v).contains("first") && !texts(&v).contains("Conversation memory"));
        assert!(
            v.left_out.contains(&"turn/t1".to_string())
                && v.left_out.contains(&"mem.block".to_string())
        );
        assert!(
            v.left_out.contains(&"call/c2".to_string()),
            "the earlier duplicate call is dropped"
        );
        assert!(texts(&v).contains("c1"));
        assert_eq!(v.messages[0].role, Role::User);
    }

    #[test]
    fn t2_t3_filter_the_memory_block() {
        let v = run(&list("T2", None));
        let t = texts(&v);
        assert!(t.contains("S1-2") && !t.contains("D1: use rust"), "{t}");
        let v = run(&list("T3", None));
        let t = texts(&v);
        assert!(t.contains("D1: use rust") && !t.contains("S1-2"));
        let v = run(&list(
            "T3",
            Some(json!({"memory_scope": "explicit", "memory_ids": ["mem/D2"]})),
        ));
        let t = texts(&v);
        assert!(t.contains("D2: dark") && !t.contains("D1: use"));
        newest_intact(&v);
    }

    #[test]
    fn t4_shortens_older_search_results_t5_keeps_recent_turns_t6_selected() {
        let v = run(&list("T4", None));
        let t = texts(&v);
        assert!(t.contains("res/R1 left out by policy T4") && t.contains("res/R2 left out"));
        assert!(t.contains("first"), "T4 keeps the turns");
        assert!(
            texts(&v).matches("new results").count() == 1,
            "the newest search result stays whole"
        );
        let v = run(&list("T5", Some(json!({"recent_turns": 1}))));
        let t = texts(&v);
        assert!(t.contains("third") && !t.contains("second") && !t.contains("first"));
        newest_intact(&v);
        let v = run(&list(
            "T6",
            Some(json!({"selection": "explicit", "item_ids": ["turn/t2", "mem/D1"]})),
        ));
        let t = texts(&v);
        assert!(
            t.contains("second")
                && !t.contains("third")
                && t.contains("D1: use")
                && !t.contains("D2")
        );
        newest_intact(&v);
    }

    #[test]
    fn the_block_names_the_policy_and_what_was_left_out() {
        let b = task_block(&list("T1", None), "fix the bug", &["turn/t1".into()]);
        assert!(b.contains("T1") && b.contains("turn/t1") && b.contains("ctx task id:T7"));
    }
}
