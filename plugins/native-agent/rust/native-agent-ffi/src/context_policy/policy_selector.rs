//! Which policy a task runs with, and its temp checklist.
//!
//! Precedence: protected items (always in) → hard exclusions (always out) →
//! the chat's pin → the highest-priority enabled rule that matches → the
//! model's own `ctx task` → the deterministic auto checklist → T7.
//!
//! `policy_mode = off`: always T7. `manual`: pin and the model's `ctx task`
//! only (no rules, no auto). `auto`: everything. When a pin or a rule wins over
//! the model's `ctx task`, the item IDs the model asked for are still added, so
//! what it said it needs is kept.

use std::collections::BTreeSet;

use serde_json::Value;

use super::dsl_parser::RuleSet;
use super::exclusions::{self, Removed};
use super::rule_evaluator::{self, Fact, Facts};
use super::temp_checklist::{Corrections, TempChecklist};
use super::types::{PolicyId, PolicyMode, PolicyParams, Source};

/// What the model said in `ctx task`.
#[derive(Debug, Clone, Default)]
pub struct AiPick {
    pub policy: Option<String>,
    pub params: Option<Value>,
    pub ids: Vec<String>,
}

/// A checklist item the auto checklist can consider: its ID and a title the
/// goal's words are matched against.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub title: String,
}

pub struct SelectInput<'a> {
    pub mode: PolicyMode,
    pub pin: Option<(PolicyId, PolicyParams)>,
    pub rules: &'a RuleSet,
    pub facts: &'a Facts,
    pub ai: Option<&'a AiPick>,
    /// The newest user prompt (for the auto checklist's terms).
    pub request: &'a str,
    /// Items of this chat's checklist the auto checklist can pick from.
    pub candidates: &'a [Candidate],
    /// Whether an ID is in this chat's checklist.
    pub known: &'a dyn Fn(&str) -> bool,
    /// Memory group of an ID, for group exclusions.
    pub group_of: &'a dyn Fn(&str) -> Option<String>,
    pub recent_turns: i64,
    pub steer_count: usize,
    pub now_ms: i64,
}

#[derive(Debug, Clone)]
pub struct Selection {
    pub checklist: TempChecklist,
    /// The rule that decided, when a rule did.
    pub rule_id: Option<String>,
    /// What validation changed (unknown IDs, unknown policy, ...).
    pub corrections: Corrections,
    /// Items a hard exclusion removed, with the reason.
    pub removed: Vec<Removed>,
}

fn pick_auto(inp: &SelectInput<'_>) -> (PolicyId, Value, Vec<String>) {
    let history = matches!(inp.facts.get("request.requires_history"), Some(Fact::Bool(true)));
    if history {
        return (PolicyId::T5, serde_json::json!({ "recent_turns": inp.recent_turns.clamp(1, 10) }), Vec::new());
    }
    let terms = crate::turn_memory::select::terms(inp.request);
    let mut ids = Vec::new();
    if !terms.is_empty() {
        for c in inp.candidates {
            let t: BTreeSet<String> = crate::turn_memory::select::terms(&c.title);
            if t.intersection(&terms).next().is_some() {
                ids.push(c.id.clone());
            }
            if ids.len() >= 24 {
                break;
            }
        }
    }
    (PolicyId::T6, serde_json::json!({ "selection": "explicit" }), ids)
}

/// Choose. Never fails: anything doubtful ends in T7.
pub fn select(inp: &SelectInput<'_>) -> Selection {
    let steer = inp.steer_count;
    if inp.mode == PolicyMode::Off {
        return Selection { checklist: TempChecklist::full(steer, Source::Fallback, inp.now_ms), rule_id: None, corrections: Corrections::default(), removed: Vec::new() };
    }
    let ai_ids: &[String] = inp.ai.map(|a| a.ids.as_slice()).unwrap_or(&[]);
    let mut rule_id = None;
    let (mut list, mut fix) = if let Some((id, params)) = &inp.pin {
        let p = Value::Object(params.clone());
        TempChecklist::build(Some(id.as_str()), Some(&p), ai_ids, inp.known, steer, Source::Pin, inp.now_ms)
    } else if let Some(rule) = (inp.mode == PolicyMode::Auto).then(|| rule_evaluator::first_match(inp.rules, inp.facts)).flatten() {
        rule_id = Some(rule.id.clone());
        TempChecklist::build(Some(&rule.policy), rule.params.as_ref(), ai_ids, inp.known, steer, Source::Rule, inp.now_ms)
    } else if let Some(ai) = inp.ai {
        TempChecklist::build(ai.policy.as_deref(), ai.params.as_ref(), &ai.ids, inp.known, steer, Source::Ai, inp.now_ms)
    } else if inp.mode == PolicyMode::Auto {
        let (id, params, ids) = pick_auto(inp);
        TempChecklist::build(Some(id.as_str()), Some(&params), &ids, inp.known, steer, Source::Auto, inp.now_ms)
    } else {
        (TempChecklist::full(steer, Source::Fallback, inp.now_ms), Corrections::default())
    };
    if fix.policy_fell_back {
        list.source = Source::Fallback;
    }
    let removed = exclusions::apply(&inp.rules.exclusions, &mut list, inp.group_of);
    list.ensure_protected(steer);
    // Explicit ids in a T6 pick become its `ids` parameter, so the view keeps them.
    if list.policy_id == PolicyId::T6 && list.params.get("selection").and_then(Value::as_str) == Some("explicit") {
        let ids: Vec<Value> = list.item_ids.iter().filter(|i| !i.starts_with("user/")).map(|i| Value::String(i.clone())).collect();
        list.params.insert("item_ids".into(), Value::Array(ids));
    }
    for r in &removed {
        fix.notes.push(format!("left out {}: {}", r.id, r.reason));
    }
    Selection { checklist: list, rule_id, corrections: fix, removed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_policy::dsl_parser::tests::design_example;
    use crate::context_policy::dsl_validator::validate;
    use serde_json::json;

    fn device_facts() -> Facts {
        let names = vec!["device__torch_on".to_string()];
        crate::context_policy::request_facts::compute(&crate::context_policy::request_facts::FactInput {
            request: "turn the torch on",
            tool_names: &names,
            first_calls: &names,
            ..Default::default()
        })
    }

    fn run(mode: PolicyMode, pin: Option<PolicyId>, ai: Option<&AiPick>, rules: &RuleSet, facts: &Facts) -> Selection {
        let known = |id: &str| id.starts_with("turn/") || id.starts_with("mem/");
        select(&SelectInput {
            mode,
            pin: pin.map(|p| (p, crate::context_policy::registry::get(p).defaults())),
            rules,
            facts,
            ai,
            request: "turn the torch on",
            candidates: &[Candidate { id: "turn/t2".into(), title: "torch settings".into() }, Candidate { id: "turn/t3".into(), title: "weather".into() }],
            known: &known,
            group_of: &|_| None,
            recent_turns: 2,
            steer_count: 0,
            now_ms: 1,
        })
    }

    #[test]
    fn pin_beats_rule_beats_ai_beats_t7_and_ai_ids_stay() {
        let rules = validate(&design_example()).unwrap();
        let f = device_facts();
        let ai = AiPick { policy: Some("T3".into()), params: None, ids: vec!["turn/t9".into()] };
        let s = run(PolicyMode::Auto, Some(PolicyId::T5), Some(&ai), &rules, &f);
        assert_eq!((s.checklist.policy_id, s.checklist.source), (PolicyId::T5, Source::Pin));
        assert!(s.checklist.item_ids.contains(&"turn/t9".to_string()), "the model's ids are kept under a pin");
        let s = run(PolicyMode::Auto, None, Some(&ai), &rules, &f);
        assert_eq!((s.checklist.policy_id, s.checklist.source), (PolicyId::T1, Source::Rule));
        assert_eq!(s.rule_id.as_deref(), Some("R_DEVICE_SIMPLE"));
        assert!(s.checklist.item_ids.contains(&"turn/t9".to_string()), "and under a rule");
        let s = run(PolicyMode::Auto, None, Some(&ai), &crate::context_policy::dsl_parser::builtin_default(), &f);
        assert_eq!((s.checklist.policy_id, s.checklist.source), (PolicyId::T3, Source::Ai));
        let s = run(PolicyMode::Manual, None, None, &rules, &f);
        assert_eq!((s.checklist.policy_id, s.checklist.source), (PolicyId::T7, Source::Fallback), "manual: no rules, no auto");
        let s = run(PolicyMode::Manual, None, Some(&ai), &rules, &f);
        assert_eq!(s.checklist.source, Source::Ai, "manual: rules are skipped");
    }

    #[test]
    fn off_unknown_ai_policy_and_auto() {
        let rules = validate(&design_example()).unwrap();
        let f = device_facts();
        let ai = AiPick { policy: Some("T3".into()), ..Default::default() };
        let s = run(PolicyMode::Off, Some(PolicyId::T1), Some(&ai), &rules, &f);
        assert_eq!(s.checklist.policy_id, PolicyId::T7, "off is always T7");
        let bad = AiPick { policy: Some("T9".into()), ids: vec!["nope".into()], ..Default::default() };
        let empty = crate::context_policy::dsl_parser::builtin_default();
        let s = run(PolicyMode::Auto, None, Some(&bad), &empty, &f);
        assert_eq!((s.checklist.policy_id, s.checklist.source), (PolicyId::T7, Source::Fallback));
        assert_eq!(s.corrections.dropped_ids, vec!["nope"]);
        let s = run(PolicyMode::Auto, None, None, &empty, &f);
        assert_eq!((s.checklist.policy_id, s.checklist.source), (PolicyId::T6, Source::Auto));
        assert_eq!(s.checklist.item_ids, vec!["user/newest", "turn/t2"], "auto picks the items the goal's words match");
        assert_eq!(s.checklist.params["item_ids"], json!(["turn/t2"]));
    }

    #[test]
    fn hard_exclusions_win_over_every_source() {
        let mut doc = design_example();
        doc["exclusions"] = json!({"always_exclude": {"turn_ids": ["turn/t9"]}});
        let rules = validate(&doc).unwrap();
        let ai = AiPick { policy: Some("T6".into()), params: Some(json!({"selection": "explicit"})), ids: vec!["turn/t9".into(), "turn/t2".into()] };
        let s = run(PolicyMode::Auto, Some(PolicyId::T6), Some(&ai), &rules, &Facts::new());
        assert!(!s.checklist.item_ids.contains(&"turn/t9".to_string()));
        assert_eq!(s.removed.len(), 1);
        assert!(s.checklist.item_ids.contains(&"user/newest".to_string()));
    }
}
