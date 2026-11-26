//! TCPE core types: the seven presets, their parameters, the task status, where a
//! decision came from, and the engine switch.
//!
//! Every value has exactly one canonical spelling. Parsing is strict: an unknown
//! or differently cased id is `None`, and the caller falls back to T7. There is no
//! fuzzy matching anywhere in the policy engine.

use serde::{Deserialize, Serialize};

/// A temp-checklist preset. T7 is the full context and the fallback for
/// everything; T1–T6 only ever shorten the transcript part of a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PolicyId {
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
}

impl PolicyId {
    pub const ALL: [PolicyId; 7] = [
        PolicyId::T1,
        PolicyId::T2,
        PolicyId::T3,
        PolicyId::T4,
        PolicyId::T5,
        PolicyId::T6,
        PolicyId::T7,
    ];

    /// Only the exact canonical id is accepted (`"T4"`). `"t4"`, `"T8"`,
    /// `"goal_only"` and `""` are `None`.
    pub fn parse(raw: &str) -> Option<PolicyId> {
        match raw {
            "T1" => Some(PolicyId::T1),
            "T2" => Some(PolicyId::T2),
            "T3" => Some(PolicyId::T3),
            "T4" => Some(PolicyId::T4),
            "T5" => Some(PolicyId::T5),
            "T6" => Some(PolicyId::T6),
            "T7" => Some(PolicyId::T7),
            _ => None,
        }
    }

    /// Parse, falling back to T7 for anything that is not canonical.
    pub fn parse_or_full(raw: &str) -> PolicyId {
        PolicyId::parse(raw).unwrap_or(PolicyId::T7)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            PolicyId::T1 => "T1",
            PolicyId::T2 => "T2",
            PolicyId::T3 => "T3",
            PolicyId::T4 => "T4",
            PolicyId::T5 => "T5",
            PolicyId::T6 => "T6",
            PolicyId::T7 => "T7",
        }
    }

    /// The preset's name, as shown next to its id.
    pub fn name(&self) -> &'static str {
        match self {
            PolicyId::T1 => "GoalOnly",
            PolicyId::T2 => "RangeSummary",
            PolicyId::T3 => "MemoryOnly",
            PolicyId::T4 => "NoSearchData",
            PolicyId::T5 => "RecentTurns",
            PolicyId::T6 => "ChecklistSelection",
            PolicyId::T7 => "FullContext",
        }
    }

    pub fn is_full(&self) -> bool {
        *self == PolicyId::T7
    }
}

impl std::fmt::Display for PolicyId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A preset's parameters: a JSON object checked against the registry schema
/// (`registry::validate_params`). Kept as JSON so the rule file, the bridge and
/// the store carry it without conversion.
pub type PolicyParams = serde_json::Map<String, serde_json::Value>;

/// Where a task stands. `Active` only while its `run_agent_turn` runs; every way
/// out of the turn ends in one of the other states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Active,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Interrupted,
    Fallback,
}

impl TaskStatus {
    pub const ALL: [TaskStatus; 7] = [
        TaskStatus::Active,
        TaskStatus::Completed,
        TaskStatus::Failed,
        TaskStatus::Cancelled,
        TaskStatus::TimedOut,
        TaskStatus::Interrupted,
        TaskStatus::Fallback,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Active => "active",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
            TaskStatus::TimedOut => "timed_out",
            TaskStatus::Interrupted => "interrupted",
            TaskStatus::Fallback => "fallback",
        }
    }

    pub fn parse(raw: &str) -> Option<TaskStatus> {
        TaskStatus::ALL.iter().copied().find(|s| s.as_str() == raw)
    }

    pub fn is_terminal(&self) -> bool {
        *self != TaskStatus::Active
    }
}

/// Who decided the policy of a task, in the order of precedence they are tried
/// (`policy_selector`): a pin of this chat, a matching rule, the model's own
/// `ctx task`, the deterministic auto checklist, or the T7 fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Source {
    Pin,
    Rule,
    Ai,
    Auto,
    Fallback,
}

impl Source {
    pub fn as_str(&self) -> &'static str {
        match self {
            Source::Pin => "pin",
            Source::Rule => "rule",
            Source::Ai => "ai",
            Source::Auto => "auto",
            Source::Fallback => "fallback",
        }
    }

    pub fn parse(raw: &str) -> Option<Source> {
        match raw {
            "pin" => Some(Source::Pin),
            "rule" => Some(Source::Rule),
            "ai" => Some(Source::Ai),
            "auto" => Some(Source::Auto),
            "fallback" => Some(Source::Fallback),
            _ => None,
        }
    }
}

/// The engine switch (`policy_mode` in `ctx_meta`). `Off` is the T7-only
/// compatibility mode and the default: every request is sent exactly as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PolicyMode {
    #[default]
    Off,
    /// Pins and the model's `ctx task`; rules are not consulted.
    Manual,
    /// Pins, rules and the model's `ctx task`.
    Auto,
}

impl PolicyMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PolicyMode::Off => "off",
            PolicyMode::Manual => "manual",
            PolicyMode::Auto => "auto",
        }
    }

    /// Anything that is not one of the three spellings is `Off`.
    pub fn parse_or_off(raw: &str) -> PolicyMode {
        match raw.trim() {
            "manual" => PolicyMode::Manual,
            "auto" => PolicyMode::Auto,
            _ => PolicyMode::Off,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_canonical_policy_ids_parse() {
        for id in PolicyId::ALL {
            assert_eq!(PolicyId::parse(id.as_str()), Some(id));
        }
        for bad in ["T8", "t1", "goal_only", "", " T1", "T1 ", "T0", "GoalOnly"] {
            assert_eq!(PolicyId::parse(bad), None, "{bad:?} must not parse");
            assert_eq!(PolicyId::parse_or_full(bad), PolicyId::T7);
        }
    }

    #[test]
    fn statuses_and_sources_round_trip() {
        for s in TaskStatus::ALL {
            assert_eq!(TaskStatus::parse(s.as_str()), Some(s));
        }
        assert!(!TaskStatus::Active.is_terminal());
        assert!(TaskStatus::Interrupted.is_terminal());
        for s in [
            Source::Pin,
            Source::Rule,
            Source::Ai,
            Source::Auto,
            Source::Fallback,
        ] {
            assert_eq!(Source::parse(s.as_str()), Some(s));
        }
        assert_eq!(Source::parse("AI"), None);
    }

    #[test]
    fn a_wrong_mode_is_off() {
        assert_eq!(PolicyMode::parse_or_off("auto"), PolicyMode::Auto);
        assert_eq!(PolicyMode::parse_or_off("manual"), PolicyMode::Manual);
        for bad in ["", "on", "AUTO", "1", "true"] {
            assert_eq!(PolicyMode::parse_or_off(bad), PolicyMode::Off);
        }
        assert_eq!(PolicyMode::default(), PolicyMode::Off);
    }
}
