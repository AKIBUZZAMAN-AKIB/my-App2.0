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
    turns
        .iter()
        .map(|turn| {
            let end = turn.end.min(messages.len());
            let slice = if turn.start < end { &messages[turn.start..end] } else { &messages[0..0] };
            let prompt = slice.first().map(|m| m.text()).unwrap_or_default();
            let tokens: u32 = slice.iter().map(|m| meter.message(m)).sum::<usize>().min(u32::MAX as usize) as u32;
            let title: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
            ReadItem::turn(
                turn_offset + turn.no,
                if title.is_empty() { "(empty turn)" } else { title.as_str() },
                tokens,
                true,
            )
        })
        .collect()
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
    view[..first.min(view.len())].iter().map(|m| meter.message(m)).sum()
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
        tokens_before: budget.demand,
        selectable: budget.selectable,
    })
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
        used += clipped.len();
        lines.push(format!("- {id}: {}", clipped.replace('\n', "\n  ")));
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

/// Handle a `ctx` tool call. Returns a JSON error object (never `Err`) so a broken
/// tree cannot take down a turn.
pub fn handle_tool(db_path: &str, session_key: &str, workspace: &str, args: &serde_json::Value, window: u64, reserve_out: u32, model: &str, now_ms: i64) -> serde_json::Value {
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
        BudgetInput { window, reserve_out, headroom: super::budget::DEFAULT_HEADROOM_TOKENS, locked: 0, min_selectable: super::budget::MIN_SELECTABLE_TOKENS },
        used_sel,
        threshold,
    );
    let mut env = CtxEnv::new(session_key, now_ms, model, budget);
    env.redact_paths = true;
    let recall = EngineRecall { conn: &conn, session_key, workspace };
    let answer = dispatch::handle(&conn, &env, args, &recall);
    // Mirrors follow a commit (plan §7): a call that changed the tree rewrites
    // strategy.md and the note files. A failed write never fails the call.
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let ok = answer.get("ok").and_then(|v| v.as_bool()) != Some(false) && answer.get("error").is_none();
    if ok && matches!(action, "note" | "strategy" | "set" | "summarize" | "category") {
        let _ = super::gc::sync_mirrors(&conn, session_key, workspace);
    }
    answer
}

/// Answer a `ctx` call for the agent loop: the text the model reads and whether
/// it is an error. Never fails: a broken tree answers with an error the model can
/// read instead of taking the turn down.
#[allow(clippy::too_many_arguments)]
pub fn answer_tool_call(db_path: &str, session_key: &str, workspace: &str, args: &serde_json::Value, window: u64, reserve_out: u32, model: &str, now_ms: i64) -> (String, bool) {
    let answer = handle_tool(db_path, session_key, workspace, args, window, reserve_out, model, now_ms);
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

/// The user deleted a sub-agent: tombstone its `agent/<id>` node and drop the
/// copied report, so the tree never offers a deleted agent's work.
pub fn forget_subagent(db_path: &str, session_key: &str, subagent_id: &str, now_ms: i64) {
    let Ok(conn) = open(db_path) else { return };
    if super::store::schema_version(&conn).is_none() {
        return;
    }
    let id = format!("agent/{subagent_id}");
    let n = conn
        .execute(
            "UPDATE ctx_nodes SET deleted = 1, state = 'out', node_rev = node_rev + 1, last_used_at = ?3
              WHERE session_key = ?1 AND id = ?2 AND deleted = 0",
            rusqlite::params![session_key, id, now_ms],
        )
        .unwrap_or(0);
    let _ = conn.execute("DELETE FROM ctx_notes WHERE session_key = ?1 AND id = ?2", rusqlite::params![session_key, id]);
    if n > 0 {
        let _ = store::bump_rev(&conn, session_key, now_ms);
    }
}

/// Housekeeping at a turn boundary, before the request is built (plan §7/§8):
/// the GC when it is due (first request of the session since the app started,
/// then every 50 turns), and the mirrors brought in line with the DB (rebuilt
/// when missing or edited by hand). Never fails the turn. Returns what the GC
/// did when it ran and did something, for the caller's event.
pub fn maintain(db_path: &str, session_key: &str, workspace: &str, now_turn: u32, now_ms: i64) -> Option<super::gc::Cleanup> {
    let conn = open(db_path).ok()?;
    if !enabled_on(&conn, session_key).unwrap_or(false) {
        return None;
    }
    store::ensure_session(&conn, session_key, now_ms).ok()?;
    let ran = super::gc::maybe_run(&conn, session_key, now_turn, now_ms);
    if ran.is_some() {
        // A GC pass is also when the mirrors are checked against the DB.
        let _ = super::gc::sync_mirrors(&conn, session_key, workspace);
    }
    ran.filter(|c| c.did_anything())
}

/// Most characters of a sub-agent report the `agent/<id>` node's note keeps.
pub const SUBAGENT_NOTE_CHARS: usize = 600;

/// Copy a sub-agent's report into its parent's tree as `agent/<id>` (plan §10:
/// "result copied to parent tree"). The full report is kept in `ctx_notes` so
/// `ctx recall agent/<id>` gives it back; the node itself starts in `note`,
/// so what every request carries is a short note, not the whole report. A
/// render_in_chat answer the user already sees starts `out`: the model can
/// still recall it. Written once: a later copy (a reused agent's next report)
/// updates the text but never undoes what the model chose for the node.
/// Does nothing when the tree is off. Never fails the caller.
#[allow(clippy::too_many_arguments)]
pub fn record_subagent_report(
    db_path: &str,
    session_key: &str,
    subagent_id: &str,
    title: &str,
    status: &str,
    report: &str,
    render_in_chat: bool,
    lifetime: &str,
    now_ms: i64,
) {
    use super::model::{safe_title, ItemState, NodeId, NodeKind, Owner, Pin, Provenance};
    let Ok(conn) = open(db_path) else { return };
    if !enabled_on(&conn, session_key).unwrap_or(false) {
        return;
    }
    if store::ensure_session(&conn, session_key, now_ms).is_err() {
        return;
    }
    let safe_id: String = subagent_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(64).collect();
    if safe_id.is_empty() {
        return;
    }
    let Ok(id) = NodeId::parse(&format!("agent/{safe_id}")) else { return };
    let report = report.trim();
    let note: String = {
        let head: String = report.chars().take(SUBAGENT_NOTE_CHARS).collect();
        if head.chars().count() < report.chars().count() { format!("{head} …(ctx recall {} for all of it)", id.as_str()) } else { head }
    };
    let title = safe_title(&format!("{title} ({})", status.replace('_', " ")));
    if store::put_note(&conn, session_key, id.as_str(), &title, report, "agents", ItemState::Note, now_ms).is_err() {
        return;
    }
    let existing = store::load_node(&conn, session_key, id.as_str()).ok().flatten();
    let tokens_full = super::render::estimate_tokens(report) as u32;
    let tokens_note = super::render::estimate_tokens(&note) as u32;
    let node = match existing {
        Some(mut n) => {
            n.title = title;
            n.note = Some(note);
            n.tokens_full = tokens_full;
            n.tokens_note = tokens_note;
            n.last_used_at = Some(now_ms);
            n
        }
        None => super::model::Node {
            id: id.clone(),
            session_key: session_key.to_string(),
            kind: NodeKind::Subagent,
            parent: "agents".to_string(),
            tags: Vec::new(),
            order: 0,
            title,
            state: if render_in_chat { ItemState::Out } else { ItemState::Note },
            pin: Pin::None,
            owner: Owner::Subagent(safe_id.clone()),
            tokens_full,
            tokens_note,
            token_model: String::new(),
            note: Some(note),
            provenance: Provenance { source: "subagent".into(), locator: Some(safe_id.clone()), range: Some(format!("lifetime:{lifetime}")), ..Default::default() },
            created_at: now_ms,
            last_used_at: Some(now_ms),
            loaded_at: None,
            turn: None,
            rev: 1,
            deleted: false,
        },
    };
    if store::upsert_node(&conn, &node).is_ok() {
        let _ = store::bump_rev(&conn, session_key, now_ms);
    }
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
