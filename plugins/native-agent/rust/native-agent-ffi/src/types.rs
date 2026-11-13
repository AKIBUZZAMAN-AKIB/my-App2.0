//! Types exposed via UniFFI to Kotlin/Swift.
//!
//! These mirror the JS types from mobile-claw (auth-store, cron-db-access, etc.)
//! and the openfang message types.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Configuration for initializing the native agent handle.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct InitConfig {
    /// Path to the SQLite database.
    pub db_path: String,
    /// Path to the workspace root.
    pub workspace_path: String,
    /// Path to auth-profiles.json.
    pub auth_profiles_path: String,
}

/// Parameters for sending a message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct SendMessageParams {
    pub prompt: String,
    pub session_key: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub system_prompt: String,
    pub max_turns: Option<u32>,
    /// JSON-encoded list of allowed tool names. `None` means unrestricted; `[]` means no tools.
    pub allowed_tools_json: Option<String>,
    /// JSON-encoded prior conversation messages for multi-turn sessions.
    pub prior_messages_json: Option<String>,
    /// JSON-encoded attachments for this prompt (multimodal input). An array of
    /// `{ "type": "image", "mediaType": "image/png", "data": "<base64>" }` or
    /// `{ "type": "text", "name": "notes.md", "text": "..." }`. `None` (the
    /// default, so older callers keep compiling) sends a text-only prompt.
    #[uniffi(default = None)]
    pub attachments_json: Option<String>,
}

/// Auth token result.
#[derive(Debug, Clone, uniffi::Record)]
pub struct AuthTokenResult {
    pub api_key: Option<String>,
    pub is_oauth: bool,
}

/// Auth status result.
#[derive(Debug, Clone, uniffi::Record)]
pub struct AuthStatusResult {
    pub has_key: bool,
    pub masked: String,
    pub provider: String,
}

/// Token usage from an agent turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize, uniffi::Record)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
}

/// Buffered event emitted while no foreground callback is attached.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct PendingEvent {
    pub id: i64,
    pub event_type: String,
    pub payload_json: String,
    pub created_at: i64,
}

// ── Internal types (not UniFFI-exported, used by agent loop) ──

/// Role in a conversation message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    /// Internal session context (such as a rolling summary). Provider adapters
    /// send it as user content, never as elevated system instructions.
    Context,
    User,
    Assistant,
}

/// Content block in a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
        /// Protocol metadata required to replay provider-native calls (for
        /// example Gemini 3 `thoughtSignature`/function-call IDs).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<serde_json::Value>,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "server_tool_use")]
    ServerToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "web_search_tool_result")]
    WebSearchToolResult {
        tool_use_id: String,
        content: serde_json::Value, // encrypted — preserve for multi-turn citations
    },
    /// Inline image input from the user (base64, no data: prefix).
    #[serde(rename = "image")]
    Image { media_type: String, data: String },
}

/// Message content — simple text or structured blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

/// A conversation message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: MessageContent,
}

impl Message {
    pub fn user(text: &str) -> Self {
        Self {
            role: Role::User,
            content: MessageContent::Text(text.to_string()),
        }
    }

    /// A user prompt with inline attachments (images and/or text files).
    /// Text comes first so providers that read the first block as the
    /// "question" still see it; an empty prompt with attachments is allowed.
    pub fn user_with_attachments(text: &str, attachments: Vec<ContentBlock>) -> Self {
        if attachments.is_empty() {
            return Self::user(text);
        }
        let mut blocks = Vec::with_capacity(attachments.len() + 1);
        if !text.trim().is_empty() {
            blocks.push(ContentBlock::Text { text: text.to_string() });
        }
        blocks.extend(attachments);
        Self {
            role: Role::User,
            content: MessageContent::Blocks(blocks),
        }
    }

    /// True for a prompt the user (or a scheduled wake) typed: user-role text or
    /// image content. Tool-result carriers share the user role in the
    /// Anthropic transcript shape and are NOT prompts.
    pub fn is_user_prompt(&self) -> bool {
        if self.role != Role::User {
            return false;
        }
        match &self.content {
            MessageContent::Text(_) => true,
            MessageContent::Blocks(blocks) => {
                !blocks.iter().any(|b| matches!(b, ContentBlock::ToolResult { .. }))
                    && blocks.iter().any(|b| matches!(b, ContentBlock::Text { .. } | ContentBlock::Image { .. }))
            }
        }
    }

    pub fn assistant_text(text: &str) -> Self {
        Self {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::Text {
                text: text.to_string(),
            }]),
        }
    }

    pub fn assistant_blocks(blocks: Vec<ContentBlock>) -> Self {
        Self {
            role: Role::Assistant,
            content: MessageContent::Blocks(blocks),
        }
    }

    pub fn tool_result(tool_use_id: &str, content: &str, is_error: bool) -> Self {
        Self {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content: content.to_string(),
                is_error,
            }]),
        }
    }

    /// Extract text from assistant message content blocks.
    pub fn text(&self) -> String {
        match &self.content {
            MessageContent::Text(t) => t.clone(),
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        }
    }
}

/// Why the model stopped generating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
}

/// Tool definition for the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    #[serde(default)]
    pub webview_only: bool,
    /// Consumer-owned approval policy synced from WebView.
    /// "always_allow" | "always_ask" | "always_ask_biometric"
    #[serde(default)]
    pub approval_policy: Option<String>,
}

/// A tool call from the LLM response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// In-memory state for the current interactive session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_key: String,
    pub agent_id: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: String,
    pub max_turns: Option<u32>,
    pub allowed_tools_json: Option<String>,
    pub messages: Vec<Message>,
}

impl SessionState {
    pub fn to_params(&self, prompt: String) -> SendMessageParams {
        SendMessageParams {
            prompt,
            session_key: self.session_key.clone(),
            model: self.model.clone(),
            provider: self.provider.clone(),
            system_prompt: self.system_prompt.clone(),
            max_turns: self.max_turns,
            allowed_tools_json: self.allowed_tools_json.clone(),
            prior_messages_json: None,
            attachments_json: None,
        }
    }
}

/// Response payload for a pending tool approval request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub tool_call_id: String,
    pub approved: bool,
    pub reason: Option<String>,
    /// Arguments the user edited before approving. When set (and approved),
    /// the tool runs with these instead of the model's original arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_args: Option<serde_json::Value>,
}

/// Result payload returned from a JS-hosted MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    pub result_json: String,
    pub is_error: bool,
}

/// Per-skill execution state tracked by the native handle.
#[derive(Debug, Clone)]
pub struct SkillSession {
    pub session_key: String,
    pub abort_flag: Arc<Mutex<bool>>,
}

pub type SkillSessions = HashMap<String, SkillSession>;

// ── Display types (provider-agnostic, UI-facing contract) ──

/// A tool call in the canonical display format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// A tool result in the canonical display format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayToolResult {
    pub tool_call_id: String,
    pub output: String,
    #[serde(default)]
    pub is_error: bool,
}

/// Provider-agnostic message for UI rendering and caching.
///
/// Every LLM driver (Anthropic, OpenAI, Gemini, etc.) converts its native
/// response into this flat format. Everything downstream — bridge events,
/// JS composables, SQLite cache — only ever sees `DisplayMessage`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayMessage {
    pub role: String,
    pub text: String,
    /// Provider-supplied working/reasoning text, separate from the final answer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thinking: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<DisplayToolCall>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_results: Vec<DisplayToolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    pub timestamp: i64,
    pub sequence: u32,
}

impl DisplayMessage {
    /// Convert internal `Message` array (provider-specific) into canonical `DisplayMessage` array.
    pub fn from_messages(
        msgs: &[Message],
        model: Option<&str>,
        usage: Option<&TokenUsage>,
        base_timestamp: i64,
    ) -> Vec<Self> {
        let mut result = Vec::with_capacity(msgs.len());
        let now = base_timestamp;
        // Usage describes the latest completed agent turn, not every assistant
        // message in the full session transcript. Attach it once, to the newest
        // assistant message, so restored history does not duplicate totals.
        let last_assistant_index = msgs.iter().rposition(|msg| msg.role == Role::Assistant);

        for (i, msg) in msgs.iter().enumerate() {
            let role = match msg.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::System | Role::Context => continue, // internal messages are not displayed
            };

            match &msg.content {
                MessageContent::Text(t) => {
                    result.push(DisplayMessage {
                        role: role.to_string(),
                        text: t.clone(),
                        thinking: String::new(),
                        tool_calls: Vec::new(),
                        tool_results: Vec::new(),
                        model: if Some(i) == last_assistant_index { model.map(|s| s.to_string()) } else { None },
                        usage: if Some(i) == last_assistant_index { usage.cloned() } else { None },
                        timestamp: now,
                        sequence: i as u32,
                    });
                }
                MessageContent::Blocks(blocks) => {
                    let text: String = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("");
                    let image_count = blocks
                        .iter()
                        .filter(|b| matches!(b, ContentBlock::Image { .. }))
                        .count();
                    // Image payloads are never replayed to the UI (they can be
                    // megabytes); a short marker keeps the history honest.
                    let text = match image_count {
                        0 => text,
                        n => {
                            let marker = if n == 1 { "[1 image attached]".to_string() } else { format!("[{n} images attached]") };
                            if text.is_empty() { marker } else { format!("{text}\n\n{marker}") }
                        }
                    };

                    let thinking: String = blocks
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Thinking { thinking } => Some(thinking.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");

                    let tool_calls: Vec<DisplayToolCall> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolUse { id, name, input, .. }
                            | ContentBlock::ServerToolUse { id, name, input } => Some(DisplayToolCall {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                            }),
                            _ => None,
                        })
                        .collect();

                    let tool_results: Vec<DisplayToolResult> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
                            } => Some(DisplayToolResult {
                                tool_call_id: tool_use_id.clone(),
                                output: content.clone(),
                                is_error: *is_error,
                            }),
                            ContentBlock::WebSearchToolResult { tool_use_id, content } => Some(DisplayToolResult {
                                tool_call_id: tool_use_id.clone(),
                                output: content.to_string(),
                                is_error: false,
                            }),
                            _ => None,
                        })
                        .collect();

                    result.push(DisplayMessage {
                        role: role.to_string(),
                        text,
                        thinking,
                        tool_calls,
                        tool_results,
                        model: if Some(i) == last_assistant_index { model.map(|s| s.to_string()) } else { None },
                        usage: if Some(i) == last_assistant_index { usage.cloned() } else { None },
                        timestamp: now,
                        sequence: i as u32,
                    });
                }
            }
        }

        result
    }
}

#[cfg(test)]
mod round_trip_tests {
    use super::*;

    /// Messages are persisted as JSON and reloaded on resume. If a block type
    /// fails to round-trip, `load_session_messages_raw` silently falls back to
    /// stuffing the raw JSON into a Text block — the transcript is then
    /// corrupt AND the API rejects it (unmatched tool_use). Every variant must
    /// survive a save/load cycle intact.
    #[test]
    fn every_content_block_survives_a_json_round_trip() {
        let blocks = vec![
            ContentBlock::Text { text: "hello আমি 🇧🇩".into() },
            ContentBlock::ToolUse {
                id: "toolu_1".into(),
                name: "read_file".into(),
                input: serde_json::json!({"path": "a.txt", "n": 3}),
                provider_metadata: None,
            },
            ContentBlock::ToolResult {
                tool_use_id: "toolu_1".into(),
                content: "file body".into(),
                is_error: false,
            },
            ContentBlock::Thinking { thinking: "reasoning".into() },
            ContentBlock::ServerToolUse {
                id: "srv_1".into(),
                name: "web_search".into(),
                input: serde_json::json!({"query": "x"}),
            },
            ContentBlock::WebSearchToolResult {
                tool_use_id: "srv_1".into(),
                content: serde_json::json!([{"title": "t"}]),
            },
        ];

        for block in blocks {
            let json = serde_json::to_string(&block).unwrap();
            let back: ContentBlock = serde_json::from_str(&json)
                .unwrap_or_else(|e| panic!("{json} failed to round-trip: {e}"));
            assert_eq!(
                serde_json::to_string(&back).unwrap(),
                json,
                "re-serialising must be stable"
            );
        }
    }

    /// `MessageContent` is `#[serde(untagged)]`, which picks the first variant
    /// that deserialises. A Blocks payload must NOT be mistaken for Text and
    /// vice versa — that is exactly how a tool call turns into garbage text.
    #[test]
    fn message_content_variants_do_not_collide() {
        let text = MessageContent::Text("plain".into());
        let json = serde_json::to_string(&text).unwrap();
        assert!(
            matches!(
                serde_json::from_str::<MessageContent>(&json).unwrap(),
                MessageContent::Text(t) if t == "plain"
            ),
            "text must stay text"
        );

        let blocks = MessageContent::Blocks(vec![ContentBlock::ToolUse {
            id: "toolu_9".into(),
            name: "bash".into(),
            input: serde_json::json!({}),
            provider_metadata: None,
        }]);
        let json = serde_json::to_string(&blocks).unwrap();
        match serde_json::from_str::<MessageContent>(&json).unwrap() {
            MessageContent::Blocks(b) => {
                assert_eq!(b.len(), 1);
                assert!(matches!(&b[0], ContentBlock::ToolUse { id, .. } if id == "toolu_9"));
            }
            MessageContent::Text(t) => {
                panic!("blocks were misparsed as text — history would be corrupted: {t}")
            }
        }
    }

    /// A full assistant turn (thinking + tool_use) must survive persistence,
    /// because resume replays it to the provider verbatim.
    #[test]
    fn a_full_assistant_turn_round_trips() {
        let msg = Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::Text { text: "I will read it".into() },
                ContentBlock::ToolUse {
                    id: "toolu_a".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({"path": "x"}),
                    provider_metadata: None,
                },
            ]),
        };
        let json = serde_json::to_string(&msg.content).unwrap();
        let back: MessageContent = serde_json::from_str(&json).unwrap();
        let restored = Message { role: Role::Assistant, content: back };

        // The tool_use id must still be there — this is what the API pairs
        // against tool_result.
        let ids: Vec<String> = match &restored.content {
            MessageContent::Blocks(b) => b
                .iter()
                .filter_map(|x| match x {
                    ContentBlock::ToolUse { id, .. } => Some(id.clone()),
                    _ => None,
                })
                .collect(),
            _ => vec![],
        };
        assert_eq!(ids, vec!["toolu_a".to_string()]);
        assert_eq!(restored.text(), "I will read it");
    }

    #[test]
    fn display_history_keeps_reasoning_and_tool_activity_separate_from_answer_text() {
        let call = Message::assistant_blocks(vec![
            ContentBlock::Thinking { thinking: "working text".into() },
            ContentBlock::Text { text: "final answer".into() },
            ContentBlock::ToolUse {
                id: "call-1".into(), name: "read_file".into(),
                input: serde_json::json!({"path":"notes.txt"}), provider_metadata: None,
            },
        ]);
        let result = Message::tool_result("call-1", "file output", false);
        let display = DisplayMessage::from_messages(&[call, result], Some("model:free"), None, 1);
        assert_eq!(display.len(), 2);
        assert_eq!(display[0].text, "final answer");
        assert_eq!(display[0].thinking, "working text");
        assert_eq!(display[0].tool_calls.len(), 1);
        assert_eq!(display[0].tool_calls[0].name, "read_file");
        assert_eq!(display[1].tool_results.len(), 1);
        assert_eq!(display[1].tool_results[0].output, "file output");
    }

    #[test]
    fn usage_is_attached_only_to_the_latest_assistant_message() {
        let messages = vec![
            Message::assistant_text("earlier answer"),
            Message::user("follow-up"),
            Message::assistant_text("latest answer"),
        ];
        let usage = TokenUsage { input_tokens: 10, output_tokens: 4, total_tokens: 14 };
        let display = DisplayMessage::from_messages(&messages, Some("test-model"), Some(&usage), 1);
        assert_eq!(display.len(), 3);
        assert!(display[0].usage.is_none());
        assert!(display[1].usage.is_none());
        assert_eq!(display[2].usage.as_ref().map(|value| value.total_tokens), Some(14));
    }

    #[test]
    fn internal_context_messages_persist_but_are_hidden_from_chat_display() {
        let context = Message {
            role: Role::Context,
            content: MessageContent::Text("continuity note".into()),
        };
        let json = serde_json::to_string(&context).unwrap();
        let restored: Message = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.role, Role::Context);
        let display = DisplayMessage::from_messages(
            &[restored, Message::user("current request")],
            None,
            None,
            1,
        );
        assert_eq!(display.len(), 1);
        assert_eq!(display[0].text, "current request");
    }

    #[test]
    fn roles_serialise_lowercase_as_the_db_expects() {
        // load_session_messages_raw matches on "user"/"assistant"/"system"/"context";
        // any other spelling silently DROPS the message.
        for (role, want) in [
            (Role::User, "\"user\""),
            (Role::Assistant, "\"assistant\""),
            (Role::System, "\"system\""),
            (Role::Context, "\"context\""),
        ] {
            assert_eq!(serde_json::to_string(&role).unwrap(), want);
        }
    }
}


/// Hard limits for multimodal prompt attachments. Images are base64, so 8 MB of
/// text is roughly a 6 MB picture — above every provider's inline image cap.
pub const MAX_ATTACHMENTS: usize = 8;
pub const MAX_IMAGE_BASE64_CHARS: usize = 8 * 1024 * 1024;
pub const MAX_TEXT_ATTACHMENT_CHARS: usize = 256 * 1024;
const IMAGE_MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Parse `SendMessageParams::attachments_json` into content blocks.
///
/// Accepts `[{type:"image", mediaType|media_type, data}]` (a `data:` URL is
/// also accepted and split) and `[{type:"text"|"file", name, text}]`. Anything
/// malformed is rejected up front so a bad attachment never reaches a provider
/// mid-turn and never gets persisted into the transcript.
pub fn parse_attachments(json: Option<&str>) -> Result<Vec<ContentBlock>, crate::NativeAgentError> {
    let Some(json) = json.map(str::trim).filter(|j| !j.is_empty() && *j != "null") else {
        return Ok(Vec::new());
    };
    let bad = |msg: String| crate::NativeAgentError::Agent { msg };
    let items: Vec<serde_json::Value> = serde_json::from_str(json)
        .map_err(|e| bad(format!("attachmentsJson must be a JSON array: {e}")))?;
    if items.len() > MAX_ATTACHMENTS {
        return Err(bad(format!("At most {MAX_ATTACHMENTS} attachments per message ({} given).", items.len())));
    }
    let mut blocks = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "image" => {
                let mut data = item.get("data").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                let mut media_type = item
                    .get("mediaType")
                    .or_else(|| item.get("media_type"))
                    .or_else(|| item.get("mimeType"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if let Some(rest) = data.strip_prefix("data:") {
                    let (header, payload) = rest
                        .split_once(',')
                        .ok_or_else(|| bad(format!("Attachment {index}: malformed data URL.")))?;
                    if !header.ends_with(";base64") {
                        return Err(bad(format!("Attachment {index}: data URL must be base64.")));
                    }
                    if media_type.is_empty() {
                        media_type = header.trim_end_matches(";base64").to_ascii_lowercase();
                    }
                    data = payload.to_string();
                }
                if media_type == "image/jpg" {
                    media_type = "image/jpeg".to_string();
                }
                if !IMAGE_MEDIA_TYPES.contains(&media_type.as_str()) {
                    return Err(bad(format!(
                        "Attachment {index}: unsupported image type '{media_type}' (use PNG, JPEG, GIF or WebP)."
                    )));
                }
                if data.is_empty() || data.len() > MAX_IMAGE_BASE64_CHARS {
                    return Err(bad(format!("Attachment {index}: image is empty or larger than 6 MB.")));
                }
                if !is_valid_base64(&data) {
                    return Err(bad(format!("Attachment {index}: image data is not valid base64.")));
                }
                blocks.push(ContentBlock::Image { media_type, data });
            }
            "text" | "file" => {
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if text.len() > MAX_TEXT_ATTACHMENT_CHARS {
                    return Err(bad(format!("Attachment {index}: text file is larger than 256 KB.")));
                }
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.replace(['\n', '\r'], " "))
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| format!("attachment-{}", index + 1));
                blocks.push(ContentBlock::Text {
                    text: format!("<attached_file name=\"{}\">\n{}\n</attached_file>", name.replace('"', "'"), text),
                });
            }
            other => {
                return Err(bad(format!("Attachment {index}: unknown type '{other}' (expected image or text).")));
            }
        }
    }
    Ok(blocks)
}

/// Index into `messages` where the `keep_user_turns`-th user prompt starts, or
/// `messages.len()` when the transcript has no more prompts than that.
/// Everything before the returned index is kept by a rewind/fork.
pub fn user_turn_cut_index(messages: &[Message], keep_user_turns: u32) -> usize {
    let mut seen = 0u32;
    for (index, message) in messages.iter().enumerate() {
        if message.is_user_prompt() {
            if seen == keep_user_turns {
                return index;
            }
            seen += 1;
        }
    }
    messages.len()
}

/// Standard-alphabet base64 check (padding required), without a new crate.
fn is_valid_base64(data: &str) -> bool {
    let bytes = data.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return false;
    }
    let padding = bytes.iter().rev().take_while(|b| **b == b'=').count();
    if padding > 2 {
        return false;
    }
    bytes[..bytes.len() - padding]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
}

#[cfg(test)]
mod attachment_and_turn_tests {
    use super::*;

    #[test]
    fn data_url_and_jpg_alias_are_normalised() {
        let blocks = parse_attachments(Some(r#"[{"type":"image","data":"data:image/jpg;base64,AAAA"}]"#)).unwrap();
        match &blocks[0] {
            ContentBlock::Image { media_type, data } => {
                assert_eq!(media_type, "image/jpeg");
                assert_eq!(data, "AAAA");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn text_attachments_are_wrapped_with_their_name() {
        let blocks = parse_attachments(Some(r#"[{"type":"text","name":"a.md","text":"hi"}]"#)).unwrap();
        match &blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "<attached_file name=\"a.md\">\nhi\n</attached_file>"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(parse_attachments(None).unwrap().is_empty());
        assert!(parse_attachments(Some("null")).unwrap().is_empty());
    }

    #[test]
    fn too_many_attachments_are_refused() {
        let many = serde_json::Value::Array(
            (0..=MAX_ATTACHMENTS).map(|_| serde_json::json!({"type":"text","text":"x"})).collect(),
        );
        assert!(parse_attachments(Some(&many.to_string())).is_err());
    }

    #[test]
    fn tool_result_carriers_are_not_user_prompts() {
        let carrier = Message {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: "ok".into(),
                is_error: false,
            }]),
        };
        let messages = vec![
            Message::user("a"),
            Message::assistant_text("b"),
            carrier,
            Message::user_with_attachments("", vec![ContentBlock::Image { media_type: "image/png".into(), data: "AAAA".into() }]),
            Message::assistant_text("c"),
        ];
        assert!(!messages[2].is_user_prompt());
        assert!(messages[3].is_user_prompt());
        assert_eq!(user_turn_cut_index(&messages, 0), 0);
        assert_eq!(user_turn_cut_index(&messages, 1), 3);
        assert_eq!(user_turn_cut_index(&messages, 2), 5);
    }

    #[test]
    fn image_blocks_round_trip_through_serde() {
        let block = ContentBlock::Image { media_type: "image/webp".into(), data: "AAAA".into() };
        let json = serde_json::to_string(&block).unwrap();
        assert_eq!(json, r#"{"type":"image","media_type":"image/webp","data":"AAAA"}"#);
        let back: ContentBlock = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, ContentBlock::Image { .. }));
    }
}
