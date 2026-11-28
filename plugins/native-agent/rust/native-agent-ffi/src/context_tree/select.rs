//! Who stays in the window when there is not enough room for everyone.
//!
//! This is the policy the model is allowed to steer but not to override. It runs
//! after the model's own choices (`in`/`out`, pins, notes) and before the request
//! is assembled, and it answers three questions:
//!
//! 1. **What must go in regardless?** `sys/core` (locked), essentials (policy
//!    pins), the strategy file, the checklist itself and the newest user prompt.
//!    Together they are the *locked* set; the budget module already subtracted them.
//! 2. **Who is over quota?** A category may carry a `cap_tokens`; everything past
//!    the cap is a candidate even if the model asked to keep it.
//! 3. **Who is cheapest to lose?** [`super::model::eviction_order`] — recency,
//!    usage, kind weight — with the AI's own pins demoted last and the eviction
//!    written to the action log, so "why is this out?" always has an answer.
//!
//! The safety net is the part the user never sees and must never be able to feel:
//! it runs on the *last* overrun (warn → compact → force), and it will take out
//! something the model asked to keep before it lets a request fail at the provider.

use super::budget::Budget;
use super::model::{
    can_transition, eviction_order, ItemState, Node, NodeId, NodeKind, Pin, Refusal,
};

/// Why an item left the window. These strings reach the UI and the audit log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The model excluded it.
    Model,
    /// It was over its category's cap.
    CategoryCap,
    /// The budget needed the room; the safety net took the cheapest item.
    Budget,
    /// The window overflowed anyway; the forced pass took the cheapest item even
    /// though it was pinned by the model.
    Forced,
}

impl Reason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Reason::Model => "model",
            Reason::CategoryCap => "category_cap",
            Reason::Budget => "budget",
            Reason::Forced => "forced",
        }
    }
}

/// The order the request is assembled in, which is also the order in which room is
/// given out: what is earlier is safer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    /// `sys/core`: the law. Never moves.
    Law = 0,
    /// Essentials: the goal, decisions, facts, preferences. Policy-pinned.
    Essential = 1,
    /// The model's strategy file.
    Strategy = 2,
    /// The checklist itself, so the model can always see its own window.
    Checklist = 3,
    /// The newest user prompt: an answer that ignores it is worthless.
    NewestPrompt = 4,
    /// Everything else, by value.
    Selectable = 5,
}

/// Which tier a node belongs to. Pure function of the node, not of its position.
pub fn tier_of(node: &Node) -> Tier {
    match node.kind {
        super::model::NodeKind::SysPart if node.pin == Pin::Locked => Tier::Law,
        super::model::NodeKind::Essential => Tier::Essential,
        // The engine's own summaries (the continuity summary, the memory block):
        // only the user's checkbox (or an explicit `ctx set`) takes them out; the
        // safety net never evicts them to make room.
        super::model::NodeKind::Summary if node.id.as_str().starts_with("sum/") => Tier::Essential,
        super::model::NodeKind::Strategy => Tier::Strategy,
        _ => Tier::Selectable,
    }
}

/// One eviction the plan wants, with its reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Eviction {
    pub id: NodeId,
    pub tokens: u32,
    pub reason: Reason,
}

/// What the policy decided. `compress` holds items that would be better replaced
/// by a temp summary than dropped (`ctx` can act on it; the safety net cannot,
/// because summarizing needs a model call).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionPlan {
    pub evict: Vec<Eviction>,
    pub compress: Vec<NodeId>,
    /// Tokens of everything that stays, including locked items.
    pub tokens_after: usize,
    /// True when the selection was already inside the budget.
    pub within_budget: bool,
}

impl SelectionPlan {
    pub fn evicted_tokens(&self) -> u32 {
        self.evict.iter().map(|e| e.tokens).sum()
    }
}

/// Tokens a node costs in the window right now.
pub fn sent_tokens(node: &Node) -> u32 {
    match node.state {
        ItemState::In => node.tokens_full,
        ItemState::Note => node.tokens_note,
        ItemState::Temp | ItemState::Out => 0,
    }
}

/// Total sent tokens of a set of nodes (the number the checklist shows).
pub fn sent_total(nodes: &[Node]) -> usize {
    nodes.iter().map(|n| sent_tokens(n) as usize).sum()
}

/// The safety net: evict until the selection fits, cheapest first.
///
/// `budget.used_sel` must already include everything that is sent. `hard_limit`
/// is where it must end up (normally `compact_at`; `force` on the last pass).
/// Items in a [`Tier`] above `Selectable` are never evicted, and a hard pin is
/// never evicted at all; only `allow_ai_pins` (the forced pass) may take an AI pin.
/// How many of the newest turns the policy keeps verbatim (plan §8.1 step 4,
/// the same `keep_recent = 7` turn memory uses).
pub const KEEP_RECENT_TURNS: u32 = 7;

/// True for a turn the policy must not take out on this pass.
///
/// * The turn in progress (`now_turn`) is never evicted: it holds the prompt
///   being answered and the tool calls still open, and dropping it would send a
///   request without a question (or with unmatched tool results).
/// * The newest [`KEEP_RECENT_TURNS`] turns are protected in the normal
///   `compact` stage. The `force` stage (`allow_ai_pins = true`) may take them,
///   oldest first, because an overflowing request is worse than a shorter one.
pub fn is_protected_turn(node: &Node, now_turn: u32, forced: bool) -> bool {
    if !matches!(node.kind, NodeKind::Turn | NodeKind::TurnPart) {
        return false;
    }
    let Some(turn) = node.turn.or(node.provenance.turn) else {
        return false;
    };
    if turn >= now_turn {
        return true;
    }
    !forced && turn + KEEP_RECENT_TURNS > now_turn
}

pub fn plan_eviction(
    nodes: &[Node],
    budget: &Budget,
    hard_limit: usize,
    now_turn: u32,
    now_ms: i64,
    allow_ai_pins: bool,
    reason: Reason,
) -> SelectionPlan {
    let mut used = budget.demand.max(budget.used_sel);
    let mut plan = SelectionPlan {
        tokens_after: 0,
        within_budget: used <= hard_limit,
        ..Default::default()
    };
    if used <= hard_limit {
        plan.tokens_after = used;
        return plan;
    }
    // Candidates: sent, selectable tier, and mutable under this pass's rules.
    let mut candidates: Vec<&Node> = nodes
        .iter()
        .filter(|n| sent_tokens(n) > 0)
        .filter(|n| tier_of(n) == Tier::Selectable)
        .filter(|n| !n.pin.is_hard())
        .filter(|n| allow_ai_pins || n.pin != Pin::Ai)
        .filter(|n| !is_protected_turn(n, now_turn, allow_ai_pins))
        .collect();
    // Order by value (cheapest first) using the model's own scorer.
    let order = eviction_order(candidates.iter().copied(), now_turn, now_ms);
    candidates.sort_by_key(|n| {
        order
            .iter()
            .position(|(id, _)| id == &n.id)
            .unwrap_or(usize::MAX)
    });
    for node in candidates {
        if used <= hard_limit {
            break;
        }
        let tokens = sent_tokens(node);
        used = used.saturating_sub(tokens as usize);
        plan.evict.push(Eviction {
            id: node.id.clone(),
            tokens,
            reason,
        });
    }
    plan.tokens_after = used;
    plan.within_budget = used <= hard_limit;
    plan
}

/// Categories with a `cap_tokens`: everything beyond the cap is a candidate, even
/// if the model asked to keep it. Returns the nodes to drop, cheapest first.
pub fn plan_category_caps(
    nodes: &[Node],
    caps: &[(String, i64)],
    now_turn: u32,
    now_ms: i64,
) -> Vec<Eviction> {
    let mut out = Vec::new();
    for (category, cap) in caps {
        let mut in_cat: Vec<&Node> = nodes
            .iter()
            .filter(|n| &n.parent == category || n.tags.iter().any(|t| t == category))
            .filter(|n| sent_tokens(n) > 0)
            .filter(|n| !n.pin.is_hard())
            .collect();
        let mut total: i64 = in_cat.iter().map(|n| sent_tokens(n) as i64).sum();
        if total <= *cap {
            continue;
        }
        // Drop a node entirely (not downgrade): a capped category shrinks, it does
        // not start whispering notes it cannot afford to explain.
        in_cat.sort_by_key(|n| {
            let order = eviction_order([*n], now_turn, now_ms);
            order
                .first()
                .map(|(_, score)| (*score * 1000.0) as i64)
                .unwrap_or(0)
        });
        for node in in_cat {
            if total <= *cap {
                break;
            }
            let tokens = sent_tokens(node);
            total -= tokens as i64;
            out.push(Eviction {
                id: node.id.clone(),
                tokens,
                reason: Reason::CategoryCap,
            });
        }
    }
    out
}

/// Apply a plan to the tree (states only, never content).
///
/// Returns the ids actually changed and the tokens released. Locked nodes are
/// skipped even if a caller somehow put them in a plan: the law is checked here,
/// at the last gate, not only where the plan was made.
pub fn apply_evictions(
    conn: &rusqlite::Connection,
    session_key: &str,
    plan: &SelectionPlan,
    now_ms: i64,
) -> rusqlite::Result<(Vec<String>, u32)> {
    let mut changed = Vec::new();
    let mut released = 0u32;
    for ev in &plan.evict {
        let Some(node) = super::store::load_node(conn, session_key, ev.id.as_str())? else {
            continue;
        };
        if node.pin.is_hard() {
            continue;
        }
        // `In`/`Note` -> `Out` is always allowed by the state machine; anything
        // else (a temp node) has nothing to give back and is left alone.
        match can_transition(
            node.state,
            ItemState::Out,
            node.pin,
            node.note.is_some(),
            false,
        ) {
            Ok(ItemState::Out) => {
                if super::store::set_state(
                    conn,
                    session_key,
                    ev.id.as_str(),
                    ItemState::Out,
                    None,
                    now_ms,
                )? {
                    changed.push(ev.id.as_str().to_string());
                    released += ev.tokens;
                }
            }
            Ok(_) | Err(Refusal::Unchanged) => {}
            Err(_) => {}
        }
    }
    Ok((changed, released))
}

/// Items a compaction pass should offer to summarize instead of dropping: the
/// oldest, largest, unpinned `in` items. Never returns locked or essential nodes.
pub fn compress_candidates(
    nodes: &[Node],
    limit: usize,
    now_turn: u32,
    now_ms: i64,
) -> Vec<NodeId> {
    let mut in_window: Vec<&Node> = nodes
        .iter()
        .filter(|n| n.state == ItemState::In)
        .filter(|n| !n.pin.is_hard())
        .filter(|n| tier_of(n) == Tier::Selectable)
        .collect();
    let order = eviction_order(in_window.iter().copied(), now_turn, now_ms);
    in_window.sort_by_key(|n| {
        order
            .iter()
            .position(|(id, _)| id == &n.id)
            .unwrap_or(usize::MAX)
    });
    in_window
        .into_iter()
        .take(limit)
        .map(|n| n.id.clone())
        .filter(|_| true)
        .collect()
}

/// The checklist's "what is the state of my window" summary, as plain numbers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WindowSummary {
    pub in_items: usize,
    pub note_items: usize,
    pub temp_items: usize,
    pub out_items: usize,
    pub sent_tokens: usize,
}

pub fn summarize(nodes: &[Node]) -> WindowSummary {
    let mut s = WindowSummary::default();
    for n in nodes {
        match n.state {
            ItemState::In => s.in_items += 1,
            ItemState::Note => s.note_items += 1,
            ItemState::Temp => s.temp_items += 1,
            ItemState::Out => s.out_items += 1,
        }
        s.sent_tokens += sent_tokens(n) as usize;
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::budget::{Budget, BudgetInput};
    use crate::context_tree::model::{Node, NodeKind, Owner, Provenance};

    fn node(id: &str, kind: NodeKind, state: ItemState, pin: Pin, tokens: u32) -> Node {
        Node {
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
        }
    }

    fn budget(window: u64, used: usize) -> Budget {
        let locked = 0usize;
        Budget::compute(
            BudgetInput {
                window,
                reserve_out: 0,
                headroom: 0,
                locked,
                min_selectable: 1,
            },
            used,
            100,
        )
    }

    #[test]
    fn what_is_sent_depends_on_state_and_nothing_else() {
        assert_eq!(
            sent_tokens(&node(
                "turn/t1",
                NodeKind::Turn,
                ItemState::In,
                Pin::None,
                100
            )),
            100
        );
        assert_eq!(
            sent_tokens(&node(
                "turn/t2",
                NodeKind::Turn,
                ItemState::Note,
                Pin::None,
                100
            )),
            10
        );
        assert_eq!(
            sent_tokens(&node(
                "turn/t3",
                NodeKind::Turn,
                ItemState::Out,
                Pin::None,
                100
            )),
            0
        );
        assert_eq!(
            sent_tokens(&node(
                "tmp/s1",
                NodeKind::TempSummary,
                ItemState::Temp,
                Pin::None,
                100
            )),
            0
        );
    }

    #[test]
    fn the_tiers_put_the_law_and_the_essentials_out_of_reach() {
        assert_eq!(
            tier_of(&node(
                "sys/core",
                NodeKind::SysPart,
                ItemState::In,
                Pin::Locked,
                800
            )),
            Tier::Law
        );
        assert_eq!(
            tier_of(&node(
                "ess/e1",
                NodeKind::Essential,
                ItemState::In,
                Pin::Policy,
                40
            )),
            Tier::Essential
        );
        assert_eq!(
            tier_of(&node(
                "strat/1",
                NodeKind::Strategy,
                ItemState::In,
                Pin::Ai,
                60
            )),
            Tier::Strategy
        );
        assert_eq!(
            tier_of(&node(
                "turn/t9",
                NodeKind::Turn,
                ItemState::In,
                Pin::None,
                900
            )),
            Tier::Selectable
        );
    }

    #[test]
    fn the_cheapest_items_go_first_and_the_law_never_goes() {
        let mut core = node(
            "sys/core",
            NodeKind::SysPart,
            ItemState::In,
            Pin::Locked,
            800,
        );
        core.turn = None;
        let mut ess = node(
            "ess/e1",
            NodeKind::Essential,
            ItemState::In,
            Pin::Policy,
            60,
        );
        ess.turn = None;
        let mut result = node("res/R1", NodeKind::Result, ItemState::In, Pin::None, 500);
        result.turn = Some(3);
        let mut turn = node("turn/t4", NodeKind::Turn, ItemState::In, Pin::None, 400);
        turn.turn = Some(4);
        let nodes = vec![core, ess, result, turn];
        let b = budget(2_000, 1_760);
        let plan = plan_eviction(&nodes, &b, 900, 20, 1_000, false, Reason::Budget);
        assert!(!plan.within_budget || plan.tokens_after <= 900);
        assert!(plan.tokens_after <= 900, "got {}", plan.tokens_after);
        let gone: Vec<&str> = plan.evict.iter().map(|e| e.id.as_str()).collect();
        assert!(
            gone.contains(&"res/R1"),
            "the tool result is the cheapest thing to lose: {gone:?}"
        );
        assert!(!gone.contains(&"sys/core"));
        assert!(!gone.contains(&"ess/e1"));
        assert_eq!(plan.evict[0].reason, Reason::Budget);
    }

    #[test]
    fn an_ai_pin_survives_the_normal_pass_and_falls_in_the_forced_one() {
        let mut pinned = node("turn/t7", NodeKind::Turn, ItemState::In, Pin::Ai, 600);
        pinned.turn = Some(7);
        let nodes = vec![pinned];
        let b = budget(1_000, 600);
        let normal = plan_eviction(&nodes, &b, 100, 10, 1_000, false, Reason::Budget);
        assert!(
            normal.evict.is_empty(),
            "the model's own pin is respected while there is a choice"
        );
        let forced = plan_eviction(&nodes, &b, 100, 10, 1_000, true, Reason::Forced);
        assert_eq!(
            forced.evict.len(),
            1,
            "when the window overflows, even a pin gives way"
        );
        assert_eq!(forced.evict[0].reason, Reason::Forced);
    }

    #[test]
    fn a_selection_that_already_fits_is_left_alone() {
        let nodes = vec![node(
            "turn/t1",
            NodeKind::Turn,
            ItemState::In,
            Pin::None,
            100,
        )];
        let b = budget(10_000, 100);
        let plan = plan_eviction(&nodes, &b, 5_000, 10, 1_000, false, Reason::Budget);
        assert!(plan.evict.is_empty());
        assert!(plan.within_budget);
        assert_eq!(plan.tokens_after, 100);
    }

    #[test]
    fn a_category_cap_shrinks_the_category_before_the_window_does() {
        let mut a = node("file/f1", NodeKind::File, ItemState::In, Pin::None, 400);
        a.parent = "cat/c1".into();
        let mut b = node("file/f2", NodeKind::File, ItemState::In, Pin::None, 400);
        b.parent = "cat/c1".into();
        let nodes = vec![a, b];
        let caps = vec![("cat/c1".to_string(), 400)];
        let evicted = plan_category_caps(&nodes, &caps, 10, 1_000);
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].reason, Reason::CategoryCap);
        assert_eq!(evicted[0].tokens, 400);
    }

    #[test]
    fn applying_an_eviction_writes_the_state_and_reports_the_tokens() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::context_tree::store::ensure_tables(&conn).unwrap();
        crate::context_tree::store::ensure_session(&conn, "s1", 1_000).unwrap();
        crate::context_tree::store::upsert_node(
            &conn,
            &node("turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 300),
        )
        .unwrap();
        crate::context_tree::store::upsert_node(
            &conn,
            &node(
                "sys/core",
                NodeKind::SysPart,
                ItemState::In,
                Pin::Locked,
                800,
            ),
        )
        .unwrap();
        let plan = SelectionPlan {
            evict: vec![
                Eviction {
                    id: NodeId::parse("turn/t1").unwrap(),
                    tokens: 300,
                    reason: Reason::Budget,
                },
                // A malicious/buggy plan that tries to evict the law.
                Eviction {
                    id: NodeId::parse("sys/core").unwrap(),
                    tokens: 800,
                    reason: Reason::Forced,
                },
            ],
            ..Default::default()
        };
        let (changed, released) = apply_evictions(&conn, "s1", &plan, 2_000).unwrap();
        assert_eq!(changed, vec!["turn/t1".to_string()]);
        assert_eq!(released, 300);
        let core = crate::context_tree::store::load_node(&conn, "s1", "sys/core")
            .unwrap()
            .unwrap();
        assert_eq!(
            core.state,
            ItemState::In,
            "the last gate still refuses to evict the law"
        );
    }

    #[test]
    fn compression_offers_the_oldest_selected_items_never_the_law() {
        let mut a = node("turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 900);
        a.turn = Some(1);
        let mut b = node("turn/t9", NodeKind::Turn, ItemState::In, Pin::None, 900);
        b.turn = Some(9);
        let core = node(
            "sys/core",
            NodeKind::SysPart,
            ItemState::In,
            Pin::Locked,
            800,
        );
        let out = node("turn/t3", NodeKind::Turn, ItemState::Out, Pin::None, 900);
        let picks = compress_candidates(&[a, b, core, out], 5, 10, 1_000);
        assert!(picks.iter().any(|id| id.as_str() == "turn/t1"));
        assert!(!picks.iter().any(|id| id.as_str() == "sys/core"));
        assert!(
            !picks.iter().any(|id| id.as_str() == "turn/t3"),
            "out items have nothing to compress"
        );
    }

    #[test]
    fn the_summary_counts_what_the_checklist_shows() {
        let nodes = vec![
            node("turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 100),
            node("turn/t2", NodeKind::Turn, ItemState::Note, Pin::None, 200),
            node("turn/t3", NodeKind::Turn, ItemState::Out, Pin::None, 300),
            node(
                "tmp/s1",
                NodeKind::TempSummary,
                ItemState::Temp,
                Pin::None,
                40,
            ),
        ];
        let s = summarize(&nodes);
        assert_eq!(
            (s.in_items, s.note_items, s.out_items, s.temp_items),
            (1, 1, 1, 1)
        );
        assert_eq!(s.sent_tokens, 120);
    }
}
