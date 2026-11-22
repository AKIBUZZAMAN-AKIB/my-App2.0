//! Per-range versions and structured change tracking across ranges.
//!
//! A range summary is immutable. Before this module the only record of what a
//! range changed against the earlier ranges was a free-text line the model
//! may write ("Changes to turns A-B: …"), and the only version was the one
//! global `TurnMemory::version` that every save bumps. Now every new range
//! gets, once, from code:
//!
//! * `rev`: its own version number in the chat (R1, R2, …). Repairs,
//!   reverts and save retries do not touch it, so R3 names the same range
//!   forever;
//! * `base_version`: the memory version it was built on;
//! * `changes`: what it changed relative to the earlier ranges, from the
//!   records themselves: a decision that replaced an earlier one (with the
//!   earlier text, its id, and the range and range version it came from), a
//!   new decision, an item added, reworded, done, retired or superseded.
//!
//! The diff is deterministic (base memory against the new memory), so the
//! same summary always produces the same changes, and nothing here depends on
//! the model writing the change line correctly.

use super::{Segment, TurnMemory};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Most changes kept on one range (the rest are counted in the last entry).
pub const MAX_CHANGES_PER_RANGE: usize = 60;

/// One structured change a range made relative to the earlier ranges.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RangeChange {
    /// "decision", "fact", "preference", "file" or "openItem".
    pub kind: String,
    /// "added", "replaced", "updated", "done", "retired" or "superseded".
    pub action: String,
    /// The record as it is now (the new decision for "replaced").
    pub id: String,
    pub text: String,
    /// The earlier record this change replaces or rewrites.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub prior_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub prior_text: String,
    /// The range the earlier record came from, `[from, to]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_range: Option<[u32; 2]>,
    /// That range's own version (R…), when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_rev: Option<u32>,
    /// The turn the change was made in.
    pub turn: u32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

/// The per-range version of a segment: its own `rev`, else its position
/// (ranges written before the field are numbered in turn order).
pub fn rev_of(mem: &TurnMemory, seg: &Segment) -> u32 {
    if seg.rev > 0 {
        return seg.rev;
    }
    mem.segments.iter().position(|s| s.from_turn == seg.from_turn && s.to_turn == seg.to_turn).map(|i| i as u32 + 1).unwrap_or(0)
}

/// The range (and its version) that holds `turn` in `mem`.
fn range_of(mem: &TurnMemory, turn: u32) -> Option<([u32; 2], u32)> {
    if turn == 0 {
        return None;
    }
    mem.segments.iter().find(|s| s.from_turn <= turn && turn <= s.to_turn).map(|s| ([s.from_turn, s.to_turn], rev_of(mem, s)))
}

fn is_new(base: &TurnMemory, s: &Segment) -> bool {
    !base.segments.iter().any(|b| b.from_turn == s.from_turn && b.to_turn == s.to_turn)
}

/// Stamp the ranges of `next` that `base` does not have: their `rev`,
/// `base_version` and `changes`. Ranges already in `base` are never touched.
pub fn stamp_new_segments(base: &TurnMemory, next: &mut TurnMemory) {
    let mut new_idx: Vec<usize> = next.segments.iter().enumerate().filter(|(_, s)| is_new(base, s)).map(|(i, _)| i).collect();
    if new_idx.is_empty() {
        return;
    }
    new_idx.sort_by_key(|&i| (next.segments[i].from_turn, next.segments[i].to_turn));
    let top = base.segments.iter().map(|s| rev_of(base, s)).max().unwrap_or(0).max(base.segments.len() as u32);
    for (k, &i) in new_idx.iter().enumerate() {
        let s = &mut next.segments[i];
        s.rev = top + k as u32 + 1;
        s.base_version = base.version;
        s.changes.clear();
    }
    let changes = diff(base, next);
    let mut per: HashMap<usize, Vec<RangeChange>> = HashMap::new();
    let last = *new_idx.last().expect("non-empty");
    for c in changes {
        let at = new_idx.iter().copied().find(|&i| next.segments[i].from_turn <= c.turn && c.turn <= next.segments[i].to_turn).unwrap_or(last);
        per.entry(at).or_default().push(c);
    }
    for (i, mut list) in per {
        if list.len() > MAX_CHANGES_PER_RANGE {
            let more = list.len() - (MAX_CHANGES_PER_RANGE - 1);
            list.truncate(MAX_CHANGES_PER_RANGE - 1);
            list.push(RangeChange { kind: "more".into(), action: "more".into(), text: format!("{} more changes", more), ..Default::default() });
        }
        next.segments[i].changes = list;
    }
}

/// Every record change from `base` to `next`, in turn order.
pub fn diff(base: &TurnMemory, next: &TurnMemory) -> Vec<RangeChange> {
    let mut out: Vec<RangeChange> = Vec::new();
    let text_of = |id: &str| next.all_decisions().find(|d| d.id == id).map(|d| d.text.clone()).unwrap_or_default();
    let mut replacing: Vec<String> = Vec::new();
    // Decisions replaced in this range (also ones made and replaced inside it).
    for d in &next.decisions.superseded {
        if base.decisions.superseded.iter().any(|b| b.id == d.id) {
            continue;
        }
        let by = d.superseded_by.clone().unwrap_or_default();
        let prior = range_of(base, d.turn).or_else(|| range_of(next, d.turn));
        if !by.is_empty() {
            replacing.push(by.clone());
        }
        out.push(RangeChange {
            kind: "decision".into(),
            action: "replaced".into(),
            id: if by.is_empty() { d.id.clone() } else { by.clone() },
            text: if by.is_empty() { String::new() } else { text_of(&by) },
            prior_id: d.id.clone(),
            prior_text: d.text.clone(),
            prior_range: prior.map(|p| p.0),
            prior_rev: prior.map(|p| p.1).filter(|r| *r > 0),
            turn: d.superseded_at.unwrap_or(d.turn),
            reason: d.reason.clone().unwrap_or_default(),
        });
    }
    // New decisions in force that replace nothing.
    for d in &next.decisions.current {
        if base.all_decisions().any(|b| b.id == d.id) || replacing.iter().any(|r| r == &d.id) {
            continue;
        }
        out.push(RangeChange { kind: "decision".into(), action: "added".into(), id: d.id.clone(), text: d.text.clone(), turn: d.turn, ..Default::default() });
    }
    // Facts, preferences, files and open items, by stable id.
    let base_items: HashMap<&str, &super::items::MemoryItem> = base.items.iter().map(|i| (i.id.as_str(), i)).collect();
    for it in &next.items {
        let turn = if it.updated_turn > 0 { it.updated_turn } else { it.source_turns.last().copied().unwrap_or(0) };
        match base_items.get(it.id.as_str()) {
            None => {
                let action = if it.status == super::items::CURRENT { "added" } else { it.status.as_str() };
                out.push(RangeChange { kind: it.kind.clone(), action: action.into(), id: it.id.clone(), text: it.text.clone(), turn, reason: it.reason.clone(), ..Default::default() });
            }
            Some(b) => {
                let prior = range_of(base, b.source_turns.first().copied().unwrap_or(b.updated_turn));
                if b.status != it.status {
                    let by = it.superseded_by.clone().unwrap_or_default();
                    out.push(RangeChange {
                        kind: it.kind.clone(),
                        action: it.status.clone(),
                        id: if by.is_empty() { it.id.clone() } else { by.clone() },
                        text: if by.is_empty() { it.text.clone() } else { next.items.iter().find(|x| x.id == by).map(|x| x.text.clone()).unwrap_or_default() },
                        prior_id: it.id.clone(),
                        prior_text: b.text.clone(),
                        prior_range: prior.map(|p| p.0),
                        prior_rev: prior.map(|p| p.1).filter(|r| *r > 0),
                        turn,
                        reason: it.reason.clone(),
                    });
                } else if b.text != it.text {
                    out.push(RangeChange {
                        kind: it.kind.clone(),
                        action: "updated".into(),
                        id: it.id.clone(),
                        text: it.text.clone(),
                        prior_id: it.id.clone(),
                        prior_text: b.text.clone(),
                        prior_range: prior.map(|p| p.0),
                        prior_rev: prior.map(|p| p.1).filter(|r| *r > 0),
                        turn,
                        reason: it.reason.clone(),
                    });
                }
            }
        }
    }
    out.sort_by_key(|c| c.turn);
    out
}

/// The range's own version as the model reads it: " (range v3)", after the
/// turn range and topic. Not "R3": in the memory block and in recall_turns
/// `R<n>` is a stored tool result ID (`result_id "R12"`), so a range
/// labelled R3 would read as result R3. The screen keeps its R1, R2 badges.
/// Empty for a range saved before ranges had versions.
pub fn rev_tag(seg: &Segment) -> String {
    if seg.rev > 0 {
        format!(" (range v{})", seg.rev)
    } else {
        String::new()
    }
}

/// The changes of a range as one compact line for the model's memory block:
/// " | Changed vs earlier ranges: D4 replaced D2 (from range v1)". Only IDs
/// and where they came from: the replaced or reworded text is not repeated,
/// because only current items reach the model as text (a replaced decision is
/// listed under REPLACED, a closed item by ID with its reason, and the full
/// history is one `ctx memory` call away). The structured `changes`, with the
/// earlier text, stay on the range for the screen. Empty when the range
/// changed nothing that was recorded before it.
pub fn changes_suffix(seg: &Segment) -> String {
    let parts: Vec<String> = seg
        .changes
        .iter()
        .filter(|c| !c.prior_id.is_empty())
        .take(8)
        .map(|c| {
            let from = match (c.prior_rev, c.prior_range) {
                (Some(r), _) => format!(" (from range v{})", r),
                (None, Some([a, b])) if a == b => format!(" (from turn {})", a),
                (None, Some([a, b])) => format!(" (from turns {}-{})", a, b),
                _ => String::new(),
            };
            if c.action == "updated" {
                format!("{} reworded{}", c.id, from)
            } else if c.id != c.prior_id {
                format!("{} {} {}{}", c.id, c.action, c.prior_id, from)
            } else {
                format!("{} {}{}", c.prior_id, c.action, from)
            }
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!(" | Changed vs earlier ranges: {}", parts.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::super::items::MemoryItem;
    use super::super::{Decision, Segment, TurnMemory};
    use super::*;

    fn seg(a: u32, b: u32) -> Segment {
        Segment { from_turn: a, to_turn: b, topic: "t".into(), title: "t".into(), summary: format!("turns {a}-{b}"), ..Default::default() }
    }

    #[test]
    fn new_ranges_get_their_own_version_and_structured_changes() {
        let mut base = TurnMemory { version: 7, through_turn: 4, ..Default::default() };
        base.segments = vec![seg(1, 4)];
        base.decisions.current.push(Decision { id: "D1".into(), text: "use port 8080".into(), turn: 2, ..Default::default() });
        base.items.push(MemoryItem { id: "F1".into(), kind: "fact".into(), text: "db is sqlite".into(), status: "current".into(), source_turns: vec![3], updated_turn: 3, ..Default::default() });
        let mut next = base.clone();
        next.segments.push(seg(5, 8));
        next.through_turn = 8;
        let mut old = next.decisions.current.remove(0);
        old.superseded_by = Some("D2".into());
        old.superseded_at = Some(6);
        old.reason = Some("port taken".into());
        next.decisions.superseded.push(old);
        next.decisions.current.push(Decision { id: "D2".into(), text: "use port 9090".into(), turn: 6, ..Default::default() });
        next.items[0].text = "db is postgres".into();
        next.items[0].updated_turn = 7;
        stamp_new_segments(&base, &mut next);
        let s = &next.segments[1];
        assert_eq!(s.rev, 2, "R1 is the old range, the new one is R2");
        assert_eq!(s.base_version, 7);
        assert_eq!(next.segments[0], base.segments[0], "old ranges are never touched");
        let d = s.changes.iter().find(|c| c.kind == "decision").unwrap();
        assert_eq!((d.action.as_str(), d.id.as_str(), d.prior_id.as_str()), ("replaced", "D2", "D1"));
        assert_eq!(d.prior_range, Some([1, 4]));
        assert_eq!(d.prior_rev, Some(1));
        assert_eq!(d.text, "use port 9090");
        assert_eq!(d.prior_text, "use port 8080");
        assert!(!s.changes.iter().any(|c| c.action == "added" && c.id == "D2"), "a replacement is not also an addition");
        let f = s.changes.iter().find(|c| c.kind == "fact").unwrap();
        assert_eq!((f.action.as_str(), f.prior_text.as_str()), ("updated", "db is sqlite"));
        let line = changes_suffix(s);
        assert!(line.contains("D2 replaced D1 (from range v1)"), "{line}");
        assert!(!line.contains("8080") && !line.contains("sqlite"), "replaced text is not repeated to the model: {line}");
        assert_eq!(rev_tag(s), " (range v2)");
        assert!(!rev_tag(s).contains('R'), "R<n> is a stored result ID");
    }

    #[test]
    fn changes_go_to_the_new_range_that_holds_their_turn() {
        let base = TurnMemory { through_turn: 0, ..Default::default() };
        let mut next = base.clone();
        next.segments = vec![seg(1, 2), seg(3, 4)];
        next.decisions.current.push(Decision { id: "D1".into(), text: "a".into(), turn: 1, ..Default::default() });
        next.decisions.current.push(Decision { id: "D2".into(), text: "b".into(), turn: 4, ..Default::default() });
        stamp_new_segments(&base, &mut next);
        assert_eq!((next.segments[0].rev, next.segments[1].rev), (1, 2));
        assert_eq!(next.segments[0].changes.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["D1"]);
        assert_eq!(next.segments[1].changes.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["D2"]);
    }
}
