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


/// Tool results at least this large are stored by result ID when they
/// arrive, so a reference to them always resolves.
pub(super) const STORE_RESULT_MIN_BYTES: usize = 1_024;

/// Store a tool result the moment it arrives, before any read budget or
/// compaction touches it. Returns its stable result ID ("R12").
pub(super) fn store_result(ctx: &AgentLoopContext<'_>, tool_use_id: &str, tool_name: &str, input: &serde_json::Value, content: &str, is_error: bool, turn: u32) -> Option<String> {
    if content.len() < STORE_RESULT_MIN_BYTES || tool_name == tm::RECALL_TOOL {
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
    let full_copy = || Some(MemoryFold { full: messages.clone(), synced: messages.len() });
    let turns = tm::split_turns(messages);
    if turns.len() < 2 {
        return Ok(full_copy());
    }
    let complete = turns.len() as u32 - 1;
    let key = ctx.session_key.clone();
    let Ok(conn) = crate::db::open_db(&ctx.config.db_path) else {
        return Ok(full_copy());
    };
    let mut mem = tm::load_memory(&conn, &key);
    if mem.through_turn > complete {
        // The transcript is shorter than the summary (messages were deleted
        // or the chat was reset): start the memory again, as a version.
        let _ = tm::reset_memory(&conn, &key, &format!("the transcript has {} complete turns but the summary covered {}", complete, mem.through_turn), now_ms());
        mem = tm::load_memory(&conn, &key);
    }

    let batches = tm::plan_batches(complete, mem.through_turn, &settings);
    if batches.is_empty() && tm::load_status(&conn, &key).status != "ok" {
        let _ = tm::set_status(&conn, &key, "ok", "", now_ms());
    }
    if !batches.is_empty() {
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
            let slices: Vec<(u32, Vec<Message>)> = batch.iter().map(|t| (t.no, messages[t.start..t.end].to_vec())).collect();
            let now = now_ms();
            let job = tm::SummarizeJob { turns: &slices, from, to, input_limit, max_output: out_tokens, result_ids: &ids, now_ms: now };
            match tm::summarize_range(&model, &mem, &job, &count).await {
                Ok(out) => {
                    let detail = serde_json::json!({
                        "fromTurn": from, "toTurn": to, "portions": out.portions, "calls": out.calls,
                        "readerCalls": out.reader_calls, "corrections": out.corrections,
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
    if mem.through_turn == 0 {
        return Ok(full_copy());
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
        &serde_json::json!({"throughTurn": mem.through_turn, "version": mem.version, "foldedMessages": fold_end, "memoryTokens": memory_tokens, "keptTurns": complete - mem.through_turn, "sessionKey": key}),
    );
    Ok(Some(MemoryFold { full, synced: messages.len() }))
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
    format!("Result #{} is unavailable: its original is no longer stored (only a deleted chat removes stored results, or the ID is wrong). Do not guess its content; run the tool again if you need it.", id.trim().trim_start_matches('#'))
}

/// Read a stored tool result: in parts, or searched in full with a question.
#[allow(clippy::too_many_arguments)]
async fn recall_result(ctx: &AgentLoopContext<'_>, route_plan: &RoutePlan, runtime_config: &AgentRuntimeConfig, id: &str, input: &serde_json::Value, meter: &TokenMeter, context_budget: usize, used_tokens: usize, max_output: u32, usage: &mut TokenUsage) -> (String, bool) {
    let stored = match crate::db::open_db(&ctx.config.db_path) {
        Ok(conn) => tm::load_result(&conn, &ctx.session_key, id),
        Err(e) => return (format!("Could not open the chat archive: {}", e), true),
    };
    let Some(r) = stored else {
        return (unavailable(id), true);
    };
    let count = |s: &str| meter.text(s);
    let big = results::BigResult { tool_use_id: r.tool_use_id.clone(), result_id: r.id.clone(), tool_name: r.tool_name.clone(), source: r.source.clone(), content: r.content.clone() };
    if let Some(q) = input.get("question").and_then(|v| v.as_str()).map(str::trim).filter(|q| !q.is_empty()) {
        let model = RouteTextModel::new(ctx, route_plan, runtime_config);
        let room = (context_budget.saturating_mul(2) / 3).clamp(1_500, 120_000);
        let res = results::ask_result(&model, &big, q, room, max_output, &count, results::MAX_READER_CALLS).await;
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
        let originals = if hi == 0 { Vec::new() } else { tm::load_turns(conn, key, lo, hi) };
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
    let ranges: Vec<(u32, u32)> = match num("from_turn") {
        Some(f) => {
            let from = f.max(1) as u32;
            let to = num("to_turn").map(|n| n as u32).unwrap_or(from).max(from);
            if to - from > 200 {
                return ("Ask for at most 200 turns at a time.".into(), true);
            }
            vec![(from, to)]
        }
        None => {
            let Some(q) = question else {
                return ("Pass from_turn (and to_turn), or a question, or a result_id.".into(), true);
            };
            let picked = tm::select_segments(&mem, q, 40);
            if picked.is_empty() {
                if mem.through_turn == 0 {
                    return ("Nothing is summarized in this chat yet; the whole conversation is still in your context.".into(), false);
                }
                via_index = format!("No segment of the index matched, so all summarized turns 1-{} were read.\n", mem.through_turn.min(200));
                vec![(1, mem.through_turn.min(200))]
            } else {
                via_index = format!(
                    "Found in the memory index: {}.\n",
                    picked.iter().map(|(a, b)| if a == b { format!("turn {}", a) } else { format!("turns {}-{}", a, b) }).collect::<Vec<_>>().join(", ")
                );
                picked
            }
        }
    };
    let mut turns: Vec<(u32, Vec<Message>)> = Vec::new();
    for (a, b) in &ranges {
        turns.extend(tm::load_turns(&conn, &ctx.session_key, *a, *b));
    }
    if turns.is_empty() {
        let r = ranges.iter().map(|(a, b)| format!("{}-{}", a, b)).collect::<Vec<_>>().join(", ");
        return (format!("No stored turns {} in this chat. Stored (summarized) turns are 1-{}; the memory's turn index lists them.", r, mem.through_turn), true);
    }
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
                let mut s = format!("{}Recall from the original messages ({} recall sub-agent call{}):\n{}", via_index, out.calls, if out.calls == 1 { "" } else { "s" }, out.answer.trim());
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
    (format!("{}{}{}{}", via_index, header, status, part), false)
}
