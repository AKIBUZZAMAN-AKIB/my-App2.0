//! Turn memory inside the agent loop: fold summarized turns out of the copy
//! sent to the model, keep the stored transcript complete, and answer
//! `recall_turns` from the archived originals.

use super::{create_driver, wait_until_cancelled, AgentLoopContext, RoutePlan};
use crate::event_bus;
use crate::llm_driver::CompletionRequest;
use crate::runtime_config::AgentRuntimeConfig;
use crate::tokens::TokenMeter;
use crate::turn_memory::{self as tm, TextModel, TurnMemory};
use crate::types::{Message, TokenUsage};
use crate::NativeAgentError;
use std::time::Duration;

/// The complete transcript kept beside the folded view the model sees.
pub(super) struct MemoryFold {
    pub full: Vec<Message>,
    /// View length already copied into `full`.
    pub synced: usize,
}

impl MemoryFold {
    /// Copy messages appended to the view since the last sync.
    pub fn sync(&mut self, view: &[Message]) {
        if self.synced < view.len() {
            self.full.extend(view[self.synced..].iter().cloned());
        }
        self.synced = view.len();
    }

    /// The transcript to store: complete originals, without the memory block
    /// or an overflow summary (both are rebuilt from storage next turn).
    pub fn finish(mut self, view: &[Message]) -> Vec<Message> {
        self.sync(view);
        self.full.retain(|m| !tm::is_memory_message(m) && !super::is_session_summary(m));
        self.full
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// One isolated, tool-less model call over the turn's routes (the same
/// failover the overflow summarizer uses). Used for summarizer and recall
/// sub-agents; usage is added up for the turn.
pub(super) struct RouteTextModel<'a, 'b> {
    pub ctx: &'a AgentLoopContext<'b>,
    pub route_plan: &'a RoutePlan,
    pub runtime_config: &'a AgentRuntimeConfig,
    pub usage: std::sync::Mutex<TokenUsage>,
}

impl<'a, 'b> RouteTextModel<'a, 'b> {
    pub fn new(ctx: &'a AgentLoopContext<'b>, route_plan: &'a RoutePlan, runtime_config: &'a AgentRuntimeConfig) -> Self {
        Self { ctx, route_plan, runtime_config, usage: std::sync::Mutex::new(TokenUsage::default()) }
    }
    pub fn take_usage(&self) -> TokenUsage {
        std::mem::take(&mut *self.usage.lock().unwrap())
    }
}

impl TextModel for RouteTextModel<'_, '_> {
    async fn complete(&self, system: &str, user: String, max_tokens: u32) -> Result<String, String> {
        let template = CompletionRequest {
            model: String::new(),
            messages: vec![Message::user(&user)],
            tools: Vec::new(),
            max_tokens: max_tokens.max(1),
            temperature: 0.0,
            system: Some(system.to_string()),
        };
        let max_routes = if self.route_plan.automatic && self.runtime_config.auto_routing.failover_on_transient {
            (1 + self.runtime_config.auto_routing.max_fallbacks as usize).min(self.route_plan.candidates.len())
        } else {
            1.min(self.route_plan.candidates.len())
        };
        let mut last_error = "no model route is available".to_string();
        for route in self.route_plan.candidates.iter().take(max_routes) {
            let driver = match create_driver(route, self.ctx.callback.clone(), self.ctx.webllm_pending.clone(), &self.ctx.session_key) {
                Ok(d) => d,
                Err(e) => {
                    last_error = e.to_string();
                    continue;
                }
            };
            let mut request = template.clone();
            request.model = route.model.clone();
            let result = tokio::select! {
                biased;
                _ = wait_until_cancelled(&self.ctx.abort_flag) => return Err("cancelled".into()),
                _ = tokio::time::sleep(Duration::from_secs(180)) => Err(None),
                r = driver.complete(&request) => r.map_err(Some),
            };
            match result {
                Ok(response) => {
                    let mut u = self.usage.lock().unwrap();
                    u.input_tokens += response.usage.input_tokens;
                    u.output_tokens += response.usage.output_tokens;
                    u.total_tokens += response.usage.total_tokens;
                    return Ok(response.text());
                }
                Err(None) => last_error = "the summarizer timed out".into(),
                Err(Some(e)) => {
                    last_error = e.to_string();
                    if !e.is_retryable() {
                        break;
                    }
                }
            }
        }
        Err(last_error)
    }
}

fn add_usage(total: &mut TokenUsage, u: TokenUsage) {
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.total_tokens += u.total_tokens;
}

/// Whether this chat has (or is about to get) a summary, so the recall tool
/// is worth offering.
pub(super) fn recall_available(ctx: &AgentLoopContext<'_>, messages: &[Message]) -> bool {
    let settings = tm::load_settings(&ctx.config.workspace_path);
    if !settings.enabled {
        return false;
    }
    let complete = tm::split_turns(messages).len().saturating_sub(1) as u32;
    let through = crate::db::open_db(&ctx.config.db_path).map(|c| tm::load_memory(&c, &ctx.session_key).through_turn).unwrap_or(0);
    through > 0 || !tm::plan_batches(complete, through, &settings).is_empty()
}

/// Summarize the turns the window policy releases, archive the originals and
/// fold the summarized turns out of `messages`. Returns the complete transcript
/// holder when anything was folded.
#[allow(clippy::too_many_arguments)]
pub(super) async fn apply(
    ctx: &AgentLoopContext<'_>,
    route_plan: &RoutePlan,
    runtime_config: &AgentRuntimeConfig,
    messages: &mut Vec<Message>,
    meter: &TokenMeter,
    context_budget: usize,
    max_output: u32,
    started_at: std::time::Instant,
    usage: &mut TokenUsage,
) -> Result<Option<MemoryFold>, NativeAgentError> {
    let callback = ctx.callback.as_deref();
    let settings = tm::load_settings(&ctx.config.workspace_path);
    if !settings.enabled {
        return Ok(None);
    }
    let turns = tm::split_turns(messages);
    if turns.len() < 2 {
        return Ok(None);
    }
    let complete = turns.len() as u32 - 1;
    let key = ctx.session_key.clone();
    let mut mem = match crate::db::open_db(&ctx.config.db_path) {
        Ok(conn) => {
            let mut mem = tm::load_memory(&conn, &key);
            if mem.through_turn > complete {
                // The transcript is shorter than the summary (messages were
                // deleted or the chat was reset): start the memory again.
                mem = TurnMemory::default();
                let _ = tm::delete_memory(&conn, &key);
            }
            let pending = &turns[mem.through_turn as usize..complete as usize];
            if let Err(e) = tm::archive_turns(&conn, &key, messages, pending, now_ms()) {
                tracing::warn!(error = %e, "could not archive turns");
            }
            mem
        }
        Err(_) => return Ok(None),
    };

    let batches = tm::plan_batches(complete, mem.through_turn, &settings);
    if !batches.is_empty() {
        let model = RouteTextModel::new(ctx, route_plan, runtime_config);
        let count = |s: &str| meter.text(s);
        let input_limit = (context_budget.saturating_mul(2) / 3).clamp(1_500, 120_000);
        let out_tokens = max_output.min(4_096);
        for (from, to) in batches {
            if super::wall_clock_timeout_reached(ctx, started_at) {
                break;
            }
            event_bus::emit(callback, "memory.summarizing", &serde_json::json!({"fromTurn": from, "toTurn": to, "sessionKey": key}));
            let texts: Vec<(u32, String)> = turns[(from - 1) as usize..to as usize]
                .iter()
                .map(|t| (t.no, tm::render_turn(t.no, &messages[t.start..t.end])))
                .collect();
            match tm::summarize_range(&model, mem.clone(), &texts, from, to, input_limit, out_tokens, &count, now_ms()).await {
                Ok(out) => {
                    mem = out.memory;
                    if let Ok(conn) = crate::db::open_db(&ctx.config.db_path) {
                        let _ = tm::save_memory(&conn, &key, &mem);
                    }
                    event_bus::emit(
                        callback,
                        "memory.updated",
                        &serde_json::json!({"fromTurn": from, "toTurn": to, "throughTurn": mem.through_turn, "portions": out.portions, "calls": out.calls, "segments": mem.segments.len(), "sessionKey": key}),
                    );
                }
                Err(error) => {
                    if *ctx.abort_flag.lock().await {
                        add_usage(usage, model.take_usage());
                        return Err(NativeAgentError::Cancelled);
                    }
                    tracing::warn!(%error, "turn summary failed; sending those turns unsummarized");
                    event_bus::emit(callback, "memory.failed", &serde_json::json!({"fromTurn": from, "toTurn": to, "error": error, "sessionKey": key}));
                    break;
                }
            }
        }
        add_usage(usage, model.take_usage());
    }

    if mem.through_turn == 0 {
        return Ok(None);
    }
    let fold_end = turns[(mem.through_turn - 1) as usize].end;
    let full = messages.clone();
    let mut view_mem = mem.clone();
    let count = |s: &str| meter.text(s);
    tm::coarsen(&mut view_mem, (context_budget / tm::MEMORY_BUDGET_DIVISOR).max(500), &count);
    let block = tm::memory_message(&view_mem);
    let memory_tokens = meter.message(&block);
    messages.splice(0..fold_end, std::iter::once(block));
    event_bus::emit(
        callback,
        "memory.applied",
        &serde_json::json!({"throughTurn": mem.through_turn, "foldedMessages": fold_end, "memoryTokens": memory_tokens, "keptTurns": complete - mem.through_turn, "sessionKey": key}),
    );
    Ok(Some(MemoryFold { full, synced: messages.len() }))
}

/// `recall_turns`: original turns as text (paged), or an answer from a recall
/// sub-agent that reads them.
#[allow(clippy::too_many_arguments)]
pub(super) async fn recall_tool(
    ctx: &AgentLoopContext<'_>,
    route_plan: &RoutePlan,
    runtime_config: &AgentRuntimeConfig,
    input: &serde_json::Value,
    meter: &TokenMeter,
    context_budget: usize,
    used_tokens: usize,
    max_output: u32,
    usage: &mut TokenUsage,
) -> (String, bool) {
    let num = |k: &str| input.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())));
    let Some(from) = num("from_turn").map(|n| n.max(1) as u32) else {
        return ("from_turn is required.".into(), true);
    };
    let to = num("to_turn").map(|n| n as u32).unwrap_or(from).max(from);
    if to - from > 200 {
        return ("Ask for at most 200 turns at a time.".into(), true);
    }
    let (turns, mem) = match crate::db::open_db(&ctx.config.db_path) {
        Ok(conn) => (tm::load_turns(&conn, &ctx.session_key, from, to), tm::load_memory(&conn, &ctx.session_key)),
        Err(e) => return (format!("Could not open the chat archive: {}", e), true),
    };
    if turns.is_empty() {
        return (format!("No stored turns {}-{} in this chat. Stored turns are numbered from 1; the memory's turn index lists them.", from, to), true);
    }
    let texts: Vec<(u32, String)> = turns.iter().map(|(n, m)| (*n, tm::render_turn(*n, m))).collect();
    let count = |s: &str| meter.text(s);
    let question = input.get("question").and_then(|v| v.as_str()).map(str::trim).filter(|q| !q.is_empty());
    if let Some(q) = question {
        let model = RouteTextModel::new(ctx, route_plan, runtime_config);
        let input_limit = (context_budget.saturating_mul(2) / 3).clamp(1_500, 120_000);
        let r = tm::recall(&model, &mem, &texts, q, input_limit, max_output.min(2_048), &count).await;
        add_usage(usage, model.take_usage());
        return match r {
            Ok((answer, portions)) => (format!("Recall from the original messages of turns {}-{} ({} recall sub-agent call{}):\n{}", from, to, portions, if portions == 1 { "" } else { "s" }, answer.trim()), false),
            Err(e) => (format!("The recall sub-agent failed: {}. Call {} again without question to read the original text.", e, tm::RECALL_TOOL), true),
        };
    }
    let all = texts.into_iter().map(|t| t.1).collect::<Vec<_>>().join("\n");
    let offset = (num("offset").unwrap_or(0) as usize).min(all.len());
    let mut offset = offset;
    while !all.is_char_boundary(offset) {
        offset -= 1;
    }
    let rest = &all[offset..];
    let limit = crate::read_budget::read_limit(None, context_budget, used_tokens);
    let cut = crate::read_budget::cut_point(rest, limit, &count);
    let part = &rest[..cut];
    let header = if cut < rest.len() {
        format!("Original messages of turns {}-{}, bytes {}-{} of {}. More remains: call {} again with offset {}.\n", from, to, offset, offset + cut, all.len(), tm::RECALL_TOOL, offset + cut)
    } else {
        format!("Original messages of turns {}-{} (bytes {}-{} of {}, complete).\n", from, to, offset, all.len(), all.len())
    };
    (format!("{}{}", header, part), false)
}
