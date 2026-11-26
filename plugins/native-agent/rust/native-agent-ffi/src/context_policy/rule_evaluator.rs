//! Evaluate a condition tree against the facts of one request.
//!
//! A missing fact is not an error: every comparison on it is false and
//! `exists` is false (so `not field == x` is true). The first enabled rule
//! that matches wins: rules are tried by priority, highest first, and by rule
//! ID (alphabetical) when priorities are equal.

use std::collections::BTreeMap;

use serde_json::Value;

use super::dsl_parser::{Cond, Lit, Op, Rule, RuleSet};

/// One computed fact.
#[derive(Debug, Clone, PartialEq)]
pub enum Fact {
    Str(String),
    Bool(bool),
    Int(i64),
}

impl Fact {
    pub fn to_json(&self) -> Value {
        match self {
            Fact::Str(s) => Value::String(s.clone()),
            Fact::Bool(b) => Value::Bool(*b),
            Fact::Int(n) => Value::from(*n),
        }
    }
}

/// The facts of one request, by field name.
pub type Facts = BTreeMap<String, Fact>;

fn eq(f: &Fact, l: &Lit) -> bool {
    match (f, l) {
        (Fact::Str(a), Lit::Str(b)) => a == b,
        (Fact::Bool(a), Lit::Bool(b)) => a == b,
        (Fact::Int(a), Lit::Num(b)) => a == b,
        _ => false,
    }
}

fn cmp(f: &Fact, op: Op, l: &Lit) -> bool {
    match op {
        Op::Eq => eq(f, l),
        Op::Ne => match (f, l) {
            (Fact::Str(_), Lit::Str(_)) | (Fact::Bool(_), Lit::Bool(_)) | (Fact::Int(_), Lit::Num(_)) => !eq(f, l),
            _ => false,
        },
        Op::In => match l {
            Lit::List(items) => items.iter().any(|i| eq(f, i)),
            _ => false,
        },
        Op::Contains => match (f, l) {
            (Fact::Str(a), Lit::Str(b)) => a.to_lowercase().contains(&b.to_lowercase()),
            _ => false,
        },
        Op::Lt | Op::Le | Op::Gt | Op::Ge => match (f, l) {
            (Fact::Int(a), Lit::Num(b)) => match op {
                Op::Lt => a < b,
                Op::Le => a <= b,
                Op::Gt => a > b,
                _ => a >= b,
            },
            _ => false,
        },
    }
}

/// True when `c` holds for `facts`.
pub fn eval(c: &Cond, facts: &Facts) -> bool {
    match c {
        Cond::All(v) => v.iter().all(|c| eval(c, facts)),
        Cond::Any(v) => v.iter().any(|c| eval(c, facts)),
        Cond::Not(c) => !eval(c, facts),
        Cond::Exists(f) => facts.contains_key(f),
        Cond::Cmp { field, op, value } => facts.get(field).is_some_and(|f| cmp(f, *op, value)),
    }
}

/// The enabled rules in the order they are tried.
pub fn ordered(set: &RuleSet) -> Vec<&Rule> {
    let mut v: Vec<&Rule> = set.rules.iter().filter(|r| r.enabled).collect();
    v.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.id.cmp(&b.id)));
    v
}

/// The first rule that matches, if any.
pub fn first_match<'a>(set: &'a RuleSet, facts: &Facts) -> Option<&'a Rule> {
    ordered(set).into_iter().find(|r| eval(&r.cond, facts))
}

/// For the editor's test panel: every enabled rule in order, with whether it
/// matched, and the winner.
pub fn explain(set: &RuleSet, facts: &Facts) -> Value {
    let rows: Vec<Value> = ordered(set)
        .into_iter()
        .map(|r| serde_json::json!({ "id": r.id, "priority": r.priority, "policy": r.policy, "matched": eval(&r.cond, facts) }))
        .collect();
    let winner = first_match(set, facts).map(|r| r.id.clone());
    serde_json::json!({ "rules": rows, "winner": winner })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_policy::dsl_parser::{parse_cond, tests::design_example};
    use crate::context_policy::dsl_validator::validate;
    use serde_json::json;

    fn facts(pairs: &[(&str, Fact)]) -> Facts {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    fn c(s: &str) -> Cond {
        let mut n = 0;
        parse_cond(&json!(s), 1, &mut n, "if").unwrap()
    }

    #[test]
    fn and_or_not_and_missing_fields() {
        let f = facts(&[("request.lang", Fact::Str("bn".into())), ("task.tool_calls", Fact::Int(3)), ("request.has_reference", Fact::Bool(false))]);
        assert!(eval(&c("request.lang == 'bn' && task.tool_calls >= 3"), &f));
        assert!(!eval(&c("request.lang == 'en' && task.tool_calls >= 3"), &f));
        assert!(eval(&c("request.lang == 'en' || task.tool_calls > 2"), &f));
        assert!(eval(&c("not request.has_reference == true"), &f));
        assert!(eval(&c("request.lang in ['en', 'bn']"), &f));
        assert!(!eval(&c("request.tool_name == 'x'"), &f), "missing field: false");
        assert!(!eval(&c("request.tool_name != 'x'"), &f), "missing field: even != is false");
        assert!(!eval(&c("exists request.tool_name"), &f));
        assert!(eval(&c("not exists request.tool_name"), &f));
        assert!(eval(&Cond::All(vec![]), &f), "empty all is true");
        assert!(!eval(&Cond::Any(vec![]), &f), "empty any is false");
        let s = facts(&[("request.tool_name", Fact::Str("device__torch_on".into()))]);
        assert!(eval(&c("request.tool_name contains 'TORCH'"), &s));
    }

    #[test]
    fn priority_then_rule_id_order_and_disabled_rules_skip() {
        let mut doc = design_example();
        doc["rules"].as_array_mut().unwrap().push(json!({"id": "R_A_SAME", "priority": 100, "if": "request.category == 'device_action'", "then": {"policy": "T3"}}));
        let set = validate(&doc).unwrap();
        let f = facts(&[
            ("request.category", Fact::Str("device_action".into())),
            ("request.has_reference", Fact::Bool(false)),
            ("request.requires_history", Fact::Bool(false)),
        ]);
        assert_eq!(first_match(&set, &f).unwrap().id, "R_A_SAME", "same priority: rule ID order");
        let mut doc2 = doc.clone();
        doc2["rules"][3]["enabled"] = json!(false);
        let set2 = validate(&doc2).unwrap();
        assert_eq!(first_match(&set2, &f).unwrap().id, "R_DEVICE_SIMPLE");
        let hist = facts(&[("request.requires_history", Fact::Bool(true))]);
        assert_eq!(first_match(&set, &hist).unwrap().policy, "T5");
        assert!(first_match(&set, &Facts::new()).is_none());
        let ex = explain(&set, &f);
        assert_eq!(ex["winner"], "R_A_SAME");
        assert_eq!(ex["rules"].as_array().unwrap().len(), 4);
    }
}
