//! `TempChecklist`: which transcript items stay in the requests of this task.
//!
//! It comes from the model's `ctx task` (AI) or from the deterministic auto
//! builder (`auto_checklist`). Validation never fails: an unknown id is dropped
//! with a note, an unknown policy becomes T7, and the protected items (the
//! newest prompt, every steer message) are always added.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::registry;
use super::types::{PolicyId, PolicyParams, Source};

/// The id of the newest user prompt in the temp checklist. Always protected.
pub const NEWEST_PROMPT_ID: &str = "user/newest";

/// The id of the n-th steer message of this task (1-based). Always protected.
pub fn steer_id(n: usize) -> String {
    format!("user/steer/{n}")
}

/// Item id families the temp checklist knows. Anything else is unknown.
const ID_PREFIXES: &[&str] = &["turn/", "res/", "mem/", "file/", "note/", "sum/", "range/", "user/"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TempChecklist {
    pub policy_id: PolicyId,
    pub params: PolicyParams,
    /// Transcript items kept, protected ones first.
    pub item_ids: Vec<String>,
    pub source: Source,
    pub created_at: i64,
}

/// What validation changed, for the `ctx task` reply and the event log.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Corrections {
    pub notes: Vec<String>,
    pub dropped_ids: Vec<String>,
    pub policy_fell_back: bool,
}

impl Corrections {
    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }
}

/// Whether `id` has the shape of a checklist item id.
pub fn looks_like_item_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id.len() <= 120
        && ID_PREFIXES.iter().any(|p| id.starts_with(p) && id.len() > p.len())
        && id.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | ':' | '#'))
}

/// The protected ids of a task with `steer_count` steer messages.
pub fn protected_ids(steer_count: usize) -> Vec<String> {
    let mut v = vec![NEWEST_PROMPT_ID.to_string()];
    v.extend((1..=steer_count).map(steer_id));
    v
}

impl TempChecklist {
    /// Build and validate a checklist. `raw_policy` and `raw_params` are what the
    /// model or a rule said; `raw_ids` the items it asked for. `known` answers
    /// whether an id is in this chat's checklist. Never fails.
    pub fn build(
        raw_policy: Option<&str>,
        raw_params: Option<&Value>,
        raw_ids: &[String],
        known: &dyn Fn(&str) -> bool,
        steer_count: usize,
        source: Source,
        now_ms: i64,
    ) -> (TempChecklist, Corrections) {
        let mut fix = Corrections::default();
        let policy_id = match raw_policy.map(str::trim).filter(|s| !s.is_empty()) {
            None => PolicyId::T7,
            Some(raw) => match PolicyId::parse(raw) {
                Some(id) => id,
                None => {
                    fix.notes.push(format!("unknown policy {raw:?}: using T7 (full context)"));
                    fix.policy_fell_back = true;
                    PolicyId::T7
                }
            },
        };
        let params = match registry::validate_params(policy_id, raw_params) {
            Ok(p) => p,
            Err(errs) => {
                fix.notes.push(format!("wrong params for {policy_id} ({}): using its defaults", errs.join("; ")));
                registry::get(policy_id).defaults()
            }
        };
        let mut item_ids = protected_ids(steer_count);
        for raw in raw_ids {
            let id = raw.trim();
            if item_ids.iter().any(|x| x == id) {
                continue;
            }
            if looks_like_item_id(id) && !id.starts_with("user/") && known(id) {
                item_ids.push(id.to_string());
            } else {
                let why = if id.starts_with("sys/") || id.starts_with("tools") {
                    "system parts and tools are always sent"
                } else {
                    "not in this chat's checklist"
                };
                fix.notes.push(format!("dropped {id:?}: {why}"));
                fix.dropped_ids.push(id.to_string());
            }
        }
        (TempChecklist { policy_id, params, item_ids, source, created_at: now_ms }, fix)
    }

    /// The full-context checklist: T7, protected items only.
    pub fn full(steer_count: usize, source: Source, now_ms: i64) -> TempChecklist {
        TempChecklist {
            policy_id: PolicyId::T7,
            params: PolicyParams::new(),
            item_ids: protected_ids(steer_count),
            source,
            created_at: now_ms,
        }
    }

    /// Make sure every protected item of a task with `steer_count` steers is in.
    pub fn ensure_protected(&mut self, steer_count: usize) {
        for (i, id) in protected_ids(steer_count).into_iter().enumerate() {
            if !self.item_ids.contains(&id) {
                self.item_ids.insert(i.min(self.item_ids.len()), id);
            }
        }
    }

    /// Add ids (already validated) that are not in yet.
    pub fn add_ids(&mut self, ids: &[String]) {
        for id in ids {
            if !self.item_ids.contains(id) {
                self.item_ids.push(id.clone());
            }
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "policy": self.policy_id.as_str(),
            "params": Value::Object(self.params.clone()),
            "items": self.item_ids,
            "source": self.source.as_str(),
            "createdAt": self.created_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn known(id: &str) -> bool {
        matches!(id, "turn/t3" | "res/R2" | "mem/m1")
    }

    #[test]
    fn unknown_ids_are_dropped_without_an_error() {
        let ids = vec!["turn/t3".to_string(), "turn/t99".into(), "garbage".into(), "sys/core".into(), "res/R2".into()];
        let (c, fix) = TempChecklist::build(Some("T6"), None, &ids, &known, 0, Source::Ai, 5);
        assert_eq!(c.policy_id, PolicyId::T6);
        assert_eq!(c.item_ids, vec![NEWEST_PROMPT_ID, "turn/t3", "res/R2"]);
        assert_eq!(fix.dropped_ids, vec!["turn/t99", "garbage", "sys/core"]);
        assert_eq!(fix.notes.len(), 3);
        assert!(fix.notes[2].contains("always sent"));
    }

    #[test]
    fn the_newest_prompt_and_every_steer_are_always_in() {
        let (c, _) = TempChecklist::build(Some("T1"), None, &[], &known, 2, Source::Auto, 1);
        assert_eq!(c.item_ids, vec![NEWEST_PROMPT_ID, "user/steer/1", "user/steer/2"]);
        let mut c = TempChecklist::full(0, Source::Fallback, 1);
        c.item_ids.clear();
        c.ensure_protected(1);
        assert_eq!(c.item_ids, vec![NEWEST_PROMPT_ID, "user/steer/1"]);
        // A model cannot smuggle a fake protected id in.
        let (c, fix) = TempChecklist::build(Some("T1"), None, &["user/steer/9".into()], &|_| true, 0, Source::Ai, 1);
        assert_eq!(c.item_ids, vec![NEWEST_PROMPT_ID]);
        assert_eq!(fix.dropped_ids, vec!["user/steer/9"]);
    }

    #[test]
    fn an_unknown_policy_is_t7() {
        for raw in ["T9", "t1", "goal_only"] {
            let (c, fix) = TempChecklist::build(Some(raw), None, &[], &known, 0, Source::Ai, 1);
            assert_eq!(c.policy_id, PolicyId::T7, "{raw}");
            assert!(fix.policy_fell_back);
        }
        let (c, fix) = TempChecklist::build(None, None, &[], &known, 0, Source::Ai, 1);
        assert_eq!(c.policy_id, PolicyId::T7);
        assert!(fix.is_empty());
    }

    #[test]
    fn wrong_params_fall_back_to_the_defaults() {
        let (c, fix) = TempChecklist::build(Some("T5"), Some(&json!({"recent_turns": 50})), &[], &known, 0, Source::Ai, 1);
        assert_eq!(c.policy_id, PolicyId::T5);
        assert_eq!(c.params["recent_turns"], 2);
        assert_eq!(fix.notes.len(), 1);
        let (c, _) = TempChecklist::build(Some("T5"), Some(&json!({"recent_turns": 4})), &[], &known, 0, Source::Ai, 1);
        assert_eq!(c.params["recent_turns"], 4);
    }

    #[test]
    fn item_id_shapes() {
        for ok in ["turn/t3", "res/R12", "mem/m4", "file/src_main.rs", "note/N2"] {
            assert!(looks_like_item_id(ok), "{ok}");
        }
        for bad in ["", "turn/", "sys/core", "tools", "turn/t3 drop table", "x"] {
            assert!(!looks_like_item_id(bad), "{bad}");
        }
    }
}
