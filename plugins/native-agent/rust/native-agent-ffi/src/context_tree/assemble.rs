//! What actually goes into one request, in one function.
//!
//! The agent loop already decides the transcript; this module decides the part
//! the tree owns — the checklist, the resume block and which nodes are sent — and
//! then applies the overflow ladder as a *pure* function so the order of decisions
//! is visible in one place:
//!
//! ```text
//! used ≤ warn_soft   →  send as selected
//! used > warn_soft   →  warn in the checklist, still send
//! used > compact_at  →  evict cheapest-first to compact_at      (reason: budget)
//! used > force       →  evict AI pins too                        (reason: forced)
//! still > selectable →  send the locked set + newest prompt only (starved)
//! ```
//!
//! The caller applies the returned evictions with
//! [`super::select::apply_evictions`] and assembles the messages; nothing in this
//! function writes to the database.

use super::budget::Budget;
use super::model::{ItemState, Node, Pin};
use super::render::{checklist, resume_block, CategoryBlock, ResumeInput};
use super::select::{self, Reason, SelectionPlan};

/// What the assembly decided, before anything is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assembly {
    /// The checklist block, to be inserted verbatim into the system prompt.
    pub checklist: String,
    /// The resume block, or `None` when there is nothing to resume.
    pub resume: Option<String>,
    /// Nodes whose state must become `out` before the request is sent.
    pub plan: SelectionPlan,
    /// True when the window could not hold the locked set at all.
    pub starved: bool,
    /// Which step of the ladder fired: `none`, `warn_soft`, `compact`, `force`, `starved`.
    pub stage: &'static str,
}

impl Assembly {
    pub fn tokens_after(&self) -> usize {
        self.plan.tokens_after
    }
}

/// Build the tree's contribution to one request.
#[allow(clippy::too_many_arguments)]
pub fn assemble(
    budget: &Budget,
    model: &str,
    nodes: &[Node],
    categories: &[CategoryBlock],
    rev: i64,
    now_turn: u32,
    now_ms: i64,
    resume: &ResumeInput<'_>,
    redact_paths: bool,
) -> Assembly {
    // 1. The ladder. Each step is a superset of the one before.
    let mut plan = if budget.used_sel > budget.force {
        let forced = select::plan_eviction(nodes, budget, budget.compact_at, now_turn, now_ms, true, Reason::Forced);
        let mut p = forced;
        p.within_budget = p.tokens_after <= budget.selectable;
        p
    } else if budget.used_sel > budget.compact_at {
        select::plan_eviction(nodes, budget, budget.compact_at, now_turn, now_ms, false, Reason::Budget)
    } else {
        SelectionPlan { tokens_after: budget.used_sel, within_budget: true, ..Default::default() }
    };
    let stage = if plan.within_budget && plan.evict.is_empty() {
        if budget.used_sel > budget.warn_soft {
            "warn_soft"
        } else {
            "none"
        }
    } else if budget.used_sel > budget.force {
        "force"
    } else {
        "compact"
    };
    let starved = budget.starved || (!plan.within_budget && plan.evict.is_empty());
    if starved {
        plan.tokens_after = budget.used_sel;
    }

    // 2. The checklist describes the window *after* the plan, so what the model
    //    reads matches what it is about to receive.
    let projected: Vec<Node> = nodes
        .iter()
        .map(|n| {
            if plan.evict.iter().any(|e| &e.id == &n.id) {
                let mut copy = n.clone();
                copy.state = ItemState::Out;
                copy
            } else {
                n.clone()
            }
        })
        .collect();
    let projected_blocks: Vec<CategoryBlock> = categories
        .iter()
        .map(|c| CategoryBlock {
            nodes: c.nodes.iter().map(|n| projected.iter().find(|p| p.id == n.id).cloned().unwrap_or_else(|| n.clone())).collect(),
            ..c.clone()
        })
        .collect();
    let mut projected_budget = *budget;
    projected_budget.used_sel = plan.tokens_after.min(budget.selectable);
    projected_budget.free = budget.selectable.saturating_sub(projected_budget.used_sel);

    let checklist_text = checklist(&projected_budget, model, &projected_blocks, rev, redact_paths);

    // 3. The resume block only helps a *fresh* model; if the last turns are still
    //    in the window it is noise, so it is emitted only when something was lost.
    let lost_recent = plan.evict.iter().any(|e| {
        nodes.iter().any(|n| &n.id == &e.id && matches!(n.kind, super::model::NodeKind::Turn | super::model::NodeKind::TurnPart))
    });
    let resume_text = (lost_recent || starved).then(|| resume_block(resume, rev));

    Assembly { checklist: checklist_text, resume: resume_text, plan, starved, stage }
}

/// The instruction block the model is given about the checklist, appended to the
/// part of the system prompt that carries the memory rules. It is short on purpose:
/// the per-action prose lives here, not in the tool schema (see `tools.rs`).
pub fn instructions() -> &'static str {
    "Your context window is listed in the block marked [native-agent-context-tree-v1].\n\
     ● in the window  ○ out (still stored)  ◐ note only  ✦ replaced by a summary  ⚿ locked\n\
     Change it with ctx: view (the list, or one item with path), set (up to 12 ops:\n\
     include, exclude, note_only, pin, unpin, move, tag — with expect_rev to be safe),\n\
     category (create cat/* of your own, cap it with max_tokens), summarize (replace\n\
     several items with one summary; the sources stay stored), recall (bring one item\n\
     back, or ask a question about it), note (your notebook: what matters, in your\n\
     words), strategy (the plan for a big task, with the next step), prompt (load or\n\
     unload part of the system prompt; sys/core can never be unloaded).\n\
     Nothing is deleted by taking it out of the window. When the window is tight the\n\
     items you marked pin=True are the last to go, and anything evicted is listed in\n\
     the log with the reason.\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::budget::BudgetInput;
    use crate::context_tree::model::{NodeKind, Owner, Provenance};

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

    fn budget(window: u64, locked: usize, used: usize) -> Budget {
        Budget::compute(BudgetInput { window, reserve_out: 0, headroom: 0, locked, min_selectable: super::super::budget::MIN_SELECTABLE_TOKENS }, used, 70)
    }

    fn cats(nodes: &[Node]) -> Vec<CategoryBlock> {
        let mut out: Vec<CategoryBlock> = Vec::new();
        for n in nodes {
            match out.iter_mut().find(|c| c.id == n.parent) {
                Some(c) => c.nodes.push(n.clone()),
                None => out.push(CategoryBlock { id: n.parent.clone(), title: n.parent.clone(), ai_owned: false, nodes: vec![n.clone()], cap_tokens: None }),
            }
        }
        out
    }

    fn run(nodes: &[Node], b: &Budget) -> Assembly {
        let blocks = cats(nodes);
        assemble(b, "m", nodes, &blocks, 5, 10, 1_000, &ResumeInput::default(), false)
    }

    #[test]
    fn a_comfortable_window_is_sent_as_selected() {
        let nodes = vec![node("turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 1_000)];
        let b = budget(100_000, 0, 1_000);
        let a = run(&nodes, &b);
        assert_eq!(a.stage, "none");
        assert!(a.plan.evict.is_empty());
        assert!(a.resume.is_none(), "nothing was lost, so no resume block");
        assert!(a.checklist.contains("turn/t1"));
    }

    #[test]
    fn over_the_compaction_point_the_cheapest_goes_and_the_checklist_agrees() {
        let nodes = vec![
            node("sys/core", NodeKind::SysPart, ItemState::In, Pin::Locked, 1_000),
            node("turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 3_000),
            node("turn/t2", NodeKind::Turn, ItemState::In, Pin::None, 2_000),
        ];
        // window 10k, locked 1k → selectable 9k; at 50% compact sits at 4.5k and
        // the forced point at 5.2k, so 4k fits, 5k is a compaction and not a force.
        let under = run(&nodes, &budget(10_000, 1_000, 4_000));
        assert_eq!(under.stage, "none");
        let b = Budget::compute(
            BudgetInput { window: 10_000, reserve_out: 0, headroom: 0, locked: 1_000, min_selectable: super::super::budget::MIN_SELECTABLE_TOKENS },
            5_000,
            50,
        );
        let over = run(&nodes, &b);
        assert_eq!(over.stage, "compact");
        assert!(!over.plan.evict.is_empty());
        assert!(over.plan.tokens_after <= b.compact_at || over.starved);
        assert!(over.resume.is_some(), "a lost turn is exactly when a resume block helps");
        // The evicted node is shown as out in the checklist it renders.
        let evicted = over.plan.evict[0].id.as_str().to_string();
        let line = over.checklist.lines().find(|l| l.contains(&evicted)).unwrap_or("");
        assert!(line.contains('○'), "the checklist must show it as out: {line}");
    }

    #[test]
    fn the_forced_pass_takes_an_ai_pin_and_says_so() {
        let nodes = vec![
            node("sys/core", NodeKind::SysPart, ItemState::In, Pin::Locked, 1_000),
            node("turn/t1", NodeKind::Turn, ItemState::In, Pin::Ai, 8_000),
        ];
        // selectable 9k, force at 115% of compact_at (70%) = 7.2k, used 9k → force.
        let b = budget(10_000, 1_000, 9_000);
        let a = run(&nodes, &b);
        assert_eq!(a.stage, "force");
        assert_eq!(a.plan.evict.len(), 1);
        assert_eq!(a.plan.evict[0].reason, Reason::Forced);
        assert!(a.resume.is_some());
    }

    #[test]
    fn a_starved_window_still_produces_a_checklist_and_says_so() {
        // Tools and prompt alone exceed the window.
        let nodes = vec![
            node("sys/core", NodeKind::SysPart, ItemState::In, Pin::Locked, 8_000),
            node("turn/t1", NodeKind::Turn, ItemState::In, Pin::None, 4_000),
        ];
        let b = budget(8_192, 8_000, 4_000);
        assert!(b.starved);
        let a = run(&nodes, &b);
        assert!(a.starved);
        assert!(a.checklist.starts_with(super::super::model::CHECKLIST_MARKER));
        assert!(a.resume.is_some(), "a starved window must tell the next model where it stands");
    }

    #[test]
    fn the_instructions_name_every_action_and_the_locked_rule() {
        let text = instructions();
        for action in ["view", "set", "category", "summarize", "recall", "note", "strategy", "prompt"] {
            assert!(text.contains(action), "instructions never mention {action}");
        }
        assert!(text.contains("sys/core can never be unloaded"));
        assert!(text.contains("Nothing is deleted"));
        // It is paid on every request, so it must stay small.
        assert!(super::super::render::estimate_tokens(text) <= 260, "instructions cost {} tokens", super::super::render::estimate_tokens(text));
    }

    #[test]
    fn the_checklist_it_produces_is_never_over_budget() {
        let mut nodes = vec![node("sys/core", NodeKind::SysPart, ItemState::In, Pin::Locked, 800)];
        for i in 1..80 {
            nodes.push(node(&format!("turn/t{i}"), NodeKind::Turn, ItemState::In, Pin::None, 200));
        }
        let b = budget(200_000, 800, 16_600);
        let a = run(&nodes, &b);
        let cost = super::super::render::estimate_tokens(&a.checklist);
        assert!(cost <= super::super::render::CHECKLIST_BUDGET_TOKENS + 200, "checklist cost {cost}");
        assert_eq!(a.checklist.matches(super::super::model::CHECKLIST_MARKER).count(), 1);
    }
}
