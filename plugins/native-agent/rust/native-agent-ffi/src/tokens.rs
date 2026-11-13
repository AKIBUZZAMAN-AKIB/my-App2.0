//! Token counting for context budgets.
//!
//! OpenAI-family models are counted exactly with their own BPE (o200k_base for
//! GPT-4o/4.1/5 and the o-series, cl100k_base for GPT-4/3.5, o200k_harmony for
//! gpt-oss) through `tiktoken-rs`. Other providers do not publish an offline
//! tokenizer, so their text is counted with o200k_base and multiplied by a
//! per-model factor. That factor starts from a cautious prior and is then
//! calibrated from the provider's own `usage.input_tokens` on every response,
//! so after the first turn the estimate tracks the provider's real count.

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
    key: String,
}

fn calibration() -> &'static Mutex<HashMap<String, f64>> {
    static CAL: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
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
            .and_then(|map| map.get(&key).copied());
        let (factor, calibrated) = match learned {
            Some(f) => (f, true),
            None if exact => (1.0, false),
            None => (UNKNOWN_TOKENIZER_PRIOR, false),
        };
        Self {
            encoding,
            exact,
            factor,
            calibrated,
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
    pub fn record_usage(&self, estimated: usize, actual: u64) {
        if estimated < 64 || actual == 0 {
            return;
        }
        let base = estimated as f64 / self.factor.max(0.01);
        let observed = (actual as f64 / base).clamp(0.5, 2.5);
        if let Ok(mut map) = calibration().lock() {
            let next = match map.get(&self.key) {
                Some(prev) => prev * 0.5 + observed * 0.5,
                None => observed,
            };
            map.insert(self.key.clone(), next);
        }
    }

    pub fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "encoding": self.encoding.name(),
            "exact": self.exact,
            "factor": (self.factor * 1000.0).round() / 1000.0,
            "calibrated": self.calibrated,
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
        system + messages + tools + 3
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
