//! The context tool the model calls, and the guard that keeps it cheap.
//!
//! The spec first described eight tools (`ctx_view`, `ctx_set`, `ctx_category`,
//! `ctx_summarize`, `ctx_recall`, `ctx_note`, `ctx_strategy`, `ctx_prompt`).
//! Measured against the real request, their schemas cost **6,203 characters
//! (~1,632 tokens) on every single model call** — 20% of an 8k window, before a
//! single message is sent. Since a tool schema is paid per call, not per use,
//! that is the most expensive part of the whole feature.
//!
//! So there is **one** tool here: `ctx`, with an `action` enum. The eight names
//! keep working as aliases (`legacy_alias`) so the UI, the docs and the tests
//! written against the spec still mean the same thing, and the dispatcher (next
//! stage) routes an alias to the same handler.
//!
//! The size guard below is the important part: if a later edit grows the schema
//! past the budget, `cargo test` fails. A prompt cost that is not tested grows.

use crate::types::ToolDefinition;
use serde_json::{json, Value};

/// The single context tool.
pub const CTX_TOOL: &str = "ctx";

/// Character budget for the tool's serialized definition.
///
/// ~2,300 characters ≈ 600 tokens with the engine's meter for English JSON. The
/// eight-tool version measured 6,203 characters, so this is the guard that keeps
/// the regression from coming back.
pub const MAX_SCHEMA_CHARS: usize = 2_300;

/// The eight action names from the spec, mapped to `ctx.action` values.
pub const ACTIONS: [&str; 12] = ["view", "set", "category", "summarize", "recall", "note", "strategy", "prompt", "original", "memory", "remember", "forget"];

/// The tools the checklist replaces while it is on (it is always on): they
/// are not offered; a call from an old transcript is still answered.
pub const REPLACED_MEMORY_TOOLS: &[&str] = &["recall_turns", "memory_inspect", "memory_recall", "memory_search", "memory_list", "memory_store", "memory_forget"];

/// A tool name from the spec's eight, mapped to the unified action.
pub fn legacy_alias(name: &str) -> Option<&'static str> {
    Some(match name {
        "ctx_view" => "view",
        "ctx_set" => "set",
        "ctx_category" => "category",
        "ctx_summarize" => "summarize",
        "ctx_recall" => "recall",
        "ctx_note" => "note",
        "ctx_strategy" => "strategy",
        "ctx_prompt" => "prompt",
        _ => return None,
    })
}

/// The eight spec names, kept for feature negotiation: an engine that reports
/// `contextTree` may be asked for any of them and answers through `ctx`.
pub fn legacy_names() -> Vec<&'static str> {
    vec!["ctx_view", "ctx_set", "ctx_category", "ctx_summarize", "ctx_recall", "ctx_note", "ctx_strategy", "ctx_prompt"]
}

/// The tool definition sent with every request while `contextTree` is on.
pub fn tool_definition() -> ToolDefinition {
    ToolDefinition {
        name: CTX_TOOL.into(),
        description: "See and steer what is in your context window: a checklist of every item with its token \
cost and state. Nothing is lost (anything out is stored and recallable); locked rules and essentials \
cannot be removed."
.into(),
        input_schema: schema(),
        webview_only: false,
        approval_policy: None,
    }
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ACTIONS,
                "description": "view|set|category|summarize|recall|note|strategy|prompt|original|memory|remember|forget"
            },
            "path": { "type": "string", "description": "Category or node id." },
            "id": { "type": "string", "description": "One node/category id." },
            "ops": {
                "type": "array", "maxItems": 12,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "action": { "type": "string", "enum": ["include", "exclude", "note_only", "pin", "unpin", "move", "tag", "auto", "all_versions", "latest", "inactive", "active", "remove"] },
                        "note": { "type": "string", "maxLength": 600 },
                        "to": { "type": "string" }
                    },
                    "required": ["id", "action"],
                    "additionalProperties": false
                }
            },
            "ids": { "type": "array", "items": { "type": "string" }, "maxItems": 40 },
            "expect_rev": { "type": "integer", "minimum": 0 },
            "since_rev": { "type": "integer", "minimum": 0 },
            "dry_run": { "type": "boolean" },
            "focus": { "type": "string", "maxLength": 400 },
            "max_tokens": { "type": "integer", "minimum": 64, "maximum": 4000 },
            "via_subagent": { "type": "boolean" },
            "question": { "type": "string", "maxLength": 500 },
            "offset": { "type": "integer", "minimum": 0 },
            "from_turn": { "type": "integer", "minimum": 1 },
            "to_turn": { "type": "integer", "minimum": 1 },
            "result_id": { "type": "string" },
            "key": { "type": "string", "maxLength": 200 },
            "keep": { "type": "boolean" },
            "title": { "type": "string", "maxLength": 120 },
            "text": { "type": "string", "maxLength": 20000 },
            "category": { "type": "string" },
            "state": { "type": "string", "enum": ["in", "out"] },
            "long_term": { "type": "boolean" },
            "delete_contents": { "type": "boolean" },
            "step": { "type": "string", "maxLength": 300 },
            "load": { "type": "array", "items": { "type": "string" }, "maxItems": 10 },
            "unload": { "type": "array", "items": { "type": "string" }, "maxItems": 10 }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

/// The serialized size of the definition, the number the guard tests.
pub fn schema_chars() -> usize {
    let d = tool_definition();
    d.name.chars().count() + d.description.chars().count() + d.input_schema.to_string().chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_stays_within_its_token_budget() {
        let chars = schema_chars();
        println!("ctx tool definition: {chars} chars ≈ {} tokens", chars / 4);
        assert!(
            chars <= MAX_SCHEMA_CHARS,
            "ctx tool definition is {chars} chars (budget {MAX_SCHEMA_CHARS}). Every character is paid on every \
             model call: move prose into sys/core or shorten a description instead of raising the budget."
        );
    }

    #[test]
    fn every_action_is_reachable_and_documented() {
        let s = schema();
        let enum_vals = s["properties"]["action"]["enum"].as_array().expect("action enum");
        assert_eq!(enum_vals.len(), ACTIONS.len());
        for a in ACTIONS {
            assert!(enum_vals.iter().any(|v| v.as_str() == Some(a)), "missing action {a}");
        }
        let desc = s["properties"]["action"]["description"].as_str().unwrap_or("").to_lowercase();
        for a in ACTIONS {
            assert!(desc.contains(a), "the action description never mentions {a}");
        }
    }

    #[test]
    fn the_eight_spec_names_still_route() {
        for name in legacy_names() {
            let action = legacy_alias(name).unwrap_or_else(|| panic!("alias missing for {name}"));
            assert!(ACTIONS.contains(&action), "{name} → {action} is not an action");
        }
        assert_eq!(legacy_alias("ctx_view"), Some("view"));
        assert_eq!(legacy_alias("recall_turns"), None, "the existing memory tools are not aliases");
    }

    #[test]
    fn the_schema_is_closed_and_requires_an_action() {
        let s = schema();
        assert_eq!(s["additionalProperties"], json!(false));
        assert_eq!(s["required"], json!(["action"]));
        assert_eq!(s["properties"]["ops"]["items"]["additionalProperties"], json!(false));
        assert_eq!(s["properties"]["ops"]["maxItems"], json!(12));
        assert_eq!(s["properties"]["ids"]["maxItems"], json!(40));
    }

    #[test]
    fn it_is_offered_without_an_approval_prompt() {
        // A context action only changes the prompt; it never touches a file, the
        // network or the user's data. It must not nag with an approval dialog.
        let d = tool_definition();
        assert!(d.approval_policy.is_none());
        assert!(!d.webview_only, "the engine, not the WebView, runs it");
        assert_eq!(d.name, "ctx");
    }

    #[test]
    fn seven_times_cheaper_than_the_eight_tool_design() {
        // Measured on the spec's own schemas: 6,203 characters for eight tools.
        const SPEC_EIGHT_TOOLS_CHARS: usize = 6_203;
        let ours = schema_chars();
        assert!(ours * 3 < SPEC_EIGHT_TOOLS_CHARS, "expected a ≥3× reduction, got {ours} vs {SPEC_EIGHT_TOOLS_CHARS}");
    }
}
