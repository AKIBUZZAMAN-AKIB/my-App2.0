//! The seven presets (T1–T7): their default parameters and parameter schema.
//!
//! A preset only decides which *transcript* items the temp checklist keeps. No
//! schema here has a field that could leave out a tool, a tool schema, a `sys/*`
//! part or the checklist block: the means to do so does not exist.

use serde_json::{json, Map, Value};

use super::types::{PolicyId, PolicyParams};

/// The type of one parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    /// One of a closed list of strings.
    Enum(&'static [&'static str]),
    /// A list of checklist item ids (strings).
    Ids,
    /// A list of strings out of a closed list.
    StrList(&'static [&'static str]),
    /// An integer within bounds.
    Int { min: i64, max: i64 },
}

#[derive(Debug, Clone, Copy)]
pub struct ParamSpec {
    pub name: &'static str,
    pub kind: ParamKind,
}

/// One preset as the registry describes it.
#[derive(Debug, Clone)]
pub struct PolicyDef {
    pub id: PolicyId,
    pub description: &'static str,
    /// What of the transcript stays in the temp checklist.
    pub keeps: &'static str,
    /// What of the transcript is left out (still stored, recallable).
    pub drops: &'static str,
    pub params: &'static [ParamSpec],
    /// When the temp context starts and ends, and what happens on an error.
    pub start: &'static str,
    pub end: &'static str,
    pub on_error: &'static str,
}

impl PolicyDef {
    /// The default parameters, filled in from the schema.
    pub fn defaults(&self) -> PolicyParams {
        let mut m = Map::new();
        for p in self.params {
            let v = match (self.id, p.name) {
                (_, "ranges") | (_, "memory_scope") | (_, "selection") => json!("relevant"),
                (_, "exclude") => json!(["raw_search_results"]),
                (_, "recent_turns") => json!(2),
                _ => match p.kind {
                    ParamKind::Ids | ParamKind::StrList(_) => json!([]),
                    ParamKind::Enum(opts) => json!(opts.first().copied().unwrap_or("")),
                    ParamKind::Int { min, .. } => json!(min),
                },
            };
            m.insert(p.name.to_string(), v);
        }
        m
    }

    /// The parameter schema as JSON, for the bridge and the UI.
    pub fn to_json(&self) -> Value {
        let params: Vec<Value> = self
            .params
            .iter()
            .map(|p| match p.kind {
                ParamKind::Enum(opts) => json!({"name": p.name, "type": "enum", "options": opts}),
                ParamKind::Ids => json!({"name": p.name, "type": "ids"}),
                ParamKind::StrList(opts) => {
                    json!({"name": p.name, "type": "list", "options": opts})
                }
                ParamKind::Int { min, max } => {
                    json!({"name": p.name, "type": "int", "min": min, "max": max})
                }
            })
            .collect();
        json!({
            "id": self.id.as_str(),
            "name": self.id.name(),
            "description": self.description,
            "keeps": self.keeps,
            "drops": self.drops,
            "defaults": Value::Object(self.defaults()),
            "params": params,
            "start": self.start,
            "end": self.end,
            "onError": self.on_error,
            "editable": self.id != PolicyId::T7,
            "removable": is_removable(self.id),
        })
    }
}

const RANGES: &[&str] = &["relevant", "all", "explicit"];
const SCOPE: &[&str] = &["relevant", "explicit"];
const EXCLUDE: &[&str] = &["raw_search_results"];

const T2_PARAMS: &[ParamSpec] = &[
    ParamSpec {
        name: "ranges",
        kind: ParamKind::Enum(RANGES),
    },
    ParamSpec {
        name: "range_ids",
        kind: ParamKind::Ids,
    },
];
const T3_PARAMS: &[ParamSpec] = &[
    ParamSpec {
        name: "memory_scope",
        kind: ParamKind::Enum(SCOPE),
    },
    ParamSpec {
        name: "memory_ids",
        kind: ParamKind::Ids,
    },
];
const T4_PARAMS: &[ParamSpec] = &[ParamSpec {
    name: "exclude",
    kind: ParamKind::StrList(EXCLUDE),
}];
const T5_PARAMS: &[ParamSpec] = &[ParamSpec {
    name: "recent_turns",
    kind: ParamKind::Int { min: 1, max: 10 },
}];
const T6_PARAMS: &[ParamSpec] = &[
    ParamSpec {
        name: "selection",
        kind: ParamKind::Enum(SCOPE),
    },
    ParamSpec {
        name: "item_ids",
        kind: ParamKind::Ids,
    },
];

const START: &str = "first_tool_call";
const END: &str = "task_completed";
const ON_ERROR: &str = "T7";

/// Every preset, T1 first.
pub fn all() -> Vec<PolicyDef> {
    PolicyId::ALL.iter().map(|id| get(*id)).collect()
}

/// One preset. Every id has one; T7 is fixed.
pub fn get(id: PolicyId) -> PolicyDef {
    let (description, keeps, drops, params): (&str, &str, &str, &'static [ParamSpec]) = match id {
        PolicyId::T1 => (
            "Only this task: earlier turns and the memory block are left out.",
            "The newest request, every steer message and every step of this task.",
            "Earlier turns and the memory block.",
            &[],
        ),
        PolicyId::T2 => (
            "This task plus range summaries of earlier turns.",
            "T1, plus the memory block's range summaries (relevant, all or explicit).",
            "Earlier turns as written.",
            T2_PARAMS,
        ),
        PolicyId::T3 => (
            "This task plus the memory records that fit the goal.",
            "T1, plus memory records chosen by the goal or listed explicitly.",
            "Earlier turns and range summaries.",
            T3_PARAMS,
        ),
        PolicyId::T4 => (
            "Full context, but earlier raw search results become one line.",
            "Everything; the newest search result stays as written.",
            "The text of earlier search results (the call pair stays; recall by id).",
            T4_PARAMS,
        ),
        PolicyId::T5 => (
            "This task plus the few turns before it.",
            "The last N turns before the newest one, and every step of this task.",
            "Older turns and the memory block.",
            T5_PARAMS,
        ),
        PolicyId::T6 => (
            "This task plus chosen checklist items.",
            "Selected checklist items (turn/tN, res/RN, mem/…) and every step of this task.",
            "Every item that was not selected.",
            T6_PARAMS,
        ),
        PolicyId::T7 => (
            "Full context: the request is sent unchanged. The default and the fallback.",
            "Everything.",
            "Nothing.",
            &[],
        ),
    };
    PolicyDef {
        id,
        description,
        keeps,
        drops,
        params,
        start: START,
        end: END,
        on_error: ON_ERROR,
    }
}

/// T7 can never be removed or redefined.
pub fn is_removable(id: PolicyId) -> bool {
    id != PolicyId::T7
}

/// The registry as JSON (for `policy.get`).
pub fn to_json() -> Value {
    Value::Array(all().iter().map(|d| d.to_json()).collect())
}

/// Check `raw` against the preset's schema and fill in what it leaves out.
/// Returns every problem at once, with the parameter path; nothing is partly
/// accepted. `null` or a missing object means the defaults.
pub fn validate_params(id: PolicyId, raw: Option<&Value>) -> Result<PolicyParams, Vec<String>> {
    let def = get(id);
    let mut out = def.defaults();
    let raw = match raw {
        None | Some(Value::Null) => return Ok(out),
        Some(Value::Object(m)) => m,
        Some(_) => return Err(vec![format!("params: {} takes an object", id)]),
    };
    let mut errors = Vec::new();
    for (key, value) in raw {
        let Some(spec) = def.params.iter().find(|p| p.name == key) else {
            errors.push(format!("params.{key}: {} has no parameter {key}", id));
            continue;
        };
        match check(spec.kind, value) {
            Ok(v) => {
                out.insert(key.clone(), v);
            }
            Err(e) => errors.push(format!("params.{key}: {e}")),
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

fn check(kind: ParamKind, value: &Value) -> Result<Value, String> {
    match kind {
        ParamKind::Enum(opts) => match value.as_str() {
            Some(s) if opts.contains(&s) => Ok(json!(s)),
            _ => Err(format!("must be one of {}", opts.join(", "))),
        },
        ParamKind::Ids => {
            let arr = value
                .as_array()
                .ok_or_else(|| "must be a list of item ids".to_string())?;
            if arr.len() > MAX_IDS {
                return Err(format!("at most {MAX_IDS} ids"));
            }
            let mut ids = Vec::new();
            for v in arr {
                match v.as_str() {
                    Some(s) if !s.trim().is_empty() && s.len() <= 120 => ids.push(json!(s.trim())),
                    _ => return Err("every id is a non-empty string".into()),
                }
            }
            Ok(Value::Array(ids))
        }
        ParamKind::StrList(opts) => {
            let arr = value
                .as_array()
                .ok_or_else(|| format!("must be a list out of {}", opts.join(", ")))?;
            let mut out = Vec::new();
            for v in arr {
                match v.as_str() {
                    Some(s) if opts.contains(&s) => out.push(json!(s)),
                    _ => return Err(format!("must be a list out of {}", opts.join(", "))),
                }
            }
            Ok(Value::Array(out))
        }
        ParamKind::Int { min, max } => match value.as_i64() {
            Some(n) if (min..=max).contains(&n) => Ok(json!(n)),
            _ => Err(format!("must be a whole number from {min} to {max}")),
        },
    }
}

/// The most ids one parameter list may hold.
pub const MAX_IDS: usize = 64;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_seven_presets_are_there_in_order() {
        let ids: Vec<&str> = all().iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
    }

    #[test]
    fn every_default_is_valid_against_its_own_schema() {
        for def in all() {
            let d = Value::Object(def.defaults());
            let back =
                validate_params(def.id, Some(&d)).unwrap_or_else(|e| panic!("{}: {e:?}", def.id));
            assert_eq!(Value::Object(back), d, "{}", def.id);
        }
        let t5 = get(PolicyId::T5).defaults();
        assert_eq!(t5["recent_turns"], 2);
        assert_eq!(
            get(PolicyId::T4).defaults()["exclude"],
            json!(["raw_search_results"])
        );
        assert_eq!(get(PolicyId::T2).defaults()["ranges"], "relevant");
        assert_eq!(get(PolicyId::T2).defaults()["range_ids"], json!([]));
        assert_eq!(get(PolicyId::T3).defaults()["memory_scope"], "relevant");
        assert_eq!(get(PolicyId::T6).defaults()["selection"], "relevant");
        assert!(
            get(PolicyId::T7).defaults().is_empty(),
            "T7 has no parameter"
        );
    }

    #[test]
    fn t7_cannot_be_removed() {
        assert!(!is_removable(PolicyId::T7));
        for id in [
            PolicyId::T1,
            PolicyId::T2,
            PolicyId::T3,
            PolicyId::T4,
            PolicyId::T5,
            PolicyId::T6,
        ] {
            assert!(is_removable(id));
        }
        assert_eq!(get(PolicyId::T7).to_json()["editable"], false);
    }

    #[test]
    fn no_schema_can_leave_out_a_tool_or_a_system_part() {
        let banned = [
            "tool",
            "tools",
            "sys",
            "system",
            "schema",
            "prompt",
            "checklist",
            "rules",
        ];
        for def in all() {
            for p in def.params {
                for word in banned {
                    assert!(
                        !p.name.contains(word),
                        "{} param {} could reach {word}",
                        def.id,
                        p.name
                    );
                }
                if let ParamKind::StrList(opts) | ParamKind::Enum(opts) = p.kind {
                    for o in opts {
                        assert!(
                            !o.contains("tool") && !o.starts_with("sys"),
                            "{} option {o}",
                            def.id
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn wrong_params_are_all_reported_together() {
        let bad = json!({"recent_turns": 99, "tools": ["x"]});
        let errs = validate_params(PolicyId::T5, Some(&bad)).unwrap_err();
        assert_eq!(errs.len(), 2, "{errs:?}");
        assert!(validate_params(PolicyId::T7, Some(&json!({"x": 1}))).is_err());
        assert!(validate_params(PolicyId::T2, Some(&json!({"ranges": "some"}))).is_err());
        let ok = validate_params(
            PolicyId::T6,
            Some(&json!({"item_ids": ["turn/t3", "res/R2"]})),
        )
        .unwrap();
        assert_eq!(ok["item_ids"], json!(["turn/t3", "res/R2"]));
        assert_eq!(ok["selection"], "relevant");
    }
}
