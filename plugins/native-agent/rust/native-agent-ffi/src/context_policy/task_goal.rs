//! `TaskGoal`: what this task is for, built from the user's own words.
//!
//! The newest user prompt is kept whole and verbatim, steer messages likewise.
//! Constraints and response requirements are *verbatim pieces* of those words;
//! the validator rejects any that do not appear in them, so a goal can never
//! invent a condition (the evidence check of `turn_memory/goals.rs`).

use serde::{Deserialize, Serialize};

use super::types::TaskStatus;

/// The most characters `required_outcome` (the model's `focus`) may hold.
pub const MAX_OUTCOME_CHARS: usize = 300;

/// The criterion every task ends on: a model answer without a tool call.
pub const FINAL_ANSWER_CRITERION: &str = "final_answer_without_tool_call";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskGoal {
    pub goal_id: String,
    /// The newest user prompt, whole and verbatim.
    pub user_request: String,
    /// User messages that arrived while the task ran, verbatim.
    pub steer_messages: Vec<String>,
    /// Steer ids already folded in (a revision is deduped by its id, not its
    /// text: the same words sent twice are two steers). Parallel to
    /// `steer_messages` where known; legacy goals have none.
    #[serde(default)]
    pub steer_ids: Vec<String>,
    /// Goal revisions made by steers (docs/steer plan: "TaskGoal-এ revision"),
    /// oldest first, one per steer id: a later patch for the same steer
    /// replaces its text. The newest revision is the goal as the user now
    /// wants it; the original `user_request` is never rewritten.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revisions: Vec<GoalRevision>,
    /// Only from the model's `ctx task focus:`; at most 300 characters.
    pub required_outcome: Option<String>,
    /// Verbatim pieces of the request that limit how the work is done.
    pub constraints: Vec<String>,
    /// Verbatim pieces of the request that say how the answer must look.
    pub response_requirements: Vec<String>,
    pub completion_criteria: Vec<String>,
    /// The active `turn_memory::goals` goal, when there is one.
    pub linked_goal_id: Option<String>,
    pub created_at: i64,
    pub status: TaskStatus,
}

/// One goal revision a steer made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalRevision {
    pub steer_id: String,
    pub text: String,
    pub at: i64,
}

/// Words that mark a clause as a constraint (English and Bangla).
const CONSTRAINT_MARKS: &[&str] = &[
    "must",
    "don't",
    "do not",
    "dont",
    "never",
    "only",
    "without",
    "avoid",
    "no more than",
    "at most",
    "at least",
    "should not",
    "shouldn't",
    "অবশ্যই",
    "শুধু",
    "করো না",
    "করবে না",
    "না করে",
    "ছাড়া",
    "বাদ",
    "কখনো না",
    "মধ্যে",
];

/// Words that mark a clause as a requirement on the answer.
const RESPONSE_MARKS: &[&str] = &[
    "answer in",
    "reply in",
    "respond in",
    "in bangla",
    "in bengali",
    "in english",
    "as a list",
    "as a table",
    "bullet",
    "format",
    "summar",
    "step by step",
    "in short",
    "briefly",
    "বাংলায়",
    "ইংরেজিতে",
    "উত্তর",
    "তালিকা",
    "টেবিল",
    "সংক্ষেপে",
    "সারাংশ",
    "ধাপে ধাপে",
];

impl TaskGoal {
    /// Build the goal for a task. `user_request` is kept exactly as given, however
    /// long. Constraints and response requirements are cut out of the user's
    /// words, never written.
    pub fn new(
        user_request: &str,
        steer_messages: &[String],
        linked_goal_id: Option<String>,
        now_ms: i64,
    ) -> TaskGoal {
        let mut constraints = Vec::new();
        let mut response_requirements = Vec::new();
        for text in std::iter::once(user_request).chain(steer_messages.iter().map(|s| s.as_str())) {
            for clause in clauses(text) {
                let lower = clause.to_lowercase();
                if RESPONSE_MARKS.iter().any(|m| lower.contains(m)) {
                    push_unique(&mut response_requirements, clause);
                } else if CONSTRAINT_MARKS.iter().any(|m| lower.contains(m)) {
                    push_unique(&mut constraints, clause);
                }
            }
        }
        TaskGoal {
            goal_id: new_goal_id(),
            user_request: user_request.to_string(),
            steer_messages: steer_messages.to_vec(),
            steer_ids: Vec::new(),
            revisions: Vec::new(),
            required_outcome: None,
            constraints,
            response_requirements,
            completion_criteria: vec![FINAL_ANSWER_CRITERION.to_string()],
            linked_goal_id,
            created_at: now_ms,
            status: TaskStatus::Active,
        }
    }

    /// Set the model's `focus`, cut to [`MAX_OUTCOME_CHARS`]. An empty focus
    /// clears it. Returns whether it had to be cut.
    pub fn set_focus(&mut self, focus: &str) -> bool {
        let focus = focus.trim();
        if focus.is_empty() {
            self.required_outcome = None;
            return false;
        }
        let cut = focus.chars().count() > MAX_OUTCOME_CHARS;
        self.required_outcome = Some(focus.chars().take(MAX_OUTCOME_CHARS).collect());
        cut
    }

    /// Add a steer message (verbatim) and the conditions it carries.
    pub fn add_steer(&mut self, text: &str) {
        self.steer_messages.push(text.to_string());
        for clause in clauses(text) {
            let lower = clause.to_lowercase();
            if RESPONSE_MARKS.iter().any(|m| lower.contains(m)) {
                push_unique(&mut self.response_requirements, clause);
            } else if CONSTRAINT_MARKS.iter().any(|m| lower.contains(m)) {
                push_unique(&mut self.constraints, clause);
            }
        }
    }

    /// Record a steer's goal revision, deduped by steer id (not text): a
    /// second patch for the same steer replaces its revision in place.
    /// Returns whether anything changed.
    pub fn add_revision(&mut self, steer_id: &str, text: &str, at: i64) -> bool {
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        if let Some(r) = self.revisions.iter_mut().find(|r| r.steer_id == steer_id) {
            if r.text == text {
                return false;
            }
            r.text = text.to_string();
            r.at = at;
            return true;
        }
        self.revisions.push(GoalRevision {
            steer_id: steer_id.to_string(),
            text: text.to_string(),
            at,
        });
        true
    }

    /// The newest steer revision of the goal, if any.
    pub fn latest_revision(&self) -> Option<&GoalRevision> {
        self.revisions.last()
    }

    /// Add a steer by id: a steer already folded in (same id) is skipped.
    /// Returns whether it was new. An empty id falls back to the text.
    pub fn add_steer_with_id(&mut self, id: &str, text: &str) -> bool {
        if id.is_empty() {
            if self.steer_messages.iter().any(|s| s == text) {
                return false;
            }
        } else if self.steer_ids.iter().any(|s| s == id) {
            return false;
        }
        self.add_steer(text);
        if !id.is_empty() {
            self.steer_ids.push(id.to_string());
        }
        true
    }

    /// Every problem with the goal, or none. A constraint or response requirement
    /// that is not a verbatim piece of the request or a steer message is rejected.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if !self.goal_id.starts_with("tg_") {
            errors.push("goal_id: must start with tg_".to_string());
        }
        if self.user_request.trim().is_empty() {
            errors.push("user_request: empty".to_string());
        }
        let found = |piece: &str| {
            !piece.trim().is_empty()
                && (self.user_request.contains(piece)
                    || self.steer_messages.iter().any(|s| s.contains(piece)))
        };
        for (i, c) in self.constraints.iter().enumerate() {
            if !found(c) {
                errors.push(format!("constraints[{i}]: not in the user's words"));
            }
        }
        for (i, c) in self.response_requirements.iter().enumerate() {
            if !found(c) {
                errors.push(format!(
                    "response_requirements[{i}]: not in the user's words"
                ));
            }
        }
        if let Some(o) = &self.required_outcome {
            if o.chars().count() > MAX_OUTCOME_CHARS {
                errors.push(format!(
                    "required_outcome: longer than {MAX_OUTCOME_CHARS} characters"
                ));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// The same goal with the user's words removed: what a finished task keeps
    /// (ids and state only).
    pub fn redacted(&self) -> serde_json::Value {
        serde_json::json!({
            "goal_id": self.goal_id,
            "linked_goal_id": self.linked_goal_id,
            "created_at": self.created_at,
            "status": self.status.as_str(),
            "steer_count": self.steer_messages.len(),
        })
    }
}

fn new_goal_id() -> String {
    let u = uuid::Uuid::new_v4().simple().to_string();
    format!("tg_{}", &u[..12])
}

fn push_unique(list: &mut Vec<String>, item: &str) {
    if !list.iter().any(|x| x == item) {
        list.push(item.to_string());
    }
}

/// The clauses of a text: split on sentence ends and line breaks, each trimmed.
/// Every clause is a verbatim slice of `text`.
fn clauses(text: &str) -> Vec<&str> {
    text.split(|c: char| matches!(c, '.' | '!' | '?' | '\n' | '।' | ';'))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.chars().count() <= 400)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_english_prompt_becomes_a_goal_with_verbatim_conditions() {
        let p =
            "Read config.json and fix the port. Do not touch other files. Answer in a short list.";
        let g = TaskGoal::new(p, &[], None, 1);
        assert_eq!(g.user_request, p);
        assert_eq!(g.constraints, vec!["Do not touch other files"]);
        assert_eq!(g.response_requirements, vec!["Answer in a short list"]);
        assert!(g.goal_id.starts_with("tg_"));
        assert_eq!(g.status, TaskStatus::Active);
        assert!(g.validate().is_ok());
    }

    #[test]
    fn a_bangla_prompt_becomes_a_goal() {
        let p = "আগের ফাইলটা আবার পড়ো। শুধু প্রথম অংশ দেখো। বাংলায় উত্তর দাও।";
        let g = TaskGoal::new(p, &[], Some("G3".into()), 1);
        assert_eq!(g.user_request, p);
        assert_eq!(g.constraints, vec!["শুধু প্রথম অংশ দেখো"]);
        assert_eq!(g.response_requirements, vec!["বাংলায় উত্তর দাও"]);
        assert_eq!(g.linked_goal_id.as_deref(), Some("G3"));
        assert!(g.validate().is_ok());
    }

    #[test]
    fn a_twenty_thousand_character_prompt_is_kept_whole() {
        let p = "x".repeat(20_000);
        let g = TaskGoal::new(&p, &[], None, 1);
        assert_eq!(g.user_request.len(), 20_000);
        assert_eq!(g.user_request, p);
        assert!(g.validate().is_ok());
    }

    #[test]
    fn a_constraint_that_is_not_in_the_prompt_is_rejected() {
        let mut g = TaskGoal::new("Turn on the torch.", &[], None, 1);
        g.constraints.push("Never use the camera".into());
        let errs = g.validate().unwrap_err();
        assert_eq!(errs, vec!["constraints[0]: not in the user's words"]);
        let mut g = TaskGoal::new("Turn on the torch.", &[], None, 1);
        g.response_requirements.push("Reply in French".into());
        assert!(g.validate().is_err());
    }

    #[test]
    fn steer_messages_are_kept_verbatim_and_count_as_the_users_words() {
        let mut g = TaskGoal::new("Summarise the log.", &[], None, 1);
        g.add_steer("Only the errors please");
        assert_eq!(g.steer_messages, vec!["Only the errors please"]);
        assert_eq!(g.constraints, vec!["Only the errors please"]);
        assert!(g.validate().is_ok());
    }

    #[test]
    fn focus_is_cut_to_three_hundred_characters() {
        let mut g = TaskGoal::new("do it", &[], None, 1);
        assert!(!g.set_focus("fix the port"));
        assert_eq!(g.required_outcome.as_deref(), Some("fix the port"));
        assert!(g.set_focus(&"ব".repeat(400)));
        assert_eq!(
            g.required_outcome.as_ref().unwrap().chars().count(),
            MAX_OUTCOME_CHARS
        );
        assert!(g.validate().is_ok());
        g.set_focus("  ");
        assert!(g.required_outcome.is_none());
    }

    #[test]
    fn steer_revisions_dedupe_by_id_and_never_leak_into_the_redacted_goal() {
        let mut g = TaskGoal::new("build the app", &[], None, 1);
        assert!(g.add_revision("st-1", "build the app with yarn", 2));
        assert!(!g.add_revision("st-1", "build the app with yarn", 3));
        assert!(g.add_revision("st-1", "build with yarn workspaces", 4));
        assert!(g.add_revision("st-2", "build with yarn workspaces", 5));
        assert_eq!(g.revisions.len(), 2, "same text, different steer: two revisions");
        assert_eq!(g.latest_revision().unwrap().steer_id, "st-2");
        assert_eq!(g.user_request, "build the app", "the request itself is never rewritten");
        let back: TaskGoal = serde_json::from_value(serde_json::to_value(&g).unwrap()).unwrap();
        assert_eq!(back, g);
        assert!(!g.redacted().to_string().contains("yarn"));
    }

    #[test]
    fn the_redacted_goal_holds_no_user_words() {
        let g = TaskGoal::new("secret plan for tomorrow", &["more secret".into()], None, 1);
        let r = g.redacted().to_string();
        assert!(!r.contains("secret"));
        assert!(r.contains(&g.goal_id));
    }
}
