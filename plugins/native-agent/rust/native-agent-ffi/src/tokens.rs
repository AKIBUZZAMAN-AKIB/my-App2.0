//! Token counting for context budgets.
//!
//! OpenAI-family models are counted exactly with their own BPE (o200k_base for
//! GPT-4o/4.1/5 and the o-series, cl100k_base for GPT-4/3.5, o200k_harmony for
//! gpt-oss) through `tiktoken-rs`. Other providers do not publish an offline
//! tokenizer, so their text is counted with o200k_base and multiplied by a
//! per-model factor. That factor starts from a cautious prior and is then
//! calibrated from the provider's own `usage.input_tokens` on every response,
//! so after the first turn the estimate tracks the provider's real count.
//!
//! Calibration is affine, `provider ≈ ratio × raw + overhead`: hosted models
//! add tokens the app never sees (chat template, tool-schema rendering, a
//! gateway's own system text), a fixed cost per request that a pure ratio
//! cannot represent. In the real-provider run (Kilo, nemotron) a ratio-only
//! factor swung between 0.57× and 1.30× of the provider's count from one
//! request to the next; the provider's counts fit 1.30 × raw + ~190.
//! The fit uses the last `CALIBRATION_SAMPLES` requests, is bounded, and is
//! the upper envelope of what was seen (it never predicts less than the
//! provider reported for a request it has seen).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tiktoken_rs::tokenizer::{get_tokenizer, Tokenizer};
use tiktoken_rs::{cl100k_base_singleton, o200k_base_singleton, o200k_harmony_singleton, CoreBPE};

use crate::types::{ContentBlock, Message, MessageContent, Role, ToolDefinition};

/// Framing tokens per chat message (role markers and separators). OpenAI's
/// published counting recipe uses 3 per message plus 3 to prime the reply.
pub const TOKENS_PER_MESSAGE: usize = 4;
/// Framing per content block (tool call wrapper, ids, JSON keys).
pub const TOKENS_PER_BLOCK: usize = 8;
/// Framing per tool schema beyond its name, description and JSON schema text.
pub const TOKENS_PER_TOOL: usize = 12;
/// An image without its pixel size: providers bill roughly 1–1.6k tokens for a
/// typical phone screenshot after downscaling; keep the higher end.
pub const TOKENS_PER_IMAGE: usize = 1_600;
/// Prior factor for providers without a public offline tokenizer, applied to
/// the o200k count until the provider's reported usage calibrates it.
pub const UNKNOWN_TOKENIZER_PRIOR: f64 = 1.15;
/// Requests kept per provider/model for the calibration fit.
pub const CALIBRATION_SAMPLES: usize = 8;
/// Bounds of the calibrated ratio and per-request overhead.
pub const CALIBRATION_RATIO_BOUNDS: (f64, f64) = (0.5, 2.5);
pub const CALIBRATION_MAX_OVERHEAD: f64 = 4_096.0;

#[derive(Debug, Clone, Default)]
struct Calibration {
    /// (raw count, provider count) of recent requests, oldest first.
    samples: Vec<(f64, f64)>,
    ratio: f64,
    overhead: f64,
}

impl Calibration {
    fn push(&mut self, raw: f64, actual: f64) {
        self.samples.push((raw, actual));
        if self.samples.len() > CALIBRATION_SAMPLES {
            self.samples.remove(0);
        }
        let (lo, hi) = CALIBRATION_RATIO_BOUNDS;
        let n = self.samples.len() as f64;
        let min_raw = self.samples.iter().map(|s| s.0).fold(f64::MAX, f64::min);
        let max_raw = self.samples.iter().map(|s| s.0).fold(0.0, f64::max);
        if self.samples.len() >= 2 && max_raw >= min_raw * 1.25 {
            // Least-squares slope over requests of different sizes, then the
            // smallest overhead under which no seen request is underestimated.
            let mx = self.samples.iter().map(|s| s.0).sum::<f64>() / n;
            let my = self.samples.iter().map(|s| s.1).sum::<f64>() / n;
            let sxx: f64 = self.samples.iter().map(|s| (s.0 - mx).powi(2)).sum();
            let sxy: f64 = self.samples.iter().map(|s| (s.0 - mx) * (s.1 - my)).sum();
            let ratio = (sxy / sxx).clamp(lo, hi);
            let overhead = self
                .samples
                .iter()
                .map(|s| s.1 - ratio * s.0)
                .fold(0.0, f64::max);
            self.ratio = ratio;
            self.overhead = overhead.clamp(0.0, CALIBRATION_MAX_OVERHEAD);
            // Overhead hit its cap: put the rest into the ratio.
            let short = self
                .samples
                .iter()
                .map(|s| (s.1 - self.overhead) / s.0.max(1.0))
                .fold(0.0, f64::max);
            if short > self.ratio {
                self.ratio = short.clamp(lo, hi);
            }
        } else {
            // One size seen so far: a ratio that covers every sample.
            self.ratio = self
                .samples
                .iter()
                .map(|s| s.1 / s.0.max(1.0))
                .fold(0.0, f64::max)
                .clamp(lo, hi);
            self.overhead = 0.0;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    O200k,
    O200kHarmony,
    Cl100k,
}

impl Encoding {
    pub fn name(self) -> &'static str {
        match self {
            Encoding::O200k => "o200k_base",
            Encoding::O200kHarmony => "o200k_harmony",
            Encoding::Cl100k => "cl100k_base",
        }
    }
    fn bpe(self) -> &'static CoreBPE {
        match self {
            Encoding::O200k => o200k_base_singleton(),
            Encoding::O200kHarmony => o200k_harmony_singleton(),
            Encoding::Cl100k => cl100k_base_singleton(),
        }
    }
}

/// How one provider/model is counted.
#[derive(Debug, Clone)]
pub struct TokenMeter {
    pub encoding: Encoding,
    /// True when `encoding` is the model's own tokenizer.
    pub exact: bool,
    /// Multiplier applied to raw counts (1.0 when exact and uncalibrated).
    pub factor: f64,
    /// True when `factor` comes from the provider's reported usage.
    pub calibrated: bool,
    /// Tokens the provider adds to every request that the app never sees
    /// (learned; 0 until two requests of different sizes were answered).
    pub overhead: usize,
    key: String,
}

fn calibration() -> &'static Mutex<HashMap<String, Calibration>> {
    static CAL: OnceLock<Mutex<HashMap<String, Calibration>>> = OnceLock::new();
    CAL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The bare model id: `openai/gpt-4o-mini` → `gpt-4o-mini`.
fn bare_model(model: &str) -> &str {
    model.rsplit('/').next().unwrap_or(model).trim()
}

fn openai_tokenizer(provider: &str, model: &str) -> Option<Encoding> {
    let bare = bare_model(model).to_ascii_lowercase();
    let vendor_is_openai = model.to_ascii_lowercase().starts_with("openai/")
        || matches!(
            provider,
            "openai" | "openai-responses" | "azure" | "azure-openai"
        );
    let looks_openai = bare.starts_with("gpt-")
        || bare.starts_with("chatgpt-")
        || bare.starts_with("codex")
        || bare.starts_with("o1")
        || bare.starts_with("o3")
        || bare.starts_with("o4");
    if !(vendor_is_openai || looks_openai) {
        return None;
    }
    match get_tokenizer(&bare) {
        Some(Tokenizer::O200kBase) => Some(Encoding::O200k),
        Some(Tokenizer::O200kHarmony) => Some(Encoding::O200kHarmony),
        Some(Tokenizer::Cl100kBase) => Some(Encoding::Cl100k),
        _ if vendor_is_openai => Some(Encoding::O200k),
        _ => None,
    }
}

impl TokenMeter {
    pub fn for_model(provider: &str, model: &str) -> Self {
        let provider = provider.trim().to_ascii_lowercase();
        let key = format!("{}/{}", provider, model.trim());
        let (encoding, exact) = match openai_tokenizer(&provider, model) {
            Some(enc) => (enc, true),
            None => (Encoding::O200k, false),
        };
        let learned = calibration()
            .lock()
            .ok()
            .and_then(|map| map.get(&key).map(|c| (c.ratio, c.overhead)));
        let (factor, overhead, calibrated) = match learned {
            Some((f, o)) => (f, o.ceil() as usize, true),
            None if exact => (1.0, 0, false),
            None => (UNKNOWN_TOKENIZER_PRIOR, 0, false),
        };
        Self {
            encoding,
            exact,
            factor,
            calibrated,
            overhead,
            key,
        }
    }

    /// Raw BPE count of one string, before the factor.
    pub fn raw(&self, text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }
        self.encoding.bpe().encode_ordinary(text).len()
    }

    fn scale(&self, raw: usize) -> usize {
        if (self.factor - 1.0).abs() < f64::EPSILON {
            raw
        } else {
            (raw as f64 * self.factor).ceil() as usize
        }
    }

    pub fn text(&self, text: &str) -> usize {
        self.scale(self.raw(text))
    }

    fn raw_message(&self, message: &Message) -> usize {
        TOKENS_PER_MESSAGE
            + match &message.content {
                MessageContent::Text(t) => self.raw(t),
                MessageContent::Blocks(blocks) => blocks
                    .iter()
                    .map(|b| {
                        TOKENS_PER_BLOCK
                            + match b {
                                ContentBlock::Text { text } => self.raw(text),
                                ContentBlock::Thinking { thinking } => self.raw(thinking),
                                ContentBlock::ToolResult { content, .. } => self.raw(content),
                                ContentBlock::ToolUse { name, input, .. } => {
                                    self.raw(name) + self.raw(&input.to_string())
                                }
                                ContentBlock::ServerToolUse { name, input, .. } => {
                                    self.raw(name) + self.raw(&input.to_string())
                                }
                                ContentBlock::WebSearchToolResult { content, .. } => {
                                    self.raw(&content.to_string())
                                }
                                ContentBlock::Image { .. } => TOKENS_PER_IMAGE,
                            }
                    })
                    .sum::<usize>(),
            }
    }

    pub fn message(&self, message: &Message) -> usize {
        self.scale(self.raw_message(message))
    }

    pub fn messages(&self, messages: &[Message]) -> usize {
        messages
            .iter()
            .map(|m| self.message(m))
            .fold(0usize, usize::saturating_add)
    }

    pub fn tools(&self, tools: &[ToolDefinition]) -> usize {
        self.scale(
            tools
                .iter()
                .map(|t| {
                    TOKENS_PER_TOOL
                        + self.raw(&t.name)
                        + self.raw(&t.description)
                        + self.raw(&t.input_schema.to_string())
                })
                .sum(),
        )
    }

    /// Learn this model's real ratio from a response: `estimated` is what this
    /// meter counted for the request, `actual` the provider's input tokens.
    /// Smoothed, and bounded so one odd response cannot swing the budget.
    ///
    /// `estimated` is what this meter returned for the whole request,
    /// including `request_overhead()`.
    pub fn record_usage(&self, estimated: usize, actual: u64) {
        if estimated < 64 || actual == 0 {
            return;
        }
        let raw = estimated.saturating_sub(self.overhead) as f64 / self.factor.max(0.01);
        if raw < 1.0 {
            return;
        }
        if let Ok(mut map) = calibration().lock() {
            map.entry(self.key.clone())
                .or_default()
                .push(raw, actual as f64);
        }
    }

    /// Tokens the provider adds once per request (see `overhead`).
    pub fn request_overhead(&self) -> usize {
        self.overhead
    }

    pub fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "encoding": self.encoding.name(),
            "exact": self.exact,
            "factor": (self.factor * 1000.0).round() / 1000.0,
            "calibrated": self.calibrated,
            "overheadTokens": self.overhead,
            "method": if self.exact && !self.calibrated { "exact" } else if self.calibrated { "calibrated" } else { "estimate" },
        })
    }
}

/// Input of `count_tokens`: plain strings, and/or a chat request.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct CountInput {
    pub texts: Vec<String>,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
}

/// Offline count for the given provider/model.
pub fn count_offline(provider: &str, model: &str, input: &CountInput) -> serde_json::Value {
    let meter = TokenMeter::for_model(provider, model);
    let texts: Vec<usize> = input.texts.iter().map(|t| meter.text(t)).collect();
    let system = input.system.as_deref().map(|s| meter.text(s)).unwrap_or(0);
    let messages = meter.messages(&input.messages);
    let tools = meter.tools(&input.tools);
    let request = if input.messages.is_empty() && input.system.is_none() && input.tools.is_empty() {
        0
    } else {
        system + messages + tools + 3 + meter.request_overhead()
    };
    serde_json::json!({
        "tokens": texts.iter().sum::<usize>() + request,
        "texts": texts,
        "system": system,
        "messages": messages,
        "tools": tools,
        "tokenizer": meter.describe(),
        "method": meter.describe()["method"],
    })
}

fn plain_text(message: &Message) -> String {
    match &message.content {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                ContentBlock::ToolResult { content, .. } => Some(content.clone()),
                ContentBlock::ToolUse { input, .. } => Some(input.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// Ask the provider's own count endpoint (free, no generation):
/// Anthropic `POST /v1/messages/count_tokens`, Gemini `POST
/// /models/{model}:countTokens`. Returns `Ok(None)` for providers without one.
pub async fn count_with_provider(
    provider: &str,
    model: &str,
    base_url: &str,
    api_key: &str,
    input: &CountInput,
) -> Result<Option<u64>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut messages: Vec<(String, String)> = input
        .messages
        .iter()
        .map(|m| {
            (
                if matches!(m.role, Role::Assistant) {
                    "assistant".to_string()
                } else {
                    "user".to_string()
                },
                plain_text(m),
            )
        })
        .filter(|(_, t)| !t.is_empty())
        .collect();
    for t in &input.texts {
        messages.push(("user".into(), t.clone()));
    }
    if messages.is_empty() {
        messages.push(("user".into(), " ".into()));
    }
    let base = base_url.trim_end_matches('/');
    match provider {
        "anthropic" => {
            let url = if base.ends_with("/v1") {
                format!("{base}/messages/count_tokens")
            } else {
                format!("{base}/v1/messages/count_tokens")
            };
            let mut body = serde_json::json!({
                "model": model,
                "messages": messages.iter().map(|(r, t)| serde_json::json!({ "role": if r == "assistant" { "assistant" } else { "user" }, "content": t })).collect::<Vec<_>>(),
            });
            if let Some(system) = input.system.as_ref().filter(|s| !s.is_empty()) {
                body["system"] = serde_json::json!(system);
            }
            if !input.tools.is_empty() {
                body["tools"] = serde_json::json!(input.tools.iter().map(|t| serde_json::json!({ "name": t.name, "description": t.description, "input_schema": t.input_schema })).collect::<Vec<_>>());
            }
            let res = client
                .post(url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = res.status();
            let value: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!(
                    "HTTP {}: {}",
                    status.as_u16(),
                    value["error"]["message"]
                        .as_str()
                        .unwrap_or("count_tokens failed")
                ));
            }
            value["input_tokens"]
                .as_u64()
                .map(Some)
                .ok_or_else(|| "no input_tokens in response".into())
        }
        "gemini" | "google" => {
            let bare = model.trim_start_matches("models/");
            let url = format!("{base}/models/{bare}:countTokens");
            let mut contents: Vec<serde_json::Value> = Vec::new();
            if let Some(system) = input.system.as_ref().filter(|s| !s.is_empty()) {
                contents.push(serde_json::json!({ "role": "user", "parts": [{ "text": system }] }));
            }
            for (r, t) in &messages {
                contents.push(serde_json::json!({ "role": if r == "assistant" { "model" } else { "user" }, "parts": [{ "text": t }] }));
            }
            let res = client
                .post(url)
                .header("x-goog-api-key", api_key)
                .json(&serde_json::json!({ "contents": contents }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = res.status();
            let value: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!(
                    "HTTP {}: {}",
                    status.as_u16(),
                    value["error"]["message"]
                        .as_str()
                        .unwrap_or("countTokens failed")
                ));
            }
            value["totalTokens"]
                .as_u64()
                .map(Some)
                .ok_or_else(|| "no totalTokens in response".into())
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_models_use_their_own_encoding() {
        assert_eq!(
            TokenMeter::for_model("openai", "gpt-4o-mini").encoding,
            Encoding::O200k
        );
        assert!(TokenMeter::for_model("openai", "gpt-5").exact);
        assert_eq!(
            TokenMeter::for_model("openai", "gpt-4").encoding,
            Encoding::Cl100k
        );
        assert_eq!(
            TokenMeter::for_model("openrouter", "openai/gpt-4.1").encoding,
            Encoding::O200k
        );
        assert!(TokenMeter::for_model("openrouter", "openai/gpt-4.1").exact);
        assert!(!TokenMeter::for_model("anthropic", "claude-sonnet-4-5").exact);
    }

    #[test]
    fn exact_counts_match_the_reference_tokenizer() {
        let m = TokenMeter::for_model("openai", "gpt-4o");
        // tiktoken o200k_base: "hello world" → [24912, 2375]
        assert_eq!(m.text("hello world"), 2);
        let c = TokenMeter::for_model("openai", "gpt-4");
        // cl100k_base: "hello world" → [15339, 1917]
        assert_eq!(c.text("hello world"), 2);
        assert_eq!(m.text(""), 0);
    }

    #[test]
    fn unknown_tokenizers_start_cautious_and_learn_from_usage() {
        let model = format!("test-model-{}", uuid::Uuid::new_v4());
        let m = TokenMeter::for_model("anthropic", &model);
        assert!(!m.calibrated);
        let raw = m.raw(&"word ".repeat(400));
        assert_eq!(
            m.text(&"word ".repeat(400)),
            (raw as f64 * UNKNOWN_TOKENIZER_PRIOR).ceil() as usize
        );
        // Provider reports 30% more than the raw o200k count.
        m.record_usage(m.text(&"word ".repeat(400)), (raw as f64 * 1.3) as u64);
        let learned = TokenMeter::for_model("anthropic", &model);
        assert!(learned.calibrated);
        assert!(
            (learned.factor - 1.3).abs() < 0.02,
            "factor {}",
            learned.factor
        );
    }

    /// The real-provider run (Kilo, nemotron): provider counts for seven
    /// requests against their raw o200k counts. Ratio-only calibration
    /// oscillated (0.57×–1.30×); the affine fit tracks every request within
    /// a few percent and never underestimates one it has seen.
    #[test]
    fn affine_calibration_tracks_a_fixed_per_request_overhead() {
        let model = format!("nemotron-{}", uuid::Uuid::new_v4());
        let seen: [(usize, u64); 7] = [
            (439, 757),
            (463, 794),
            (583, 937),
            (623, 964),
            (2219, 2911),
            (2285, 3004),
            (2373, 3280),
        ];
        let mut worst_before: f64 = 0.0;
        let mut worst_after: f64 = 0.0;
        for (i, (raw, actual)) in seen.iter().enumerate() {
            let m = TokenMeter::for_model("kilo", &model);
            let estimate = (*raw as f64 * m.factor).ceil() as usize + m.request_overhead();
            let ratio = estimate as f64 / *actual as f64;
            if i >= 2 {
                worst_after = worst_after.max((1.0 - ratio).abs());
            } else {
                worst_before = worst_before.max((1.0 - ratio).abs());
            }
            m.record_usage(estimate, *actual);
        }
        let m = TokenMeter::for_model("kilo", &model);
        assert!(m.calibrated && m.overhead > 0, "{:?}", m.describe());
        assert!((1.2..1.45).contains(&m.factor), "{:?}", m.describe());
        for (raw, actual) in seen {
            let estimate = (raw as f64 * m.factor).ceil() as usize + m.request_overhead();
            assert!(
                estimate as u64 >= actual,
                "never under: {estimate} < {actual}"
            );
            assert!(
                (estimate as f64) < actual as f64 * 1.20,
                "close: {estimate} vs {actual}"
            );
        }
        // After two different sizes the error stays small (was up to 43 %).
        eprintln!("relative error: first two {worst_before:.3}, after {worst_after:.3}");
        assert!(
            worst_after < 0.25,
            "worst relative error after calibration {worst_after}"
        );
    }

    #[test]
    fn calibration_is_bounded() {
        let model = format!("odd-{}", uuid::Uuid::new_v4());
        let m = TokenMeter::for_model("kilo", &model);
        m.record_usage(1_000, 100_000); // absurd: ratio clamps to 2.5
        let m = TokenMeter::for_model("kilo", &model);
        assert!(m.factor <= CALIBRATION_RATIO_BOUNDS.1 + 1e-9);
        assert_eq!(m.overhead, 0);
        for i in 0..20 {
            let m = TokenMeter::for_model("kilo", &model);
            let raw = 1_000 + i * 500;
            m.record_usage(
                (raw as f64 * m.factor) as usize + m.overhead,
                (raw + 50_000) as u64,
            );
        }
        let m = TokenMeter::for_model("kilo", &model);
        assert!(m.overhead as f64 <= CALIBRATION_MAX_OVERHEAD);
        assert!(m.factor <= CALIBRATION_RATIO_BOUNDS.1 + 1e-9);
    }

    #[test]
    fn count_offline_reports_parts_and_method() {
        let input: CountInput = serde_json::from_str(r#"{"texts":["hello world"],"system":"be brief","messages":[{"role":"user","content":"hi"}]}"#).unwrap();
        let out = count_offline("openai", "gpt-4o", &input);
        assert_eq!(out["texts"][0], 2);
        assert_eq!(out["method"], "exact");
        assert!(out["tokens"].as_u64().unwrap() > 2);
    }

    #[test]
    fn bengali_text_is_counted_by_bpe_not_characters() {
        let m = TokenMeter::for_model("openai", "gpt-4o");
        let text = "আমি বাংলায় কথা বলি";
        let n = m.text(text);
        assert!(
            n > 0 && n < text.chars().count(),
            "{} tokens for {} chars",
            n,
            text.chars().count()
        );
    }
}
