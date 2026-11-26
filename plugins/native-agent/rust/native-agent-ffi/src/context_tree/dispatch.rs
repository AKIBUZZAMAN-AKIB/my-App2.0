//! One tool call in, one JSON answer out.
//!
//! `ctx` is the only context tool the model has, so this router owns all eight
//! actions. Two rules shape it:
//!
//! * **It never panics and never hangs.** Every path returns an object with `ok`
//!   and `text`; a bad argument is a message the model can act on, not a dropped
//!   turn. `ctx` runs as a leaf task — no network, no sub-agent, no file writes —
//!   so it is safe to run while other tools are running in parallel.
//! * **It touches only the tree.** `recall` reads the engine's own rows through
//!   [`Recall`], which is a trait so the engine decides what "the file" or "the
//!   result" means, and so this module can be tested with a fake.
//!
//! Anything that needs a model (a temp summary, a sub-agent) is *requested* here
//! and executed by the caller: `needs_model: true` is a contract, not an apology.

use serde_json::{json, Value};

use super::budget::Budget;
use super::model::{ItemState, Node, NodeId, CHECKLIST_MARKER};
use super::ops::{apply_batch, parse_ops, BatchEnv};
use super::render::{self, text, CategoryBlock};
use super::select;
use super::store;
use super::tools;

/// What the engine lets `recall` reach. The tree stores locators, not content.
pub trait Recall {
    /// Messages of one turn, already formatted for the model.
    fn turn(&self, n: u32) -> Option<String>;
    /// A stored tool result by its id.
    fn result(&self, result_id: &str) -> Option<String>;
    /// A file slice: `locator` is a path, `range` is what the node recorded.
    fn file(&self, locator: &str, range: Option<&str>) -> Option<String>;
}

/// A `Recall` that knows nothing, for tests and for engines that do not wire it.
pub struct NoRecall;

impl Recall for NoRecall {
    fn turn(&self, _n: u32) -> Option<String> {
        None
    }
    fn result(&self, _result_id: &str) -> Option<String> {
        None
    }
    fn file(&self, _locator: &str, _range: Option<&str>) -> Option<String> {
        None
    }
}

/// Everything a `ctx` call needs to know that is not in its arguments.
#[derive(Debug, Clone)]
pub struct CtxEnv<'a> {
    pub session_key: &'a str,
    pub now_ms: i64,
    pub now_turn: Option<u32>,
    pub step: Option<u32>,
    pub model: &'a str,
    /// The budget of the *current* request, so `view` can show what is left.
    pub budget: Budget,
    /// True when paths should be shortened before they are shown.
    pub redact_paths: bool,
    /// Default size of a summary the model asks for.
    pub default_summary_tokens: u32,
}

impl<'a> CtxEnv<'a> {
    pub fn new(session_key: &'a str, now_ms: i64, model: &'a str, budget: Budget) -> CtxEnv<'a> {
        CtxEnv {
            session_key,
            now_ms,
            now_turn: None,
            step: None,
            model,
            budget,
            redact_paths: false,
            default_summary_tokens: 400,
        }
    }
}

fn fail(action: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "action": action, "text": message.into()})
}

fn ok_text(action: &str, message: impl Into<String>, extra: Value) -> Value {
    let mut base = json!({"ok": true, "action": action, "text": message.into()});
    if let (Some(obj), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    base
}

/// Shorten a path for display (`…/src/main.rs`) without changing what it points at.
pub fn shorten(path: &str, redact: bool) -> String {
    if !redact {
        return path.to_string();
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => path.to_string(),
        1 | 2 => path.to_string(),
        _ => format!("…/{}", parts[parts.len() - 2..].join("/")),
    }
}

fn category_blocks(conn: &rusqlite::Connection, session_key: &str, nodes: &[super::model::Node], only: Option<&str>) -> rusqlite::Result<Vec<CategoryBlock>> {
    let cats = store::load_categories(conn, session_key)?;
    let mut blocks = Vec::new();
    for cat in cats.into_iter().filter(|c| !c.deleted) {
        if let Some(only) = only {
            if cat.id != only {
                continue;
            }
        }
        let in_cat: Vec<super::model::Node> = nodes
            .iter()
            .filter(|n| n.parent == cat.id || n.tags.iter().any(|t| t == &cat.id))
            .cloned()
            .collect();
        blocks.push(CategoryBlock {
            id: cat.id,
            title: cat.title,
            ai_owned: cat.owner == "ai",
            nodes: in_cat,
            cap_tokens: cat.cap_tokens,
        });
    }
    // Nodes filed under a category the tree no longer has must still be visible.
    let known: Vec<&str> = blocks.iter().map(|b| b.id.as_str()).collect();
    let orphans: Vec<super::model::Node> = nodes.iter().filter(|n| !known.contains(&n.parent.as_str())).cloned().collect();
    if !orphans.is_empty() && only.is_none() {
        blocks.push(CategoryBlock { id: "other".into(), title: "Other".into(), ai_owned: false, nodes: orphans, cap_tokens: None });
    }
    Ok(blocks)
}

/// Handle one `ctx` call. `args` is the tool input exactly as the model sent it.
pub fn handle(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value, recall: &dyn Recall) -> Value {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or_default();
    // The engine may route a legacy name (ctx_view, ...) straight here.
    let action = match tools::legacy_alias(action) {
        Some(mapped) => mapped,
        None => action,
    };
    let result = match action {
        "view" => view(conn, env, args),
        "set" => set(conn, env, args),
        "category" => category(conn, env, args),
        "summarize" => summarize(conn, env, args, recall),
        "recall" => recall_action(conn, env, args, recall),
        "note" => note(conn, env, args),
        "strategy" => strategy(conn, env, args),
        "prompt" => prompt(conn, env, args),
        "original" => original(conn, env, args),
        "memory" => Ok(memory(conn, env, args)),
        "task" => Ok(task(conn, env, args)),
        // Normally answered by the agent loop (with the platform's provider);
        // here the checklist's long-term group alone is written.
        "remember" | "forget" => {
            let (text, is_error) = super::memory_checklist::long_term_apply(conn, None, action, args);
            Ok(if is_error { fail(action, text) } else { ok_text(action, text, json!({})) })
        }
        "" => Ok(fail("unknown", "action is required: view, set, category, summarize, recall, note, strategy, prompt, original, memory, remember, forget, task.")),
        other => Ok(fail(other, format!("unknown action \"{other}\": view, set, category, summarize, recall, note, strategy, prompt, original, memory, remember, forget, task."))),
    };
    result.unwrap_or_else(|e| fail(action, format!("the context store failed: {e}. Nothing was changed by this call.")))
}

type Handled = rusqlite::Result<Value>;

/// Whether `id` is an item of this chat's checklist: a stored node, a memory
/// record id, or a turn/result id of the transcript (`turn/tN`, `res/RN`).
pub(crate) fn known_item(conn: &rusqlite::Connection, session_key: &str) -> impl Fn(&str) -> bool {
    let nodes: std::collections::HashSet<String> =
        store::load_nodes(conn, session_key).map(|v| v.into_iter().map(|n| n.id.as_str().to_string()).collect()).unwrap_or_default();
    move |id: &str| {
        let numbered = |prefix: &str, letter: char| {
            id.strip_prefix(prefix)
                .map(|rest| rest.split('/').next().unwrap_or_default())
                .map(|head| head.trim_start_matches(letter))
                .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        };
        nodes.contains(id) || super::memory_checklist::is_memory_id(id) || numbered("turn/", 't') || numbered("res/", 'R')
    }
}

/// `ctx task`: the model says which context this task needs, in the same
/// answer as its first tool call. It is stored as the running request's pick
/// and is read by the task's policy selector; `text` holds a proposed rule,
/// which is stored as `proposed` and never becomes active without the user.
/// Always succeeds: a wrong id or policy is corrected and the correction named,
/// so it never counts as a failed call or a retry.
fn task(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Value {
    use crate::context_policy::{store as pstore, TempChecklist, Source};
    let policy = args.get("id").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let ids: Vec<String> = args
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let focus = args
        .get("focus")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(crate::context_policy::task_goal::MAX_OUTCOME_CHARS).collect::<String>())
        .filter(|s| !s.is_empty());
    let known = known_item(conn, env.session_key);
    let (list, fix) = TempChecklist::build(policy.as_deref(), None, &ids, &known, 0, Source::Ai, env.now_ms);
    let kept: Vec<String> = list.item_ids.iter().filter(|i| !i.starts_with("user/")).cloned().collect();
    let mut lines = vec![format!(
        "task context: {} ({}){}",
        list.policy_id,
        list.policy_id.name(),
        if kept.is_empty() { String::new() } else { format!(", items: {}", kept.join(", ")) }
    )];
    for n in &fix.notes {
        lines.push(format!("corrected: {n}"));
    }
    let pick = pstore::AiPickRow {
        policy: Some(list.policy_id.as_str().to_string()),
        params: None,
        ids: kept.clone(),
        focus: focus.clone(),
        at: env.now_ms,
    };
    let stored = pstore::set_pick(conn, env.session_key, &pick).is_ok();
    if !stored {
        lines.push("note: the pick could not be stored; this task uses full context (T7).".into());
    }
    let mut proposal = Value::Null;
    if let Some(text) = args.get("text").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        match serde_json::from_str::<Value>(text) {
            Ok(rule) => {
                let errors = crate::context_policy::dsl_validator::check_rule(&rule);
                let errs_json = Value::Array(errors.iter().map(|e| e.to_json()).collect());
                match pstore::add_proposal(conn, env.session_key, &rule, &errs_json, env.now_ms) {
                    Ok(pid) => {
                        lines.push(format!(
                            "rule proposal #{pid} saved as proposed; it is not active until the user approves it{}",
                            if errors.is_empty() { String::new() } else { format!(" ({} problem(s) to fix first: {})", errors.len(), errors[0]) }
                        ));
                        proposal = json!({"id": pid, "status": "proposed", "problems": errs_json});
                    }
                    Err(_) => lines.push("note: the rule proposal could not be stored.".into()),
                }
            }
            Err(e) => lines.push(format!("note: text is not a JSON rule ({e}); no proposal was saved.")),
        }
    }
    lines.push("Answer fully, as you normally would. If something seems missing: ctx task id:T7.".into());
    ok_text(
        "task",
        lines.join("\n"),
        json!({
            "policy": list.policy_id.as_str(),
            "ids": kept,
            "focus": focus,
            "corrections": fix.notes,
            "droppedIds": fix.dropped_ids,
            "proposal": proposal,
        }),
    )
}

/// The chat memory as checklist rows (memory_checklist.rs): groups, one
/// record with every version (`id`), one group (`path`), or one of the old
/// inspection sections. This replaces the separate `memory_inspect` tool.
fn memory(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Value {
    let (text, is_error) = super::memory_checklist::view(conn, env.session_key, args);
    if is_error {
        fail("memory", text)
    } else {
        ok_text("memory", text, json!({"alwaysOn": true}))
    }
}

/// Raw-vs-summary for summarized turns: the model (like the user in the
/// card) can send a range's original turns instead of / beside its summary,
/// or one original turn beside it. It takes effect from the next request.
fn original(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    use crate::turn_memory::{load_memory, raw_select as rs};
    let mem = load_memory(conn, env.session_key);
    if mem.segments.is_empty() {
        return Ok(fail("original", "nothing is summarized yet; every turn is sent as written."));
    }
    let mut sel = rs::load(conn, env.session_key);
    if let Some(r) = args.get("range").and_then(|v| v.as_array()) {
        let a = r.first().and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let b = r.get(1).and_then(|v| v.as_u64()).unwrap_or(a as u64) as u32;
        let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or(rs::RAW);
        if !matches!(mode, "summary" | "raw" | "both") {
            return Ok(fail("original", "mode is summary, raw or both."));
        }
        if !mem.segments.iter().any(|s| s.from_turn == a && s.to_turn == b) {
            let have: Vec<String> = mem.segments.iter().map(|s| format!("{}-{}", s.from_turn, s.to_turn)).collect();
            return Ok(fail("original", format!("no summarized range {a}-{b}; the ranges are {}.", have.join(", "))));
        }
        rs::set_range(&mut sel, a, b, mode);
    } else if let Some(t) = args.get("turn").and_then(|v| v.as_u64()) {
        let t = t as u32;
        let raw = args.get("raw").and_then(|v| v.as_bool()).unwrap_or(true);
        if raw && (t == 0 || t > mem.through_turn) {
            return Ok(fail("original", format!("turn {t} is not summarized; summaries cover turns 1-{}.", mem.through_turn)));
        }
        rs::set_turn(&mut sel, t, raw);
    } else {
        let plan = rs::plan(&mem, &sel);
        return Ok(ok_text("original", format!("original turns sent: {:?}; summaries left out: {:?}.", plan.raw_turns, plan.skip_ranges), json!({"selection": sel, "plan": plan})));
    }
    sel.updated_at = env.now_ms;
    if let Err(e) = rs::save(conn, env.session_key, &sel) {
        return Ok(fail("original", format!("could not save the choice: {e}")));
    }
    let plan = rs::plan(&mem, &sel);
    Ok(ok_text(
        "original",
        format!("from the next request: original turns {:?}, summaries left out {:?}.", plan.raw_turns, plan.skip_ranges),
        json!({"selection": sel, "plan": plan}),
    ))
}

fn view(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    let path = args.get("path").and_then(|v| v.as_str());
    let since = args.get("since_rev").and_then(|v| v.as_i64());
    let rev = store::rev(conn, env.session_key)?;
    if let Some(since) = since {
        let log = store::load_log(conn, env.session_key, 20)?;
        let changed: Vec<Value> = log
            .into_iter()
            .filter(|e| e["revAfter"].as_i64().unwrap_or(0) > since)
            .collect();
        return Ok(ok_text(
            "view",
            format!("{} change(s) since rev {since}; the tree is at rev {rev}.", changed.len()),
            json!({"rev": rev, "changes": changed}),
        ));
    }
    let nodes = store::load_nodes(conn, env.session_key)?;
    let blocks = category_blocks(conn, env.session_key, &nodes, path)?;
    if let Some(p) = path {
        if blocks.is_empty() && !p.is_empty() {
            // A node id instead of a category: show that one item in full.
            if let Some(node) = store::load_node(conn, env.session_key, p)? {
                return Ok(ok_text(
                    "view",
                    format!(
                        "{} · {} · {} · {} tokens · state {} · pin {} · source {}",
                        node.id,
                        node.title,
                        node.kind.as_str(),
                        node.tokens_full,
                        node.state.as_str(),
                        node.pin.as_str(),
                        shorten(node.provenance.source.as_str(), env.redact_paths)
                    ),
                    json!({"rev": rev, "node": {"id": node.id.as_str(), "state": node.state.as_str(), "pin": node.pin.as_str(), "tokens": node.tokens_full}}),
                ));
            }
            return Ok(fail("view", text::unknown_node(p)));
        }
    }
    let summary = select::summarize(&nodes);
    let rendered = render::checklist(&env.budget, env.model, &blocks, rev, env.redact_paths);
    Ok(ok_text(
        "view",
        rendered,
        json!({
            "rev": rev,
            "counts": {
                "in": summary.in_items,
                "note": summary.note_items,
                "temp": summary.temp_items,
                "out": summary.out_items,
            },
            "tokens": {"sent": summary.sent_tokens, "selectable": env.budget.selectable, "free": env.budget.free},
            // Per-item cost for the panel's breakdown card. `sent_tokens` is what the
            // engine will really put in the request, not what was stored with the node,
            // so a stale `tokens_full` cannot make the card lie.
            "items": nodes.iter().map(|n| json!({
                "id": n.id.as_str(),
                "title": n.title,
                "state": n.state.as_str(),
                "tokens": select::sent_tokens(n),
            })).collect::<Vec<_>>(),
        }),
    ))
}

fn set(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    let Some(ops_raw) = args.get("ops") else {
        return Ok(fail("set", "ops is required, e.g. [{\"id\":\"turn/t12\",\"action\":\"exclude\"}]."));
    };
    // Memory rows (mem/D12, #D12) are the memory checklist's; the rest are
    // the tree's own nodes.
    let (mem_ops, tree_ops): (Vec<Value>, Vec<Value>) = match ops_raw.as_array() {
        Some(a) => a.iter().cloned().partition(|o| o.get("id").and_then(|v| v.as_str()).map(super::memory_checklist::is_memory_id).unwrap_or(false)),
        None => (Vec::new(), Vec::new()),
    };
    let mem_result = if mem_ops.is_empty() {
        None
    } else if args.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false) {
        Some(json!({"ok": true, "memory": [], "dryRun": true}))
    } else {
        Some(super::memory_checklist::apply_ops(conn, env.session_key, &mem_ops, "model", env.now_ms))
    };
    if let Some(m) = &mem_result {
        if tree_ops.is_empty() {
            let lines: Vec<String> = m["memory"].as_array().map(|a| a.iter().map(|r| r["message"].as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
            let mut out = m.clone();
            out["action"] = json!("set");
            out["text"] = json!(if lines.is_empty() { "nothing changed".to_string() } else { lines.join("; ") });
            return Ok(out);
        }
    }
    let ops_raw = &Value::Array(tree_ops);
    let ops = match parse_ops(ops_raw) {
        Ok(ops) if !ops.is_empty() => ops,
        Ok(_) => return Ok(fail("set", "ops is empty: send at least one change.")),
        Err(e) => return Ok(fail("set", e)),
    };
    let expect_rev = args.get("expect_rev").and_then(|v| v.as_i64());
    let dry_run = args.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false);
    let batch_env = BatchEnv {
        session_key: env.session_key,
        now_ms: env.now_ms,
        now_turn: env.now_turn,
        step: env.step,
        actor: "model",
        tool: "ctx",
    };
    let result = apply_batch(conn, &batch_env, &ops, expect_rev, dry_run)?;
    let mut out = result.to_json();
    if let Some(obj) = out.as_object_mut() {
        obj.insert("text".into(), json!(result.headline()));
        obj.insert("action".into(), json!("set"));
        if let Some(m) = mem_result {
            obj.insert("memory".into(), m["memory"].clone());
        }
    }
    Ok(out)
}

fn category(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    let rev = store::rev(conn, env.session_key)?;
    let cats = store::load_categories(conn, env.session_key)?;
    let id = args.get("id").and_then(|v| v.as_str());
    let title = args.get("title").and_then(|v| v.as_str());

    match (id, title) {
        // Create or rename.
        (Some(id), Some(title)) => {
            if !id.starts_with("cat/") {
                return Ok(fail(
                    "category",
                    "your own categories must be named cat/… (the built-in ones wrap the engine's own structure).",
                ));
            }
            let parent = args.get("path").and_then(|v| v.as_str());
            let cap = args.get("max_tokens").and_then(|v| v.as_i64());
            if !store::upsert_category(conn, env.session_key, id, parent, title, "ai", cap, env.now_ms)? {
                return Ok(fail("category", "that category cannot be created: depth is capped at 6, and built-in categories are not renameable."));
            }
            store::bump_rev(conn, env.session_key, env.now_ms)?;
            Ok(ok_text(
                "category",
                format!("{id} (\"{title}\") is ready{}.", if cap.is_some() { " with a token cap" } else { "" }),
                json!({"rev": store::rev(conn, env.session_key)?, "id": id}),
            ))
        }
        // Delete.
        (Some(id), None) if args.get("delete_contents").and_then(|v| v.as_bool()).unwrap_or(false) => {
            let fallback = "other";
            if !store::delete_category(conn, env.session_key, id, fallback)? {
                return Ok(fail("category", format!("{id} is built in or does not exist; it cannot be deleted.")));
            }
            store::bump_rev(conn, env.session_key, env.now_ms)?;
            Ok(ok_text("category", format!("{id} is gone; its items moved to notes-level storage, not deleted."), json!({"rev": store::rev(conn, env.session_key)?})))
        }
        // List.
        _ => {
            let listing: Vec<Value> = cats
                .iter()
                .filter(|c| !c.deleted)
                .map(|c| {
                    json!({
                        "id": c.id,
                        "title": c.title,
                        "owner": c.owner,
                        "cap": c.cap_tokens,
                        "depth": c.depth,
                    })
                })
                .collect();
            Ok(ok_text(
                "category",
                format!("{} categories. Yours can be renamed or deleted; the built-in ones cannot.", listing.len()),
                json!({"rev": rev, "categories": listing}),
            ))
        }
    }
}

fn summarize(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value, recall: &dyn Recall) -> Handled {
    let ids: Vec<String> = args
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(fail("summarize", "ids is required: which items should be replaced by one summary?"));
    }
    let mut found = Vec::new();
    let mut tokens = 0u32;
    for raw in &ids {
        match store::load_node(conn, env.session_key, raw)? {
            Some(node) if node.pin.is_hard() => {
                return Ok(fail("summarize", text::refused_locked(&node.id)));
            }
            Some(node) => {
                tokens += node.tokens_full;
                found.push(node);
            }
            None => return Ok(fail("summarize", text::unknown_node(raw))),
        }
    }
    let max_tokens = args
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .map(|v| v.clamp(64, 4_000) as u32)
        .unwrap_or(env.default_summary_tokens);
    let focus = args.get("focus").and_then(|v| v.as_str()).map(|f| f.to_string());
    // A summary the caller already produced (a sub-agent, a previous step) can be
    // stored directly; otherwise the engine is asked to run one.
    if let Some(raw_summary) = args.get("text").and_then(|v| v.as_str()) {
        // Like a note, a summary is sent back on every request (SECURITY T8).
        let redacted = crate::error_taxonomy::redact_secrets(raw_summary);
        let summary_text = redacted.as_str();
        let id = next_id(conn, env, super::model::NodeKind::TempSummary)?;
        let sources: Vec<String> = found.iter().map(|n| n.id.as_str().to_string()).collect();
        store::put_temp_summary(
            conn,
            env.session_key,
            id.as_str(),
            summary_text,
            focus.as_deref(),
            &sources,
            "model",
            render::estimate_tokens(summary_text) as u32,
            env.now_ms,
        )?;
        for node in &found {
            store::set_state(conn, env.session_key, node.id.as_str(), ItemState::Temp, None, env.now_ms)?;
        }
        store::upsert_node(
            conn,
            &super::model::Node {
                id: id.clone(),
                session_key: env.session_key.to_string(),
                kind: super::model::NodeKind::TempSummary,
                parent: "turns".into(),
                tags: Vec::new(),
                order: found.first().map(|n| n.order).unwrap_or(0),
                title: super::model::safe_title(focus.as_deref().unwrap_or("summary")),
                state: ItemState::In,
                pin: super::model::Pin::Ai,
                owner: super::model::Owner::Ai,
                tokens_full: render::estimate_tokens(summary_text) as u32,
                tokens_note: 0,
                token_model: String::new(),
                note: None,
                provenance: super::model::Provenance { source: "model".into(), locator: Some(id.as_str().to_string()), ..Default::default() },
                created_at: env.now_ms,
                last_used_at: Some(env.now_ms),
                loaded_at: Some(env.now_ms),
                turn: env.now_turn,
                rev: 1,
                deleted: false,
            },
        )?;
        let rev = store::bump_rev(conn, env.session_key, env.now_ms)?;
        return Ok(ok_text(
            "summarize",
            format!("{} item(s) replaced by {id}: {} tokens → {}.", found.len(), tokens, render::estimate_tokens(summary_text)),
            json!({"rev": rev, "tempId": id.as_str(), "replaced": sources}),
        ));
    }
    let via_subagent = args.get("via_subagent").and_then(|v| v.as_bool()).unwrap_or(false);
    if via_subagent {
        // The engine has no "run this in a temp sub-agent" primitive the model can
        // reach, and a tool call cannot await one. What it *can* do is hand the
        // model a complete `spawn_subagent` request: the material is embedded,
        // the child sees nothing else, and the parent stores the answer with
        // `summarize {text}` (or keeps it as-is) when it comes back.
        let borrowed: Vec<&Node> = found.iter().collect();
        let material = spawn_material(conn, env, &borrowed, recall, SPAWN_MATERIAL_CHARS);
        let focus_line = focus.as_deref().map(|f| format!(" Focus on: {f}.")).unwrap_or_default();
        let task = format!(
            "Summarize the material below in at most {max_tokens} tokens.{focus_line}\n\
             Only this material is yours; you have no other context and no tools.\n\
             Keep names, numbers, paths, decisions and next steps exact. No preamble.\n\n\
             === MATERIAL ===\n{material}"
        );
        let spawn = json!({
            "task": task,
            "name": "ctx-summary",
            "title": focus.clone().unwrap_or_else(|| "Context summary".to_string()),
            "hidden": true,
            "wait": true,
            "maxSteps": 2,
            "tokenBudget": max_tokens,
            "context": "fresh",
            // Stage 7: the engine deletes it once its answer reached the parent.
            "lifetime": "temp",
        });
        return Ok(ok_text(
            "summarize",
            format!(
                "spawn_subagent is ready with exactly these {} item(s) ({tokens} tokens) and a budget of {max_tokens} tokens. \
                 Call it, then store the answer with ctx summarize {{text}} — the children you replaced go to `temp`.",
                found.len()
            ),
            json!({
                "rev": store::rev(conn, env.session_key)?,
                "needs_model": true,
                "viaSubagent": true,
                "spawnRequest": spawn,
                "sources": found.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
                "maxTokens": max_tokens,
                "focus": focus,
                "tokens": tokens,
                // A summarising child exists for one call: `lifetime: temp` makes
                // the engine delete it once its report reached the parent (stage 7),
                // and `hidden` keeps it out of the agent list meanwhile.
                "subagentLifetime": "temp",
            }),
        ));
    }
    Ok(ok_text(
        "summarize",
        format!(
            "ready to summarize {} item(s) ({tokens} tokens) into at most {max_tokens}: {}.{}",
            found.len(),
            if via_subagent {
                "the engine will run it in a temp sub-agent that is deleted when done"
            } else {
                "the engine will run it and store the result"
            },
            if via_subagent { " The sub-agent only sees these items, never the whole chat." } else { "" }
        ),
        json!({
            "needs_model": true,
            "sources": found.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            "maxTokens": max_tokens,
            "focus": focus,
            "viaSubagent": via_subagent,
            // A sub-agent run must be a *temp* one: it is deleted when it returns,
            // so a summarising sub-agent can never accumulate in the tree.
            "subagentLifetime": if via_subagent { Some("temp") } else { None },
            "tokens": tokens,
        }),
    ))
}

/// The turn number of a node: the column first, the id second. A node built by an
/// older build (or by a test) may only carry `turn/t12` and no column.
fn turn_number(node: &super::model::Node) -> Option<u32> {
    if let Some(t) = node.turn {
        return Some(t);
    }
    node.id
        .as_str()
        .strip_prefix("turn/t")
        .and_then(|rest| rest.split('/').next())
        .and_then(|n| n.parse::<u32>().ok())
}

/// The text behind a node, from the tree for its own kinds and from the engine
/// for the immutable ones. `None` means "listed but not retrievable right now".
fn node_body(conn: &rusqlite::Connection, env: &CtxEnv<'_>, node: &Node, recall: &dyn Recall) -> Option<String> {
    match node.kind {
        super::model::NodeKind::Note => store::load_note(conn, env.session_key, node.id.as_str()).ok().flatten(),
        super::model::NodeKind::TempSummary => store::load_temp_summary(conn, env.session_key, node.id.as_str()).ok().flatten(),
        super::model::NodeKind::Turn => turn_number(node).and_then(|t| recall.turn(t)),
        super::model::NodeKind::Result => node.provenance.locator.as_deref().and_then(|r| recall.result(r)),
        super::model::NodeKind::File => node
            .provenance
            .locator
            .as_deref()
            .and_then(|loc| recall.file(loc, node.provenance.range.as_deref())),
        _ => None,
    }
}

/// How much source text a summarising child is given. A summary target of 600
/// tokens needs the material, but a child that receives the whole window would be
/// as expensive as the request we are trying to shrink.
const SPAWN_MATERIAL_CHARS: usize = 24_000;

/// Concatenate the bodies of `nodes`, in tree order, each with a header so the
/// child can name what it is summarising. Stops at `limit` characters and says so.
fn spawn_material(
    conn: &rusqlite::Connection,
    env: &CtxEnv<'_>,
    nodes: &[&Node],
    recall: &dyn Recall,
    limit: usize,
) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    let mut skipped = 0usize;
    for node in nodes {
        let Some(body) = node_body(conn, env, node, recall) else {
            skipped += 1;
            continue;
        };
        let header = format!("\n=== {} :: {} ===\n", node.id.as_str(), node.title);
        let room = limit.saturating_sub(used + header.len());
        if room < 200 {
            skipped += 1;
            continue;
        }
        out.push_str(&header);
        let piece: String = body.chars().take(room).collect();
        used += header.len() + piece.len();
        out.push_str(&piece);
        if piece.len() < body.len() {
            out.push_str("\n[... cut here]");
        }
    }
    if skipped > 0 {
        out.push_str(&format!("\n[{skipped} item(s) could not be included: their source is gone]"));
    }
    if out.is_empty() {
        out.push_str("[no item text was retrievable; summarize from the tree listing only]");
    }
    out
}

fn recall_action(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value, recall: &dyn Recall) -> Handled {
    let id = args.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if id.is_empty() {
        return Ok(fail("recall", "id is required (an item id, e.g. turn/t12 or res/R7)."));
    }
    let Some(node) = store::load_node(conn, env.session_key, id)? else {
        return Ok(fail("recall", text::unknown_node(id)));
    };
    let max_tokens = args.get("max_tokens").and_then(|v| v.as_u64()).map(|v| v.clamp(64, 4_000) as usize).unwrap_or(1_500);
    // Own content first: notes and temp summaries live in the tree.
    let body = node_body(conn, env, &node, recall);
    let Some(body) = body else {
        return Ok(ok_text(
            "recall",
            format!("{id} is not retrievable right now (its source is gone or the engine did not provide it). It is still listed in the tree."),
            json!({"found": false}),
        ));
    };
    let truncated = body.chars().count() > max_tokens * 4;
    let shown: String = body.chars().take(max_tokens * 4).collect();
    store::touch(conn, env.session_key, &[id], env.now_ms)?;
    let keep = args.get("keep").and_then(|v| v.as_bool()).unwrap_or(false);
    if keep {
        store::set_state(conn, env.session_key, id, ItemState::In, None, env.now_ms)?;
        store::bump_rev(conn, env.session_key, env.now_ms)?;
    }
    Ok(ok_text(
        "recall",
        format!("{id}{}: {}", if truncated { " (first part)" } else { "" }, shown),
        json!({
            "found": true,
            "truncated": truncated,
            "tokens": render::estimate_tokens(&body),
            "kept": keep,
            "maxTokens": max_tokens,
        }),
    ))
}

fn note(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or_default();
    let body = args.get("text").and_then(|v| v.as_str()).unwrap_or_default();
    if title.is_empty() || body.is_empty() {
        return Ok(fail("note", "title and text are required: the note is what you keep when the item itself is too big."));
    }
    let state = match args.get("state").and_then(|v| v.as_str()) {
        Some("out") => ItemState::Out,
        _ => ItemState::In,
    };
    let category = args.get("category").and_then(|v| v.as_str()).unwrap_or("notes");
    // A note goes back to the model on every request and into the panel:
    // credentials the model copied into it are removed first (SECURITY T8).
    let redacted = crate::error_taxonomy::redact_secrets(body);
    let body = redacted.as_str();
    let id = next_id(conn, env, super::model::NodeKind::Note)?;
    store::put_note(conn, env.session_key, id.as_str(), &super::model::safe_title(title), body, category, state, env.now_ms)?;
    let tokens = render::estimate_tokens(body) as u32;
    store::upsert_node(
        conn,
        &super::model::Node {
            id: id.clone(),
            session_key: env.session_key.to_string(),
            kind: super::model::NodeKind::Note,
            parent: category.to_string(),
            tags: Vec::new(),
            order: 0,
            title: super::model::safe_title(title),
            state,
            pin: super::model::Pin::Ai,
            owner: super::model::Owner::Ai,
            tokens_full: tokens,
            tokens_note: tokens,
            token_model: String::new(),
            note: None,
            provenance: super::model::Provenance { source: "model".into(), locator: Some(id.as_str().to_string()), ..Default::default() },
            created_at: env.now_ms,
            last_used_at: Some(env.now_ms),
            loaded_at: None,
            turn: env.now_turn,
            rev: 1,
            deleted: false,
        },
    )?;
    let rev = store::bump_rev(conn, env.session_key, env.now_ms)?;
    Ok(ok_text(
        "note",
        format!("{id} saved ({tokens} tokens, {}).", if state == ItemState::In { "sent with every request" } else { "not sent until you include it" }),
        json!({"rev": rev, "id": id.as_str(), "tokens": tokens}),
    ))
}

fn strategy(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    let body = args.get("text").and_then(|v| v.as_str());
    let step = args.get("step").and_then(|v| v.as_str());
    match (body, step) {
        (None, None) => {
            let latest = store::latest_strategy(conn, env.session_key)?;
            Ok(match latest {
                Some((version, text_body, next)) => ok_text(
                    "strategy",
                    format!("strategy v{version}{}: {}", next.map(|n| format!(" · next: {n}")).unwrap_or_default(), text_body),
                    json!({"version": version}),
                ),
                None => ok_text("strategy", "no strategy recorded yet.", json!({"version": 0})),
            })
        }
        (Some(text), next) => {
            let version = store::put_strategy(conn, env.session_key, text, next, env.now_ms)?;
            let rev = store::bump_rev(conn, env.session_key, env.now_ms)?;
            Ok(ok_text(
                "strategy",
                format!("strategy v{version} saved ({} tokens). It stays in the window while it fits.", render::estimate_tokens(text)),
                json!({"rev": rev, "version": version}),
            ))
        }
        (None, Some(step)) => {
            let (previous, text_body, _) = store::latest_strategy(conn, env.session_key)?.unwrap_or((0, String::new(), None));
            let version = store::put_strategy(conn, env.session_key, &text_body, Some(step), env.now_ms)?;
            let rev = store::bump_rev(conn, env.session_key, env.now_ms)?;
            Ok(ok_text(
                "strategy",
                format!("next step: {step} (strategy v{previous} → v{version})."),
                json!({"rev": rev, "version": version, "previous": previous}),
            ))
        }
    }
}

fn prompt(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    let load: Vec<String> = args
        .get("load")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let unload: Vec<String> = args
        .get("unload")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if load.is_empty() && unload.is_empty() {
        let nodes = store::load_nodes(conn, env.session_key)?;
        let parts: Vec<Value> = nodes
            .iter()
            .filter(|n| n.kind == super::model::NodeKind::SysPart)
            .map(|n| json!({"id": n.id.as_str(), "state": n.state.as_str(), "tokens": n.tokens_full, "locked": n.pin.is_hard()}))
            .collect();
        return Ok(ok_text("prompt", format!("{} prompt part(s).", parts.len()), json!({"parts": parts})));
    }
    let mut changed = Vec::new();
    let mut refused = Vec::new();
    for (ids, want) in [(&load, ItemState::In), (&unload, ItemState::Out)] {
        for raw in ids {
            let id = if raw.starts_with("sys/") { raw.clone() } else { format!("sys/{raw}") };
            match store::load_node(conn, env.session_key, &id)? {
                None => refused.push(json!({"id": id, "why": "no such prompt part"})),
                Some(node) if node.pin == super::model::Pin::Locked && want == ItemState::Out => {
                    refused.push(json!({"id": id, "why": "locked: the rules prompt is always sent"}))
                }
                Some(node) => {
                    store::set_state(conn, env.session_key, &id, want, None, env.now_ms)?;
                    changed.push(json!({"id": id, "state": want.as_str(), "tokens": node.tokens_full}));
                }
            }
        }
    }
    let rev = if changed.is_empty() { store::rev(conn, env.session_key)? } else { store::bump_rev(conn, env.session_key, env.now_ms)? };
    Ok(ok_text(
        "prompt",
        format!("{} part(s) changed, {} refused. sys/core can never be unloaded.", changed.len(), refused.len()),
        json!({"rev": rev, "changed": changed, "refused": refused}),
    ))
}

fn next_id(conn: &rusqlite::Connection, env: &CtxEnv<'_>, kind: super::model::NodeKind) -> rusqlite::Result<NodeId> {
    store::next_node_id(conn, env.session_key, kind, env.now_ms)
}

/// The marker the assembler looks for when it decides whether a checklist is
/// already in the request. Re-exported so the wiring imports it from one place.
pub fn checklist_marker() -> &'static str {
    CHECKLIST_MARKER
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::budget::{Budget, BudgetInput};
    use crate::context_tree::model::{Node, NodeKind, Owner, Pin, Provenance};

    struct FakeRecall;
    impl Recall for FakeRecall {
        fn turn(&self, n: u32) -> Option<String> {
            Some(format!("turn {n}: the user asked for the apk"))
        }
        fn result(&self, result_id: &str) -> Option<String> {
            if result_id == "R7" {
                Some("build log: 42 passed".into())
            } else {
                None
            }
        }
        fn file(&self, locator: &str, range: Option<&str>) -> Option<String> {
            Some(format!("{locator} {range:?}: fn main() {{}}"))
        }
    }

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        store::ensure_tables(&conn).unwrap();
        store::ensure_session(&conn, "s1", 1_000).unwrap();
        conn
    }

    fn env<'a>(budget: &'a Budget, model: &'a str) -> CtxEnv<'a> {
        CtxEnv::new("s1", 2_000, model, *budget)
    }

    #[test]
    fn ctx_task_never_fails_corrects_bad_ids_and_policies_and_stores_rule_proposals() {
        let conn = db();
        let b = budget();
        let out = handle(&conn, &env(&b, "m"), &json!({"action": "task", "id": "T9", "ids": ["turn/t2", "bogus", "sys/core"], "focus": "find the bug"}), &FakeRecall);
        assert_eq!(out["ok"], json!(true), "{out}");
        assert!(out.get("error").is_none());
        assert_eq!(out["policy"], "T7");
        assert_eq!(out["ids"], json!(["turn/t2"]));
        assert_eq!(out["droppedIds"], json!(["bogus", "sys/core"]));
        assert!(out["text"].as_str().unwrap().contains("corrected"));
        let pick = crate::context_policy::store::get_pick(&conn, "s1").unwrap().unwrap();
        assert_eq!(pick.policy.as_deref(), Some("T7"));
        assert_eq!(pick.focus.as_deref(), Some("find the bug"));
        let (_, is_error) = (serde_json::to_string(&out).unwrap(), out.get("ok").and_then(|v| v.as_bool()) == Some(false));
        assert!(!is_error);
        let rule = json!({"id": "R_DEVICE", "priority": 100, "if": "request.category == 'device_action'", "then": {"policy": "T1"}}).to_string();
        let out = handle(&conn, &env(&b, "m"), &json!({"action": "task", "id": "T1", "text": rule}), &FakeRecall);
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["proposal"]["status"], "proposed");
        assert_eq!(out["proposal"]["problems"], json!([]));
        let props = crate::context_policy::store::list_proposals(&conn, Some("proposed")).unwrap();
        assert_eq!(props.len(), 1);
        let bad = json!({"id": "x", "if": "nope.y == 1", "then": {"policy": "T9"}}).to_string();
        let out = handle(&conn, &env(&b, "m"), &json!({"action": "task", "text": bad}), &FakeRecall);
        assert_eq!(out["ok"], json!(true), "a bad proposal is still not an error");
        assert_eq!(out["proposal"]["problems"].as_array().unwrap().len(), 3);
        let out = handle(&conn, &env(&b, "m"), &json!({"action": "task", "text": "not json"}), &FakeRecall);
        assert_eq!(out["ok"], json!(true));
        assert!(out["proposal"].is_null());
    }

    fn budget() -> Budget {
        Budget::compute(BudgetInput { window: 128_000, reserve_out: 8_000, headroom: 0, locked: 10_000, min_selectable: 1 }, 20_000, 70)
    }

    fn put(conn: &rusqlite::Connection, id: &str, kind: NodeKind, state: ItemState, tokens: u32) {
        // Mirror what reading.rs does for the engine's own furniture: sys/core is
        // locked, other prompt parts are the model's, essentials are policy pins.
        let pin = match kind {
            NodeKind::SysPart => Pin::Locked,
            NodeKind::Essential => Pin::Policy,
            _ => Pin::None,
        };
        store::upsert_node(
            conn,
            &Node {
                id: NodeId::parse(id).unwrap(),
                session_key: "s1".into(),
                kind,
                parent: kind.home_category().into(),
                tags: vec![],
                order: 0,
                title: format!("item {id}"),
                state,
                pin,
                owner: Owner::Policy,
                tokens_full: tokens,
                tokens_note: tokens / 10,
                token_model: String::new(),
                note: None,
                provenance: Provenance::default(),
                created_at: 1,
                last_used_at: None,
                loaded_at: None,
                turn: None,
                rev: 1,
                deleted: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn an_unknown_or_missing_action_is_told_the_list() {
        let conn = db();
        let b = budget();
        let e = env(&b, "m");
        let r = handle(&conn, &e, &json!({}), &NoRecall);
        assert_eq!(r["ok"], false);
        assert!(r["text"].as_str().unwrap().contains("view"));
        let r = handle(&conn, &e, &json!({"action": "explode"}), &NoRecall);
        assert_eq!(r["ok"], false);
        assert!(r["text"].as_str().unwrap().contains("explode"));
    }

    #[test]
    fn the_legacy_names_route_to_the_same_handlers() {
        let conn = db();
        let b = budget();
        let e = env(&b, "m");
        let r = handle(&conn, &e, &json!({"action": "ctx_view"}), &NoRecall);
        assert_eq!(r["ok"], true);
        assert_eq!(r["action"], "view");
    }

    #[test]
    fn view_renders_the_checklist_with_numbers_and_a_revision() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 400);
        let b = budget();
        let e = env(&b, "gpt-x");
        let r = handle(&conn, &e, &json!({"action": "view"}), &NoRecall);
        assert_eq!(r["ok"], true);
        let body = r["text"].as_str().unwrap();
        assert!(body.starts_with(CHECKLIST_MARKER), "{body}");
        assert!(body.contains("item turn/t1"));
        assert_eq!(r["counts"]["in"], 1);
        assert_eq!(r["tokens"]["sent"], 400);
    }

    #[test]
    fn view_can_show_one_item_or_only_what_changed() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 400);
        let b = budget();
        let e = env(&b, "m");
        let one = handle(&conn, &e, &json!({"action": "view", "path": "turn/t1"}), &NoRecall);
        assert_eq!(one["ok"], true);
        assert!(one["text"].as_str().unwrap().contains("turn/t1"));
        let missing = handle(&conn, &e, &json!({"action": "view", "path": "turn/t99"}), &NoRecall);
        assert_eq!(missing["ok"], false);
    }

    #[test]
    fn set_without_ops_explains_the_shape() {
        let conn = db();
        let b = budget();
        let e = env(&b, "m");
        let r = handle(&conn, &e, &json!({"action": "set"}), &NoRecall);
        assert_eq!(r["ok"], false);
        assert!(r["text"].as_str().unwrap().contains("ops"));
        let r = handle(&conn, &e, &json!({"action": "set", "ops": []}), &NoRecall);
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn set_applies_and_reports_like_the_model_needs_it_to() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 400);
        let b = budget();
        let e = env(&b, "m");
        let r = handle(&conn, &e, &json!({"action": "set", "ops": [{"id": "turn/t1", "action": "exclude"}]}), &NoRecall);
        assert_eq!(r["ok"], true);
        assert_eq!(r["applied"], 1);
        assert_eq!(r["tokens"]["after"], 0);
        assert!(r["text"].as_str().unwrap().contains("1 applied"));
    }

    #[test]
    fn a_note_round_trips_through_recall() {
        let conn = db();
        let b = budget();
        let e = env(&b, "m");
        let made = handle(&conn, &e, &json!({"action": "note", "title": "build cmd", "text": "npm run build"}), &NoRecall);
        assert_eq!(made["ok"], true);
        let id = made["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("note/"));
        let back = handle(&conn, &e, &json!({"action": "recall", "id": id}), &NoRecall);
        assert_eq!(back["ok"], true);
        assert!(back["text"].as_str().unwrap().contains("npm run build"));
    }

    #[test]
    fn recall_reaches_turns_results_and_files_through_the_engine() {
        let conn = db();
        put(&conn, "turn/t3", NodeKind::Turn, ItemState::Out, 400);
        let mut res = Node {
            id: NodeId::parse("res/R7").unwrap(),
            session_key: "s1".into(),
            kind: NodeKind::Result,
            parent: "results".into(),
            tags: vec![],
            order: 0,
            title: "cargo test".into(),
            state: ItemState::Out,
            pin: Pin::None,
            owner: Owner::Policy,
            tokens_full: 900,
            tokens_note: 12,
            token_model: String::new(),
            note: None,
            provenance: Provenance { source: "tool".into(), locator: Some("R7".into()), ..Default::default() },
            created_at: 1,
            last_used_at: None,
            loaded_at: None,
            turn: Some(3),
            rev: 1,
            deleted: false,
        };
        store::upsert_node(&conn, &res).unwrap();
        res.id = NodeId::parse("file/f1").unwrap();
        res.kind = NodeKind::File;
        res.provenance = Provenance { source: "workspace".into(), locator: Some("src/main.rs".into()), ..Default::default() };
        store::upsert_node(&conn, &res).unwrap();

        let b = budget();
        let e = env(&b, "m");
        let t = handle(&conn, &e, &json!({"action": "recall", "id": "turn/t3"}), &FakeRecall);
        assert!(t["text"].as_str().unwrap().contains("apk"), "{t}");
        let r = handle(&conn, &e, &json!({"action": "recall", "id": "res/R7"}), &FakeRecall);
        assert!(r["text"].as_str().unwrap().contains("42 passed"), "{r}");
        let f = handle(&conn, &e, &json!({"action": "recall", "id": "file/f1"}), &FakeRecall);
        assert!(f["text"].as_str().unwrap().contains("fn main"), "{f}");
        // An id the tree does not have is refused with the way out.
        let unknown = handle(&conn, &e, &json!({"action": "recall", "id": "res/R8"}), &FakeRecall);
        assert_eq!(unknown["ok"], false);
        assert!(unknown["text"].as_str().unwrap().contains("no such item"), "{unknown}");
        // A node whose source is gone says so without pretending it failed: it is
        // still listed, it just cannot be fetched right now.
        let mut orphan = res.clone();
        orphan.id = NodeId::parse("res/R9").unwrap();
        orphan.kind = NodeKind::Result;
        orphan.provenance = Provenance { source: "tool".into(), locator: Some("R9".into()), ..Default::default() };
        store::upsert_node(&conn, &orphan).unwrap();
        let gone = handle(&conn, &e, &json!({"action": "recall", "id": "res/R9"}), &FakeRecall);
        assert_eq!(gone["ok"], true);
        assert_eq!(gone["found"], false);
    }

    #[test]
    fn recall_keep_brings_the_item_back_into_the_window() {
        let conn = db();
        put(&conn, "turn/t3", NodeKind::Turn, ItemState::Out, 400);
        let b = budget();
        let e = env(&b, "m");
        let r = handle(&conn, &e, &json!({"action": "recall", "id": "turn/t3", "keep": true}), &FakeRecall);
        assert_eq!(r["kept"], true);
        assert_eq!(store::load_node(&conn, "s1", "turn/t3").unwrap().unwrap().state, ItemState::In);
        assert!(store::rev(&conn, "s1").unwrap() > 0);
    }

    #[test]
    fn summarize_without_text_asks_the_engine_to_run_one() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 4_000);
        put(&conn, "turn/t2", NodeKind::Turn, ItemState::In, 3_000);
        let b = budget();
        let e = env(&b, "m");
        let r = handle(&conn, &e, &json!({"action": "summarize", "ids": ["turn/t1", "turn/t2"], "focus": "the build"}), &NoRecall);
        assert_eq!(r["ok"], true);
        assert_eq!(r["needs_model"], true);
        assert_eq!(r["tokens"], 7_000);
        assert_eq!(r["sources"].as_array().unwrap().len(), 2);
        // Nothing changed yet: the engine has not run.
        assert_eq!(store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap().state, ItemState::In);
    }

    #[test]
    fn via_subagent_hands_back_a_spawn_call_the_model_can_run() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 4_000);
        put(&conn, "turn/t2", NodeKind::Turn, ItemState::In, 3_000);
        let b = budget();
        let e = env(&b, "m");
        let r = handle(
            &conn,
            &e,
            &json!({"action": "summarize", "ids": ["turn/t1", "turn/t2"], "via_subagent": true, "max_tokens": 300, "focus": "the build"}),
            &FakeRecall,
        );
        assert_eq!(r["ok"], true);
        assert_eq!(r["viaSubagent"], true);
        assert_eq!(r["subagentLifetime"], "temp", "a summarising child is meant to exist for one call");
        let spawn = &r["spawnRequest"];
        assert_eq!(spawn["name"], "ctx-summary");
        assert_eq!(spawn["hidden"], true, "it is not one of the user's agents");
        assert_eq!(spawn["wait"], true, "the parent needs the answer in this turn");
        assert_eq!(spawn["tokenBudget"], 300);
        let task = spawn["task"].as_str().unwrap();
        assert!(task.contains("at most 300 tokens"), "{task}");
        assert!(task.contains("Focus on: the build"), "{task}");
        // The material is embedded, so the child needs no tools and no transcript.
        assert!(task.contains("turn/t1") && task.contains("turn/t2"), "{task}");
        assert!(task.contains("the user asked for the apk"), "the actual text rides along");
        // Nothing moved yet: the items stay in the window until an answer exists.
        assert_eq!(store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap().state, ItemState::In);
    }

    #[test]
    fn a_spawn_request_says_so_when_the_material_is_gone() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 4_000);
        let b = budget();
        let e = env(&b, "m");
        // The engine could not give us the turn text (a restart, a pruned archive).
        let r = handle(
            &conn,
            &e,
            &json!({"action": "summarize", "ids": ["turn/t1"], "via_subagent": true}),
            &NoRecall,
        );
        assert_eq!(r["ok"], true);
        let task = r["spawnRequest"]["task"].as_str().unwrap();
        assert!(task.contains("could not be included"), "the child is told what is missing: {task}");
        assert!(task.contains("[no item text was retrievable") || task.contains("could not"), "{task}");
    }

    #[test]
    fn spawn_material_respects_its_budget_and_says_what_it_cut() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 4_000);
        put(&conn, "turn/t2", NodeKind::Turn, ItemState::In, 3_000);
        put(&conn, "turn/t3", NodeKind::Turn, ItemState::In, 3_000);
        let b = budget();
        let e = env(&b, "m");
        // Three turns of 20k characters against a 24k budget: the first fits, the
        // second is cut, the third has no room left.
        let big = "x".repeat(20_000);
        struct Big(String);
        impl Recall for Big {
            fn turn(&self, _n: u32) -> Option<String> {
                Some(self.0.clone())
            }
            fn result(&self, _r: &str) -> Option<String> {
                None
            }
            fn file(&self, _l: &str, _r: Option<&str>) -> Option<String> {
                None
            }
        }
        let recall = Big(big);
        let r = handle(
            &conn,
            &e,
            &json!({"action": "summarize", "ids": ["turn/t1", "turn/t2", "turn/t3"], "via_subagent": true}),
            &recall,
        );
        let task = r["spawnRequest"]["task"].as_str().unwrap();
        assert!(task.len() < SPAWN_MATERIAL_CHARS + 2_000, "the material is bounded: {} bytes", task.len());
        assert!(task.contains("[... cut here]"), "the cut is visible to the child");
        assert!(task.contains("could not be included"), "the item that got no room is reported, not silently dropped");
    }

    #[test]
    fn a_supplied_summary_replaces_the_sources() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, 4_000);
        let b = budget();
        let e = env(&b, "m");
        let summary = "they agreed to build the apk with gradle";
        let r = handle(&conn, &e, &json!({"action": "summarize", "ids": ["turn/t1"], "text": summary}), &NoRecall);
        assert_eq!(r["ok"], true);
        assert_eq!(store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap().state, ItemState::Temp);
        let temp_id = r["tempId"].as_str().unwrap();
        let node = store::load_node(&conn, "s1", temp_id).unwrap().unwrap();
        assert_eq!(node.state, ItemState::In, "the summary itself is sent");
        assert_eq!(node.kind, NodeKind::TempSummary);
        let back = handle(&conn, &e, &json!({"action": "recall", "id": temp_id}), &NoRecall);
        assert!(back["text"].as_str().unwrap().contains("gradle"));
    }

    #[test]
    fn summarize_refuses_the_law() {
        let conn = db();
        put(&conn, "sys/core", NodeKind::SysPart, ItemState::In, 800);
        let b = budget();
        let e = env(&b, "m");
        let r = handle(&conn, &e, &json!({"action": "summarize", "ids": ["sys/core"], "text": "x"}), &NoRecall);
        assert_eq!(r["ok"], false);
        assert!(r["text"].as_str().unwrap().contains("locked"));
    }

    #[test]
    fn categories_can_be_created_listed_and_deleted_but_not_the_built_ins() {
        let conn = db();
        let b = budget();
        let e = env(&b, "m");
        let made = handle(&conn, &e, &json!({"action": "category", "id": "cat/c1", "title": "Migrations"}), &NoRecall);
        assert_eq!(made["ok"], true);
        let listed = handle(&conn, &e, &json!({"action": "category"}), &NoRecall);
        assert!(listed["categories"].as_array().unwrap().len() >= 8);
        let protected = handle(&conn, &e, &json!({"action": "category", "id": "cat/bad", "title": "x"}), &NoRecall);
        assert_eq!(protected["ok"], true);
        let not_builtin = handle(&conn, &e, &json!({"action": "category", "id": "sys", "title": "renamed"}), &NoRecall);
        assert_eq!(not_builtin["ok"], false, "built-ins are not renamable");
        let del = handle(&conn, &e, &json!({"action": "category", "id": "cat/c1", "delete_contents": true}), &NoRecall);
        assert_eq!(del["ok"], true);
        let del_sys = handle(&conn, &e, &json!({"action": "category", "id": "sys", "delete_contents": true}), &NoRecall);
        assert_eq!(del_sys["ok"], false);
    }

    #[test]
    fn strategy_versions_and_next_step() {
        let conn = db();
        let b = budget();
        let e = env(&b, "m");
        let none = handle(&conn, &e, &json!({"action": "strategy"}), &NoRecall);
        assert!(none["text"].as_str().unwrap().contains("no strategy"));
        let made = handle(&conn, &e, &json!({"action": "strategy", "text": "1. read 2. patch 3. test", "step": "patch"}), &NoRecall);
        assert_eq!(made["ok"], true);
        let read = handle(&conn, &e, &json!({"action": "strategy"}), &NoRecall);
        assert!(read["text"].as_str().unwrap().contains("next: patch"));
    }

    #[test]
    fn prompt_parts_load_and_the_law_stays() {
        let conn = db();
        put(&conn, "sys/core", NodeKind::SysPart, ItemState::In, 800);
        put(&conn, "sys/tools.files", NodeKind::SysPart, ItemState::Out, 300);
        let b = budget();
        let e = env(&b, "m");
        let listed = handle(&conn, &e, &json!({"action": "prompt"}), &NoRecall);
        assert_eq!(listed["parts"].as_array().unwrap().len(), 2);
        let load = handle(&conn, &e, &json!({"action": "prompt", "load": ["tools.files"]}), &NoRecall);
        assert_eq!(load["ok"], true);
        assert_eq!(store::load_node(&conn, "s1", "sys/tools.files").unwrap().unwrap().state, ItemState::In);
        let unload_core = handle(&conn, &e, &json!({"action": "prompt", "unload": ["core"]}), &NoRecall);
        assert_eq!(unload_core["refused"].as_array().unwrap().len(), 1);
        assert_eq!(store::load_node(&conn, "s1", "sys/core").unwrap().unwrap().state, ItemState::In);
    }

    #[test]
    fn no_action_panics_on_junk_input() {
        let conn = db();
        let b = budget();
        let e = env(&b, "m");
        for args in [
            json!({"action": "set", "ops": "nope"}),
            json!({"action": "recall"}),
            json!({"action": "note"}),
            json!({"action": "prompt", "load": [1, 2, 3]}),
            json!({"action": "view", "since_rev": "later"}),
            json!({"action": "summarize", "ids": []}),
        ] {
            let r = handle(&conn, &e, &args, &NoRecall);
            assert!(r.get("ok").is_some(), "every answer has an ok field: {args}");
        }
    }

    #[test]
    fn paths_are_shortened_only_when_the_caller_asks() {
        assert_eq!(shorten("/home/user/app/src/main.rs", false), "/home/user/app/src/main.rs");
        assert_eq!(shorten("/home/user/app/src/main.rs", true), "…/src/main.rs");
        assert_eq!(shorten("notes.txt", true), "notes.txt");
    }
}
