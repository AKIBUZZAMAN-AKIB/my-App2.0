//! Context assembly record and provider-overflow recovery (spec §4.3, §4.7,
//! §8.4 step 12).
//!
//! * `breakdown` splits the transcript that is about to be sent into token
//!   counts by source, so the `context.assembly` event (emitted before every
//!   model call, also for calls that then fail) says what took the space and
//!   why the memory block is there.
//! * When the provider rejects a request as too long although the estimate
//!   fitted (an estimated tokenizer, a smaller real window), the loop shrinks
//!   its transcript budget by `OVERFLOW_FACTORS` and runs the same overflow
//!   tiers again before retrying. Turn-based memory is not touched here, so
//!   overflow compaction and turn-based compaction stay separate.

use crate::tokens::TokenMeter;
use crate::types::{ContentBlock, Message, MessageContent, Role};

/// Budget factor for each retry after a provider overflow error. Two retries
/// at most, then the provider's error ends the turn as before.
pub(super) const OVERFLOW_FACTORS: [f64; 2] = [0.60, 0.35];

/// The transcript budget for this attempt.
pub(super) fn scaled_budget(budget: usize, overflow_retries: usize) -> usize {
    match overflow_retries {
        0 => budget,
        n => (budget as f64 * OVERFLOW_FACTORS[(n - 1).min(OVERFLOW_FACTORS.len() - 1)]).floor() as usize,
    }
}

/// True when a provider error says the request is longer than the model's
/// context window. Rate limits on tokens per minute are not overflow.
pub(super) fn is_context_overflow(error: &str) -> bool {
    let e = error.to_lowercase();
    if e.contains("per min") || e.contains("tpm") || e.contains("rate limit") || e.contains("rate_limit") || e.contains("quota") {
        return false;
    }
    const PHRASES: &[&str] = &[
        "context_length_exceeded",
        "maximum context length",
        "context length exceeded",
        "prompt is too long",
        "exceed context limit",
        "exceeds the context window",
        "exceeds the maximum number of tokens",
        "input is too long",
        "too many input tokens",
        "exceeds the available context size",
        "context size has been exceeded",
        "context window",
        "reduce the length of the messages",
        "string_above_max_length",
    ];
    PHRASES.iter().any(|p| e.contains(p))
}

const SESSION_SUMMARY_MARKER: &str = "[native-agent-session-summary-v1]";

fn starts_with_marker(text: &str, marker: &str) -> bool {
    text.trim_start().starts_with(marker)
}

fn is_reference(content: &str) -> bool {
    content.starts_with("[result #")
}

/// Token counts by source for the transcript about to be sent, with the
/// number of real user turns and whether a memory or session summary is in it.
pub(super) fn breakdown(messages: &[Message], meter: &TokenMeter) -> serde_json::Value {
    let (mut memory, mut session, mut user, mut assistant, mut calls, mut results, mut refs, mut thinking, mut images) = (0, 0, 0, 0, 0, 0, 0, 0, 0usize);
    let mut user_turns = 0usize;
    let mut reference_count = 0usize;
    for m in messages {
        match &m.content {
            MessageContent::Text(t) => {
                let n = meter.text(t);
                if starts_with_marker(t, crate::turn_memory::MEMORY_MARKER) {
                    memory += n;
                } else if starts_with_marker(t, SESSION_SUMMARY_MARKER) {
                    session += n;
                } else if m.role == Role::User {
                    user += n;
                    user_turns += 1;
                } else {
                    assistant += n;
                }
            }
            MessageContent::Blocks(bs) => {
                let mut counted_user = false;
                for b in bs {
                    match b {
                        ContentBlock::Text { text } => {
                            let n = meter.text(text);
                            if starts_with_marker(text, crate::turn_memory::MEMORY_MARKER) {
                                memory += n;
                            } else if starts_with_marker(text, SESSION_SUMMARY_MARKER) {
                                session += n;
                            } else if m.role == Role::User {
                                user += n;
                                if !counted_user {
                                    user_turns += 1;
                                    counted_user = true;
                                }
                            } else {
                                assistant += n;
                            }
                        }
                        ContentBlock::Thinking { thinking: t } => thinking += meter.text(t),
                        ContentBlock::ToolUse { name, input, .. } | ContentBlock::ServerToolUse { name, input, .. } => {
                            calls += meter.text(name) + meter.text(&input.to_string())
                        }
                        ContentBlock::ToolResult { content, .. } => {
                            if is_reference(content) {
                                refs += meter.text(content);
                                reference_count += 1;
                            } else {
                                results += meter.text(content);
                            }
                        }
                        ContentBlock::WebSearchToolResult { content, .. } => results += meter.text(&content.to_string()),
                        ContentBlock::Image { .. } => images += meter.message(&Message { role: m.role.clone(), content: MessageContent::Blocks(vec![b.clone()]) }),
                    }
                }
            }
        }
    }
    serde_json::json!({
        "bySource": {
            "memory": memory,
            "sessionSummary": session,
            "userText": user,
            "assistantText": assistant,
            "thinking": thinking,
            "toolCalls": calls,
            "toolResults": results,
            "toolResultReferences": refs,
            "images": images,
        },
        "messages": messages.len(),
        "userTurns": user_turns,
        "references": reference_count,
        "memoryPresent": memory > 0,
        "sessionSummaryPresent": session > 0,
    })
}

/// Version and last summarized turn of the memory block in the transcript,
/// read from the header `render` writes.
pub(super) fn memory_provenance(messages: &[Message]) -> (Option<u32>, Option<u32>) {
    for m in messages {
        if let MessageContent::Text(t) = &m.content {
            if starts_with_marker(t, crate::turn_memory::MEMORY_MARKER) {
                let num_after = |key: &str| t.find(key).and_then(|i| t[i + key.len()..].split(|c: char| !c.is_ascii_digit()).next().and_then(|d| d.parse().ok()));
                return (num_after("(version "), num_after("Turns 1-"));
            }
        }
    }
    (None, None)
}

/// Why the memory block is in the context, in words for the log and the UI.
pub(super) fn memory_reason(memory_present: bool, through_turn: Option<u32>) -> String {
    match (memory_present, through_turn) {
        (true, Some(n)) => format!("turns 1–{} are folded into chat memory; the summary and the decisions in force stand in for them", n),
        (true, None) => "chat memory summary present".into(),
        (false, _) => "no chat memory in this context".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_errors_of_each_provider_are_recognised_and_rate_limits_are_not() {
        for e in [
            "API error (400): This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens. (context_length_exceeded)",
            "API error (400): prompt is too long: 211000 tokens > 200000 maximum",
            "API error (400): input length and `max_tokens` exceed context limit: 198000 + 8192 > 200000",
            "API error (400): The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).",
            "API error (400): the request exceeds the available context size, try increasing it",
        ] {
            assert!(is_context_overflow(e), "{}", e);
        }
        for e in [
            "Rate limited, retry after 2000ms",
            "API error (429): Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 50000",
            "API error (401): invalid api key",
            "Network connection error: reset",
        ] {
            assert!(!is_context_overflow(e), "{}", e);
        }
    }

    #[test]
    fn each_retry_shrinks_the_budget_and_the_factor_stops_shrinking_after_two() {
        assert_eq!(scaled_budget(10_000, 0), 10_000);
        assert_eq!(scaled_budget(10_000, 1), 6_000);
        assert_eq!(scaled_budget(10_000, 2), 3_500);
        assert_eq!(scaled_budget(10_000, 3), 3_500);
    }

    #[test]
    fn breakdown_attributes_tokens_to_their_source() {
        let meter = TokenMeter::for_model("openai", "gpt-4o");
        let msgs = vec![
            Message::user(&format!("{}\nGoal: ship the parser", crate::turn_memory::MEMORY_MARKER)),
            Message::user("next question please"),
            Message::assistant_text("an answer"),
        ];
        let b = breakdown(&msgs, &meter);
        assert!(b["bySource"]["memory"].as_u64().unwrap() > 0);
        assert!(b["bySource"]["userText"].as_u64().unwrap() > 0);
        assert!(b["bySource"]["assistantText"].as_u64().unwrap() > 0);
        assert_eq!(b["userTurns"], 1);
        assert_eq!(b["memoryPresent"], true);
        assert_eq!(memory_reason(true, Some(40)).contains("1–40"), true);
        let mem = crate::turn_memory::TurnMemory { version: 7, through_turn: 40, ..Default::default() };
        let msgs = vec![Message { role: Role::Context, content: MessageContent::Text(crate::turn_memory::render(&mem)) }];
        assert_eq!(memory_provenance(&msgs), (Some(7), Some(40)));
        assert_eq!(memory_provenance(&[]), (None, None));
    }
}
