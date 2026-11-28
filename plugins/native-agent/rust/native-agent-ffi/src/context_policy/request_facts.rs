//! The facts a rule can read, computed from the request and the steps of the
//! running task. Pure: no store, no network, no model call.

use std::sync::OnceLock;

use regex::Regex;

use super::rule_evaluator::{Fact, Facts};

/// What the facts are computed from.
#[derive(Debug, Clone, Default)]
pub struct FactInput<'a> {
    /// The newest user prompt, as typed.
    pub request: &'a str,
    /// The real tool calls of this task so far, in order (no `ctx`).
    pub tool_names: &'a [String],
    /// The real tool calls of the first model answer of the task.
    pub first_calls: &'a [String],
    /// Each tool result of this task so far, in order: (tool name, is_error).
    pub results: &'a [(String, bool)],
    /// The model chose T4 for this task.
    pub ai_chose_t4: bool,
    pub is_background: bool,
    pub is_subagent: bool,
}

/// The permission page's group of a tool (`40-permissions.js` `groupOf`),
/// with `device__*` as `device_action` for `request.category`.
pub fn tool_group(name: &str) -> &'static str {
    if name.starts_with("device__") {
        return "device";
    }
    if name.starts_with("ui__") {
        return "ui";
    }
    if matches!(
        name,
        "spawn_subagent"
            | "list_subagents"
            | "message_subagent"
            | "stop_subagent"
            | "workflow"
            | "list_sessions"
            | "ask_session"
    ) {
        return "agents";
    }
    if name.starts_with("mcp__") {
        return "mcp";
    }
    if name.starts_with("git_") {
        return "git";
    }
    if name == "execute_command" {
        return "shell";
    }
    if name == "web_fetch" || name.starts_with("web_") {
        return "web";
    }
    if name.starts_with("memory_") {
        return "memory";
    }
    if name.contains("document") {
        return "docs";
    }
    if name.contains("cron") || name.contains("automation") || name.contains("skill") {
        return "auto";
    }
    if name.contains("file") || name.starts_with("find_") || name.starts_with("grep_") {
        return "files";
    }
    "other"
}

/// `request.category`: the group, with the device group named `device_action`.
pub fn category(name: &str) -> &'static str {
    match tool_group(name) {
        "device" => "device_action",
        g => g,
    }
}

/// Words that point at something said or done earlier.
fn previous_turn_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\b(?:previous(?:ly)?|above|again|earlier|last\s+(?:time|answer|message|reply|turn|one)|you\s+(?:said|told|wrote|mentioned))\b|আগের|ওটা|সেটা|সেই|আবার|উপরের|#[\p{L}\p{N}_-]+|\bturn/t?\d+").unwrap()
    })
}

/// An item ID (`turn/…`, `res/…`, `mem/…`, `#tag`) or a file path.
fn reference_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\b(?:turn|res|mem|file|note|sum|range)/[\w./-]+|#[\p{L}\p{N}_-]+|(?:^|[\s(\x22'`])(?:\.{0,2}/|~/)?[\w.-]+(?:/[\w.-]+)*\.[A-Za-z0-9]{1,8}\b|(?:^|\s)(?:\.{1,2}|~)?/[\w.-]+(?:/[\w.-]+)+").unwrap()
    })
}

/// `request.lang`: `bn` when the request has Bengali letters, `en` when it is
/// mostly Latin letters, else `other`.
pub fn lang(s: &str) -> &'static str {
    let mut bn = 0usize;
    let mut latin = 0usize;
    let mut other = 0usize;
    for c in s.chars().filter(|c| c.is_alphabetic()) {
        if ('\u{0980}'..='\u{09FF}').contains(&c) {
            bn += 1;
        } else if c.is_ascii_alphabetic() {
            latin += 1;
        } else {
            other += 1;
        }
    }
    if bn > 0 && bn * 4 >= (latin + other) {
        "bn"
    } else if latin > 0 && latin >= other {
        "en"
    } else if bn > 0 {
        "bn"
    } else {
        "other"
    }
}

pub fn is_search_tool(name: &str) -> bool {
    tool_group(name) == "web" || name.contains("search")
}

/// Compute every fact. Request facts that need a first tool call are absent
/// until there is one.
pub fn compute(inp: &FactInput<'_>) -> Facts {
    let mut f = Facts::new();
    let mut put = |k: &str, v: Fact| {
        f.insert(k.to_string(), v);
    };
    if let Some(first) = inp.tool_names.first() {
        put("request.category", Fact::Str(category(first).to_string()));
        put("request.tool_name", Fact::Str(first.clone()));
        put(
            "request.tool_group",
            Fact::Str(tool_group(first).to_string()),
        );
    }
    let req = inp.request;
    let previous = previous_turn_re().is_match(req);
    put(
        "request.has_reference",
        Fact::Bool(reference_re().is_match(req)),
    );
    put("request.references_previous_turn", Fact::Bool(previous));
    put(
        "request.requires_history",
        Fact::Bool(previous || crate::turn_memory::select::history_re().is_match(req)),
    );
    put("request.lang", Fact::Str(lang(req).to_string()));
    put(
        "task.has_search_results",
        Fact::Bool(inp.results.iter().any(|(n, err)| !err && is_search_tool(n))),
    );
    put("task.needs_raw_search_results", Fact::Bool(needs_raw(inp)));
    put("task.tool_calls", Fact::Int(inp.tool_names.len() as i64));
    put(
        "task.retries",
        Fact::Int(inp.results.iter().filter(|(_, e)| *e).count() as i64),
    );
    put(
        "task.spawns_subagent",
        Fact::Bool(inp.first_calls.iter().any(|n| n == "spawn_subagent")),
    );
    put("session.is_background", Fact::Bool(inp.is_background));
    put("session.is_subagent", Fact::Bool(inp.is_subagent));
    f
}

/// `task.needs_raw_search_results`: true unless the model chose T4, or a
/// non-search tool succeeded after the last search result.
fn needs_raw(inp: &FactInput<'_>) -> bool {
    if inp.ai_chose_t4 {
        return false;
    }
    match inp.results.iter().rposition(|(n, _)| is_search_tool(n)) {
        Some(last) => !inp.results[last + 1..]
            .iter()
            .any(|(n, err)| !err && !is_search_tool(n)),
        None => true,
    }
}

/// Facts as JSON (for the event log and the editor's test panel).
pub fn to_json(f: &Facts) -> serde_json::Value {
    serde_json::Value::Object(f.iter().map(|(k, v)| (k.clone(), v.to_json())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_policy::dsl_validator::FIELDS;

    #[test]
    fn every_field_is_computed_once_there_is_a_tool_call() {
        let names = vec!["device__torch_on".to_string()];
        let f = compute(&FactInput {
            request: "turn the torch on",
            tool_names: &names,
            first_calls: &names,
            ..Default::default()
        });
        for (field, _, _) in FIELDS {
            assert!(f.contains_key(*field), "{field}");
        }
        assert_eq!(f["request.category"], Fact::Str("device_action".into()));
        assert_eq!(f["request.tool_group"], Fact::Str("device".into()));
        assert_eq!(f["request.has_reference"], Fact::Bool(false));
        assert_eq!(f["request.references_previous_turn"], Fact::Bool(false));
        assert_eq!(f["request.lang"], Fact::Str("en".into()));
    }

    #[test]
    fn references_history_language_search_and_retries() {
        let names = vec![
            "web_fetch".to_string(),
            "web_fetch".to_string(),
            "spawn_subagent".to_string(),
        ];
        let results = vec![
            ("web_fetch".to_string(), true),
            ("web_fetch".to_string(), false),
        ];
        let f = compute(&FactInput {
            request: "আগের ফাইলটা আবার পড়ো",
            tool_names: &names,
            first_calls: &names,
            results: &results,
            is_background: true,
            ..Default::default()
        });
        assert_eq!(f["request.lang"], Fact::Str("bn".into()));
        assert_eq!(f["request.references_previous_turn"], Fact::Bool(true));
        assert_eq!(f["request.requires_history"], Fact::Bool(true));
        assert_eq!(f["task.has_search_results"], Fact::Bool(true));
        assert_eq!(
            f["task.needs_raw_search_results"],
            Fact::Bool(true),
            "default true"
        );
        assert_eq!(f["task.retries"], Fact::Int(1));
        assert_eq!(f["task.tool_calls"], Fact::Int(3));
        assert_eq!(f["task.spawns_subagent"], Fact::Bool(true));
        assert_eq!(f["session.is_background"], Fact::Bool(true));
        let g = compute(&FactInput {
            request: "why did we change the plan before?",
            ..Default::default()
        });
        assert_eq!(g["request.requires_history"], Fact::Bool(true));
        assert!(!g.contains_key("request.category"));
        assert_eq!(g["request.has_reference"], Fact::Bool(false));
        let h = compute(&FactInput {
            request: "open src/main.rs and fix it",
            ..Default::default()
        });
        assert_eq!(h["request.has_reference"], Fact::Bool(true), "a file path");
        assert_eq!(h["request.references_previous_turn"], Fact::Bool(false));
        let ids = compute(&FactInput {
            request: "use res/R3 for this",
            ..Default::default()
        });
        assert_eq!(ids["request.has_reference"], Fact::Bool(true), "an item id");
        // needs_raw: false after a later non-search success, or when the model chose T4.
        let r2 = vec![
            ("web_search".to_string(), false),
            ("read_file".to_string(), false),
        ];
        let n2 = vec!["web_search".to_string(), "read_file".to_string()];
        let k = compute(&FactInput {
            request: "x",
            tool_names: &n2,
            results: &r2,
            ..Default::default()
        });
        assert_eq!(k["task.needs_raw_search_results"], Fact::Bool(false));
        let r3 = vec![("web_search".to_string(), false)];
        let k3 = compute(&FactInput {
            request: "x",
            results: &r3,
            ai_chose_t4: true,
            ..Default::default()
        });
        assert_eq!(k3["task.needs_raw_search_results"], Fact::Bool(false));
        // spawns_subagent looks at the first answer's calls only.
        let later = vec!["read_file".to_string(), "spawn_subagent".to_string()];
        let first = vec!["read_file".to_string()];
        let s = compute(&FactInput {
            request: "x",
            tool_names: &later,
            first_calls: &first,
            ..Default::default()
        });
        assert_eq!(s["task.spawns_subagent"], Fact::Bool(false));
        assert_eq!(category("read_file"), "files");
        assert_eq!(category("mcp__x"), "mcp");
        assert_eq!(category("git_status"), "git");
    }
}
