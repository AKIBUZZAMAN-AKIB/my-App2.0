//! Applying what the model asked for, one op at a time.
//!
//! A batch is applied **all or nothing on the revision rule, best-effort per op**:
//! if the tree moved since the model looked (`expect_rev`), nothing is applied and
//! the whole batch is refused with the new revision, because acting on a stale
//! picture is how a model drops something it did not mean to. Individual ops are
//! independent: one locked item does not cancel the other nine.
//!
//! Every outcome is reported back in the tool result, including the refusals and
//! *why*. A model that is told "note required" once stops guessing; a model that
//! is told "failed" keeps trying.

use serde_json::{json, Value};

use super::model::{can_transition, safe_title, ItemState, Node, NodeId, Owner, Pin, Refusal, MAX_NOTE_CHARS};
use super::render::text;
use super::store;

/// The seven things an op can do to one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpAction {
    Include,
    Exclude,
    NoteOnly,
    Pin,
    Unpin,
    Move,
    Tag,
}

impl OpAction {
    pub fn parse(raw: &str) -> Option<OpAction> {
        Some(match raw {
            "include" => OpAction::Include,
            "exclude" => OpAction::Exclude,
            "note_only" => OpAction::NoteOnly,
            "pin" => OpAction::Pin,
            "unpin" => OpAction::Unpin,
            "move" => OpAction::Move,
            "tag" => OpAction::Tag,
            _ => return None,
        })
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            OpAction::Include => "include",
            OpAction::Exclude => "exclude",
            OpAction::NoteOnly => "note_only",
            OpAction::Pin => "pin",
            OpAction::Unpin => "unpin",
            OpAction::Move => "move",
            OpAction::Tag => "tag",
        }
    }
}

/// One requested change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Op {
    pub id: String,
    pub action: OpAction,
    pub note: Option<String>,
    /// Target category for `move`/`tag`.
    pub to: Option<String>,
}

/// Parse the `ops` array of a `ctx` call. Rejects the whole array on a malformed
/// element: half a batch is worse than none, because the model cannot tell which
/// half it got.
pub fn parse_ops(raw: &Value) -> Result<Vec<Op>, String> {
    let Some(list) = raw.as_array() else { return Err("ops must be an array".into()) };
    if list.len() > 12 {
        return Err(format!("at most 12 ops per call (got {})", list.len()));
    }
    let mut out = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let obj = item.as_object().ok_or_else(|| format!("ops[{i}] must be an object"))?;
        let id = obj.get("id").and_then(|v| v.as_str()).ok_or_else(|| format!("ops[{i}].id is required"))?;
        // A raw id is validated here, so a junk id never reaches a query.
        NodeId::parse(id).map_err(|e| format!("ops[{i}].id: {e}"))?;
        let action_raw = obj.get("action").and_then(|v| v.as_str()).ok_or_else(|| format!("ops[{i}].action is required"))?;
        let action = OpAction::parse(action_raw)
            .ok_or_else(|| format!("ops[{i}].action: unknown \"{action_raw}\" (include, exclude, note_only, pin, unpin, move, tag)"))?;
        let note = obj.get("note").and_then(|v| v.as_str()).map(|n| n.chars().take(MAX_NOTE_CHARS).collect::<String>());
        let to = obj.get("to").and_then(|v| v.as_str()).map(|s| s.to_string());
        if matches!(action, OpAction::Move | OpAction::Tag) && to.is_none() {
            return Err(format!("ops[{i}] ({action_raw}) needs a target category in \"to\""));
        }
        out.push(Op { id: id.to_string(), action, note, to });
    }
    Ok(out)
}

/// What happened to one op.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpOutcome {
    pub id: String,
    pub action: &'static str,
    pub ok: bool,
    pub state: Option<ItemState>,
    /// One line the model reads. On success it says what changed; on refusal it
    /// says what to do instead.
    pub message: String,
    pub tokens_before: u32,
    pub tokens_after: u32,
}

impl OpOutcome {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "action": self.action,
            "ok": self.ok,
            "state": self.state.map(|s| s.as_str()),
            "message": self.message,
            "tokens": { "before": self.tokens_before, "after": self.tokens_after },
        })
    }
}

/// When and by whom a batch runs.
#[derive(Debug, Clone)]
pub struct BatchEnv<'a> {
    pub session_key: &'a str,
    pub now_ms: i64,
    pub now_turn: Option<u32>,
    pub step: Option<u32>,
    /// Set when a non-model actor applies the batch (policy, user, engine).
    pub actor: &'a str,
    pub tool: &'a str,
}

impl<'a> BatchEnv<'a> {
    pub fn model(session_key: &'a str, now_ms: i64) -> BatchEnv<'a> {
        BatchEnv { session_key, now_ms, now_turn: None, step: None, actor: "model", tool: "ctx" }
    }
}

/// The result of a batch, ready to be rendered as the tool result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchResult {
    pub rev: i64,
    pub applied: usize,
    pub refused: usize,
    pub outcomes: Vec<OpOutcome>,
    pub tokens_before: usize,
    pub tokens_after: usize,
    /// True when nothing was written because the revision had moved.
    pub stale: bool,
    pub dry_run: bool,
}

impl BatchResult {
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.refused == 0 && !self.stale,
            "rev": self.rev,
            "stale": self.stale,
            "dryRun": self.dry_run,
            "applied": self.applied,
            "refused": self.refused,
            "tokens": { "before": self.tokens_before, "after": self.tokens_after },
            "results": self.outcomes.iter().map(OpOutcome::to_json).collect::<Vec<_>>(),
        })
    }

    /// The one-line summary the model reads first.
    pub fn headline(&self) -> String {
        if self.stale {
            return "nothing applied: the tree moved. re-read and retry.".into();
        }
        if self.dry_run {
            return format!(
                "dry run: {} would apply, {} would be refused; {} → {} tokens.",
                self.applied, self.refused, self.tokens_before, self.tokens_after
            );
        }
        format!(
            "{} applied, {} refused; {} → {} tokens (rev {}).",
            self.applied, self.refused, self.tokens_before, self.tokens_after, self.rev
        )
    }
}

fn sent(node: &Node) -> u32 {
    super::select::sent_tokens(node)
}

/// Can the model change this node's state at all? The engine's own furniture
/// (`sys/*`, essentials) is only ever *read* by the model; anything hard-pinned is
/// out of reach by the law, not by ownership.
fn may_change(node: &Node) -> Result<(), Refusal> {
    if node.pin.is_hard() {
        return Err(Refusal::Locked);
    }
    if node.kind == super::model::NodeKind::Essential && node.owner == Owner::Policy {
        return Err(Refusal::Locked);
    }
    Ok(())
}

/// Apply a batch. `dry_run` computes the same outcomes without writing anything,
/// which is what makes "what would this cost?" answerable.
pub fn apply_batch(
    conn: &rusqlite::Connection,
    env: &BatchEnv<'_>,
    ops: &[Op],
    expect_rev: Option<i64>,
    dry_run: bool,
) -> rusqlite::Result<BatchResult> {
    let current_rev = store::rev(conn, env.session_key)?;
    let nodes = store::load_nodes(conn, env.session_key)?;
    let tokens_before: usize = nodes.iter().map(|n| sent(n) as usize).sum();

    if let Some(expected) = expect_rev {
        if expected != current_rev {
            let outcomes = ops
                .iter()
                .map(|op| OpOutcome {
                    id: op.id.clone(),
                    action: op.action.as_str(),
                    ok: false,
                    state: None,
                    message: text::stale_rev(expected, current_rev),
                    tokens_before: 0,
                    tokens_after: 0,
                })
                .collect();
            return Ok(BatchResult {
                rev: current_rev,
                applied: 0,
                refused: ops.len(),
                outcomes,
                tokens_before,
                tokens_after: tokens_before,
                stale: true,
                dry_run,
            });
        }
    }

    let mut outcomes = Vec::with_capacity(ops.len());
    let mut applied = 0usize;
    let mut refused = 0usize;
    // The projected state, so a batch of ten ops sees its own earlier ops.
    let mut projected: Vec<Node> = nodes.clone();

    for op in ops {
        let Some(node) = projected.iter().find(|n| n.id.as_str() == op.id).cloned() else {
            refused += 1;
            outcomes.push(OpOutcome {
                id: op.id.clone(),
                action: op.action.as_str(),
                ok: false,
                state: None,
                message: text::unknown_node(&op.id),
                tokens_before: 0,
                tokens_after: 0,
            });
            continue;
        };
        let before = sent(&node);

        // pin / unpin do not touch the state machine.
        if matches!(op.action, OpAction::Pin | OpAction::Unpin) {
            let want = if op.action == OpAction::Pin { Pin::Ai } else { Pin::None };
            let refusal = if node.pin.is_hard() {
                Some(Refusal::Locked)
            } else {
                None
            };
            let ok = refusal.is_none();
            if ok {
                if !dry_run {
                    store::set_pin(conn, env.session_key, op.id.as_str(), want)?;
                }
                applied += 1;
                if let Some(n) = projected.iter_mut().find(|n| n.id.as_str() == op.id) {
                    n.pin = want;
                }
            } else {
                refused += 1;
            }
            outcomes.push(OpOutcome {
                id: op.id.clone(),
                action: op.action.as_str(),
                ok,
                state: Some(node.state),
                message: match refusal {
                    Some(r) => text::refusal(&node.id, r),
                    None => {
                        if op.action == OpAction::Pin {
                            format!("{} is pinned: it will not be evicted (an AI pin gives way only under a forced compaction).", op.id)
                        } else {
                            format!("{} is unpinned.", op.id)
                        }
                    }
                },
                tokens_before: before,
                tokens_after: before,
            });
            continue;
        }

        // move / tag change the filing, not the window.
        if matches!(op.action, OpAction::Move | OpAction::Tag) {
            let to = op.to.clone().unwrap_or_default();
            let known = store::load_categories(conn, env.session_key)?.into_iter().any(|c| c.id == to && !c.deleted);
            if !known {
                refused += 1;
                outcomes.push(OpOutcome {
                    id: op.id.clone(),
                    action: op.action.as_str(),
                    ok: false,
                    state: Some(node.state),
                    message: format!("no such category: {to}. ctx(action:\"category\") lists them."),
                    tokens_before: before,
                    tokens_after: before,
                });
                continue;
            }
            if !dry_run {
                match op.action {
                    OpAction::Move => {
                        store::move_node(conn, env.session_key, op.id.as_str(), &to, node.order)?;
                    }
                    _ => {
                        store::add_tag(conn, env.session_key, op.id.as_str(), &to)?;
                    }
                }
            }
            applied += 1;
            outcomes.push(OpOutcome {
                id: op.id.clone(),
                action: op.action.as_str(),
                ok: true,
                state: Some(node.state),
                message: if op.action == OpAction::Move {
                    format!("{} is now filed under {to}.", op.id)
                } else {
                    format!("{} is also tagged {to}.", op.id)
                },
                tokens_before: before,
                tokens_after: before,
            });
            continue;
        }

        // State transitions.
        let target = match op.action {
            OpAction::Include => ItemState::In,
            OpAction::Exclude => ItemState::Out,
            OpAction::NoteOnly => ItemState::Note,
            _ => ItemState::In,
        };
        let note_given = op.note.is_some();
        let verdict = may_change(&node).and_then(|()| {
            can_transition(node.state, target, node.pin, node.note.is_some(), note_given)
        });
        match verdict {
            Ok(new_state) => {
                let note = op.note.as_deref().map(safe_title);
                if !dry_run {
                    store::set_state(conn, env.session_key, op.id.as_str(), new_state, note.as_deref(), env.now_ms)?;
                }
                if let Some(n) = projected.iter_mut().find(|n| n.id.as_str() == op.id) {
                    n.state = new_state;
                    if note.is_some() {
                        n.note = note;
                    }
                }
                let after = projected.iter().find(|n| n.id.as_str() == op.id).map(sent).unwrap_or(before);
                applied += 1;
                outcomes.push(OpOutcome {
                    id: op.id.clone(),
                    action: op.action.as_str(),
                    ok: true,
                    state: Some(new_state),
                    message: match new_state {
                        ItemState::In => format!("{} is in the window ({before} → {after} tokens).", op.id),
                        ItemState::Out => format!("{} is out (still stored; recall it any time).", op.id),
                        ItemState::Note => format!("{} is kept as a note only ({after} tokens).", op.id),
                        ItemState::Temp => format!("{} is replaced by a summary.", op.id),
                    },
                    tokens_before: before,
                    tokens_after: after,
                });
            }
            Err(refusal) => {
                refused += 1;
                outcomes.push(OpOutcome {
                    id: op.id.clone(),
                    action: op.action.as_str(),
                    ok: false,
                    state: Some(node.state),
                    message: text::refusal(&node.id, refusal),
                    tokens_before: before,
                    tokens_after: before,
                });
            }
        }
    }

    let tokens_after: usize = projected.iter().map(|n| sent(n) as usize).sum();
    let mut rev = current_rev;
    if !dry_run && applied > 0 {
        rev = store::bump_rev(conn, env.session_key, env.now_ms)?;
        let entry = store::LogEntry {
            actor: env.actor.to_string(),
            tool: Some(env.tool.to_string()),
            ops: serde_json::to_string(&ops.iter().map(|o| json!({"id": o.id, "action": o.action.as_str(), "to": o.to})).collect::<Vec<_>>())
                .unwrap_or_else(|_| "[]".into()),
            rev_before: current_rev,
            rev_after: rev,
            tokens_before,
            tokens_after,
            reason: Some("model".into()),
            turn: env.now_turn,
            step: env.step,
        };
        store::log_action(conn, env.session_key, &entry, env.now_ms)?;
    }

    Ok(BatchResult {
        rev,
        applied,
        refused,
        outcomes,
        tokens_before,
        tokens_after,
        stale: false,
        dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::model::{Node, NodeKind, Provenance};

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        store::ensure_tables(&conn).unwrap();
        store::ensure_session(&conn, "s1", 1_000).unwrap();
        conn
    }

    fn put(conn: &rusqlite::Connection, id: &str, kind: NodeKind, state: ItemState, pin: Pin, tokens: u32) {
        let node = Node {
            id: NodeId::parse(id).unwrap(),
            session_key: "s1".into(),
            kind,
            parent: kind.home_category().into(),
            tags: vec![],
            order: 0,
            title: id.into(),
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
        };
        store::upsert_node(conn, &node).unwrap();
    }

    fn ops(json: Value) -> Vec<Op> {
        parse_ops(&json).expect("valid ops")
    }

    #[test]
    fn a_batch_applies_and_reports_the_tokens_it_moved() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        put(&conn, "turn/t2", NodeKind::Turn, ItemState::In, Pin::None, 300);
        let env = BatchEnv::model("s1", 2_000);
        let batch = ops(json!([
            {"id": "turn/t1", "action": "exclude"},
            {"id": "turn/t2", "action": "note_only", "note": "the user's build command"}
        ]));
        let r = apply_batch(&conn, &env, &batch, None, false).unwrap();
        assert_eq!(r.applied, 2);
        assert_eq!(r.refused, 0);
        assert_eq!(r.tokens_before, 800);
        assert_eq!(r.tokens_after, 30, "note-only keeps a tenth");
        assert_eq!(r.rev, 1);
        assert!(r.headline().contains("2 applied"));
    }

    #[test]
    fn a_stale_expect_rev_refuses_the_whole_batch() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        store::bump_rev(&conn, "s1", 1_500).unwrap();
        let env = BatchEnv::model("s1", 2_000);
        let batch = ops(json!([{"id": "turn/t1", "action": "exclude"}]));
        let r = apply_batch(&conn, &env, &batch, Some(0), false).unwrap();
        assert!(r.stale);
        assert_eq!(r.applied, 0);
        assert!(r.outcomes[0].message.contains("rev 1"), "{}", r.outcomes[0].message);
        // Nothing changed on disk.
        let node = store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap();
        assert_eq!(node.state, ItemState::In);
    }

    #[test]
    fn one_locked_item_does_not_cancel_the_rest() {
        let conn = db();
        put(&conn, "sys/core", NodeKind::SysPart, ItemState::In, Pin::Locked, 800);
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        let env = BatchEnv::model("s1", 2_000);
        let batch = ops(json!([
            {"id": "sys/core", "action": "exclude"},
            {"id": "turn/t1", "action": "exclude"}
        ]));
        let r = apply_batch(&conn, &env, &batch, None, false).unwrap();
        assert_eq!((r.applied, r.refused), (1, 1));
        assert!(!r.outcomes[0].ok && r.outcomes[0].message.contains("locked"));
        assert!(r.outcomes[1].ok);
        assert_eq!(store::load_node(&conn, "s1", "sys/core").unwrap().unwrap().state, ItemState::In);
    }

    #[test]
    fn a_dry_run_writes_nothing_but_tells_the_truth() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        let env = BatchEnv::model("s1", 2_000);
        let batch = ops(json!([{"id": "turn/t1", "action": "exclude"}]));
        let r = apply_batch(&conn, &env, &batch, None, true).unwrap();
        assert!(r.dry_run);
        assert_eq!(r.applied, 1);
        assert_eq!(r.tokens_after, 0);
        assert_eq!(r.rev, 0, "a dry run does not move the revision");
        assert_eq!(store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap().state, ItemState::In);
        assert!(r.headline().contains("dry run"));
    }

    #[test]
    fn pinning_is_the_models_own_and_survives_a_hard_pin() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        put(&conn, "ess/e1", NodeKind::Essential, ItemState::In, Pin::Policy, 40);
        let env = BatchEnv::model("s1", 2_000);
        let r = apply_batch(&conn, &env, &ops(json!([
            {"id": "turn/t1", "action": "pin"},
            {"id": "ess/e1", "action": "unpin"}
        ])), None, false).unwrap();
        assert_eq!(r.applied, 1);
        assert_eq!(r.refused, 1);
        assert_eq!(store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap().pin, Pin::Ai);
        assert_eq!(store::load_node(&conn, "s1", "ess/e1").unwrap().unwrap().pin, Pin::Policy, "a policy pin is not the model's to drop");
    }

    #[test]
    fn note_only_without_a_note_teaches_instead_of_failing() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        let env = BatchEnv::model("s1", 2_000);
        let r = apply_batch(&conn, &env, &ops(json!([{"id": "turn/t1", "action": "note_only"}])), None, false).unwrap();
        assert_eq!(r.refused, 1);
        assert!(r.outcomes[0].message.contains("\"note\""), "{}", r.outcomes[0].message);
        // With a note it works, and the note is stored flattened.
        let r = apply_batch(&conn, &env, &ops(json!([{"id": "turn/t1", "action": "note_only", "note": "why:\nthe build broke"}])), None, false).unwrap();
        assert_eq!(r.applied, 1);
        let node = store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap();
        assert_eq!(node.state, ItemState::Note);
        assert!(!node.note.unwrap().contains('\n'));
    }

    #[test]
    fn move_and_tag_need_a_real_category() {
        let conn = db();
        put(&conn, "file/f1", NodeKind::File, ItemState::Out, Pin::None, 100);
        let env = BatchEnv::model("s1", 2_000);
        let r = apply_batch(&conn, &env, &ops(json!([{"id": "file/f1", "action": "move", "to": "cat/nope"}])), None, false).unwrap();
        assert_eq!(r.refused, 1);
        assert!(r.outcomes[0].message.contains("no such category"));
        store::upsert_category(&conn, "s1", "cat/c1", None, "Migrations", "ai", None, 1_000).unwrap();
        let r = apply_batch(&conn, &env, &ops(json!([
            {"id": "file/f1", "action": "move", "to": "cat/c1"},
            {"id": "file/f1", "action": "tag", "to": "cat/c1"}
        ])), None, false).unwrap();
        assert_eq!(r.applied, 2);
        let node = store::load_node(&conn, "s1", "file/f1").unwrap().unwrap();
        assert_eq!(node.parent, "cat/c1");
        assert_eq!(node.tags, vec!["cat/c1".to_string()]);
    }

    #[test]
    fn ten_ops_in_one_call_see_each_other() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        let env = BatchEnv::model("s1", 2_000);
        // exclude then note_only in the same batch: the second must not be treated
        // as "already out".
        let r = apply_batch(&conn, &env, &ops(json!([
            {"id": "turn/t1", "action": "exclude"},
            {"id": "turn/t1", "action": "note_only", "note": "kept the gist"}
        ])), None, false).unwrap();
        assert_eq!(r.applied, 2, "{:?}", r.outcomes);
        assert_eq!(store::load_node(&conn, "s1", "turn/t1").unwrap().unwrap().state, ItemState::Note);
    }

    #[test]
    fn malformed_ops_are_rejected_before_anything_is_written() {
        assert!(parse_ops(&json!({"not": "an array"})).is_err());
        assert!(parse_ops(&json!([{"id": "turn/t1"}])).is_err());
        assert!(parse_ops(&json!([{"action": "exclude"}])).is_err());
        assert!(parse_ops(&json!([{"id": "nonsense", "action": "exclude"}])).is_err());
        assert!(parse_ops(&json!([{"id": "turn/t1", "action": "explode"}])).is_err());
        assert!(parse_ops(&json!([{"id": "turn/t1", "action": "move"}])).is_err(), "move needs a target");
        let many: Vec<Value> = (0..13).map(|i| json!({"id": format!("turn/t{i}"), "action": "exclude"})).collect();
        assert!(parse_ops(&json!(many)).is_err(), "the cap is 12");
    }

    #[test]
    fn a_note_is_truncated_rather_than_rejected() {
        let long = "x".repeat(MAX_NOTE_CHARS * 2);
        let parsed = parse_ops(&json!([{"id": "turn/t1", "action": "note_only", "note": long}])).unwrap();
        assert_eq!(parsed[0].note.as_ref().unwrap().chars().count(), MAX_NOTE_CHARS);
    }

    #[test]
    fn the_batch_is_written_to_the_log_with_before_and_after() {
        let conn = db();
        put(&conn, "turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 500);
        let env = BatchEnv { now_turn: Some(4), step: Some(2), ..BatchEnv::model("s1", 2_000) };
        apply_batch(&conn, &env, &ops(json!([{"id": "turn/t1", "action": "exclude"}])), None, false).unwrap();
        let log = store::load_log(&conn, "s1", 5).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0]["actor"], "model");
        assert_eq!(log[0]["turn"], 4);
        assert_eq!(log[0]["tokensBefore"], 500);
        assert_eq!(log[0]["tokensAfter"], 0);
    }

    #[test]
    fn the_model_cannot_take_an_essential_away() {
        let conn = db();
        put(&conn, "ess/e1", NodeKind::Essential, ItemState::In, Pin::Policy, 40);
        let env = BatchEnv::model("s1", 2_000);
        let r = apply_batch(&conn, &env, &ops(json!([{"id": "ess/e1", "action": "exclude"}])), None, false).unwrap();
        assert_eq!(r.refused, 1);
        assert!(r.outcomes[0].message.contains("locked"));
    }
}
