//! Turn memory inside the agent loop: fold summarized turns out of the copy
//! sent to the model, keep the stored transcript complete, and answer
//! `recall_turns` from the archived originals.

use super::{create_driver, wait_until_cancelled, AgentLoopContext, RoutePlan};
use crate::event_bus;
use crate::llm_driver::CompletionRequest;
use crate::runtime_config::AgentRuntimeConfig;
use crate::tokens::TokenMeter;
use crate::turn_memory::{self as tm, commit, repair, results, TextModel, TurnMemory};
use crate::types::{Message, TokenUsage};
use crate::NativeAgentError;
use std::time::Duration;

/// The complete transcript kept beside the folded view the model sees.
pub(super) struct MemoryFold {
    pub full: Vec<Message>,
    /// View length already copied into `full`.
    pub synced: usize,
    /// Length of the stored transcript this turn started from. A session
    /// summary inside it (written by overflow compaction before turn memory
    /// was on) is the only record of the turns it replaced and is kept (W-1).
    pub stored: usize,
    /// What the memory block of this turn holds (for the assembly record).
    pub injected: Option<Injected>,
}

/// The memory block put into this turn's view: its version, the turns it
/// stands for and the records chosen for the request (`select.rs`).
#[derive(Debug, Clone, Default)]
pub(super) struct Injected {
    pub version: u64,
    pub through_turn: u32,
    pub selection: tm::select::Selection,
    /// The inputs of the selection, kept so an over-budget request can
    /// choose again with a smaller cap (`reselect_smaller`).
    mem: TurnMemory,
    goals: tm::goals::GoalState,
    query: String,
    previous: String,
    fts_turns: Vec<u32>,
    /// The checklist's picks and #tags for this request (memory_checklist.rs),
    /// kept so a smaller re-selection honours them too.
    picks: tm::select::Picks,
    /// Summarized turns put back as written (raw-vs-summary selection,
    /// `turn_memory::raw_select`), in turn order, with the first message of
    /// each so the context tree can number them by their real turn even
    /// after compaction trimmed the view.
    pub raw_turns: Vec<(u32, String)>,
}

impl Injected {
    /// The restored turns as `(turn, head)` pairs for `wiring::TurnNumbers`.
    pub fn raw_heads(&self) -> &[(u32, String)] {
        &self.raw_turns
    }
}

/// Over budget: choose the memory block again with a smaller cap, before
/// any compaction touches the recent turns. Only optional records go (the
/// current goal, its decisions and tasks stay); the block is replaced only
/// when the new one is smaller. Returns the tokens saved.
pub(super) fn reselect_smaller(fold: &mut MemoryFold, messages: &mut [Message], meter: &TokenMeter, over_by: usize) -> Option<usize> {
    let inj = fold.injected.as_mut()?;
    let at = messages.iter().position(tm::is_memory_message)?;
    let before = meter.message(&messages[at]);
    let cap = before.saturating_sub(over_by.saturating_add(16));
    let count = |s: &str| meter.text(s);
    let sel = tm::select::select_with(
        &tm::select::Input { mem: &inj.mem, goals: &inj.goals, query: &inj.query, previous: &inj.previous, fts_turns: &inj.fts_turns, max_tokens: cap },
        &inj.picks,
        &count,
    );
    let block = tm::memory_block(&sel.text);
    let after = meter.message(&block);
    if after >= before {
        return None;
    }
    messages[at] = block;
    inj.selection = sel;
    Some(before - after)
}

impl MemoryFold {
    /// Holder of the stored transcript `full`, nothing synced from the view yet
    /// beyond its current length.
    pub fn new(full: Vec<Message>) -> Self {
        let synced = full.len();
        Self { stored: synced, full, synced, injected: None }
    }

    /// Copy messages appended to the view since the last sync.
    pub fn sync(&mut self, view: &[Message]) {
        if self.synced < view.len() {
            self.full.extend(view[self.synced..].iter().cloned());
        }
        self.synced = view.len();
    }

    /// The transcript to store: complete originals, without the memory block
    /// or an overflow summary made during this turn (both are rebuilt next
    /// turn). Everything that was already stored is kept as it was.
    pub fn finish(mut self, view: &[Message]) -> Vec<Message> {
        self.sync(view);
        let stored = self.stored;
        self.full
            .into_iter()
            .enumerate()
            .filter(|(i, m)| *i < stored || (!tm::is_memory_message(m) && !super::is_session_summary(m)))
            .map(|(_, m)| m)
            .collect()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// One isolated, tool-less model call over the turn's routes (the same
/// failover the overflow summarizer uses). Used for summarizer and recall
/// sub-agents; usage is added up for the turn.
/// What stops a summarizer call: the turn's abort flag, or a background
/// worker's cancel flag.
pub(super) enum Abort {
    Turn(std::sync::Arc<tokio::sync::Mutex<bool>>),
    Flag(std::sync::Arc<std::sync::atomic::AtomicBool>),
}

impl Abort {
    async fn cancelled(&self) {
        match self {
            Abort::Turn(f) => wait_until_cancelled(f).await,
            Abort::Flag(f) => loop {
                if f.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            },
        }
    }
}

/// The chat's model route as a plain text model for the summarizer. Owns
/// what it uses, so a background job can keep it after the turn ends.
pub(super) struct RouteTextModel {
    route_plan: RoutePlan,
    runtime_config: AgentRuntimeConfig,
    callback: Option<std::sync::Arc<dyn crate::NativeEventCallback>>,
    webllm_pending: super::WebLlmPending,
    session_key: String,
    abort: Abort,
    pub usage: std::sync::Mutex<TokenUsage>,
}

impl RouteTextModel {
    pub fn new(ctx: &AgentLoopContext<'_>, route_plan: &RoutePlan, runtime_config: &AgentRuntimeConfig) -> Self {
        Self::owned(route_plan.clone(), runtime_config.clone(), ctx.callback.clone(), ctx.webllm_pending.clone(), ctx.session_key.clone(), Abort::Turn(ctx.abort_flag.clone()))
    }
    pub fn owned(route_plan: RoutePlan, runtime_config: AgentRuntimeConfig, callback: Option<std::sync::Arc<dyn crate::NativeEventCallback>>, webllm_pending: super::WebLlmPending, session_key: String, abort: Abort) -> Self {
        Self { route_plan, runtime_config, callback, webllm_pending, session_key, abort, usage: std::sync::Mutex::new(TokenUsage::default()) }
    }
    pub fn take_usage(&self) -> TokenUsage {
        std::mem::take(&mut *self.usage.lock().unwrap())
    }
}

impl TextModel for RouteTextModel {
    async fn complete(&self, system: &str, user: String, max_tokens: u32) -> Result<String, String> {
        let template = CompletionRequest {
            model: String::new(),
            messages: vec![Message::user(&user)],
            tools: Vec::new(),
            max_tokens: max_tokens.max(1),
            temperature: 0.0,
            system: Some(system.to_string()),
            // Summaries are structured JSON: ask reasoning models not to spend
            // the output budget thinking (fix for finish_reason=length with no
            // JSON from a free reasoning model in the real-provider run).
            minimal_reasoning: true,
        };
        let max_routes = if self.route_plan.automatic && self.runtime_config.auto_routing.failover_on_transient {
            (1 + self.runtime_config.auto_routing.max_fallbacks as usize).min(self.route_plan.candidates.len())
        } else {
            1.min(self.route_plan.candidates.len())
        };
        let mut last_error = "no model route is available".to_string();
        for route in self.route_plan.candidates.iter().take(max_routes) {
            let driver = match create_driver(route, self.callback.clone(), self.webllm_pending.clone(), &self.session_key) {
                Ok(d) => d,
                Err(e) => {
                    last_error = e.to_string();
                    continue;
                }
            };
            let mut request = template.clone();
            request.model = route.model.clone();
            // At most two extra attempts on this route: one without the
            // reasoning field if the endpoint rejects it, one with a larger
            // output budget if the answer was cut off before any JSON.
            let mut dropped_reasoning_hint = false;
            let mut raised_budget = false;
            let outcome = loop {
                let result = tokio::select! {
                    biased;
                    _ = self.abort.cancelled() => return Err("cancelled".into()),
                    _ = tokio::time::sleep(Duration::from_secs(180)) => Err(None),
                    r = driver.complete(&request) => r.map_err(Some),
                };
                match result {
                    Ok(response) => {
                        {
                            let mut u = self.usage.lock().unwrap();
                            u.input_tokens += response.usage.input_tokens;
                            u.output_tokens += response.usage.output_tokens;
                            u.total_tokens += response.usage.total_tokens;
                        }
                        let text = response.text();
                        if response.stop_reason == crate::types::StopReason::MaxTokens
                            && !raised_budget
                            && crate::turn_memory::extract_json_object(&text).is_none()
                        {
                            raised_budget = true;
                            let next = summarizer_retry_budget(request.max_tokens);
                            crate::event_bus::emit(
                                self.callback.as_deref(),
                                "memory.summarizer_retry",
                                &serde_json::json!({
                                    "reason": "finish_reason_length_without_json",
                                    "provider": route.provider,
                                    "model": route.model,
                                    "maxTokens": request.max_tokens,
                                    "nextMaxTokens": next,
                                    "outputTokens": response.usage.output_tokens,
                                    "sessionKey": self.session_key,
                                }),
                            );
                            request.max_tokens = next;
                            continue;
                        }
                        break Ok(text);
                    }
                    Err(Some(e)) if request.minimal_reasoning && !dropped_reasoning_hint && rejects_reasoning_hint(&e) => {
                        dropped_reasoning_hint = true;
                        request.minimal_reasoning = false;
                        crate::event_bus::emit(
                            self.callback.as_deref(),
                            "memory.summarizer_retry",
                            &serde_json::json!({
                                "reason": "reasoning_hint_rejected",
                                "provider": route.provider,
                                "model": route.model,
                                "error": e.to_string().chars().take(200).collect::<String>(),
                                "sessionKey": self.session_key,
                            }),
                        );
                        continue;
                    }
                    Err(e) => break Err(e),
                }
            };
            match outcome {
                Ok(text) => return Ok(text),
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

/// Output budget for the one retry after a summary was cut off: double, at
/// least 8,192 and at most 16,384 tokens.
pub(crate) fn summarizer_retry_budget(current: u32) -> u32 {
    current.saturating_mul(2).clamp(8_192, 16_384).max(current)
}

/// A 400/422 that names the reasoning field: the endpoint does not take it
/// (or the model cannot turn reasoning off). Retried once without it.
pub(crate) fn rejects_reasoning_hint(error: &crate::llm_driver::LlmError) -> bool {
    match error {
        crate::llm_driver::LlmError::Api { status, message } => {
            matches!(*status, 400 | 422) && {
                let m = message.to_ascii_lowercase();
                m.contains("reasoning") || m.contains("thinking")
            }
        }
        _ => false,
    }
}

fn add_usage(total: &mut TokenUsage, u: TokenUsage) {
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.total_tokens += u.total_tokens;
}


/// Tool results at least this large are stored by result ID when they
/// arrive, so a reference to them always resolves.
pub(super) const STORE_RESULT_MIN_BYTES: usize = 1_024;

/// Store a tool result the moment it arrives, before any read budget or
/// compaction touches it. Returns its stable result ID ("R12").
pub(super) fn store_result(ctx: &AgentLoopContext<'_>, tool_use_id: &str, tool_name: &str, input: &serde_json::Value, content: &str, is_error: bool, turn: u32) -> Option<String> {
    if content.len() < STORE_RESULT_MIN_BYTES || tool_name == tm::RECALL_TOOL || tool_name == tm::inspect::INSPECT_TOOL {
        return None;
    }
    let conn = crate::db::open_db(&ctx.config.db_path).ok()?;
    match tm::store_result(&conn, &ctx.session_key, tool_use_id, tool_name, results::source_of(input).as_deref(), content, is_error, Some(turn), now_ms()) {
        Ok((id, _)) => Some(id),
        Err(e) => {
            tracing::warn!(error = %e, "could not store a tool result");
            None
        }
    }
}

/// Split the private original out of a tool result (ADR-7). Returns the
/// result as the model sees it and, when the tool kept more than it shows,
/// the complete result to store: the same JSON with the original text in
/// place of the cut one.
pub(super) fn take_original(mut val: serde_json::Value) -> (serde_json::Value, Option<String>) {
    let Some(orig) = val.as_object_mut().and_then(|o| o.remove(crate::tool_runner::ORIGINAL_FIELD)) else {
        return (val, None);
    };
    let mut full = val.clone();
    if let Some(o) = orig.as_object() {
        for (k, v) in o {
            match k.as_str() {
                "stdout" | "stderr" | "body" => full[k.as_str()] = v.clone(),
                _ => full["original"][k.as_str()] = v.clone(),
            }
        }
    }
    for k in ["stdoutTruncated", "stderrTruncated", "truncated"] {
        if full.get(k).is_some() {
            full[k] = serde_json::json!(false);
        }
    }
    full["storedOriginal"] = serde_json::json!(true);
    (val, Some(serde_json::to_string(&full).unwrap_or_default()))
}

/// The shown result, told where its complete original is.
pub(super) fn note_original(content: &str, result_id: &str, original: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(content) else {
        return content.to_string();
    };
    let cut = serde_json::from_str::<serde_json::Value>(original).ok().and_then(|o| o["original"]["originalTruncated"].as_bool()).unwrap_or(false);
    v["fullOutput"] = serde_json::json!(format!(
        "This output was cut for display. Its original ({}{}) is stored as result #{}: call {} with result_id \"{}\" and offset, or with a question, to read the rest.",
        results::human_size(original.len()),
        if cut { ", itself stopped at the storage limit" } else { "" },
        result_id,
        tm::RECALL_TOOL,
        result_id
    ));
    serde_json::to_string(&v).unwrap_or_else(|_| content.to_string())
}

/// Bytes of an original kept for storage, from the memory settings.
pub(super) fn original_capture_bytes(ctx: &AgentLoopContext<'_>) -> usize {
    tm::load_settings(&ctx.config.workspace_path).max_stored_result_bytes as usize
}

pub(super) fn stored_result_ids(ctx: &AgentLoopContext<'_>) -> std::collections::HashMap<String, String> {
    crate::db::open_db(&ctx.config.db_path).map(|c| tm::result_ids(&c, &ctx.session_key)).unwrap_or_default()
}

fn has_references(messages: &[Message]) -> bool {
    messages.iter().any(|m| match &m.content {
        crate::types::MessageContent::Blocks(bs) => bs.iter().any(|b| matches!(b, crate::types::ContentBlock::ToolResult { content, .. } if results::is_reference(content))),
        _ => false,
    })
}

/// Whether the recall tool is worth offering: the chat has (or is about to
/// get) a summary, or the transcript holds result references.
pub(super) fn recall_available(ctx: &AgentLoopContext<'_>, messages: &[Message]) -> bool {
    if has_references(messages) {
        return true;
    }
    let settings = tm::load_settings(&ctx.config.workspace_path);
    if !settings.enabled {
        return false;
    }
    let complete = tm::split_turns(messages).len().saturating_sub(1) as u32;
    let through = crate::db::open_db(&ctx.config.db_path).map(|c| tm::load_memory(&c, &ctx.session_key).through_turn).unwrap_or(0);
    through > 0 || !tm::plan_batches(complete, through, &settings).is_empty()
}

/// The persisted record of one model request (`turn_memory::audit`): IDs
/// and numbers only, from the same values the `context.assembly` event has.
#[allow(clippy::too_many_arguments)]
pub(super) fn assembly_record(
    key: &str,
    route: Option<(&str, &str)>,
    fold: Option<&MemoryFold>,
    view: &[Message],
    (memory_version, through_turn): (Option<u32>, Option<u32>),
    (budget, estimated, reserved_output): (usize, usize, usize),
    (iteration, attempt): (u32, usize),
    actions: &[&str],
) -> tm::audit::AssemblyRecord {
    let inj = fold.and_then(|f| f.injected.as_ref());
    // Turns sent verbatim: those after the memory block in the view,
    // numbered from the end of the complete transcript.
    let after = view.iter().position(tm::is_memory_message).map_or(0, |i| i + 1);
    let shown = tm::split_turns(&view[after..]).len() as u32;
    let total = fold.map_or(shown, |f| tm::split_turns(&f.full).len() as u32);
    let recent: Vec<u32> = if shown == 0 { Vec::new() } else { (total.saturating_sub(shown) + 1..=total).collect() };
    let mut compaction: Vec<String> = Vec::new();
    let mut truncation: Vec<String> = Vec::new();
    if let Some(t) = through_turn.filter(|t| *t > 0) {
        compaction.push(format!("memory_fold:turns_1-{}", t));
    }
    for a in actions {
        match *a {
            "trimmed" | "memory_reselected" => truncation.push((*a).to_string()),
            other => compaction.push(other.to_string()),
        }
    }
    let sel = inj.map(|i| i.selection.clone()).unwrap_or_default();
    truncation.extend(sel.truncated.iter().map(|id| format!("memory_left_out:{}", id)));
    let (provider, model) = route.map_or((None, None), |(p, m)| (Some(p.to_string()).filter(|s| !s.is_empty()), Some(m.to_string()).filter(|s| !s.is_empty())));
    tm::audit::AssemblyRecord {
        assembly_id: uuid::Uuid::new_v4().to_string(),
        conversation_id: key.to_string(),
        created_at: now_ms(),
        provider,
        model,
        iteration,
        attempt: attempt as u32,
        memory_version: memory_version.map(u64::from).or(inj.map(|i| i.version)),
        summary_through_turn: through_turn.or(inj.map(|i| i.through_turn)),
        input_token_budget: budget,
        estimated_input_tokens: estimated,
        reserved_output_tokens: reserved_output,
        included_recent_turns: recent,
        included_goal_ids: sel.goal_ids,
        included_decision_ids: sel.decision_ids,
        included_task_ids: sel.task_ids,
        included_memory_ids: sel.memory_ids,
        included_summary_segment_ids: sel.segment_ids,
        retrieval_sources: sel.sources,
        compaction_actions: compaction,
        truncation_actions: truncation,
    }
}

/// The user's own words in a turn: the text of its first user message
/// (tool results and attachments left out).
pub(super) fn user_words(msgs: &[Message]) -> String {
    use crate::types::{ContentBlock, MessageContent, Role};
    let Some(m) = msgs.iter().find(|m| m.role == Role::User) else { return String::new() };
    match &m.content {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(bs) => bs
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn emit_goal_outcomes(callback: Option<&dyn crate::NativeEventCallback>, key: &str, outcomes: &[tm::goals::Outcome], st: Option<&tm::goals::GoalState>) {
    if outcomes.is_empty() {
        return;
    }
    let applied: Vec<&tm::goals::Outcome> = outcomes.iter().filter(|o| o.applied).collect();
    let rejected: Vec<&tm::goals::Outcome> = outcomes.iter().filter(|o| !o.applied).collect();
    event_bus::emit(
        callback,
        "memory.goals",
        &serde_json::json!({
            "applied": applied,
            "rejected": rejected,
            "currentGoalId": st.and_then(|s| s.current_goal_id.clone()),
            "sessionKey": key,
        }),
    );
}

/// Goal lifecycle, step 1 of every turn: the deterministic detector reads
/// the new user message (once per turn) and records explicit goal commands
/// through `goals::apply`. No model call; nothing waits for a summary.
fn detect_goals(callback: Option<&dyn crate::NativeEventCallback>, conn: &rusqlite::Connection, key: &str, turn: &tm::Turn, messages: &[Message]) {
    let text = user_words(&messages[turn.start..turn.end]);
    match tm::goals::detect_turn(conn, key, turn.no, &text, now_ms()) {
        Ok(out) if !out.is_empty() => {
            let st = tm::goals::load_state(conn, key);
            emit_goal_outcomes(callback, key, &out, Some(&st));
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(session = %key, error = %e, "goal detection failed"),
    }
}

/// Goal changes the summarizer proposed for turns `from..=to`: kept only
/// when the quoted words are the user's own in that turn, then validated
/// and recorded like the detector's (`goals::apply`). Runs before the
/// summary is saved, so the new decisions and tasks link to the right goal.
pub(super) fn summary_goal_ops(callback: Option<&dyn crate::NativeEventCallback>, conn: &rusqlite::Connection, key: &str, ops: &[tm::goals::Proposal], from: u32, to: u32, slices: &[(u32, Vec<Message>)]) {
    if ops.is_empty() {
        return;
    }
    let words = |t: u32| slices.iter().find(|(n, _)| *n == t).map(|(_, m)| user_words(m)).filter(|w| !w.trim().is_empty());
    let (ok, rejected) = tm::goals::validate_summary_ops(ops.to_vec(), from, to, &words);
    let mut out: Vec<tm::goals::Outcome> =
        rejected.into_iter().map(|note| tm::goals::Outcome { op: "summary".into(), note, origin: tm::goals::ORIGIN_SUMMARY.into(), ..Default::default() }).collect();
    let mut st = None;
    if !ok.is_empty() {
        match tm::goals::apply(conn, key, &ok, now_ms()) {
            Ok((o, s)) => {
                out.extend(o);
                st = Some(s);
            }
            Err(e) => tracing::warn!(session = %key, error = %e, "goal ops from the summary were not recorded"),
        }
    }
    emit_goal_outcomes(callback, key, &out, st.as_ref());
}

/// The summarizer sees the tracked goals (IDs, titles, statuses).
pub(super) fn with_tracked_goals(conn: &rusqlite::Connection, key: &str, mem: &mut TurnMemory) {
    let st = tm::goals::load_state(conn, key);
    mem.tracked_goals = (!st.goals.is_empty()).then(|| tm::goals::summary_context(&st));
}

/// Summarize the turns the window policy releases (each batch validated in
/// code and saved as a new version together with its archived turns), then
/// fold the summarized turns out of `messages`. Returns the holder of the
/// complete transcript whenever memory is on, so the stored transcript keeps
/// its originals even when overflow compaction shortens the view.
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
    let full_copy = || Some(MemoryFold::new(messages.clone()));
    let turns = tm::split_turns(messages);
    if let (Ok(c), Some(last)) = (crate::db::open_db(&ctx.config.db_path), turns.last()) {
        detect_goals(callback, &c, &ctx.session_key, last, messages);
    }
    if turns.len() < 2 {
        return Ok(full_copy());
    }
    let complete = turns.len() as u32 - 1;
    let key = ctx.session_key.clone();
    let Ok(conn) = crate::db::open_db(&ctx.config.db_path) else {
        return Ok(full_copy());
    };
    let mut mem = tm::load_memory(&conn, &key);
    if mem.from_newer_build() {
        // A newer build wrote this memory; this one would drop its fields.
        // The model gets every original turn instead.
        return Ok(full_copy());
    }
    if mem.unreadable || mem.recovered_from.is_some() {
        let note = match mem.recovered_from {
            Some(v) => format!("the saved summary was unreadable; continuing from version {}", v),
            None => "the saved summary was unreadable and no earlier version could be read; summarizing again from the original turns (the unreadable copy is kept)".to_string(),
        };
        tracing::warn!(session = %key, "{}", note);
        event_bus::emit(callback, "memory.recovered", &serde_json::json!({"recoveredFrom": mem.recovered_from, "message": note, "sessionKey": key}));
    }
    if mem.through_turn > complete {
        // The transcript is shorter than the summary (messages were deleted
        // or the chat was reset): start the memory again, as a version.
        let _ = tm::reset_memory(&conn, &key, &format!("the transcript has {} complete turns but the summary covered {}", complete, mem.through_turn), now_ms());
        mem = tm::load_memory(&conn, &key);
    }

    let batches = tm::plan_batches(complete, mem.through_turn, &settings);
    if batches.is_empty() && tm::load_status(&conn, &key).status != "ok" && tm::jobs::active(&conn, &key).is_none() {
        let _ = tm::set_status(&conn, &key, "ok", "", now_ms());
    }
    if settings.background_summaries {
        // Phase 4: never wait. Queue the next due batch (idempotent) for the
        // chat's worker and fold with the latest committed version below;
        // a running job is never treated as committed.
        if !batches.is_empty() || tm::jobs::active(&conn, &key).is_some() {
            let env = std::sync::Arc::new(super::memory_worker::WorkerEnv {
                db_path: ctx.config.db_path.clone(),
                workspace_path: ctx.config.workspace_path.clone(),
                session_key: key.clone(),
                callback: ctx.callback.clone(),
                route_plan: route_plan.clone(),
                runtime_config: runtime_config.clone(),
                webllm_pending: ctx.webllm_pending.clone(),
                meter: meter.clone(),
                context_budget,
                max_output,
            });
            let queued = super::memory_worker::queue_and_kick(env, complete, &tokio::runtime::Handle::current());
            if let Some(tm::jobs::Enqueued::Queued(job_key)) = &queued {
                event_bus::emit(callback, "memory.queued", &serde_json::json!({"jobKey": job_key, "throughTurn": mem.through_turn, "background": true, "sessionKey": key}));
            }
        }
    } else if tm::jobs::active(&conn, &key).is_some() {
        // Background summaries were switched off: their queued job goes,
        // and this turn summarizes in the foreground as before.
        super::memory_worker::cancel(&key);
        let _ = tm::jobs::cancel_active(&conn, &key, "background summaries were switched off", now_ms());
    }
    if !batches.is_empty() && !settings.background_summaries {
        let model = RouteTextModel::new(ctx, route_plan, runtime_config);
        let count = |s: &str| meter.text(s);
        let input_limit = (context_budget.saturating_mul(2) / 3).clamp(1_500, 120_000);
        let out_tokens = max_output.min(4_096);
        let ids = tm::result_ids(&conn, &key);
        for (from, to) in batches {
            if super::wall_clock_timeout_reached(ctx, started_at) {
                break;
            }
            let _busy = tm::mark_summarizing(&key, from, to);
            event_bus::emit(callback, "memory.summarizing", &serde_json::json!({"fromTurn": from, "toTurn": to, "version": mem.version, "sessionKey": key}));
            let batch = &turns[(from - 1) as usize..to as usize];
            let mut slices: Vec<(u32, Vec<Message>)> = batch.iter().map(|t| (t.no, messages[t.start..t.end].to_vec())).collect();
            results::use_stored_originals(&mut slices, &|tu| ids.get(tu).and_then(|id| tm::load_result(&conn, &key, id)).map(|r| r.content));
            let now = now_ms();
            let job = tm::SummarizeJob { turns: &slices, from, to, input_limit, max_output: out_tokens, result_ids: &ids, now_ms: now, parts: None };
            with_tracked_goals(&conn, &key, &mut mem);
            match tm::summarize_range(&model, &mem, &job, &count).await {
                Ok(out) => {
                    summary_goal_ops(callback, &conn, &key, &out.update.goal_ops, from, to, &slices);
                    if !out.dropped_refs.is_empty() {
                        event_bus::emit(callback, "memory.dropped_refs", &serde_json::json!({"fromTurn": from, "toTurn": to, "dropped": out.dropped_refs, "sessionKey": key}));
                    }
                    if !out.auto_superseded.is_empty() {
                        event_bus::emit(callback, "memory.auto_superseded", &serde_json::json!({"fromTurn": from, "toTurn": to, "linked": out.auto_superseded, "sessionKey": key}));
                    }
                    let detail = serde_json::json!({
                        "fromTurn": from, "toTurn": to, "portions": out.portions, "calls": out.calls,
                        "readerCalls": out.reader_calls, "corrections": out.corrections, "droppedRefs": out.dropped_refs, "autoSuperseded": out.auto_superseded,
                        "current": out.memory.decisions.current.iter().map(|d| d.id.clone()).collect::<Vec<_>>(),
                        "superseded": out.memory.decisions.superseded.iter().filter(|d| !mem.decisions.superseded.iter().any(|p| p.id == d.id)).map(|d| serde_json::json!({"id": d.id, "by": d.superseded_by})).collect::<Vec<_>>(),
                    });
                    let base_for_rebuild = mem.clone();
                    let job = commit::CommitJob { session_key: &key, kind: "summary", detail, archive: Some(tm::ArchiveTurns { messages, turns: batch }), now_ms: now };
                    let outcome = commit::commit(&conn, job, mem.version, out.memory, commit::summary_rebuild(&base_for_rebuild, &out.update, from, to, now));
                    match outcome {
                        commit::CommitOutcome::Saved { version, tries } => {
                            mem = tm::load_memory(&conn, &key);
                            event_bus::emit(
                                callback,
                                "memory.updated",
                                &serde_json::json!({"fromTurn": from, "toTurn": to, "throughTurn": mem.through_turn, "version": version, "saveTries": tries, "portions": out.portions, "calls": out.calls, "readerCalls": out.reader_calls, "corrections": out.corrections, "segments": mem.segments.len(), "currentDecisions": mem.decisions.current.len(), "supersededDecisions": mem.decisions.superseded.len(), "sessionKey": key}),
                            );
                        }
                        commit::CommitOutcome::AlreadyDone { version } => {
                            mem = tm::load_memory(&conn, &key);
                            event_bus::emit(callback, "memory.updated", &serde_json::json!({"fromTurn": from, "toTurn": to, "throughTurn": mem.through_turn, "version": version, "alreadyDone": true, "sessionKey": key}));
                        }
                        commit::CommitOutcome::JobLost { .. } => break,
                        commit::CommitOutcome::Pending { reason, tries } => {
                            event_bus::emit(callback, "memory.pending", &serde_json::json!({"fromTurn": from, "toTurn": to, "reason": reason, "tries": tries, "message": commit::PENDING_TEXT, "sessionKey": key}));
                            mem = tm::load_memory(&conn, &key);
                            break;
                        }
                    }
                }
                Err(error) => {
                    if *ctx.abort_flag.lock().await {
                        add_usage(usage, model.take_usage());
                        // The UI showed "summarizing": tell it the batch stopped
                        // (nothing changed; it runs again next turn).
                        event_bus::emit(callback, "memory.cancelled", &serde_json::json!({"fromTurn": from, "toTurn": to, "sessionKey": key}));
                        return Err(NativeAgentError::Cancelled);
                    }
                    tracing::warn!(%error, "turn summary failed; sending those turns unsummarized");
                    let _ = tm::set_status(&conn, &key, "pending", &format!("{} ({})", commit::PENDING_TEXT, tm::clip(&error, 300)), now_ms());
                    event_bus::emit(callback, "memory.failed", &serde_json::json!({"fromTurn": from, "toTurn": to, "error": error, "message": commit::PENDING_TEXT, "sessionKey": key}));
                    break;
                }
            }
        }
        add_usage(usage, model.take_usage());
    }

    // Complete turns after the summary are archived too (upsert, a handful
    // of rows), so recall and repair evidence can read any finished turn.
    let tail: Vec<tm::Turn> = turns[mem.through_turn as usize..complete as usize].to_vec();
    if !tail.is_empty() {
        let _ = tm::archive_turns(&conn, &key, messages, &tail, now_ms());
    }
    let goal_state = tm::goals::load_state(&conn, &key);
    if mem.through_turn == 0 && goal_state.goals.is_empty() {
        // No memory block yet, but the checklist is always on: files and
        // #tags are tracked from the first turns, and a tag's context goes
        // to its last mention.
        return Ok(Some(checklist_only(&conn, &key, &mem, &goal_state, messages, &turns)));
    }
    // Before the first summary the block holds only the goals (every turn
    // is still in the view); nothing is folded.
    let fold_end = if mem.through_turn == 0 { turns[0].start } else { turns[(mem.through_turn - 1) as usize].end };
    // Messages before turn 1 (a legacy session summary) stay in the view,
    // ahead of the memory block: no summary covers them.
    let fold_start = turns[0].start;
    let full = messages.clone();
    let count = |s: &str| meter.text(s);
    // Selective injection (`select.rs`): the block holds what this request
    // needs, under the same token cap the whole memory had.
    let current = &turns[turns.len() - 1];
    let query = user_words(&messages[current.start..current.end]);
    let previous = if turns.len() >= 2 {
        let t = &turns[turns.len() - 2];
        user_words(&messages[t.start..t.end])
    } else {
        String::new()
    };
    let fts_turns = if mem.through_turn > 0 { tm::fts::search_turns(&conn, &key, &query, mem.through_turn, 12) } else { Vec::new() };
    let max_tokens = (context_budget / tm::MEMORY_BUDGET_DIVISOR).max(500);
    // Raw-vs-summary selection: the summary replaces its turns by default;
    // the turns the user chose to send as written come back right after the
    // memory block, in turn order, and a range sent "raw" leaves its
    // summary out of the block.
    let raw_sel = tm::raw_select::load(&conn, &key);
    let raw_plan = tm::raw_select::plan(&mem, &raw_sel);
    let block_mem = tm::raw_select::block_memory(&mem, &raw_plan);
    // The checklist (always on): every record is a row of the tree, with its
    // versions kept; picks and the #tags of the transcript (the last mention
    // of each) decide before relevance does, and every row gets the reason
    // it was or was not sent (the panel's colours).
    let mut turn_at: Vec<Option<u32>> = vec![None; messages.len()];
    for t in &turns {
        for slot in turn_at.iter_mut().take(t.end.min(messages.len())).skip(t.start) {
            *slot = Some(t.no);
        }
    }
    // A #tag whose last mention is in a turn still shown (after the summary)
    // gets its context there, once; it stays out of the block.
    let through = mem.through_turn;
    let (mem_rows, picks, anchors) = crate::context_tree::memory_checklist::prepare_anchored(&conn, &key, &block_mem, &goal_state, messages, &|i| turn_at.get(i).copied().flatten(), &|t| t > through, now_ms());
    crate::context_tree::memory_checklist::place_anchors(messages, &|i| turn_at.get(i).copied().flatten(), &anchors);
    let selection = tm::select::select_with(&tm::select::Input { mem: &block_mem, goals: &goal_state, query: &query, previous: &previous, fts_turns: &fts_turns, max_tokens }, &picks, &count);
    let _ = crate::context_tree::memory_checklist::save_status(&conn, &key, &selection, &picks, &mem_rows, now_ms());
    let block = tm::memory_block(&selection.text);
    let memory_tokens = meter.message(&block);
    let mut raw_msgs: Vec<Message> = Vec::new();
    let mut raw_turns: Vec<(u32, String)> = Vec::new();
    for &n in &raw_plan.raw_turns {
        let Some(t) = turns.get((n as usize).wrapping_sub(1)) else { continue };
        if n > mem.through_turn || t.start >= t.end || t.end > messages.len() {
            continue;
        }
        raw_turns.push((n, crate::context_tree::wiring::turn_head(&messages[t.start])));
        raw_msgs.extend(messages[t.start..t.end].iter().cloned());
    }
    let raw_tokens: usize = raw_msgs.iter().map(|m| meter.message(m)).sum();
    messages.splice(fold_start..fold_end, std::iter::once(block).chain(raw_msgs));
    event_bus::emit(
        callback,
        "memory.applied",
        &serde_json::json!({
            "throughTurn": mem.through_turn, "version": mem.version, "foldedMessages": fold_end - fold_start, "memoryTokens": memory_tokens, "keptTurns": complete - mem.through_turn,
            "rawTurns": raw_turns.iter().map(|(n, _)| *n).collect::<Vec<_>>(), "rawTokens": raw_tokens, "rawSkippedRanges": raw_plan.skip_ranges, "rawCapped": raw_plan.capped,
            "currentGoalId": goal_state.current().map(|g| g.goal_id.clone()),
            "selected": {"goals": selection.goal_ids, "decisions": selection.decision_ids, "tasks": selection.task_ids, "memory": selection.memory_ids, "segments": selection.segment_ids, "sources": selection.sources, "leftOut": selection.truncated},
            "checklist": {"anchored": anchors.iter().map(|a| serde_json::json!({"rid": a.rid, "tag": format!("#{}", a.tag), "turn": a.turn, "version": a.version})).collect::<Vec<_>>(), "picked": picks.include.iter().map(|(id, why)| serde_json::json!({"id": id, "why": why})).collect::<Vec<_>>(), "excluded": picks.exclude, "inactiveTags": picks.inactive, "versions": picks.extra.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>()},
            "sessionKey": key,
        }),
    );
    let mut fold = MemoryFold::new(full);
    fold.synced = messages.len();
    fold.injected = Some(Injected { version: mem.version, through_turn: mem.through_turn, selection, mem: block_mem, goals: goal_state, query, previous, fts_turns, picks, raw_turns });
    Ok(Some(fold))
}

/// The checklist of a chat with no memory block yet (nothing summarized, no
/// goals): files and versions are tracked, #tags recorded, and each active
/// tag's context is put at its last mention (every turn is in the view).
/// The returned fold keeps the transcript as written; only the view gets
/// the anchors.
fn checklist_only(conn: &rusqlite::Connection, key: &str, mem: &TurnMemory, goals: &tm::goals::GoalState, messages: &mut [Message], turns: &[tm::Turn]) -> MemoryFold {
    let full = messages.to_vec();
    let mut turn_at: Vec<Option<u32>> = vec![None; messages.len()];
    for t in turns {
        for slot in turn_at.iter_mut().take(t.end.min(messages.len())).skip(t.start) {
            *slot = Some(t.no);
        }
    }
    let (rows, picks, anchors) = crate::context_tree::memory_checklist::prepare_anchored(conn, key, mem, goals, messages, &|i| turn_at.get(i).copied().flatten(), &|_| true, now_ms());
    let _ = crate::context_tree::memory_checklist::save_status(conn, key, &tm::select::Selection::default(), &picks, &rows, now_ms());
    crate::context_tree::memory_checklist::place_anchors(messages, &|i| turn_at.get(i).copied().flatten(), &anchors);
    MemoryFold::new(full)
}

/// Tier 2 of overflow compaction: one model call shortens long old assistant
/// explanations in place. Returns how many were shortened.
pub(super) async fn shorten_explanations(ctx: &AgentLoopContext<'_>, route_plan: &RoutePlan, runtime_config: &AgentRuntimeConfig, messages: &mut [Message], meter: &TokenMeter, usage: &mut TokenUsage) -> usize {
    let count = |s: &str| meter.text(s);
    let items = super::compaction::long_explanations(messages, &count, 24);
    if items.is_empty() {
        return 0;
    }
    let model = RouteTextModel::new(ctx, route_plan, runtime_config);
    let r = model.complete(super::compaction::EXPLANATION_SYSTEM, super::compaction::explanation_prompt(&items), 2_048).await;
    add_usage(usage, model.take_usage());
    match r {
        Ok(answer) => super::compaction::apply_explanations(messages, &items, &answer),
        Err(e) => {
            tracing::warn!(error = %e, "could not shorten explanations");
            0
        }
    }
}

pub(super) fn unavailable(id: &str) -> String {
    format!("Result #{} is unavailable: its original is no longer stored (the chat was deleted or reset, or the ID is wrong). Do not guess its content; run the tool again if you need it.", id.trim().trim_start_matches('#'))
}

/// A result storage cleanup removed: when and why (Phase 6).
pub(super) fn pruned_text(id: &str, at_ms: i64, reason: &str) -> String {
    let day = chrono::DateTime::from_timestamp_millis(at_ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
    format!("Result #{} is unavailable: storage cleanup removed it on {} because {}. Do not guess its content; run the tool again if you need it.", id, day, reason)
}

/// Read a stored tool result: in parts, or searched in full with a question.
#[allow(clippy::too_many_arguments)]
async fn recall_result(ctx: &AgentLoopContext<'_>, route_plan: &RoutePlan, runtime_config: &AgentRuntimeConfig, id: &str, input: &serde_json::Value, meter: &TokenMeter, context_budget: usize, used_tokens: usize, max_output: u32, usage: &mut TokenUsage) -> (String, bool) {
    let stored = match crate::db::open_db(&ctx.config.db_path) {
        Ok(conn) => tm::load_result(&conn, &ctx.session_key, id),
        Err(e) => return (format!("Could not open the chat archive: {}", e), true),
    };
    let Some(r) = stored else {
        let pruned = crate::db::open_db(&ctx.config.db_path).ok().and_then(|c| tm::retention::pruned_info(&c, &ctx.session_key, id));
        return (pruned.map(|(rid, at, reason, _)| pruned_text(&rid, at, &reason)).unwrap_or_else(|| unavailable(id)), true);
    };
    let count = |s: &str| meter.text(s);
    let big = results::BigResult { tool_use_id: r.tool_use_id.clone(), result_id: r.id.clone(), tool_name: r.tool_name.clone(), source: r.source.clone(), content: r.content.clone() };
    if let Some(q) = input.get("question").and_then(|v| v.as_str()).map(str::trim).filter(|q| !q.is_empty()) {
        let model = RouteTextModel::new(ctx, route_plan, runtime_config);
        let room = (context_budget.saturating_mul(2) / 3).clamp(1_500, 120_000);
        let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let res = results::ask_result(&model, &big, q, offset, room, max_output, &count, results::MAX_READER_CALLS).await;
        add_usage(usage, model.take_usage());
        return match res {
            Ok((text, _)) => (text, false),
            Err(e) => (format!("The reader sub-agent failed: {}. Call {} again with result_id and offset to read the text.", e, tm::RECALL_TOOL), true),
        };
    }
    let all = &r.content;
    let mut offset = (input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize).min(all.len());
    while !all.is_char_boundary(offset) {
        offset -= 1;
    }
    let rest = &all[offset..];
    let limit = crate::read_budget::read_limit(None, context_budget, used_tokens);
    let cut = crate::read_budget::cut_point(rest, limit, &count);
    let src = r.source.as_deref().map(|s| format!(" {}", s)).unwrap_or_default();
    let header = if cut < rest.len() {
        format!("[result #{} · {}{} · bytes {}-{} of {} · more remains: call {} with result_id \"{}\" and offset {}]\n", r.id, r.tool_name, src, offset, offset + cut, all.len(), tm::RECALL_TOOL, r.id, offset + cut)
    } else {
        format!("[result #{} · {}{} · bytes {}-{} of {} · complete]\n", r.id, r.tool_name, src, offset, all.len(), all.len())
    };
    (format!("{}{}", header, &rest[..cut]), r.is_error)
}

/// Verify and apply repair proposals; one line per proposal.
fn handle_repairs(conn: &rusqlite::Connection, key: &str, proposals: &[serde_json::Value], callback: Option<&dyn crate::NativeEventCallback>) -> Vec<String> {
    let mut out = Vec::new();
    for raw in proposals.iter().take(2) {
        let mem = tm::load_memory(conn, key);
        let p = match repair::parse_proposal(raw) {
            Ok(p) => p,
            Err(e) => {
                out.push(format!("Repair proposal dropped: {}.", e));
                continue;
            }
        };
        let (lo, hi) = p.evidence.iter().fold((u32::MAX, 0), |(a, b), (t, _)| (a.min(*t), b.max(*t)));
        // Evidence is checked against the transcript (source of truth).
        let originals = if hi == 0 { Vec::new() } else { tm::source::load_source_turns(conn, key, lo, hi).turns };
        if let Err(e) = repair::check_proposal(&mem, &p, &originals) {
            event_bus::emit(callback, "memory.repair_rejected", &serde_json::json!({"reason": e, "sessionKey": key}));
            out.push(format!("Repair proposal dropped: {}.", e));
            continue;
        }
        let now = now_ms();
        let (next, detail) = match repair::apply_proposal(&mem, &p, now) {
            Ok(x) => x,
            Err(e) => {
                out.push(format!("Repair proposal dropped: {}.", e));
                continue;
            }
        };
        let p2 = p.clone();
        let rebuild = move |latest: &TurnMemory| match repair::check_proposal(latest, &p2, &originals).and_then(|_| repair::apply_proposal(latest, &p2, now)) {
            Ok((m, _)) => commit::Rebuild::Ready(m),
            Err(e) => commit::Rebuild::Invalid(e),
        };
        let job = commit::CommitJob { session_key: key, kind: "repair", detail: detail.clone(), archive: None, now_ms: now };
        match commit::commit(conn, job, mem.version, next, rebuild) {
            commit::CommitOutcome::Saved { version, .. } => {
                event_bus::emit(callback, "memory.repaired", &serde_json::json!({"version": version, "detail": detail, "sessionKey": key}));
                out.push(format!("Memory repaired as version {} ({}); the user can revert it.", version, detail.get("kind").and_then(|k| k.as_str()).unwrap_or("change")));
            }
            other => out.push(format!("Repair verified but not saved: {:?}.", other)),
        }
    }
    out
}

/// Turns one `recall_turns` call reads at most; the rest is reported as not
/// read, with the call that reads it.
pub(super) const MAX_RECALL_TURNS: u32 = 200;

/// Turns taken from the full-text index for one recall question.
pub(super) const FTS_RECALL_HITS: usize = 12;

/// `recall_turns`: a stored tool result, the original turns as text (paged),
/// or an answer from recall sub-agents that read the turns the memory's
/// index points at.
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
    if let Some(id) = input.get("result_id").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        return recall_result(ctx, route_plan, runtime_config, id, input, meter, context_budget, used_tokens, max_output.min(2_048), usage).await;
    }
    let num = |k: &str| input.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())));
    let question = input.get("question").and_then(|v| v.as_str()).map(str::trim).filter(|q| !q.is_empty());
    let conn = match crate::db::open_db(&ctx.config.db_path) {
        Ok(c) => c,
        Err(e) => return (format!("Could not open the chat archive: {}", e), true),
    };
    let mem = tm::load_memory(&conn, &ctx.session_key);
    let mut via_index = String::new();
    // Turns asked for but not read in this call; always reported (Phase 5:
    // no silent truncation).
    let mut unread: Vec<(u32, u32)> = Vec::new();
    let ranges: Vec<(u32, u32)> = match num("from_turn") {
        Some(f) => {
            let from = f.max(1) as u32;
            let to = num("to_turn").map(|n| n as u32).unwrap_or(from).max(from);
            let end = to.min(from + MAX_RECALL_TURNS - 1);
            if end < to {
                unread.push((end + 1, to));
            }
            vec![(from, end)]
        }
        None => {
            let Some(q) = question else {
                return ("Pass from_turn (and to_turn), or a question, or a result_id.".into(), true);
            };
            let by_index = tm::select_segments(&mem, q, 40);
            // Full-text search of the original turns (schema v5) finds what
            // the model-written index left out; merged with the index hits.
            let by_text = tm::fts::search_turns(&conn, &ctx.session_key, q, mem.through_turn, FTS_RECALL_HITS);
            let picked = tm::fts::merge_hits(&by_index, &by_text);
            if picked.is_empty() {
                if mem.through_turn == 0 {
                    return ("Nothing is summarized in this chat yet; the whole conversation is still in your context.".into(), false);
                }
                let end = mem.through_turn.min(MAX_RECALL_TURNS);
                if end < mem.through_turn {
                    unread.push((end + 1, mem.through_turn));
                }
                via_index = format!("No segment of the index matched, so summarized turns 1-{} were read.\n", end);
                vec![(1, end)]
            } else {
                via_index = String::new();
                if !by_index.is_empty() {
                    via_index.push_str(&format!("Found in the memory index: {}.\n", tm::source::ranges_text(&by_index)));
                }
                if !by_text.is_empty() {
                    let mut t = by_text.clone();
                    t.sort_unstable();
                    via_index.push_str(&format!("Found by full-text search of the original turns: {}.\n", tm::source::ranges_text(&tm::source::ranges(&t))));
                }
                // Cap the total, keeping whole ranges in index order.
                let mut kept = Vec::new();
                let mut total = 0u32;
                for (a, b) in picked {
                    let room = MAX_RECALL_TURNS.saturating_sub(total);
                    if room == 0 {
                        unread.push((a, b));
                        continue;
                    }
                    let end = b.min(a + room - 1);
                    if end < b {
                        unread.push((end + 1, b));
                    }
                    total += end - a + 1;
                    kept.push((a, end));
                }
                kept
            }
        }
    };
    let mut turns: Vec<(u32, Vec<Message>)> = Vec::new();
    let mut from_archive: Vec<u32> = Vec::new();
    let mut missing: Vec<(u32, u32)> = Vec::new();
    let mut differs: Vec<u32> = Vec::new();
    for (a, b) in &ranges {
        let src = tm::source::load_source_turns(&conn, &ctx.session_key, *a, *b);
        from_archive.extend(src.from_archive());
        missing.extend(src.missing.iter().copied());
        differs.extend(src.archive_differs.iter().copied());
        turns.extend(src.turns);
    }
    if turns.is_empty() {
        let r = ranges.iter().map(|(a, b)| format!("{}-{}", a, b)).collect::<Vec<_>>().join(", ");
        return (format!("No stored turns {} in this chat. Stored (summarized) turns are 1-{}; the memory's turn index lists them.", r, mem.through_turn), true);
    }
    // Where the text came from, and what was not read, said by code.
    let source_note = {
        let mut lines = Vec::new();
        if !from_archive.is_empty() {
            lines.push(format!("Read from the memory archive (no longer in the transcript): {}.", tm::source::ranges_text(&tm::source::ranges(&from_archive))));
        }
        if !differs.is_empty() {
            lines.push(format!("The archived copy of {} differs from the transcript; the transcript was used.", tm::source::ranges_text(&tm::source::ranges(&differs))));
        }
        if !missing.is_empty() {
            lines.push(format!("Not stored anywhere: {}.", tm::source::ranges_text(&missing)));
        }
        if lines.is_empty() { String::new() } else { format!("{}\n", lines.join("\n")) }
    };
    let unread_note = |extra: &[(u32, u32)]| {
        let mut all: Vec<(u32, u32)> = unread.iter().chain(extra.iter()).copied().collect();
        all.sort_unstable();
        all.dedup();
        if all.is_empty() {
            String::new()
        } else {
            let (a, b) = all[0];
            format!("\nNOT READ in this call: {}. Call {} again with from_turn {} and to_turn {} (and the same question) to read them.", tm::source::ranges_text(&all), tm::RECALL_TOOL, a, b)
        }
    };
    let ids = tm::result_ids(&conn, &ctx.session_key);
    let texts: Vec<(u32, String)> = turns
        .iter()
        .map(|(n, m)| {
            // Results already stored by ID are shown as references here; the
            // recall answer can point at them.
            let digests: std::collections::HashMap<String, String> = m
                .iter()
                .filter_map(|x| match &x.content {
                    crate::types::MessageContent::Blocks(bs) => Some(bs),
                    _ => None,
                })
                .flatten()
                .filter_map(|b| match b {
                    crate::types::ContentBlock::ToolResult { tool_use_id, content, .. } if content.len() > 200_000 => ids.get(tool_use_id).map(|id| (tool_use_id.clone(), results::reference_text(id, "tool", None, content.len()))),
                    _ => None,
                })
                .collect();
            (*n, tm::render_turn_with(*n, m, &digests))
        })
        .collect();
    let turn_nos: Vec<u32> = turns.iter().map(|t| t.0).collect();
    let count = |s: &str| meter.text(s);
    if let Some(q) = question {
        let model = RouteTextModel::new(ctx, route_plan, runtime_config);
        let input_limit = (context_budget.saturating_mul(2) / 3).clamp(1_500, 120_000);
        let r = tm::recall(&model, &mem, &texts, q, input_limit, max_output.min(2_048), &count).await;
        add_usage(usage, model.take_usage());
        return match r {
            Ok(out) => {
                let mut s = format!("{}{}Recall from the original messages ({} recall sub-agent call{}):\n{}", via_index, source_note, out.calls, if out.calls == 1 { "" } else { "s" }, out.answer.trim());
                let summaries = tm::stored_summaries_note(&mem, &ranges);
                if !summaries.is_empty() {
                    s.push_str(&format!("\n{}", summaries.trim_end()));
                }
                let checked: Vec<String> = out
                    .citations
                    .iter()
                    .filter(|c| !c.quote.is_empty())
                    .map(|c| {
                        let ok = turns.iter().any(|(n, m)| *n == c.turn && tm::render_turn(*n, m).split_whitespace().collect::<Vec<_>>().join(" ").contains(&c.quote.split_whitespace().collect::<Vec<_>>().join(" ")));
                        format!("- turn {}: \"{}\"{}", c.turn, tm::clip(&c.quote, 200), if ok { "" } else { " (quote not found verbatim in that turn)" })
                    })
                    .collect();
                if !checked.is_empty() {
                    s.push_str(&format!("\nSources:\n{}", checked.join("\n")));
                }
                let status = tm::status_lines(&mem, &turn_nos);
                if !status.is_empty() {
                    s.push_str(&format!("\nStatus in the memory (version {}):\n- {}", mem.version, status.join("\n- ")));
                }
                let reps = handle_repairs(&conn, &ctx.session_key, &out.repairs, ctx.callback.as_deref());
                if !reps.is_empty() {
                    s.push_str(&format!("\n{}", reps.join("\n")));
                }
                s.push_str(&unread_note(&out.unread));
                (s, false)
            }
            Err(e) => (format!("The recall sub-agent failed: {}. Call {} again without question to read the original text.", e, tm::RECALL_TOOL), true),
        };
    }
    let all = texts.into_iter().map(|t| t.1).collect::<Vec<_>>().join("\n");
    let mut offset = (num("offset").unwrap_or(0) as usize).min(all.len());
    while !all.is_char_boundary(offset) {
        offset -= 1;
    }
    let rest = &all[offset..];
    let limit = crate::read_budget::read_limit(None, context_budget, used_tokens);
    let cut = crate::read_budget::cut_point(rest, limit, &count);
    let part = &rest[..cut];
    let r = ranges.iter().map(|(a, b)| format!("{}-{}", a, b)).collect::<Vec<_>>().join(", ");
    let header = if cut < rest.len() {
        format!("Original messages of turns {}, bytes {}-{} of {}. More remains: call {} again with offset {}.\n", r, offset, offset + cut, all.len(), tm::RECALL_TOOL, offset + cut)
    } else {
        format!("Original messages of turns {} (bytes {}-{} of {}, complete).\n", r, offset, all.len(), all.len())
    };
    let status = tm::status_lines(&mem, &turn_nos);
    let status = if status.is_empty() { String::new() } else { format!("Status in the memory (version {}):\n- {}\n", mem.version, status.join("\n- ")) };
    // The original range summaries (immutable) beside the original turns,
    // on the first part only.
    let summaries = if offset == 0 { tm::stored_summaries_note(&mem, &ranges) } else { String::new() };
    (format!("{}{}{}{}{}{}{}", via_index, source_note, summaries, header, status, part, unread_note(&[])), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizer_retry_budget_and_reasoning_rejection() {
        assert_eq!(summarizer_retry_budget(4_096), 8_192);
        assert_eq!(summarizer_retry_budget(6_000), 12_000);
        assert_eq!(summarizer_retry_budget(12_000), 16_384);
        assert_eq!(summarizer_retry_budget(20_000), 20_000);
        use crate::llm_driver::LlmError;
        assert!(rejects_reasoning_hint(&LlmError::Api { status: 400, message: "Unrecognized request argument supplied: reasoning".into() }));
        assert!(rejects_reasoning_hint(&LlmError::Api { status: 400, message: "Reasoning is mandatory for this endpoint and cannot be disabled.".into() }));
        assert!(!rejects_reasoning_hint(&LlmError::Api { status: 400, message: "maximum context length is 32768 tokens".into() }));
        assert!(!rejects_reasoning_hint(&LlmError::Api { status: 429, message: "reasoning rate limit".into() }));
    }
    use crate::types::{MessageContent, Role};

    fn text(role: Role, t: &str) -> Message {
        Message { role, content: MessageContent::Text(t.to_string()) }
    }

    /// W-1: a session summary that is part of the STORED transcript (written
    /// by overflow compaction before turn memory was on) is the only record
    /// of the turns it replaced. `finish` must keep it.
    #[test]
    fn w1_finish_keeps_a_legacy_session_summary_from_the_stored_transcript() {
        let legacy = super::super::session_summary_message("LEGACY-SUMMARY decided to use port 8443");
        let stored = vec![legacy.clone(), Message::user("q1"), text(Role::Assistant, "a1"), Message::user("q2")];
        let fold = MemoryFold::new(stored.clone());
        let mut view = stored.clone();
        view.push(text(Role::Assistant, "a2"));
        let saved = fold.finish(&view);
        assert!(saved.iter().any(|m| m.text().contains("LEGACY-SUMMARY")), "legacy session summary deleted from the stored transcript");
        assert_eq!(saved.len(), 5);
        assert_eq!(serde_json::to_value(&saved[..4]).unwrap(), serde_json::to_value(&stored[..]).unwrap());
    }

    /// An overflow summary made during THIS turn lives only in the view; the
    /// stored transcript keeps the originals instead.
    #[test]
    fn finish_does_not_store_a_summary_made_for_the_view() {
        let stored = vec![Message::user("q1"), text(Role::Assistant, "a1"), Message::user("q2")];
        let mut fold = MemoryFold::new(stored.clone());
        let mut view = stored.clone();
        view.push(text(Role::Assistant, "a2"));
        fold.sync(&view);
        // Overflow compaction replaces the view's prefix with a new summary.
        let mut view = vec![super::super::session_summary_message("NEW-VIEW-SUMMARY"), Message::user("q2"), text(Role::Assistant, "a2")];
        fold.synced = view.len();
        view.push(text(Role::Assistant, "a3"));
        let saved = fold.finish(&view);
        assert!(!saved.iter().any(|m| m.text().contains("NEW-VIEW-SUMMARY")));
        assert_eq!(saved.len(), 5);
        assert_eq!(saved[0].text(), "q1");
    }

    #[test]
    fn take_original_strips_the_private_field_and_builds_the_full_result() {
        let val = serde_json::json!({"exitCode": 0, "stdout": "short…", "stderr": "", "stdoutTruncated": true, "stderrTruncated": false, "timedOut": false,
            "_original": {"stdout": "THE WHOLE OUTPUT", "stderr": "", "stdoutBytes": 16, "stderrBytes": 0, "originalTruncated": false}});
        let (shown, full) = take_original(val);
        assert!(shown.get("_original").is_none(), "the private field must never reach the model");
        assert_eq!(shown["stdout"], "short…");
        let full: serde_json::Value = serde_json::from_str(&full.unwrap()).unwrap();
        assert_eq!(full["stdout"], "THE WHOLE OUTPUT");
        assert_eq!(full["stdoutTruncated"], false);
        assert_eq!(full["storedOriginal"], true);
        assert_eq!(full["original"]["stdoutBytes"], 16);
        let (plain, none) = take_original(serde_json::json!({"stdout": "x"}));
        assert!(none.is_none());
        assert_eq!(plain["stdout"], "x");
    }

    #[test]
    fn note_original_points_at_the_stored_result() {
        let shown = r#"{"stdout":"cut","stdoutTruncated":true}"#;
        let full = serde_json::json!({"stdout": "x".repeat(200_000), "original": {"originalTruncated": true}}).to_string();
        let out: serde_json::Value = serde_json::from_str(&note_original(shown, "R4", &full)).unwrap();
        let note = out["fullOutput"].as_str().unwrap();
        assert!(note.contains("R4") && note.contains(tm::RECALL_TOOL) && note.contains("storage limit"), "{note}");
        assert_eq!(out["stdout"], "cut");
    }
}
