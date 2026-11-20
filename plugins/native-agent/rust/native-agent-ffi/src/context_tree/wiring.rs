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

use std::sync::atomic::{AtomicBool, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// True when the tree is switched on for this run. The agent loop sets this once
/// per turn after reading the database flag; the tool list and the tool executor
/// read it, so a disabled tree costs exactly one atomic load.
pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

pub fn set_active(on: bool) {
    ACTIVE.store(on, Ordering::Relaxed);
}

/// The session a `ctx` call belongs to. The tool executor has no session of its
/// own (`execute_tool` is called from several places, including tests), so the
/// loop publishes these three numbers once per request and the executor reads them.
#[derive(Debug, Clone, Default)]
struct RequestContext {
    session_key: String,
    window: u64,
    reserve_out: u32,
    model: String,
}

static REQUEST: std::sync::Mutex<Option<RequestContext>> = std::sync::Mutex::new(None);

/// Publish the current request's session, window and model.
pub fn set_request_context(session_key: &str, window: u64, reserve_out: u32, model: &str) {
    if let Ok(mut guard) = REQUEST.lock() {
        *guard = Some(RequestContext {
            session_key: session_key.to_string(),
            window,
            reserve_out,
            model: model.to_string(),
        });
    }
}

fn request_context() -> Option<RequestContext> {
    REQUEST.lock().ok().and_then(|g| g.clone())
}

/// Index the transcript into items the tree can hold.
///
/// Turns come from the engine's own splitter, so their numbers match
/// `turn_archive` and `recall` finds the same turn later. Only the newest turn
/// starts inside the window: the rest are listed and retrievable.
pub fn items_from_messages(messages: &[crate::types::Message], meter: &crate::tokens::TokenMeter) -> Vec<ReadItem> {
    let turns = crate::turn_memory::split_turns(messages);
    let total = turns.len();
    turns
        .iter()
        .map(|turn| {
            let end = turn.end.min(messages.len());
            let slice = if turn.start < end { &messages[turn.start..end] } else { &messages[0..0] };
            let text = slice.iter().map(|m| m.text()).collect::<Vec<_>>().join(" ");
            let tokens: u32 = slice.iter().map(|m| meter.message(m)).sum::<usize>().min(u32::MAX as usize) as u32;
            let title: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
            ReadItem::turn(
                turn.no,
                if title.is_empty() { "(empty turn)" } else { title.as_str() },
                tokens,
                turn.no as usize == total,
            )
        })
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
        let path = std::path::Path::new(self.workspace).join(locator);
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

    let mut prompt = String::from(assemble::instructions());
    prompt.push('\n');
    prompt.push_str(&assembly.checklist);
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
    })
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
    let budget = Budget::compute(
        BudgetInput { window, reserve_out, headroom: super::budget::DEFAULT_HEADROOM_TOKENS, locked: 0, min_selectable: super::budget::MIN_SELECTABLE_TOKENS },
        used_sel,
        70,
    );
    let mut env = CtxEnv::new(session_key, now_ms, model, budget);
    env.redact_paths = true;
    let recall = EngineRecall { conn: &conn, session_key, workspace };
    dispatch::handle(&conn, &env, args, &recall)
}

/// Answer a `ctx` call from inside the tool executor, using the request context the
/// loop published. Returns `None` when the tree is off, so the caller can fall
/// through to its normal "unknown tool" path.
pub fn handle_ctx_tool(db_path: &str, workspace: &str, args: &serde_json::Value) -> Option<serde_json::Value> {
    if !active() {
        return None;
    }
    let req = request_context()?;
    if req.session_key.is_empty() {
        return None;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(handle_tool(db_path, &req.session_key, workspace, args, req.window, req.reserve_out, &req.model, now_ms))
}

/// Turn `ctx` on for one database and seed the built-in categories. Used by tests
/// and by the settings screen once it exists.
pub fn enable(db_path: &str) -> rusqlite::Result<()> {
    let conn = open(db_path)?;
    store::ensure_session(&conn, "default", 0).or(Ok(()))?;
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
