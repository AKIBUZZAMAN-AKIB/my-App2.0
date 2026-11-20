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
use super::model::{ItemState, NodeId, CHECKLIST_MARKER};
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
        "summarize" => summarize(conn, env, args),
        "recall" => recall_action(conn, env, args, recall),
        "note" => note(conn, env, args),
        "strategy" => strategy(conn, env, args),
        "prompt" => prompt(conn, env, args),
        "" => Ok(fail("unknown", "action is required: view, set, category, summarize, recall, note, strategy, prompt.")),
        other => Ok(fail(other, format!("unknown action \"{other}\": view, set, category, summarize, recall, note, strategy, prompt."))),
    };
    result.unwrap_or_else(|e| fail(action, format!("the context store failed: {e}. Nothing was changed by this call.")))
}

type Handled = rusqlite::Result<Value>;

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
        }),
    ))
}

fn set(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
    let Some(ops_raw) = args.get("ops") else {
        return Ok(fail("set", "ops is required, e.g. [{\"id\":\"turn/t12\",\"action\":\"exclude\"}]."));
    };
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

fn summarize(conn: &rusqlite::Connection, env: &CtxEnv<'_>, args: &Value) -> Handled {
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
    if let Some(summary_text) = args.get("text").and_then(|v| v.as_str()) {
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
    let body = match node.kind {
        super::model::NodeKind::Note => store::load_note(conn, env.session_key, id)?,
        super::model::NodeKind::TempSummary => store::load_temp_summary(conn, env.session_key, id)?,
        super::model::NodeKind::Turn => turn_number(&node).and_then(|t| recall.turn(t)),
        super::model::NodeKind::Result => node.provenance.locator.as_deref().and_then(|r| recall.result(r)),
        super::model::NodeKind::File => node
            .provenance
            .locator
            .as_deref()
            .and_then(|loc| recall.file(loc, node.provenance.range.as_deref())),
        _ => None,
    };
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
