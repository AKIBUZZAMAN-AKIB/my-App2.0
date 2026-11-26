//! Hard exclusions: what the user said must never go into the context of a
//! task, whatever the policy picks.
//!
//! A hard exclusion names context-tree categories, memory groups, turn IDs or
//! item IDs. It can never name a tool, a tool group, the system prompt, the
//! essentials, or a protected item: those are refused when the rule file is
//! validated, and `apply` skips protected items again at run time. A policy
//! cannot bring back an item a hard exclusion removed.

use super::dsl_parser::{DslError, Exclusions};
use super::temp_checklist::TempChecklist;

/// Context-tree categories a hard exclusion may name. `sys` and `ess` are
/// never allowed.
pub const EXCLUDABLE_CATEGORIES: &[&str] = &["turns", "files", "results", "notes", "strategy"];

/// Tool groups (the permission page's groups) and tool-name prefixes. Tools
/// are never context, so naming one is always an error.
const TOOL_WORDS: &[&str] = &[
    "files", "git", "shell", "web", "memory", "docs", "auto", "device", "mcp", "ui", "agents", "other", "tools", "tool",
];

/// True for an item that can never be excluded: the system prompt, the
/// essentials, the request's own prompt and steer messages (`user/*`), and
/// the step ledger.
pub fn is_protected(id: &str) -> bool {
    let t = id.trim();
    t.starts_with("sys/")
        || t == "sys"
        || t.starts_with("ess/")
        || t == "ess"
        || t.starts_with("user/")
        || t == "ledger"
}

fn looks_like_tool(s: &str) -> bool {
    let t = s.trim();
    t.starts_with("device__")
        || t.starts_with("ui__")
        || t.starts_with("mcp__")
        || t.starts_with("tool:")
        || t.starts_with("tool/")
        || matches!(
            t,
            "read_file" | "write_file" | "edit_file" | "execute_command" | "web_fetch" | "web_search" | "spawn_subagent" | "ctx"
        )
}

/// Every reason the exclusion list is not allowed, with its path.
pub fn validate(ex: &Exclusions, base: &str) -> Vec<DslError> {
    let mut errors = Vec::new();
    for (i, c) in ex.categories.iter().enumerate() {
        let path = format!("{base}.categories[{i}]");
        if c == "sys" || c == "ess" {
            errors.push(DslError::new(path, format!("{c} is protected and can never be excluded")));
        } else if !EXCLUDABLE_CATEGORIES.contains(&c.as_str()) {
            errors.push(DslError::new(path, format!("unknown category {c:?} (allowed: {})", EXCLUDABLE_CATEGORIES.join(", "))));
        }
    }
    for (i, g) in ex.groups.iter().enumerate() {
        let path = format!("{base}.groups[{i}]");
        if TOOL_WORDS.contains(&g.as_str()) || looks_like_tool(g) {
            errors.push(DslError::new(path, format!("{g:?} is a tool or tool group; tools are never removed from a request")));
        } else if !crate::context_tree::memory_checklist::GROUPS.iter().any(|(id, _, _)| id == g) {
            errors.push(DslError::new(path, format!("unknown memory group {g:?}")));
        } else if g == "mem" {
            errors.push(DslError::new(path, "the whole memory cannot be excluded; name a group such as mem.facts"));
        }
    }
    for (i, t) in ex.turn_ids.iter().enumerate() {
        let path = format!("{base}.turn_ids[{i}]");
        if !t.starts_with("turn/") || t.len() <= 5 || t[5..].contains('/') {
            errors.push(DslError::new(path, format!("{t:?} is not a turn ID (turn/tN)")));
        }
    }
    for (i, t) in ex.item_ids.iter().enumerate() {
        let path = format!("{base}.item_ids[{i}]");
        if is_protected(t) {
            errors.push(DslError::new(path, format!("{t} is protected and can never be excluded")));
        } else if looks_like_tool(t) {
            errors.push(DslError::new(path, format!("{t:?} is a tool; tools are never removed from a request")));
        } else if crate::context_tree::model::NodeId::parse(t).is_err() && !crate::context_tree::memory_checklist::is_memory_id(t) {
            errors.push(DslError::new(path, format!("{t:?} is not a context item ID")));
        }
    }
    errors
}

/// Why an item was removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub id: String,
    pub reason: String,
}

/// The reason `id` is hard-excluded, or None. `category` is the item's
/// context-tree category, `group` its memory group, when known.
pub fn excludes(ex: &Exclusions, id: &str, category: Option<&str>, group: Option<&str>) -> Option<String> {
    if is_protected(id) {
        return None;
    }
    if ex.item_ids.iter().any(|x| x == id) {
        return Some(format!("item {id} is always excluded"));
    }
    if ex.turn_ids.iter().any(|x| x == id || id.starts_with(&format!("{x}/"))) {
        return Some(format!("turn {id} is always excluded"));
    }
    if let Some(c) = category {
        if ex.categories.iter().any(|x| x == c) {
            return Some(format!("category {c} is always excluded"));
        }
    }
    let cat: Option<&str> = crate::context_tree::model::NodeId::parse(id).ok().map(|n| n.home_category());
    if let Some(c) = cat {
        if ex.categories.iter().any(|x| x == c) {
            return Some(format!("category {c} is always excluded"));
        }
    }
    if let Some(g) = group {
        if ex.groups.iter().any(|x| x == g || g.starts_with(&format!("{x}."))) {
            return Some(format!("group {g} is always excluded"));
        }
    }
    None
}

/// Remove hard-excluded IDs from a temp checklist. Protected IDs stay. The
/// removed IDs are returned, so the checklist block and the step ledger can
/// name them; `ctx recall` can still bring them back on an explicit ask.
pub fn apply(ex: &Exclusions, list: &mut TempChecklist, group_of: &dyn Fn(&str) -> Option<String>) -> Vec<Removed> {
    let mut removed = Vec::new();
    if ex.is_empty() {
        return removed;
    }
    list.item_ids.retain(|id| {
        let g = group_of(id);
        match excludes(ex, id, None, g.as_deref()) {
            Some(reason) => {
                removed.push(Removed { id: id.clone(), reason });
                false
            }
            None => true,
        }
    });
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex() -> Exclusions {
        Exclusions { categories: vec!["notes".into()], groups: vec!["mem.prefs".into()], turn_ids: vec!["turn/t3".into()], item_ids: vec!["file/a.txt".into()] }
    }

    #[test]
    fn tools_tool_groups_and_protected_items_are_refused() {
        let bad = Exclusions {
            categories: vec!["sys".into(), "ess".into(), "bogus".into()],
            groups: vec!["device".into(), "files".into(), "mem".into(), "mem.nope".into()],
            turn_ids: vec!["turn/".into(), "file/x".into(), "turn/t1/call/2".into()],
            item_ids: vec!["sys/core".into(), "ess/goal".into(), "user/newest".into(), "device__open_app".into(), "read_file".into(), "nonsense".into()],
        };
        let errs = validate(&bad, "exclusions.always_exclude");
        assert_eq!(errs.len(), 16, "{errs:?}");
        assert!(validate(&ex(), "x").is_empty());
    }

    #[test]
    fn apply_removes_matches_keeps_protected_and_records_them() {
        let (mut list, _) = TempChecklist::build(Some("T6"), None, &[], &|_| true, 1, crate::context_policy::Source::Ai, 0);
        list.item_ids.extend(["file/a.txt", "turn/t3/call/1", "turn/t4", "mem/f1", "mem/g1"].map(String::from));
        let group_of = |id: &str| match id {
            "mem/f1" => Some("mem.prefs".to_string()),
            "mem/g1" => Some("mem.goals".to_string()),
            _ => None,
        };
        let removed = apply(&ex(), &mut list, &group_of);
        let ids: Vec<&str> = removed.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["file/a.txt", "turn/t3/call/1", "mem/f1"]);
        assert_eq!(list.item_ids, vec!["user/newest", "user/steer/1", "turn/t4", "mem/g1"]);
        // A protected ID named directly is still never removed at run time.
        let sneaky = Exclusions { item_ids: vec!["user/newest".into(), "user/steer/1".into()], ..Default::default() };
        let (mut l2, _) = TempChecklist::build(Some("T1"), None, &[], &|_| true, 1, crate::context_policy::Source::Ai, 0);
        assert!(apply(&sneaky, &mut l2, &|_| None).is_empty());
        assert_eq!(l2.item_ids, vec!["user/newest", "user/steer/1"]);
    }
}
