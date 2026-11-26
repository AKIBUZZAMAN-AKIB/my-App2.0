//! Whether a parsed rule file is allowed: fields from a closed list with their
//! types, operators that fit the type, canonical policy IDs only, parameters
//! from the registry schema, unique rule IDs, allowed defaults and allowed
//! exclusions. Every problem is reported at once, with its path; a file with
//! any problem is never applied (the last good one stays).

use std::collections::HashSet;

use serde_json::Value;

use super::dsl_parser::{self, Cond, DslError, Lit, Op, RuleSet};
use super::exclusions;
use super::registry;
use super::types::PolicyId;

/// Most rules in one file.
pub const MAX_RULES: usize = 64;
/// Allowed priority range.
pub const PRIORITY_RANGE: (i64, i64) = (0, 1000);

/// The type of a fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldType {
    Str,
    Bool,
    Int,
}

impl FieldType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FieldType::Str => "string",
            FieldType::Bool => "boolean",
            FieldType::Int => "number",
        }
    }
}

/// Every field a condition may read, with its type and meaning. Computed by
/// `request_facts`; nothing else can be named.
pub const FIELDS: &[(&str, FieldType, &str)] = &[
    ("request.category", FieldType::Str, "group of the first real tool call (device_action, files, web, shell, git, memory, docs, auto, mcp, ui, agents, other)"),
    ("request.tool_name", FieldType::Str, "name of the first real tool call"),
    ("request.tool_group", FieldType::Str, "permission-page group of the first real tool call"),
    ("request.has_reference", FieldType::Bool, "the request points at something earlier (that, it, the file, ...)"),
    ("request.references_previous_turn", FieldType::Bool, "the request names an earlier turn or answer"),
    ("request.requires_history", FieldType::Bool, "the request asks about history (before, earlier, changed, ...)"),
    ("request.lang", FieldType::Str, "language of the request: en, bn or other"),
    ("task.has_search_results", FieldType::Bool, "this task already has a web search or fetch result"),
    ("task.needs_raw_search_results", FieldType::Bool, "the request asks for the raw search text (quote, exact, source)"),
    ("task.tool_calls", FieldType::Int, "real tool calls made in this task so far"),
    ("task.retries", FieldType::Int, "failed tool results in this task so far"),
    ("task.spawns_subagent", FieldType::Bool, "this task calls spawn_subagent"),
    ("session.is_background", FieldType::Bool, "the turn runs in the background (cron, automation)"),
    ("session.is_subagent", FieldType::Bool, "the turn runs inside a sub-agent"),
];

pub fn field_type(name: &str) -> Option<FieldType> {
    FIELDS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, t, _)| *t)
}

/// The field list as JSON (for the editor's help panel).
pub fn fields_json() -> Value {
    Value::Array(
        FIELDS
            .iter()
            .map(|(n, t, d)| {
                let ops: Vec<&str> = ops_for(*t).iter().map(|o| o.as_str()).chain(std::iter::once("exists")).collect();
                serde_json::json!({ "field": n, "type": t.as_str(), "description": d, "operators": ops })
            })
            .collect(),
    )
}

fn ops_for(t: FieldType) -> &'static [Op] {
    match t {
        FieldType::Str => &[Op::Eq, Op::Ne, Op::In, Op::Contains],
        FieldType::Bool => &[Op::Eq, Op::Ne],
        FieldType::Int => &[Op::Eq, Op::Ne, Op::In, Op::Lt, Op::Le, Op::Gt, Op::Ge],
    }
}

fn lit_fits(t: FieldType, l: &Lit) -> bool {
    matches!(
        (t, l),
        (FieldType::Str, Lit::Str(_))
            | (FieldType::Bool, Lit::Bool(_))
            | (FieldType::Int, Lit::Num(_))
    )
}

fn check_cond(c: &Cond, path: &str, errors: &mut Vec<DslError>) {
    for leaf in c.leaves() {
        match leaf {
            Cond::Exists(f) => {
                if field_type(f).is_none() {
                    errors.push(DslError::new(path, format!("unknown field {f}")));
                }
            }
            Cond::Cmp { field, op, value } => {
                let Some(t) = field_type(field) else {
                    errors.push(DslError::new(path, format!("unknown field {field}")));
                    continue;
                };
                if !ops_for(t).contains(op) {
                    errors.push(DslError::new(
                        path,
                        format!(
                            "{field} is a {}; {} does not apply to it",
                            t.as_str(),
                            op.as_str()
                        ),
                    ));
                    continue;
                }
                let ok = match (op, value) {
                    (Op::In, Lit::List(items)) => items.iter().all(|i| lit_fits(t, i)),
                    (Op::In, _) => false,
                    (Op::Contains, Lit::Str(_)) => true,
                    (_, v) => lit_fits(t, v),
                };
                if !ok {
                    let want = if *op == Op::In {
                        format!("a list of {}s", t.as_str())
                    } else {
                        format!("a {}", t.as_str())
                    };
                    errors.push(DslError::new(
                        path,
                        format!(
                            "{field} {} needs {want}, not a {}",
                            op.as_str(),
                            value.type_name()
                        ),
                    ));
                }
            }
            _ => {}
        }
    }
}

/// `^R_[A-Z0-9_]{1,40}$`.
pub fn rule_id_ok(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("R_") else {
        return false;
    };
    (1..=40).contains(&rest.len())
        && rest
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Check a parsed rule set.
pub fn check(set: &RuleSet) -> Vec<DslError> {
    let mut errors = Vec::new();
    if set.version != 1 {
        errors.push(DslError::new("version", "only version 1 is supported"));
    }
    let d = &set.defaults;
    if d.policy != "T7" {
        errors.push(DslError::new(
            "defaults.policy",
            "the default policy is always T7 (full context)",
        ));
    }
    if d.start != "first_tool_call" {
        errors.push(DslError::new(
            "defaults.start",
            "the temp context can only start at first_tool_call",
        ));
    }
    if d.end != "task_completed" {
        errors.push(DslError::new(
            "defaults.end",
            "the temp context can only end at task_completed",
        ));
    }
    if !matches!(d.on_error.as_str(), "retry_then_fallback" | "fallback") {
        errors.push(DslError::new(
            "defaults.on_error",
            "must be retry_then_fallback or fallback",
        ));
    }
    if !(0..=5).contains(&d.max_retries) {
        errors.push(DslError::new(
            "defaults.max_retries",
            "must be between 0 and 5",
        ));
    }
    if d.unknown_policy != "T7" {
        errors.push(DslError::new(
            "defaults.unknown_policy",
            "an unknown policy always falls back to T7",
        ));
    }
    let mut seen_policies = HashSet::new();
    for (i, p) in set.policies.iter().enumerate() {
        let path = format!("policies[{i}]");
        let Some(id) = PolicyId::parse(&p.id) else {
            errors.push(DslError::new(
                format!("{path}.id"),
                format!(
                    "{:?} is not a policy; only T1..T7 exist and new ones cannot be added",
                    p.id
                ),
            ));
            continue;
        };
        if !seen_policies.insert(id) {
            errors.push(DslError::new(
                format!("{path}.id"),
                format!("{id} is listed twice"),
            ));
        }
        if let Some(name) = &p.name {
            let names = [id.name().to_ascii_lowercase(), snake(id.name())];
            if !names.iter().any(|n| *n == name.to_ascii_lowercase()) {
                errors.push(DslError::new(
                    format!("{path}.name"),
                    format!(
                        "{id} is called {} ({}); it cannot be renamed",
                        id.name(),
                        snake(id.name())
                    ),
                ));
            }
        }
        if let Some(defs) = &p.defaults {
            if id == PolicyId::T7 && defs.as_object().is_some_and(|o| !o.is_empty()) {
                errors.push(DslError::new(
                    format!("{path}.defaults"),
                    "T7 is fixed and cannot be changed",
                ));
            } else if let Err(es) = registry::validate_params(id, Some(defs)) {
                for e in es {
                    errors.push(DslError::new(format!("{path}.defaults"), e));
                }
            }
        }
    }
    if set.rules.len() > MAX_RULES {
        errors.push(DslError::new("rules", format!("at most {MAX_RULES} rules")));
    }
    let mut ids = HashSet::new();
    for (i, r) in set.rules.iter().enumerate() {
        let path = format!("rules[{i}]");
        if !rule_id_ok(&r.id) {
            errors.push(DslError::new(
                format!("{path}.id"),
                "must look like R_NAME: R_ then 1 to 40 of A-Z, 0-9 and _",
            ));
        }
        if !ids.insert(r.id.clone()) {
            errors.push(DslError::new(
                format!("{path}.id"),
                format!("{} is used by another rule", r.id),
            ));
        }
        if r.priority < PRIORITY_RANGE.0 || r.priority > PRIORITY_RANGE.1 {
            errors.push(DslError::new(
                format!("{path}.priority"),
                format!(
                    "must be between {} and {}",
                    PRIORITY_RANGE.0, PRIORITY_RANGE.1
                ),
            ));
        }
        check_cond(&r.cond, &format!("{path}.if"), &mut errors);
        match PolicyId::parse(&r.policy) {
            None => errors.push(DslError::new(
                format!("{path}.then.policy"),
                format!("{:?} is not a policy (T1..T7, exactly)", r.policy),
            )),
            Some(id) => {
                if let Err(es) = registry::validate_params(id, r.params.as_ref()) {
                    for e in es {
                        errors.push(DslError::new(format!("{path}.then.{e}"), "".to_string()));
                    }
                }
            }
        }
        if let Some(desc) = &r.description {
            if desc.chars().count() > dsl_parser::MAX_STRING {
                errors.push(DslError::new(
                    format!("{path}.description"),
                    format!("longer than {} characters", dsl_parser::MAX_STRING),
                ));
            }
        }
    }
    errors.extend(exclusions::validate(
        &set.exclusions,
        "exclusions.always_exclude",
    ));
    // `then.params.x: message` came back from the registry in one string; split it.
    for e in errors.iter_mut() {
        if e.message.is_empty() {
            if let Some((p, m)) = e.path.split_once(": ") {
                let (p, m) = (p.to_string(), m.to_string());
                e.path = p;
                e.message = m;
            }
        }
    }
    errors
}

fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

/// Parse and check. `Ok` only when there is no problem at all.
pub fn validate(doc: &Value) -> Result<RuleSet, Vec<DslError>> {
    let set = dsl_parser::parse(doc)?;
    let errors = check(&set);
    if errors.is_empty() {
        Ok(set)
    } else {
        Err(errors)
    }
}

/// Check one rule on its own (a model's proposal): its problems, with paths
/// relative to the rule. A rule ID used by the rule file in force is not
/// checked here; `approve` checks the whole file again.
pub fn check_rule(rule: &Value) -> Vec<DslError> {
    let doc = serde_json::json!({ "version": 1, "rules": [rule] });
    match validate(&doc) {
        Ok(_) => Vec::new(),
        Err(errs) => errs
            .into_iter()
            .map(|e| DslError {
                path: e
                    .path
                    .strip_prefix("rules[0]")
                    .map(|p| p.trim_start_matches('.').to_string())
                    .filter(|p| !p.is_empty())
                    .unwrap_or(e.path),
                message: e.message,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_policy::dsl_parser::tests::design_example;
    use serde_json::json;

    #[test]
    fn the_design_example_is_valid() {
        let set = validate(&design_example()).expect("valid");
        assert_eq!(set.rules.len(), 3);
    }

    fn errs(doc: Value) -> Vec<String> {
        validate(&doc)
            .unwrap_err()
            .iter()
            .map(|e| e.to_string())
            .collect()
    }

    #[test]
    fn every_kind_of_mistake_is_named_with_its_path() {
        let e = errs(
            json!({"version": 1, "rules": [{"id": "r-a", "if": "task.tool_calls > 1", "then": {"policy": "T1"}}]}),
        );
        assert!(
            e.iter()
                .any(|m| m.contains("rules[0].id") && m.contains("R_NAME")),
            "{e:?}"
        );
        let e = errs(
            json!({"version": 1, "rules": [{"id": "R_A", "if": "request.colour == 'red'", "then": {"policy": "T4"}}]}),
        );
        assert!(
            e.iter()
                .any(|m| m.contains("rules[0].if") && m.contains("unknown field request.colour")),
            "{e:?}"
        );
        let e = errs(
            json!({"version": 1, "rules": [{"id": "R_A", "if": "request.has_reference == 'yes'", "then": {"policy": "T4"}}]}),
        );
        assert!(e.iter().any(|m| m.contains("needs a boolean")), "{e:?}");
        let e = errs(
            json!({"version": 1, "rules": [{"id": "R_A", "if": "request.has_reference > 1", "then": {"policy": "T4"}}]}),
        );
        assert!(e.iter().any(|m| m.contains("does not apply")), "{e:?}");
        for p in ["T8", "t4", "goal_only", ""] {
            let e = errs(
                json!({"version": 1, "rules": [{"id": "R_A", "if": "task.tool_calls > 1", "then": {"policy": p}}]}),
            );
            assert!(
                e.iter().any(|m| m.contains("rules[0].then.policy")),
                "{p}: {e:?}"
            );
        }
        let e = errs(
            json!({"version": 1, "rules": [{"id": "R_A", "if": "task.tool_calls > 1", "then": {"policy": "T5", "params": {"recent_turns": 99}}}]}),
        );
        assert!(
            e.iter()
                .any(|m| m.contains("rules[0].then.params.recent_turns")),
            "{e:?}"
        );
        let e = errs(json!({"version": 1, "rules": [
            {"id": "R_A", "if": "task.tool_calls > 1", "then": {"policy": "T1"}},
            {"id": "R_A", "priority": 5000, "if": "task.tool_calls > 1", "then": {"policy": "T1"}}
        ]}));
        assert!(
            e.iter()
                .any(|m| m.contains("rules[1].id") && m.contains("another rule")),
            "{e:?}"
        );
        assert!(e.iter().any(|m| m.contains("rules[1].priority")), "{e:?}");
        let e = errs(
            json!({"version": 1, "defaults": {"start": "after_tool_call", "unknown_policy": "T1", "policy": "T9"}}),
        );
        assert_eq!(e.len(), 3, "{e:?}");
        let e = errs(json!({"version": 1, "defaults": {"policy": "T1"}}));
        assert!(e.iter().any(|m| m.contains("defaults.policy")), "{e:?}");
        let e = errs(
            json!({"version": 1, "exclusions": {"always_exclude": {"item_ids": ["sys/core"]}}}),
        );
        assert_eq!(e.len(), 1, "{e:?}");
        let e = errs(
            json!({"version": 1, "exclusions": {"always_exclude": {"item_ids": ["sys/tools"]}}}),
        );
        assert_eq!(e.len(), 1, "{e:?}");
        let many: Vec<Value> = (0..65).map(|i| json!({"id": format!("R_{i}"), "if": "task.tool_calls > 1", "then": {"policy": "T1"}})).collect();
        let e = errs(json!({"version": 1, "rules": many}));
        assert!(e.iter().any(|m| m.contains("at most 64")), "{e:?}");
        let e = errs(
            json!({"version": 1, "policies": [{"id": "T8"}, {"id": "T7", "defaults": {"x": 1}}, {"id": "T1", "name": "tiny"}]}),
        );
        assert_eq!(e.len(), 3, "{e:?}");
        let e = errs(
            json!({"version": 1, "exclusions": {"always_exclude": {"groups": ["device"], "categories": ["sys"], "item_ids": ["execute_command"]}}}),
        );
        assert_eq!(e.len(), 3, "{e:?}");
    }

    #[test]
    fn the_field_list_names_every_field_with_its_operators() {
        let f = fields_json();
        assert_eq!(f.as_array().unwrap().len(), FIELDS.len());
        assert!(f[0]["operators"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o == "exists"));
    }
}
