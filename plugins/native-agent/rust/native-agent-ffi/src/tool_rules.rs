//! Per-tool argument rules, layered on top of the tool permission table.
//!
//! A rule set names patterns for the one argument that matters for a tool:
//! the `command` of `execute_command`, the `path` of file tools, the `url` of
//! `web_fetch`. `deny` patterns block a call before anything runs (even for
//! "always allow" tools). `allow` patterns let an "always ask" call run without
//! the prompt; they never skip a fingerprint/face prompt, never enable a tool
//! that is turned off, and never match a shell command that chains or
//! redirects (`;`, `&`, `|`, backticks, `$(`, `>`, `<`, newlines).
//!
//! Patterns: `*` matches anything; everything else is literal. Paths are
//! compared without a leading `./` or `/`.
//!
//! Stored beside the runtime config as `native-agent-tool-rules.json`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "native-agent-tool-rules.json";
const MAX_PATTERNS: usize = 64;
const MAX_PATTERN_LEN: usize = 300;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ToolRule {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

pub type ToolRules = BTreeMap<String, ToolRule>;

#[derive(Debug, PartialEq)]
pub enum RuleDecision {
    /// No rule applies; the permission table decides.
    None,
    /// An allow pattern matched: run without the approval prompt.
    Allow(String),
    /// A deny pattern matched: block the call.
    Deny(String),
}

/// Which argument each tool's rules look at, for the settings UI.
pub fn subject_key(tool: &str) -> Option<&'static str> {
    match tool {
        "execute_command" => Some("command"),
        "web_fetch" => Some("url"),
        // "Always allow for this chat" = an allow pattern with the chat's key.
        "ask_session" => Some("session_key"),
        "read_file" | "write_file" | "edit_file" | "delete_file" | "list_files" | "find_files"
        | "grep_files" | "search_files" | "index_document" | "forget_document" => Some("path"),
        _ => None,
    }
}

fn subject(tool: &str, input: &serde_json::Value) -> Option<String> {
    let key = subject_key(tool)?;
    let raw = input.get(key)?.as_str()?.trim();
    Some(if key == "path" {
        normalize_path(raw)
    } else {
        raw.to_string()
    })
}

fn normalize_path(p: &str) -> String {
    let mut s = p.trim();
    while let Some(rest) = s.strip_prefix("./") {
        s = rest;
    }
    s.trim_start_matches('/').to_string()
}

fn chains_shell(command: &str) -> bool {
    command.contains(|c| matches!(c, ';' | '&' | '|' | '`' | '>' | '<' | '\n' | '\r'))
        || command.contains("$(")
}

/// `*` wildcard match, iterative (no backtracking blow-up).
pub fn wildcard(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] != '*' && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn decide(rules: &ToolRules, tool: &str, input: &serde_json::Value) -> RuleDecision {
    let Some(rule) = rules.get(tool) else {
        return RuleDecision::None;
    };
    let Some(subject) = subject(tool, input) else {
        return RuleDecision::None;
    };
    let is_path = subject_key(tool) == Some("path");
    let norm = |p: &str| {
        if is_path {
            normalize_path(p)
        } else {
            p.trim().to_string()
        }
    };
    if let Some(p) = rule.deny.iter().find(|p| wildcard(&norm(p), &subject)) {
        return RuleDecision::Deny(p.clone());
    }
    if tool == "execute_command" && chains_shell(&subject) {
        return RuleDecision::None;
    }
    if is_path && subject.split('/').any(|seg| seg == "..") {
        return RuleDecision::None;
    }
    match rule.allow.iter().find(|p| wildcard(&norm(p), &subject)) {
        Some(p) => RuleDecision::Allow(p.clone()),
        None => RuleDecision::None,
    }
}

pub fn rules_path(workspace_path: &str) -> PathBuf {
    let workspace = Path::new(workspace_path);
    workspace.parent().unwrap_or(workspace).join(FILE_NAME)
}

pub fn load(workspace_path: &str) -> ToolRules {
    fs::read(rules_path(workspace_path))
        .ok()
        .and_then(|b| serde_json::from_slice::<ToolRules>(&b).ok())
        .unwrap_or_default()
}

fn clean(list: Vec<String>) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let p = p.trim().to_string();
        if p.is_empty() || out.contains(&p) {
            continue;
        }
        if p.len() > MAX_PATTERN_LEN {
            return Err(format!("pattern longer than {MAX_PATTERN_LEN} characters"));
        }
        if p.chars().all(|c| c == '*') {
            return Err(
                "a pattern of only * would match everything; use the tool's permission instead"
                    .into(),
            );
        }
        out.push(p);
    }
    if out.len() > MAX_PATTERNS {
        return Err(format!("at most {MAX_PATTERNS} patterns per list"));
    }
    Ok(out)
}

/// Replace one tool's rules (empty lists remove the entry). Returns all rules.
pub fn set(workspace_path: &str, tool: &str, rule: ToolRule) -> Result<ToolRules, String> {
    let tool = tool.trim();
    if tool.is_empty() {
        return Err("toolName is required".into());
    }
    if subject_key(tool).is_none() {
        return Err(format!(
            "{tool} has no argument rules; use its permission instead"
        ));
    }
    let rule = ToolRule {
        allow: clean(rule.allow)?,
        deny: clean(rule.deny)?,
    };
    let mut all = load(workspace_path);
    if rule.allow.is_empty() && rule.deny.is_empty() {
        all.remove(tool);
    } else {
        all.insert(tool.to_string(), rule);
    }
    save(workspace_path, &all)?;
    Ok(all)
}

pub fn save(workspace_path: &str, rules: &ToolRules) -> Result<(), String> {
    let path = rules_path(workspace_path);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(rules).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules() -> ToolRules {
        let mut r = ToolRules::new();
        r.insert(
            "execute_command".into(),
            ToolRule {
                allow: vec!["git status*".into(), "ls *".into()],
                deny: vec!["rm -rf *".into()],
            },
        );
        r.insert(
            "write_file".into(),
            ToolRule {
                allow: vec!["notes/*".into()],
                deny: vec![".agent/*".into()],
            },
        );
        r
    }

    #[test]
    fn wildcard_basics() {
        assert!(wildcard("git *", "git status"));
        assert!(wildcard("*.md", "a/b/c.md"));
        assert!(!wildcard("*.md", "a.mdx"));
        assert!(wildcard("a*b*c", "aXXbYYc"));
        assert!(!wildcard("abc", "abcd"));
    }

    #[test]
    fn deny_wins_and_allow_skips_prompt() {
        let r = rules();
        assert_eq!(
            decide(&r, "execute_command", &json!({"command": "git status -s"})),
            RuleDecision::Allow("git status*".into())
        );
        assert_eq!(
            decide(&r, "execute_command", &json!({"command": "rm -rf /tmp/x"})),
            RuleDecision::Deny("rm -rf *".into())
        );
        assert_eq!(
            decide(&r, "write_file", &json!({"path": "./notes/a.md"})),
            RuleDecision::Allow("notes/*".into())
        );
        assert_eq!(
            decide(&r, "write_file", &json!({"path": "/.agent/x"})),
            RuleDecision::Deny(".agent/*".into())
        );
        assert_eq!(
            decide(&r, "read_file", &json!({"path": "notes/a.md"})),
            RuleDecision::None
        );
    }

    #[test]
    fn allow_never_matches_chained_commands_or_parent_paths() {
        let r = rules();
        assert_eq!(
            decide(
                &r,
                "execute_command",
                &json!({"command": "git status; rm -rf ~"})
            ),
            RuleDecision::None
        );
        assert_eq!(
            decide(&r, "execute_command", &json!({"command": "ls $(whoami)"})),
            RuleDecision::None
        );
        assert_eq!(
            decide(&r, "execute_command", &json!({"command": "ls a > b"})),
            RuleDecision::None
        );
        assert_eq!(
            decide(&r, "write_file", &json!({"path": "notes/../.agent/x"})),
            RuleDecision::None
        );
    }

    #[test]
    fn set_validates_and_persists() {
        let dir = std::env::temp_dir().join(format!("tool-rules-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("workspace");
        let ws = ws.to_str().unwrap();
        assert!(set(
            ws,
            "execute_command",
            ToolRule {
                allow: vec!["*".into()],
                deny: vec![]
            }
        )
        .is_err());
        assert!(set(
            ws,
            "memory_store",
            ToolRule {
                allow: vec!["x".into()],
                deny: vec![]
            }
        )
        .is_err());
        let all = set(
            ws,
            "execute_command",
            ToolRule {
                allow: vec![" git log* ".into(), "git log*".into()],
                deny: vec![],
            },
        )
        .unwrap();
        assert_eq!(all["execute_command"].allow, vec!["git log*".to_string()]);
        assert_eq!(load(ws), all);
        let all = set(ws, "execute_command", ToolRule::default()).unwrap();
        assert!(all.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
