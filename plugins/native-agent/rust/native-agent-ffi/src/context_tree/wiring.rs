//! The seam between the engine and the tree.
//!
//! Everything in this module exists so the agent loop has to learn **three** small
//! things instead of the whole feature:
//!
//! ```text
//! wiring::enabled(db, session)          -> is the tree on for this session?
//! wiring::before_request(db, session, …) -> the checklist to append + the states to apply
//! wiring::handle_tool(db, session, args) -> the JSON answer to a `ctx` call
//! ```
//!
//! It opens its own `Connection` to the session database: the tree is an index, so
//! a second connection is safe, and it keeps the feature completely out of the
//! agent loop's borrow of its own store. Every function here is `pub(crate)`-safe to
//! call from `agent_loop` and does nothing at all when the feature is off.
//!
//! The flag lives in the tree's own `ctx_meta` table (`enabled` = `0`/`1`), so
//! turning the feature on is a database write today and a settings toggle later —
//! no rebuild, and `main` can merge with it off.

use rusqlite::{Connection, OptionalExtension};

use super::assemble::{self, Assembly};
use super::budget::{Budget, BudgetInput};
use super::dispatch::{self, CtxEnv, Recall};
use super::model::Node;
use super::reading::{self, ReadItem};
use super::render::{CategoryBlock, ResumeInput};
use super::store;

use std::collections::BTreeSet;

use crate::types::Message;

// There is deliberately no process-wide "active" flag or "current request"
// here any more. Two sessions run at once (a chat and its sub-agents, or two
// chats), and a global switch let one session's state decide another one's tool
// list and `ctx` answers. The agent loop now owns the per-request facts and
// answers `ctx` calls itself through [`handle_tool`], with its own session key.

/// Index the transcript **view** (what this request would send) into items.
///
/// Turns come from the engine's own splitter. `turn_offset` is the number of
/// whole turns that are no longer in the view because memory folded them into
/// its summary (or compaction cut them): the first turn of the view is turn
/// `turn_offset + 1` of the chat, so the ids match `turn_archive` and `recall`
/// finds the same turn later. Without the offset the numbers restarted at 1
/// after every fold, and the same id named a different turn on each step.
///
/// Every turn that is in the view starts **in**: it is being sent right now. The
/// policy (and the model) take turns out from there; a turn that was already
/// taken out keeps its state, because reconciliation never overwrites a state.
pub fn items_from_messages(messages: &[Message], meter: &crate::tokens::TokenMeter, turn_offset: u32) -> Vec<ReadItem> {
    let turns = crate::turn_memory::split_turns(messages);
    let mut out = Vec::new();
    for turn in &turns {
        let end = turn.end.min(messages.len());
        let slice = if turn.start < end { &messages[turn.start..end] } else { &messages[0..0] };
        let prompt = slice.first().map(|m| m.text()).unwrap_or_default();
        let total: u32 = slice.iter().map(|m| meter.message(m)).sum::<usize>().min(u32::MAX as usize) as u32;
        let title: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
        let n = turn_offset + turn.no;
        // Each tool call with its result is a node of its own under the turn, so
        // it can be taken out alone. The turn carries the rest (prompt, answers).
        let parts = call_parts(slice, meter);
        let parts_tokens: u32 = parts.iter().map(|p| p.tokens).sum();
        out.push(ReadItem::turn(
            n,
            if title.is_empty() { "(empty turn)" } else { title.as_str() },
            total.saturating_sub(parts_tokens).max(1),
            true,
        ));
        for p in parts {
            out.push(ReadItem::turn_part(n, p.index, &p.title, p.tokens.max(1)));
        }
    }
    out
}

/// One tool call of a turn: its 1-based index, the tool_use id, a title and the
/// tokens of the call plus its result.
#[derive(Debug, Clone)]
pub struct CallPart {
    pub index: u32,
    pub id: String,
    pub title: String,
    pub tokens: u32,
}

/// The tool_use ids of one turn's messages with their 1-based index, numbered
/// the same way as [`call_parts`].
pub fn call_ids(slice: &[Message]) -> Vec<(u32, String)> {
    use crate::types::{ContentBlock, MessageContent, Role};
    let mut out = Vec::new();
    for m in slice.iter().filter(|m| m.role == Role::Assistant) {
        if let MessageContent::Blocks(blocks) = &m.content {
            for b in blocks {
                if let ContentBlock::ToolUse { id, .. } = b {
                    out.push((out.len() as u32 + 1, id.clone()));
                }
            }
        }
    }
    out
}

/// The tool calls of one turn's messages, in the order they were made, each
/// with the tokens of its call and of its result.
pub fn call_parts(slice: &[Message], meter: &crate::tokens::TokenMeter) -> Vec<CallPart> {
    use crate::types::{ContentBlock, MessageContent, Role};
    let mut parts: Vec<CallPart> = Vec::new();
    for m in slice {
        let MessageContent::Blocks(blocks) = &m.content else { continue };
        for b in blocks {
            match b {
                ContentBlock::ToolUse { id, name, input, .. } if m.role == Role::Assistant => {
                    let args = input.to_string();
                    let short: String = args.chars().take(48).collect();
                    let title = if args == "{}" || args == "null" { name.clone() } else { format!("{name} {short}") };
                    let tokens = meter.text(&serde_json::to_string(b).unwrap_or_default()) as u32;
                    parts.push(CallPart { index: parts.len() as u32 + 1, id: id.clone(), title, tokens });
                }
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    let tokens = meter.text(&serde_json::to_string(b).unwrap_or_default()) as u32;
                    if let Some(p) = parts.iter_mut().find(|p| &p.id == tool_use_id) {
                        p.tokens = p.tokens.saturating_add(tokens);
                    }
                }
                _ => {}
            }
        }
    }
    parts
}

/// Whole turns that are not in the view: the chat has `total_turns` turns and the
/// view shows `split_turns(view).len()` of them, always the newest ones.
pub fn turn_offset(view: &[Message], total_turns: u32) -> u32 {
    let in_view = crate::turn_memory::split_turns(view).len() as u32;
    total_turns.saturating_sub(in_view)
}

/// Tokens of the parts of the view that are **not** turns (the memory block, a
/// continuity summary, anything before the first prompt). They are sent but no
/// node stands for them, so the budget has to count them as locked.
pub fn untracked_view_tokens(view: &[Message], meter: &crate::tokens::TokenMeter) -> usize {
    let turns = crate::turn_memory::split_turns(view);
    let first = turns.first().map(|t| t.start).unwrap_or(view.len());
    view[..first.min(view.len())].iter().filter(|m| summary_kind(m).is_none()).map(|m| meter.message(m)).sum()
}

/// Which chat summary a message before the first turn is, if it is one.
fn summary_kind(m: &Message) -> Option<&'static str> {
    if crate::turn_memory::is_memory_message(m) {
        return Some("memory");
    }
    match &m.content {
        crate::types::MessageContent::Text(t) if m.role == crate::types::Role::Context && t.starts_with(crate::agent_loop::CONTEXT_SUMMARY_MARKER) => Some("chat"),
        _ => None,
    }
}

/// The chat summaries the view sends ahead of its first turn, as items: the
/// continuity summary written when the chat was summarized (`sum/1-N`, N = the
/// last turn it covers) and the memory block of range summaries (`sum/memory`).
/// Before this they were sent but invisible: the window lost the summarized
/// turns and showed nothing in their place. Their tokens are no longer counted
/// as locked ([`untracked_view_tokens`]) because the nodes now carry them.
pub fn summary_items(view: &[Message], meter: &crate::tokens::TokenMeter, turn_offset: u32) -> Vec<ReadItem> {
    let turns = crate::turn_memory::split_turns(view);
    let first = turns.first().map(|t| t.start).unwrap_or(view.len()).min(view.len());
    let mut chat_tokens = 0usize;
    let mut memory_tokens = 0usize;
    for m in &view[..first] {
        match summary_kind(m) {
            Some("chat") => chat_tokens += meter.message(m),
            Some(_) => memory_tokens += meter.message(m),
            None => {}
        }
    }
    let mut out = Vec::new();
    if chat_tokens > 0 {
        let (id, title) = if turn_offset > 0 {
            (format!("sum/1-{turn_offset}"), format!("Summary of turns 1-{turn_offset}"))
        } else {
            ("sum/chat".to_string(), "Summary of earlier turns".to_string())
        };
        out.push(ReadItem::chat_summary(&id, &title, chat_tokens.min(u32::MAX as usize) as u32, 0));
    }
    if memory_tokens > 0 {
        out.push(ReadItem::chat_summary("sum/memory", "Chat memory: summaries of earlier turns", memory_tokens.min(u32::MAX as usize) as u32, 1));
    }
    out
}

/// The turn base of a session (see [`store::turn_base`]); 0 when the tree's
/// tables cannot be read.
pub fn turn_base(db_path: &str, session_key: &str) -> u32 {
    // A plain read: with the tree never used there is no `ctx_meta` table, the
    // query fails and the base is 0, and nothing is created.
    Connection::open(db_path).map(|c| store::turn_base(&c, session_key)).unwrap_or(0)
}

/// After a turn: remember how many turns of the chat are no longer in the
/// transcript that is stored (`total_turns` minus the prompts left in it), so
/// the next turn numbers its turns where this one stopped. Only written while
/// the tree is on; with it off nothing touches the database.
pub fn record_turn_base(db_path: &str, session_key: &str, total_turns: u32, stored: &[Message]) {
    let Ok(conn) = open(db_path) else { return };
    if !enabled_on(&conn, session_key).unwrap_or(false) {
        return;
    }
    let kept = crate::turn_memory::split_turns(stored).len() as u32;
    let base = total_turns.saturating_sub(kept);
    if base != store::turn_base(&conn, session_key) {
        let _ = store::set_turn_base(&conn, session_key, base);
    }
}

/// The messages this request really sends: the view without the turns the tree
/// took out.
///
/// * A turn is dropped only as a whole (prompt, answers, tool calls and their
///   results), so tool calls and results always stay paired.
/// * The newest turn of the view is never dropped: it holds the prompt being
///   answered and any tool call still open.
/// * Messages before the first turn (memory summary, continuity summary) and
///   memory/context messages are always kept.
///
/// With an empty `drop` set the result is exactly `view`, which is what keeps a
/// request with the tree off byte-for-byte identical to one without the feature.
pub fn request_view(view: &[Message], turn_offset: u32, drop: &BTreeSet<u32>) -> Vec<Message> {
    request_view_calls(view, turn_offset, drop, &BTreeSet::new())
}

/// [`request_view`] that also leaves out single tool calls: `calls` holds
/// `(turn, call)` pairs (absolute turn number, 1-based call index) whose node is
/// not `in`. A call goes out together with its result, so the pairing the
/// providers require is kept; a message left with nothing in it goes too, and
/// two messages of the same role that end up next to each other are joined.
/// The newest turn is never touched (it may hold a call that is still open).
pub fn request_view_calls(view: &[Message], turn_offset: u32, drop: &BTreeSet<u32>, calls: &BTreeSet<(u32, u32)>) -> Vec<Message> {
    let base = request_view_turns(view, turn_offset, drop);
    if calls.is_empty() {
        return base;
    }
    use crate::types::{ContentBlock, MessageContent};
    let turns = crate::turn_memory::split_turns(&base);
    let Some(last) = turns.last().map(|t| t.no) else { return base };
    let mut remove_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for turn in &turns {
        if turn.no == last {
            continue;
        }
        let n = turn_offset + turn.no;
        if !calls.iter().any(|(t, _)| *t == n) {
            continue;
        }
        let end = turn.end.min(base.len());
        for (index, id) in call_ids(&base[turn.start..end]) {
            if calls.contains(&(n, index)) {
                remove_ids.insert(id);
            }
        }
    }
    if remove_ids.is_empty() {
        return base;
    }
    let mut out: Vec<Message> = Vec::with_capacity(base.len());
    for m in base {
        let m = match m.content {
            MessageContent::Blocks(blocks) => {
                let had = blocks.len();
                let kept: Vec<ContentBlock> = blocks
                    .into_iter()
                    .filter(|b| match b {
                        ContentBlock::ToolUse { id, .. } => !remove_ids.contains(id),
                        ContentBlock::ToolResult { tool_use_id, .. } => !remove_ids.contains(tool_use_id),
                        _ => true,
                    })
                    .collect();
                if kept.is_empty() && had > 0 {
                    continue;
                }
                Message { role: m.role, content: MessageContent::Blocks(kept) }
            }
            other => Message { role: m.role, content: other },
        };
        if let Some(prev) = out.last_mut() {
            if prev.role == m.role && prev.role != crate::types::Role::System && prev.role != crate::types::Role::Context {
                let mut joined = into_blocks(std::mem::replace(&mut prev.content, MessageContent::Blocks(Vec::new())));
                joined.extend(into_blocks(m.content));
                prev.content = MessageContent::Blocks(joined);
                continue;
            }
        }
        out.push(m);
    }
    out
}

fn into_blocks(c: crate::types::MessageContent) -> Vec<crate::types::ContentBlock> {
    match c {
        crate::types::MessageContent::Blocks(b) => b,
        crate::types::MessageContent::Text(t) => vec![crate::types::ContentBlock::Text { text: t }],
    }
}

fn request_view_turns(view: &[Message], turn_offset: u32, drop: &BTreeSet<u32>) -> Vec<Message> {
    if drop.is_empty() {
        return view.to_vec();
    }
    let turns = crate::turn_memory::split_turns(view);
    let Some(last) = turns.last().map(|t| t.no) else { return view.to_vec() };
    let mut hidden = vec![false; view.len()];
    for turn in &turns {
        if turn.no == last || !drop.contains(&(turn_offset + turn.no)) {
            continue;
        }
        for i in turn.start..turn.end.min(view.len()) {
            hidden[i] = true;
        }
    }
    view.iter()
        .zip(hidden)
        .filter(|(m, hide)| !*hide || crate::turn_memory::is_memory_message(m) || m.role == crate::types::Role::Context)
        .map(|(m, _)| m.clone())
        .collect()
}

/// Open the tree tables in the session database. Cheap and idempotent.
pub fn open(db_path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    // Do not fight the engine's writers for the whole turn.
    conn.busy_timeout(std::time::Duration::from_millis(2_000))?;
    store::ensure_tables(&conn)?;
    Ok(conn)
}

/// Is the tree enabled for this session?
///
/// Off unless `ctx_meta.enabled` is `"1"`. A missing database, a locked database or
/// a corrupt flag all mean "off": a feature that can break a chat by existing is
/// not a feature.
pub fn enabled(db_path: &str, session_key: &str) -> bool {
    let Ok(conn) = open(db_path) else { return false };
    enabled_on(&conn, session_key).unwrap_or(false)
}

fn enabled_on(conn: &Connection, _session_key: &str) -> rusqlite::Result<bool> {
    let flag: Option<String> = conn
        .query_row("SELECT value FROM ctx_meta WHERE key = 'enabled'", [], |r| r.get(0))
        .optional()?;
    Ok(flag.as_deref() == Some("1"))
}

/// Turn the tree on or off for every session in this database.
pub fn set_enabled(db_path: &str, on: bool) -> rusqlite::Result<()> {
    let conn = open(db_path)?;
    conn.execute(
        "INSERT INTO ctx_meta (key, value) VALUES ('enabled', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![if on { "1" } else { "0" }],
    )?;
    Ok(())
}


/// The revision the tree is at for this session, without opening a request.
///
/// This is the primitive a mid-turn change needs: the loop records the revision it
/// sent, and before assembling the next step in the *same* turn it compares. If the
/// number moved, the model changed the tree while the turn was running and the
/// checklist it is looking at is stale — the next step must be built again instead of
/// being sent with an old view.
pub fn rev(db_path: &str, session_key: &str) -> Option<i64> {
    let conn = open(db_path).ok()?;
    store::rev(&conn, session_key).ok()
}

/// True when the tree changed after `sent_rev`.
///
/// A missing session is *not* a change: it means nothing has been assembled yet. A
/// smaller revision than expected (a reset) is a change, because the view the model
/// holds no longer describes the tree.
pub fn changed_since(db_path: &str, session_key: &str, sent_rev: i64) -> bool {
    match rev(db_path, session_key) {
        Some(now) => now != sent_rev,
        None => false,
    }
}

/// Read content for `recall` out of the engine's own tables.
pub struct EngineRecall<'a> {
    pub conn: &'a Connection,
    pub session_key: &'a str,
    pub workspace: &'a str,
}

impl Recall for EngineRecall<'_> {
    fn turn(&self, n: u32) -> Option<String> {
        let turns = crate::turn_memory::store::load_turns(self.conn, self.session_key, n, n);
        let (_, messages) = turns.into_iter().next()?;
        let mut out = String::new();
        for m in messages {
            let role = match m.role {
                crate::types::Role::User => "user",
                crate::types::Role::Assistant => "assistant",
                _ => "context",
            };
            let text = m.text();
            if !text.trim().is_empty() {
                out.push_str(&format!("{role}: {text}\n"));
            }
        }
        (!out.is_empty()).then_some(out)
    }

    fn result(&self, result_id: &str) -> Option<String> {
        crate::turn_memory::store::load_result(self.conn, self.session_key, result_id).map(|r| r.content)
    }

    fn file(&self, locator: &str, range: Option<&str>) -> Option<String> {
        // Same confinement as `read_file`: a locator cannot leave the workspace
        // (`../`, absolute paths and symlinks out are refused).
        let path = crate::tool_runner::resolve_path(self.workspace, locator).ok()?;
        let text = std::fs::read_to_string(path).ok()?;
        Some(match range {
            // `L120-340`: one-based inclusive line range.
            Some(r) if r.starts_with('L') => {
                let (from, to) = r.trim_start_matches('L').split_once('-')?;
                let from: usize = from.parse().ok()?;
                let to: usize = to.parse().ok()?;
                text.lines()
                    .skip(from.saturating_sub(1))
                    .take(to.saturating_sub(from) + 1)
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            _ => text,
        })
    }
}

/// What the agent loop needs before it builds a request.
#[derive(Debug, Clone)]
pub struct RequestParts {
    /// The block to append to the system prompt: instructions + checklist (+ resume).
    pub prompt: String,
    /// Items whose state must be set to `out` before sending, with the reason.
    pub evict: Vec<String>,
    pub stage: &'static str,
    pub starved: bool,
    pub tokens_after: usize,
    /// The checklist on its own, for the audit row and the UI.
    pub checklist: String,
    /// Absolute turn numbers the request must leave out (state `out`, `note` or
    /// `temp` after this pass). Feed it to [`request_view`].
    pub drop_turns: BTreeSet<u32>,
    /// Single tool calls the request must leave out, as `(turn, call)` pairs.
    pub drop_calls: BTreeSet<(u32, u32)>,
    /// Selected tokens before and after this pass, and the room there is.
    pub tokens_before: usize,
    pub selectable: usize,
}

impl RequestParts {
    pub fn is_empty(&self) -> bool {
        self.prompt.is_empty()
    }
}

/// Index the session's material and decide what this request carries.
///
/// `items` is built by the caller from what it already loaded (turns, results,
/// files); this function never reads the transcript itself. Returns `None` when the
/// feature is off or the tree cannot be opened — a request must never fail because
/// the tree did.
#[allow(clippy::too_many_arguments)]
pub fn before_request(
    db_path: &str,
    session_key: &str,
    items: &[ReadItem],
    window: u64,
    reserve_out: u32,
    locked_tokens: usize,
    threshold_percent: u64,
    model: &str,
    now_ms: i64,
    now_turn: u32,
    newest_user: Option<&str>,
) -> Option<RequestParts> {
    let conn = open(db_path).ok()?;
    if !enabled_on(&conn, session_key).unwrap_or(false) {
        return None;
    }
    store::ensure_session(&conn, session_key, now_ms).ok()?;

    // A threshold the user typed on the settings screen wins over the caller's
    // default. Only a *stored* row counts, so an untouched engine keeps the
    // behaviour its own configuration asked for.
    let threshold_percent = super::settings::number(&conn, "threshold_percent")
        .map(|v| v.clamp(10, 90))
        .unwrap_or(threshold_percent);

    // 1. Reconcile: the engine's material is the truth, the tree follows it.
    let existing = store::load_nodes(&conn, session_key).ok()?;
    let plan = reading::plan(session_key, &existing, items, now_ms);
    reading::apply(&conn, session_key, &plan, now_ms, true).ok()?;

    // 1b. Housekeeping (plan §6.6): every 50 turns the quotas run and the action
    //     log is trimmed. Best effort; a failure here never blocks the request.
    run_gc_if_due(&conn, session_key, now_turn, now_ms);

    // 2. Constants that must always be in the request, whatever the model chose.
    let nodes = store::load_nodes(&conn, session_key).ok()?;
    let categories = store::load_categories(&conn, session_key).ok()?;
    let blocks: Vec<CategoryBlock> = categories
        .iter()
        .filter(|c| !c.deleted)
        .map(|c| CategoryBlock {
            id: c.id.clone(),
            title: c.title.clone(),
            ai_owned: c.owner == "ai",
            nodes: nodes.iter().filter(|n| n.parent == c.id || n.tags.iter().any(|t| t == &c.id)).cloned().collect(),
            cap_tokens: c.cap_tokens,
        })
        .collect();

    let used_sel = nodes.iter().map(|n| super::select::sent_tokens(n) as usize).sum();
    let budget = Budget::compute(
        BudgetInput { window, reserve_out, headroom: super::budget::DEFAULT_HEADROOM_TOKENS, locked: locked_tokens, min_selectable: super::budget::MIN_SELECTABLE_TOKENS },
        used_sel,
        threshold_percent,
    );

    let essentials: Vec<&Node> = nodes.iter().filter(|n| n.kind == super::model::NodeKind::Essential).collect();
    let recent: Vec<&Node> = nodes
        .iter()
        .filter(|n| n.kind == super::model::NodeKind::Turn && n.state == super::model::ItemState::In)
        .collect();
    let strategy_next = store::latest_strategy(&conn, session_key).ok().flatten().and_then(|(_, _, next)| next);
    let resume = ResumeInput {
        newest_user,
        strategy_next: strategy_next.as_deref(),
        essentials: essentials.clone(),
        recent_turns: recent,
        open_questions: Vec::new(),
    };

    let rev = store::rev(&conn, session_key).unwrap_or(0);
    let assembly: Assembly = assemble::assemble(&budget, model, &nodes, &blocks, rev, now_turn, now_ms, &resume, false);

    // 3. Apply the plan now, so the request that follows is the one the checklist
    //    described. The caller also sees the ids, for its audit row.
    let _ = super::select::apply_evictions(&conn, session_key, &assembly.plan, now_ms);
    let evicted: Vec<String> = assembly.plan.evict.iter().map(|e| e.id.as_str().to_string()).collect();
    if !evicted.is_empty() {
        let entry = store::LogEntry {
            actor: "policy".into(),
            tool: None,
            ops: serde_json::to_string(&evicted).unwrap_or_else(|_| "[]".into()),
            rev_before: rev,
            rev_after: store::bump_rev(&conn, session_key, now_ms).unwrap_or(rev),
            tokens_before: budget.used_sel,
            tokens_after: assembly.tokens_after(),
            reason: Some(assembly.stage.to_string()),
            turn: Some(now_turn),
            step: None,
        };
        let _ = store::log_action(&conn, session_key, &entry, now_ms);
    }

    // 4. What the request leaves out, read back from the store so that states
    //    the model set earlier (`ctx set … out`) count as much as this pass.
    let after = store::load_nodes(&conn, session_key).unwrap_or(nodes);
    let drop_turns = dropped_turns(&after);
    let drop_calls = dropped_calls(&after);

    let mut prompt = String::from(assemble::instructions());
    prompt.push('\n');
    prompt.push_str(&assembly.checklist);
    if let Some(kept) = kept_in_place(&conn, session_key, &after) {
        prompt.push('\n');
        prompt.push_str(&kept);
    }
    if let Some(resume) = assembly.resume.as_deref() {
        prompt.push('\n');
        prompt.push_str(resume);
    }

    Some(RequestParts {
        prompt,
        evict: evicted,
        stage: assembly.stage,
        starved: assembly.starved,
        tokens_after: assembly.tokens_after(),
        checklist: assembly.checklist,
        drop_turns,
        drop_calls,
        tokens_before: budget.demand,
        selectable: budget.selectable,
    })
}

/// Run the quotas and trim the action log when `now_turn` is a multiple of
/// [`store::GC_EVERY_TURNS`] and they have not run for this turn yet. Returns
/// the report when they ran. Before this the quotas existed but nothing called
/// them, so a long chat's tree only ever grew.
pub fn run_gc_if_due(conn: &Connection, session_key: &str, now_turn: u32, now_ms: i64) -> Option<store::GcReport> {
    if now_turn == 0 || now_turn % store::GC_EVERY_TURNS != 0 {
        return None;
    }
    let key = format!("gc_turn:{session_key}");
    let last: Option<u32> = conn
        .query_row("SELECT value FROM ctx_meta WHERE key = ?1", [&key], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok());
    if last == Some(now_turn) {
        return None;
    }
    // Live engine-material nodes are not trimmed here: right after the
    // reconcile every one of them is in the view this request sends, and a
    // trimmed one would be indexed again (as `in`) on the next request. What
    // grows is their tombstones, and the model's notes and temp summaries.
    let quotas = store::Quotas { nodes: i64::MAX, ..store::Quotas::default() };
    let report = store::enforce_quotas(conn, session_key, quotas).ok()?;
    let purged = store::purge_tombstones(conn, session_key, store::KEEP_TOMBSTONES).unwrap_or(0);
    let trimmed = store::trim_action_log(conn, session_key, store::MAX_ACTION_LOG_ROWS).unwrap_or(0);
    let _ = conn.execute(
        "INSERT INTO ctx_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, now_turn.to_string()],
    );
    if report != store::GcReport::default() || trimmed > 0 || purged > 0 {
        let rev = store::rev(conn, session_key).unwrap_or(0);
        let entry = store::LogEntry {
            actor: "engine".into(),
            ops: serde_json::json!({
                "op": "gc",
                "nodesTrimmed": report.nodes_trimmed,
                "notesTrimmed": report.notes_trimmed,
                "tempTrimmed": report.temp_trimmed,
                "bytesFreed": report.bytes_freed,
                "tombstonesPurged": purged,
                "logRowsTrimmed": trimmed,
            })
            .to_string(),
            rev_before: rev,
            rev_after: store::bump_rev(conn, session_key, now_ms).unwrap_or(rev),
            reason: Some("quotas".into()),
            turn: Some(now_turn),
            ..store::LogEntry::default()
        };
        let _ = store::log_action(conn, session_key, &entry, now_ms);
    }
    Some(report)
}

/// The panel's view of one session's tree: the payload of the `context.tree`
/// event and of the `ctx.tree` action. Every number in it is read from the
/// store (or from the pass that just ran), never invented by the WebView.
pub fn snapshot(db_path: &str, session_key: &str, parts: Option<&RequestParts>, window: u64, model: &str) -> serde_json::Value {
    let Ok(conn) = open(db_path) else {
        return serde_json::json!({"sessionKey": session_key, "enabled": false});
    };
    snapshot_on(&conn, session_key, parts, window, model)
}

/// [`snapshot`] on a connection that is already open (the `ctx.tree` action).
pub fn snapshot_on(conn: &Connection, session_key: &str, parts: Option<&RequestParts>, window: u64, model: &str) -> serde_json::Value {
    use super::model::ItemState;
    let conn = conn;
    let _ = store::ensure_tables(conn);
    let enabled = enabled_on(&conn, session_key).unwrap_or(false);
    let nodes = store::load_nodes(&conn, session_key).unwrap_or_default();
    let live: Vec<&Node> = nodes.iter().filter(|n| !n.deleted).collect();
    let count = |st: ItemState| live.iter().filter(|n| n.state == st).count();
    let sent: usize = live.iter().map(|n| super::select::sent_tokens(n) as usize).sum();
    let mut ordered = live.clone();
    ordered.sort_by_key(|n| (n.parent.clone(), n.order, n.id.as_str().to_string()));
    let items: Vec<serde_json::Value> = ordered
        .iter()
        .map(|n| {
            serde_json::json!({
                "id": n.id.as_str(),
                "title": n.title,
                "kind": n.kind.as_str(),
                "state": n.state.as_str(),
                "pin": n.pin.as_str(),
                "parent": n.parent,
                "tokens": n.tokens_full,
                "tokensNote": n.tokens_note,
                "turn": n.turn,
                "callIndex": n.provenance.call_index,
                "hasNote": n.note.as_deref().map(|t| !t.trim().is_empty()).unwrap_or(false),
            })
        })
        .collect();
    // Policy rows store bare ids; the panel reads `{id, action}` objects.
    let log: Vec<serde_json::Value> = store::load_log(&conn, session_key, 50)
        .unwrap_or_default()
        .into_iter()
        .map(|mut row| {
            if let Some(ops) = row.get("ops").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                if let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(&ops) {
                    if list.iter().all(|v| v.is_string()) {
                        let objs: Vec<serde_json::Value> = list.iter().map(|v| serde_json::json!({"id": v, "action": "out"})).collect();
                        row["ops"] = serde_json::Value::String(serde_json::Value::Array(objs).to_string());
                    }
                }
            }
            row
        })
        .collect();
    let settings = super::settings::Settings::load(&conn).unwrap_or_default();
    serde_json::json!({
        "sessionKey": session_key,
        "enabled": enabled,
        "rev": store::rev(&conn, session_key).unwrap_or(0),
        "model": model,
        "stage": parts.map(|p| p.stage).unwrap_or("none"),
        "starved": parts.map(|p| p.starved).unwrap_or(false),
        "counts": {
            "in": count(ItemState::In),
            "note": count(ItemState::Note),
            "out": count(ItemState::Out),
            "temp": count(ItemState::Temp),
        },
        "tokens": {
            "window": window,
            "selectable": parts.map(|p| p.selectable),
            "selected": sent,
            "sent": parts.map(|p| p.tokens_after).unwrap_or(sent),
            "before": parts.map(|p| p.tokens_before),
        },
        "droppedTurns": parts.map(|p| p.drop_turns.iter().copied().collect::<Vec<u32>>()).unwrap_or_default(),
        "items": items,
        "log": log,
        "settings": settings.to_json(),
    })
}

/// Single tool calls (`turn/tN/call/K`) whose node is not `in`, as
/// `(turn, call)` pairs. Feed them to [`request_view_calls`].
pub fn dropped_calls(nodes: &[Node]) -> BTreeSet<(u32, u32)> {
    use super::model::{ItemState, NodeKind};
    nodes
        .iter()
        .filter(|n| !n.deleted && n.kind == NodeKind::TurnPart && n.state != ItemState::In)
        .filter_map(|n| {
            let turn = n.turn.or(n.provenance.turn)?;
            let call = n.provenance.call_index.or_else(|| n.id.as_str().rsplit('/').next()?.parse().ok())?;
            Some((turn, call))
        })
        .collect()
}

/// Turn numbers whose node is not `in`: those turns are not sent verbatim.
/// A locked pin is always `in` (the transition table refuses anything else).
pub fn dropped_turns(nodes: &[Node]) -> BTreeSet<u32> {
    use super::model::{ItemState, NodeKind};
    nodes
        .iter()
        .filter(|n| !n.deleted && n.kind == NodeKind::Turn && n.state != ItemState::In)
        .filter_map(|n| n.turn.or(n.provenance.turn))
        .collect()
}

/// Most characters of kept text the prompt carries in one request. Beyond it the
/// model still has the ids and can `ctx recall` the rest.
pub const KEPT_TEXT_BUDGET_CHARS: usize = 24_000;

/// The text that stands in for items that are not sent in full:
///
/// * an item in `note` sends its note instead of its content;
/// * the model's own notebook entries (`note/…`) that are `in`;
/// * temp summaries (`tmp/…`) that are `in`, which replace their sources.
///
/// Before this, `note` and `temp` only changed a token count: the text they
/// promised never reached the model.
fn kept_in_place(conn: &Connection, session_key: &str, nodes: &[Node]) -> Option<String> {
    use super::model::{ItemState, NodeKind};
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut push = |id: &str, text: &str, lines: &mut Vec<String>| {
        let text = text.trim();
        if text.is_empty() || used >= KEPT_TEXT_BUDGET_CHARS {
            return;
        }
        let room = KEPT_TEXT_BUDGET_CHARS - used;
        let clipped: String = text.chars().take(room).collect();
        // The budget is in characters, like `room`: counting bytes made a
        // Bangla note use up the budget about three times as fast.
        used += clipped.chars().count();
        let safe = kept_text_safe(&clipped);
        lines.push(format!("- {id}: {}", safe.replace('\n', "\n  ")));
    };
    let mut ordered: Vec<&Node> = nodes.iter().filter(|n| !n.deleted).collect();
    ordered.sort_by_key(|n| (n.order, n.id.as_str().to_string()));
    for n in ordered {
        match (n.kind, n.state) {
            (_, ItemState::Note) => {
                if let Some(note) = n.note.as_deref() {
                    push(n.id.as_str(), note, &mut lines);
                }
            }
            (NodeKind::Note, ItemState::In) => {
                let text = store::load_note(conn, session_key, n.id.as_str()).ok().flatten();
                if let Some(text) = text.or_else(|| n.note.clone()) {
                    push(n.id.as_str(), &text, &mut lines);
                }
            }
            (NodeKind::TempSummary, ItemState::In) => {
                let text = store::load_temp_summary(conn, session_key, n.id.as_str()).ok().flatten();
                if let Some(text) = text.or_else(|| n.note.clone()) {
                    push(n.id.as_str(), &text, &mut lines);
                }
            }
            _ => {}
        }
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!("Kept in place of full items (notes and summaries):\n{}", lines.join("\n")))
}

/// Text written by the model (a note, a temp summary) on its way back into the
/// system prompt: the engine's own markers are taken out, so a note cannot pose
/// as the checklist or the resume block (SECURITY T2), and credentials are
/// removed (T8) for notes written before redaction existed.
fn kept_text_safe(text: &str) -> String {
    let mut s = crate::error_taxonomy::redact_secrets(text);
    for marker in [super::model::CHECKLIST_MARKER, super::model::RESUME_MARKER, "[native-agent-"] {
        while s.contains(marker) {
            s = s.replace(marker, "[");
        }
    }
    s
}

/// Most `ctx` calls one model step may make; more are answered with `limit`
/// (plan §6.4 / TOOLS: per step 4, per turn 24).
pub const MAX_CTX_CALLS_PER_STEP: usize = 4;
/// Most `ctx` calls one turn (one run of the agent loop) may make.
pub const MAX_CTX_CALLS_PER_TURN: usize = 24;

/// What the loop does with one `ctx` call before it reaches the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallAdmission {
    /// Run it.
    Run,
    /// The same call (same arguments) already ran in this step: here is its
    /// answer again, marked `cached`. It does not count against the limits.
    Cached(String, bool),
    /// Over the per-step or per-turn limit: here is the answer to send.
    Limited(String, bool),
}

/// The `ctx` call limits and the per-step cache of one turn. The agent loop keeps
/// one for the whole turn and calls [`CallBudget::new_step`] before every model
/// request. Pure bookkeeping: no database, no clock.
#[derive(Debug, Default)]
pub struct CallBudget {
    step_calls: usize,
    turn_calls: usize,
    step_cache: std::collections::HashMap<String, (String, bool)>,
}

impl CallBudget {
    /// A new model step starts: the per-step count and cache start again.
    pub fn new_step(&mut self) {
        self.step_calls = 0;
        self.step_cache.clear();
    }

    fn key(args: &serde_json::Value) -> String {
        serde_json::to_string(args).unwrap_or_default()
    }

    /// Decide on one call, before it runs.
    pub fn admit(&mut self, args: &serde_json::Value) -> CallAdmission {
        if let Some((text, is_error)) = self.step_cache.get(&Self::key(args)) {
            let marked = match serde_json::from_str::<serde_json::Value>(text) {
                Ok(serde_json::Value::Object(mut obj)) => {
                    obj.insert("cached".into(), serde_json::Value::Bool(true));
                    serde_json::Value::Object(obj).to_string()
                }
                _ => text.clone(),
            };
            return CallAdmission::Cached(marked, *is_error);
        }
        let (scope, limit) = if self.turn_calls >= MAX_CTX_CALLS_PER_TURN {
            ("turn", MAX_CTX_CALLS_PER_TURN)
        } else if self.step_calls >= MAX_CTX_CALLS_PER_STEP {
            ("step", MAX_CTX_CALLS_PER_STEP)
        } else {
            self.step_calls += 1;
            self.turn_calls += 1;
            return CallAdmission::Run;
        };
        let answer = serde_json::json!({
            "ok": false,
            "reason": "limit",
            "text": format!(
                "At most {limit} ctx calls per {scope}: this one did not run. Batch your changes into one `ctx set` call with several ops, then go on with the task."
            ),
        });
        CallAdmission::Limited(answer.to_string(), true)
    }

    /// Remember the answer of a call that ran, for an identical call later in
    /// the same step.
    pub fn record(&mut self, args: &serde_json::Value, answer: &(String, bool)) {
        self.step_cache.insert(Self::key(args), answer.clone());
    }

    /// Calls that ran in this turn (cached and limited ones are not counted).
    pub fn turn_calls(&self) -> usize {
        self.turn_calls
    }
}

/// Handle a `ctx` tool call. Returns a JSON error object (never `Err`) so a broken
/// tree cannot take down a turn.
pub fn handle_tool(db_path: &str, session_key: &str, workspace: &str, args: &serde_json::Value, window: u64, reserve_out: u32, model: &str, now_ms: i64) -> serde_json::Value {
    handle_tool_locked(db_path, session_key, workspace, args, window, reserve_out, 0, model, now_ms)
}

/// [`handle_tool`] with the request's locked tokens (the tree's own block, the
/// memory messages before the first turn, the request overhead). With them the
/// budget a `ctx view` shows is the one the engine enforced for the request the
/// model is answering (invariant I3); without them `view` overstated the room.
#[allow(clippy::too_many_arguments)]
pub fn handle_tool_locked(db_path: &str, session_key: &str, workspace: &str, args: &serde_json::Value, window: u64, reserve_out: u32, locked_tokens: usize, model: &str, now_ms: i64) -> serde_json::Value {
    let conn = match open(db_path) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"ok": false, "text": format!("the context store is unavailable: {e}")}),
    };
    if !enabled_on(&conn, session_key).unwrap_or(false) {
        return serde_json::json!({"ok": false, "text": "the context tree is not enabled in this build."});
    }
    if store::ensure_session(&conn, session_key, now_ms).is_err() {
        return serde_json::json!({"ok": false, "text": "the context store could not be initialised."});
    }
    let used_sel: usize = store::load_nodes(&conn, session_key)
        .map(|nodes| nodes.iter().map(|n| super::select::sent_tokens(n) as usize).sum())
        .unwrap_or(0);
    let threshold = super::settings::number(&conn, "threshold_percent").map(|v| v.clamp(10, 90)).unwrap_or(70);
    let budget = Budget::compute(
        BudgetInput { window, reserve_out, headroom: super::budget::DEFAULT_HEADROOM_TOKENS, locked: locked_tokens, min_selectable: super::budget::MIN_SELECTABLE_TOKENS },
        used_sel,
        threshold,
    );
    let mut env = CtxEnv::new(session_key, now_ms, model, budget);
    env.redact_paths = true;
    let recall = EngineRecall { conn: &conn, session_key, workspace };
    let answer = dispatch::handle(&conn, &env, args, &recall);
    // Notes and the strategy are mirrored to `.context/` (plan §6.5). A mirror
    // that cannot be written never fails the call.
    if answer["ok"].as_bool() == Some(true) && matches!(args.get("action").and_then(|v| v.as_str()), Some("note" | "strategy" | "set" | "category")) {
        sync_mirror(&conn, workspace, session_key);
    }
    answer
}

/// Bring a session's `.context/` mirror in line with the database. Best effort.
pub fn sync_mirror(conn: &Connection, workspace: &str, session_key: &str) {
    if workspace.trim().is_empty() || !enabled_on(conn, session_key).unwrap_or(false) {
        return;
    }
    // The next sync (and every start) writes it again.
    let _ = super::mirror::sync_session(conn, workspace, session_key);
}

/// At start: rebuild every mirror from the database, so a mirror edited or
/// deleted while the app was closed is put back. Best effort.
pub fn rebuild_mirrors(db_path: &str, workspace: &str) -> usize {
    if workspace.trim().is_empty() {
        return 0;
    }
    let Ok(conn) = open(db_path) else { return 0 };
    if !enabled_on(&conn, "").unwrap_or(false) || store::ensure_tables(&conn).is_err() {
        return 0;
    }
    super::mirror::rebuild_all(&conn, workspace).unwrap_or(0)
}

/// Keep a sub-agent's report in its parent's tree as a note (plan stage 7):
/// `send` true puts it `in` (render_in_chat: the parent reads the note instead of
/// the whole text), false keeps it `out` (a temp agent's report, recallable after
/// the agent itself is deleted). Returns the note id, or None when the tree is
/// off for that session or the store failed.
#[allow(clippy::too_many_arguments)]
pub fn keep_subagent_result(db_path: &str, workspace: &str, parent_session: &str, agent_id: &str, agent_name: &str, report: &str, send: bool, now_ms: i64) -> Option<String> {
    let args = serde_json::json!({
        "action": "note",
        "title": format!("Report from sub-agent {agent_name} ({agent_id})"),
        "text": report,
        "state": if send { "in" } else { "out" },
        "category": "notes",
    });
    let answer = handle_tool(db_path, parent_session, workspace, &args, 128_000, 4_096, "", now_ms);
    answer["ok"].as_bool().filter(|ok| *ok).and(answer["id"].as_str().map(str::to_string))
}

/// Answer a `ctx` call for the agent loop: the text the model reads and whether
/// it is an error. Never fails: a broken tree answers with an error the model can
/// read instead of taking the turn down.
#[allow(clippy::too_many_arguments)]
pub fn answer_tool_call(db_path: &str, session_key: &str, workspace: &str, args: &serde_json::Value, window: u64, reserve_out: u32, locked_tokens: usize, model: &str, now_ms: i64) -> (String, bool) {
    let answer = handle_tool_locked(db_path, session_key, workspace, args, window, reserve_out, locked_tokens, model, now_ms);
    let is_error = answer.get("ok").and_then(|v| v.as_bool()) == Some(false) || answer.get("error").is_some();
    (serde_json::to_string(&answer).unwrap_or_else(|_| "{\"ok\":false}".into()), is_error)
}

/// What a `ctx` call gets when the tree is off for the session. The tool is not
/// advertised then, but a model that remembers it from an earlier request may
/// still call it; it gets a clear answer, never "Unknown tool".
pub fn disabled_answer() -> (String, bool) {
    (
        serde_json::json!({
            "ok": false,
            "text": "The context tree is off for this chat, so `ctx` does nothing. Everything in the conversation is sent as usual; the user can turn the tree on in Settings → Context tree."
        })
        .to_string(),
        true,
    )
}

/// Turn `ctx` on for one database and seed the built-in categories. Used by tests
/// and by the settings screen once it exists.
pub fn enable(db_path: &str) -> rusqlite::Result<()> {
    let conn = open(db_path)?;
    store::ensure_session(&conn, "default", 0)?;
    set_enabled(db_path, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("ctx-wiring-{}-{}.sqlite", std::process::id(), name));
        let _ = std::fs::remove_file(&path);
        path.to_string_lossy().to_string()
    }

    #[test]
    fn ctx_calls_are_limited_per_step_and_per_turn_and_repeats_are_cached() {
        let mut b = CallBudget::default();
        let call = |i: usize| serde_json::json!({"action": "view", "n": i});
        b.new_step();
        for i in 0..MAX_CTX_CALLS_PER_STEP {
            assert_eq!(b.admit(&call(i)), CallAdmission::Run);
            b.record(&call(i), &(format!("{{\"ok\":true,\"i\":{i}}}"), false));
        }
        // The same arguments again in this step: the stored answer, marked, not counted.
        match b.admit(&call(0)) {
            CallAdmission::Cached(text, is_error) => {
                let v: serde_json::Value = serde_json::from_str(&text).unwrap();
                assert_eq!(v["cached"], true);
                assert_eq!(v["i"], 0);
                assert!(!is_error);
            }
            other => panic!("expected cached, got {other:?}"),
        }
        // A fifth different call in the step is refused with `limit`.
        match b.admit(&call(99)) {
            CallAdmission::Limited(text, is_error) => {
                let v: serde_json::Value = serde_json::from_str(&text).unwrap();
                assert_eq!(v["reason"], "limit");
                assert!(is_error);
            }
            other => panic!("expected limit, got {other:?}"),
        }
        // Steps reset the step count and cache, never the turn count.
        let mut ran = MAX_CTX_CALLS_PER_STEP;
        while ran < MAX_CTX_CALLS_PER_TURN {
            b.new_step();
            for _ in 0..MAX_CTX_CALLS_PER_STEP {
                if ran >= MAX_CTX_CALLS_PER_TURN {
                    break;
                }
                assert_eq!(b.admit(&call(1000 + ran)), CallAdmission::Run);
                ran += 1;
            }
        }
        b.new_step();
        assert!(matches!(b.admit(&call(5000)), CallAdmission::Limited(..)), "the turn limit holds across steps");
        assert_eq!(b.turn_calls(), MAX_CTX_CALLS_PER_TURN);
    }

    fn call_turn(prompt: &str, calls: &[(&str, &str)]) -> Vec<Message> {
        use crate::types::{ContentBlock, MessageContent, Role};
        let mut out = vec![Message::user(prompt)];
        for (id, result) in calls {
            out.push(Message { role: Role::Assistant, content: MessageContent::Blocks(vec![ContentBlock::ToolUse { id: id.to_string(), name: "read".into(), input: serde_json::json!({"path": id}), provider_metadata: None }]) });
            out.push(Message { role: Role::User, content: MessageContent::Blocks(vec![ContentBlock::ToolResult { tool_use_id: id.to_string(), content: result.to_string(), is_error: false }]) });
        }
        out.push(Message { role: Role::Assistant, content: MessageContent::Text(format!("answer to {prompt}")) });
        out
    }

    fn tool_ids(view: &[Message]) -> Vec<String> {
        use crate::types::{ContentBlock, MessageContent};
        let mut ids = Vec::new();
        for m in view {
            if let MessageContent::Blocks(b) = &m.content {
                for x in b {
                    match x {
                        ContentBlock::ToolUse { id, .. } => ids.push(format!("use:{id}")),
                        ContentBlock::ToolResult { tool_use_id, .. } => ids.push(format!("res:{tool_use_id}")),
                        _ => {}
                    }
                }
            }
        }
        ids
    }

    #[test]
    fn single_tool_calls_leave_the_request_with_their_results_and_the_newest_turn_stays_whole() {
        let mut view = call_turn("first", &[("a", "AAA"), ("b", "BBB")]);
        view.extend(call_turn("second", &[("c", "CCC")]));
        // Turn offset 10: the turns are 11 and 12. Take out call 1 of turn 11 and
        // call 1 of turn 12 (the newest, which must stay).
        let calls: BTreeSet<(u32, u32)> = [(11, 1), (12, 1)].into_iter().collect();
        let sent = request_view_calls(&view, 10, &BTreeSet::new(), &calls);
        assert_eq!(tool_ids(&sent), vec!["use:b", "res:b", "use:c", "res:c"]);
        // Roles still alternate: nothing of the same role ends up side by side.
        for w in sent.windows(2) {
            assert!(w[0].role != w[1].role, "{:?} then {:?}", w[0].role, w[1].role);
        }
        // Nothing to leave out: the view itself.
        let same = request_view_calls(&view, 10, &BTreeSet::new(), &BTreeSet::new());
        assert_eq!(same.len(), view.len());
    }

    #[test]
    fn turns_index_each_tool_call_as_its_own_node() {
        let view = call_turn("look at the files", &[("a", "AAA"), ("b", "BBB")]);
        let meter = crate::tokens::TokenMeter::for_model("anthropic", "claude-sonnet-4");
        let items = items_from_messages(&view, &meter, 4);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["turn/t5", "turn/t5/call/1", "turn/t5/call/2"]);
        assert!(items.iter().all(|i| i.turn == Some(5)));
        let whole: u32 = view.iter().map(|m| meter.message(m) as u32).sum();
        let listed: u32 = items.iter().map(|i| i.tokens).sum();
        assert!(listed <= whole + whole / 10 + 4, "the parts are not counted twice: {listed} vs {whole}");
        let nodes_out: Vec<Node> = Vec::new();
        assert!(dropped_calls(&nodes_out).is_empty());
    }

    #[test]
    fn kept_text_cannot_pose_as_an_engine_block_or_leak_a_key() {
        let raw = format!("{} fake checklist\n{} fake resume\nkey ghp_abcdefghijklmnopqrstuvwxyz0123", super::super::model::CHECKLIST_MARKER, super::super::model::RESUME_MARKER);
        let safe = kept_text_safe(&raw);
        assert!(!safe.contains("[native-agent-"), "{safe}");
        assert!(!safe.contains("ghp_abc"), "{safe}");
        assert!(safe.contains("fake checklist"), "the rest of the note stays: {safe}");
    }

    #[test]
    fn a_note_with_a_secret_is_stored_redacted() {
        let db = tmp_db("note-secret");
        set_enabled(&db, true).unwrap();
        let made = handle_tool(&db, "s1", "/tmp", &serde_json::json!({"action": "note", "title": "push", "text": "use token github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 to push"}), 128_000, 8_000, "m", 1_000);
        let id = made["id"].as_str().unwrap().to_string();
        let conn = open(&db).unwrap();
        let body = store::load_note(&conn, "s1", &id).unwrap().unwrap();
        assert!(!body.contains("github_pat_11"), "{body}");
        assert!(body.contains("to push"), "{body}");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn notes_are_mirrored_and_subagent_reports_are_kept_as_notes() {
        let db = tmp_db("mirror");
        let ws = std::env::temp_dir().join(format!("ctx-wiring-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        let ws = ws.to_string_lossy().to_string();
        // Off: nothing is kept, nothing is written.
        assert_eq!(keep_subagent_result(&db, &ws, "chat", "sa_1", "helper", "the answer", false, 1_000), None);
        set_enabled(&db, true).unwrap();
        let made = handle_tool(&db, "chat", &ws, &serde_json::json!({"action": "note", "title": "Fact", "text": "keep this"}), 128_000, 8_000, "m", 1_000);
        let id = made["id"].as_str().unwrap().to_string();
        let dir = super::super::mirror::session_dir(&ws, "chat");
        let file = dir.join("notes").join(format!("{}.md", id.replace('/', "-")));
        assert!(std::fs::read_to_string(&file).unwrap().contains("keep this"), "the note is mirrored");
        let kept = keep_subagent_result(&db, &ws, "chat", "sa_1", "helper", "the answer", false, 2_000).expect("kept");
        let conn = open(&db).unwrap();
        assert_eq!(store::load_note(&conn, "chat", &kept).unwrap().as_deref(), Some("the answer"));
        let node = store::load_node(&conn, "chat", &kept).unwrap().unwrap();
        assert_eq!(node.state, super::super::model::ItemState::Out, "a temp agent's report is recallable, not sent");
        assert!(node.title.contains("helper"));
        assert_eq!(rebuild_mirrors(&db, &ws), 1);
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn view_counts_the_locked_tokens_of_the_request() {
        let db = tmp_db("locked");
        set_enabled(&db, true).unwrap();
        let free = handle_tool_locked(&db, "s1", "/tmp", &serde_json::json!({"action": "view"}), 32_000, 4_000, 0, "m", 1_000);
        let held = handle_tool_locked(&db, "s1", "/tmp", &serde_json::json!({"action": "view"}), 32_000, 4_000, 10_000, "m", 1_000);
        assert_eq!(free["ok"], true, "{free}");
        assert_ne!(free["text"], held["text"], "the locked tokens change the budget the model is shown");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_rewind_in_the_memory_store_follows_into_the_tree() {
        let db = tmp_db("rewind");
        set_enabled(&db, true).unwrap();
        let items: Vec<ReadItem> = (1..=4).map(|t| ReadItem::turn(t, "turn", 100, t == 4)).collect();
        before_request(&db, "s1", &items, 128_000, 8_000, 1_000, 70, "m", 1_000, 4, None).expect("on");
        let conn = open(&db).unwrap();
        // The model took turn 3 out with a note.
        store::set_state(&conn, "s1", "turn/t3", super::super::model::ItemState::Note, Some("old turn three"), 1_500).unwrap();
        crate::turn_memory::ensure_tables(&conn).unwrap();
        crate::turn_memory::forget_after(&conn, "s1", 2, 2_000).unwrap();
        assert!(store::load_node(&conn, "s1", "turn/t3").unwrap().is_none());
        assert!(store::load_node(&conn, "s1", "turn/t2").unwrap().is_some());
        // The new turn 3 comes in fresh: `in`, no old note, not dropped.
        let items: Vec<ReadItem> = (1..=3).map(|t| ReadItem::turn(t, "turn", 100, t == 3)).collect();
        let parts = before_request(&db, "s1", &items, 128_000, 8_000, 1_000, 70, "m", 3_000, 3, None).expect("on");
        assert!(!parts.drop_turns.contains(&3), "{:?}", parts.drop_turns);
        let n = store::load_node(&conn, "s1", "turn/t3").unwrap().unwrap();
        assert_eq!(n.state, super::super::model::ItemState::In);
        assert_eq!(n.note, None);
        assert!(!parts.prompt.contains("old turn three"));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn housekeeping_runs_every_fifty_turns_once() {
        let db = tmp_db("gc");
        set_enabled(&db, true).unwrap();
        let conn = open(&db).unwrap();
        store::ensure_session(&conn, "s1", 1_000).unwrap();
        assert!(run_gc_if_due(&conn, "s1", 49, 1_000).is_none());
        assert!(run_gc_if_due(&conn, "s1", 50, 1_000).is_some());
        assert!(run_gc_if_due(&conn, "s1", 50, 1_001).is_none(), "once per turn");
        assert!(run_gc_if_due(&conn, "s1", 100, 2_000).is_some());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn the_feature_is_off_until_it_is_turned_on() {
        let db = tmp_db("flag");
        assert!(!enabled(&db, "s1"), "a missing database means off, not an error");
        set_enabled(&db, true).unwrap();
        assert!(enabled(&db, "s1"));
        set_enabled(&db, false).unwrap();
        assert!(!enabled(&db, "s1"));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn before_request_returns_nothing_when_off() {
        let db = tmp_db("off");
        let parts = before_request(&db, "s1", &[], 128_000, 8_000, 1_000, 70, "m", 1_000, 1, None);
        assert!(parts.is_none());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_turn_of_material_becomes_a_checklist_and_a_prompt() {
        let db = tmp_db("on");
        set_enabled(&db, true).unwrap();
        let items = vec![
            ReadItem::sys_part("core", "rules", 800),
            ReadItem::turn(1, "user wants the apk", 200, true),
            ReadItem::result("R7", "cargo test", 900, Some(1)),
        ];
        let parts = before_request(&db, "s1", &items, 128_000, 8_000, 1_500, 70, "m", 1_000, 1, Some("please build"))
            .expect("feature is on");
        assert!(parts.prompt.contains("[native-agent-context-tree-v1]"), "{}", parts.prompt);
        assert!(parts.prompt.contains("ctx:"), "the instructions are included");
        assert!(parts.starved == false);
        assert_eq!(parts.stage, "none");
        // The index really is stored.
        let conn = open(&db).unwrap();
        assert!(store::load_nodes(&conn, "s1").unwrap().iter().any(|n| n.id.as_str() == "turn/t1"));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn the_tool_answers_and_refuses_when_disabled() {
        let db = tmp_db("tool");
        let off = handle_tool(&db, "s1", "/tmp", &serde_json::json!({"action": "view"}), 128_000, 8_000, "m", 1_000);
        assert_eq!(off["ok"], false);
        assert!(off["text"].as_str().unwrap().contains("not enabled"));
        set_enabled(&db, true).unwrap();
        let on = handle_tool(&db, "s1", "/tmp", &serde_json::json!({"action": "view"}), 128_000, 8_000, "m", 1_000);
        assert_eq!(on["ok"], true, "{on}");
        assert!(on["text"].as_str().unwrap().contains("[native-agent-context-tree-v1]"));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_note_written_through_the_seam_survives_a_reopen() {
        let db = tmp_db("note");
        set_enabled(&db, true).unwrap();
        let made = handle_tool(&db, "s1", "/tmp", &serde_json::json!({"action": "note", "title": "build", "text": "gradlew assembleRelease"}), 128_000, 8_000, "m", 1_000);
        let id = made["id"].as_str().unwrap().to_string();
        let back = handle_tool(&db, "s1", "/tmp", &serde_json::json!({"action": "recall", "id": id}), 128_000, 8_000, "m", 2_000);
        assert!(back["text"].as_str().unwrap().contains("gradlew"));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_pathological_window_does_not_lose_the_prompt() {
        let db = tmp_db("tiny");
        set_enabled(&db, true).unwrap();
        let items = vec![ReadItem::turn(1, "big", 9_000, true)];
        let parts = before_request(&db, "s1", &items, 8_192, 4_096, 9_000, 70, "m", 1_000, 1, None).expect("on");
        assert!(parts.starved, "34 tokens of room is not a window");
        assert!(parts.prompt.contains("[native-agent-context-tree-v1]"));
        let _ = std::fs::remove_file(&db);
    }
}
