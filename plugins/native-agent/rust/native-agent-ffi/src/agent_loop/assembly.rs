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

/// What a provider's overflow error says about the real window. Every field is
/// optional: providers word the error differently and some give no numbers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct OverflowLimits {
    /// The model's real context window, in the provider's tokens.
    pub context_limit: Option<u64>,
    /// The provider's own count of the rejected prompt (input) tokens.
    pub prompt_tokens: Option<u64>,
    /// True when `prompt_tokens` is only a lower bound (vLLM: "at least N").
    pub prompt_is_lower_bound: bool,
    /// Output tokens the request asked for, when the error names them.
    pub requested_output: Option<u64>,
}

/// The first unsigned integer within `window` bytes after `from`; digit
/// groups separated by `,` or `_` are joined ("32,768").
fn number_at(s: &str, from: usize, window: usize) -> Option<(u64, usize)> {
    let bytes = s.as_bytes();
    let end = (from + window).min(bytes.len());
    let mut i = from;
    while i < end && !bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i >= end {
        return None;
    }
    let mut value: u64 = 0;
    let mut j = i;
    while j < bytes.len() {
        let b = bytes[j];
        if b.is_ascii_digit() {
            value = value.checked_mul(10)?.checked_add((b - b'0') as u64)?;
            j += 1;
        } else if (b == b',' || b == b'_') && j + 1 < bytes.len() && bytes[j + 1].is_ascii_digit() {
            j += 1;
        } else {
            break;
        }
    }
    Some((value, j))
}

fn number_after(s: &str, phrase: &str, window: usize) -> Option<(u64, usize)> {
    let at = s.find(phrase)?;
    number_at(s, at + phrase.len(), window)
}

/// A window outside this range is a misread (an HTTP status, a byte count).
fn plausible_limit(value: u64) -> Option<u64> {
    (1_024..=100_000_000).contains(&value).then_some(value)
}

/// Reads the real context window (and, when given, the prompt size) out of a
/// provider's overflow error. Formats covered, each from the provider's own
/// error text:
///
/// * OpenAI / vLLM (OVHcloud AI Endpoints, many OpenAI-compatible hosts):
///   "This model's maximum context length is 32768 tokens. However, your
///   messages resulted in 54946 tokens" / "... your request has 40001 input
///   tokens" / "... you requested 40016 tokens (40000 in the messages, 16 in
///   the completion)" / "... your prompt contains at least 32769 input tokens".
/// * OpenRouter / Kilo gateway pass the upstream wording through in
///   `error.message` (often the OpenAI form above).
/// * Anthropic: "prompt is too long: 208310 tokens > 200000 maximum" and
///   "input length and `max_tokens` exceed context limit: 197901 + 8192 > 200000".
/// * Gemini: "The input token count (1196265) exceeds the maximum number of
///   tokens allowed (1048575)."
/// * llama.cpp server: "request (40000 tokens) exceeds the available context
///   size (32768 tokens)".
/// * Mistral: "Prompt contains 40000 tokens ... too large for model with 32768
///   maximum context length".
pub(crate) fn parse_overflow_limits(error: &str) -> OverflowLimits {
    let e = error.to_lowercase();
    let mut out = OverflowLimits::default();

    // OpenAI / vLLM family.
    if let Some((limit, _)) = number_after(&e, "maximum context length is", 24) {
        out.context_limit = plausible_limit(limit);
        if let Some((n, _)) = number_after(&e, "messages resulted in", 24) {
            out.prompt_tokens = Some(n);
        } else if let Some((n, _)) = number_after(&e, "contains at least", 24) {
            out.prompt_tokens = Some(n);
            out.prompt_is_lower_bound = true;
        } else if let Some((n, _)) = number_after(&e, "your request has", 24) {
            out.prompt_tokens = Some(n);
        }
        if let Some(at) = e.find("tokens (") {
            // "(40000 in the messages, 16 in the completion)"
            if let Some((n, next)) = number_at(&e, at + "tokens (".len(), 4) {
                if e[next..].trim_start().starts_with("in the messages") {
                    out.prompt_tokens = Some(n);
                    if let Some((c, _)) = number_at(&e, next, 40) {
                        out.requested_output = Some(c);
                    }
                }
            }
        }
        if out.requested_output.is_none() {
            if let Some((n, _)) = number_after(&e, "you requested", 24) {
                if e.contains("output tokens") {
                    out.requested_output = Some(n);
                }
            }
        }
        return out;
    }

    // Anthropic: "prompt is too long: 208310 tokens > 200000 maximum".
    if let Some((prompt, next)) = number_after(&e, "prompt is too long:", 12) {
        out.prompt_tokens = Some(prompt);
        if let Some(gt) = e[next..].find('>') {
            out.context_limit = number_at(&e, next + gt + 1, 12).and_then(|(n, _)| plausible_limit(n));
        }
        return out;
    }
    // Anthropic: "... exceed context limit: 197901 + 8192 > 200000".
    if let Some((prompt, next)) = number_after(&e, "exceed context limit:", 12) {
        out.prompt_tokens = Some(prompt);
        if let Some(plus) = e[next..].find('+') {
            if let Some((output, next2)) = number_at(&e, next + plus + 1, 12) {
                out.requested_output = Some(output);
                if let Some(gt) = e[next2..].find('>') {
                    out.context_limit = number_at(&e, next2 + gt + 1, 12).and_then(|(n, _)| plausible_limit(n));
                }
            }
        }
        return out;
    }
    // Gemini.
    if let Some((prompt, _)) = number_after(&e, "input token count", 8) {
        if let Some((limit, _)) = number_after(&e, "maximum number of tokens allowed", 8) {
            out.prompt_tokens = Some(prompt);
            out.context_limit = plausible_limit(limit);
            return out;
        }
    }
    // llama.cpp server.
    if let Some((limit, _)) = number_after(&e, "available context size", 8) {
        out.context_limit = plausible_limit(limit);
        out.prompt_tokens = number_after(&e, "request (", 4).map(|(n, _)| n);
        return out;
    }
    // Mistral.
    if let Some(at) = e.find("maximum context length") {
        // "... too large for model with 32768 maximum context length"
        let head = &e[..at];
        if let Some(with) = head.rfind("with ") {
            out.context_limit = number_at(&e, with + 5, 12).and_then(|(n, _)| plausible_limit(n));
        }
        out.prompt_tokens = number_after(&e, "prompt contains", 4).map(|(n, _)| n);
        return out;
    }
    out
}

/// Tokens kept free below a provider-reported window on top of the output
/// reserve: the app's estimate of an unknown tokenizer can still be off, so
/// keep 5% of the window (at least 1,024 tokens) unused.
pub(crate) fn learned_limit_margin(limit: u64) -> u64 {
    (limit / 20).max(1_024)
}

/// The transcript ceiling for the next attempt after an overflow. Always below
/// what was just rejected, so a retry can never resend the same request:
///
/// * with the provider's real window: `window − output − system/tools −
///   margin`, scaled down by how much the provider counted above our estimate;
/// * without it: the old factors, applied to what was actually sent (not to a
///   fallback budget that may be larger than the request).
pub(crate) fn overflow_retry_ceiling(
    limits: &OverflowLimits,
    sent_transcript_tokens: usize,
    reserved_input_tokens: usize,
    output_tokens: usize,
    attempt: usize,
) -> usize {
    let sent = sent_transcript_tokens.max(1);
    let fallback = scaled_budget(sent, attempt);
    let Some(limit) = limits.context_limit else {
        return fallback;
    };
    let limit = limit as usize;
    let margin = learned_limit_margin(limit as u64) as usize;
    let mut ceiling = limit
        .saturating_sub(output_tokens)
        .saturating_sub(reserved_input_tokens)
        .saturating_sub(margin);
    // The provider counted more than we did: shrink by the same ratio.
    let estimated_request = sent.saturating_add(reserved_input_tokens);
    if let Some(provider_count) = limits.prompt_tokens {
        let provider_count = provider_count as usize;
        if provider_count > estimated_request {
            ceiling = ((ceiling as f64) * (estimated_request as f64 / provider_count as f64)).floor() as usize;
        }
    }
    // Never above 95% of what was rejected; a later attempt keeps shrinking.
    let strictly_smaller = sent.saturating_mul(95) / 100;
    let ceiling = ceiling.min(strictly_smaller);
    if attempt >= 2 { ceiling.min(fallback) } else { ceiling }
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
    fn parses_real_windows_from_provider_overflow_errors() {
        // OVHcloud AI Endpoints (vLLM), body observed in the smoke run.
        let ovh = r#"API error (400): {"object":"error","message":"This model's maximum context length is 32768 tokens. However, your request has 40001 input tokens. Please reduce the length of the input messages.","type":"BadRequestError","param":null,"code":400}"#;
        let l = parse_overflow_limits(ovh);
        assert_eq!((l.context_limit, l.prompt_tokens, l.prompt_is_lower_bound), (Some(32_768), Some(40_001), false));
        let vllm_lb = "This model's maximum context length is 32768 tokens. However, your prompt contains at least 32769 input tokens, and you requested 16 output tokens.";
        let l = parse_overflow_limits(vllm_lb);
        assert_eq!((l.context_limit, l.prompt_tokens, l.prompt_is_lower_bound, l.requested_output), (Some(32_768), Some(32_769), true, Some(16)));
        let vllm_old = "This model's maximum context length is 32,768 tokens. However, you requested 40016 tokens (40000 in the messages, 16 in the completion).";
        let l = parse_overflow_limits(vllm_old);
        assert_eq!((l.context_limit, l.prompt_tokens, l.requested_output), (Some(32_768), Some(40_000), Some(16)));
        // OpenAI / OpenRouter / Kilo (OpenAI wording passed through).
        let openai = r#"{"error":{"message":"This model's maximum context length is 128000 tokens. However, your messages resulted in 130523 tokens. Please reduce the length of the messages.","code":"context_length_exceeded"}}"#;
        let l = parse_overflow_limits(openai);
        assert_eq!((l.context_limit, l.prompt_tokens), (Some(128_000), Some(130_523)));
        // Anthropic, both forms.
        let l = parse_overflow_limits(r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 208310 tokens > 200000 maximum"}}"#);
        assert_eq!((l.context_limit, l.prompt_tokens), (Some(200_000), Some(208_310)));
        let l = parse_overflow_limits("input length and `max_tokens` exceed context limit: 197901 + 8192 > 200000, decrease input length or `max_tokens` and try again");
        assert_eq!((l.context_limit, l.prompt_tokens, l.requested_output), (Some(200_000), Some(197_901), Some(8_192)));
        // Gemini.
        let l = parse_overflow_limits("The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).");
        assert_eq!((l.context_limit, l.prompt_tokens), (Some(1_048_575), Some(1_196_265)));
        // llama.cpp and Mistral.
        let l = parse_overflow_limits("request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it");
        assert_eq!((l.context_limit, l.prompt_tokens), (Some(32_768), Some(40_000)));
        let l = parse_overflow_limits("Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length");
        assert_eq!((l.context_limit, l.prompt_tokens), (Some(32_768), Some(40_000)));
        // No numbers: nothing learned, recovery falls back to factors.
        assert_eq!(parse_overflow_limits("context_length_exceeded"), OverflowLimits::default());
        // An HTTP status is not a window.
        assert_eq!(parse_overflow_limits("maximum context length is 400").context_limit, None);
    }

    #[test]
    fn retry_ceiling_comes_from_the_real_window_and_is_always_smaller() {
        // The smoke-test case: fallback budget 239,760 > request 54,946, real
        // window 32,768, provider says "at least 32,769".
        let limits = OverflowLimits { context_limit: Some(32_768), prompt_tokens: Some(32_769), prompt_is_lower_bound: true, requested_output: None };
        let c = overflow_retry_ceiling(&limits, 54_946, 0, 8_192, 1);
        assert_eq!(c, 32_768 - 8_192 - learned_limit_margin(32_768) as usize);
        assert!(c < 54_946);
        // The provider counted more than we did: shrink by that ratio too.
        let limits = OverflowLimits { context_limit: Some(32_768), prompt_tokens: Some(40_000), ..Default::default() };
        let c2 = overflow_retry_ceiling(&limits, 30_000, 1_000, 4_096, 1);
        let base = 32_768 - 4_096 - 1_000 - 1_638;
        assert_eq!(c2, (base as f64 * 31_000.0 / 40_000.0).floor() as usize);
        // Window bigger than the request (a stale catalog): still 95% of sent.
        let limits = OverflowLimits { context_limit: Some(1_000_000), ..Default::default() };
        assert_eq!(overflow_retry_ceiling(&limits, 10_000, 0, 1_000, 1), 9_500);
        // No window in the error: factors apply to what was sent, not to a
        // fallback budget larger than the request.
        assert_eq!(overflow_retry_ceiling(&OverflowLimits::default(), 54_946, 0, 8_192, 1), 32_967);
        assert_eq!(overflow_retry_ceiling(&OverflowLimits::default(), 54_946, 0, 8_192, 2), 19_231);
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
