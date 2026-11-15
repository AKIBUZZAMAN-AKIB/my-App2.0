//! Memory repair: a recall sub-agent may PROPOSE a correction with quoted
//! evidence; code checks that every cited turn exists and that every quote
//! really appears in that turn's original messages before a new version is
//! made. A repair never changes or supersedes an existing decision (it may
//! only add one). Every repair is a version with the change recorded, and a
//! revert undoes exactly that change.

use super::items::{self, AddOp, ItemOps, Kind};
use super::{clip, norm_key, render_turn, validate_transition, Decision, TurnMemory};
use crate::types::Message;
use serde_json::{json, Value};

/// Shortest quote accepted as evidence (characters, whitespace collapsed).
pub const MIN_QUOTE_CHARS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub enum RepairChange {
    Segment { from: u32, to: u32, summary: String },
    Fact { text: String, turn: u32, replaces: Option<String> },
    Preference { text: String, turn: u32, replaces: Option<String> },
    Decision { text: String, turn: u32 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    pub change: RepairChange,
    pub evidence: Vec<(u32, String)>,
    pub reason: String,
}

fn num(v: Option<&Value>) -> Option<u32> {
    v.and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))).map(|n| n as u32)
}

fn s(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").trim().to_string()
}

/// Read a proposal from a recall answer's "repair" object.
pub fn parse_proposal(v: &Value) -> Result<Proposal, String> {
    let o = v.as_object().ok_or("the repair is not an object")?;
    let kind = s(o.get("kind")).to_lowercase();
    let replaces = Some(s(o.get("replaces"))).filter(|r| !r.is_empty());
    let change = match kind.as_str() {
        "segment" => RepairChange::Segment {
            from: num(o.get("fromTurn")).ok_or("segment repair needs fromTurn")?,
            to: num(o.get("toTurn")).or(num(o.get("fromTurn"))).unwrap_or(0),
            summary: s(o.get("summary")),
        },
        "fact" => RepairChange::Fact { text: s(o.get("text")), turn: num(o.get("turn")).unwrap_or(0), replaces },
        "preference" => RepairChange::Preference { text: s(o.get("text")), turn: num(o.get("turn")).unwrap_or(0), replaces },
        "decision" => {
            if o.get("supersedes").is_some() || o.get("replaces").is_some() || o.get("id").is_some() {
                return Err("a repair may not change or supersede an existing decision".into());
            }
            RepairChange::Decision { text: s(o.get("text")), turn: num(o.get("turn")).unwrap_or(0) }
        }
        other => return Err(format!("unknown repair kind {:?}", other)),
    };
    let evidence = o
        .get("evidence")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|e| Some((num(e.get("turn"))?, s(e.get("quote"))))).collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(Proposal { change, evidence, reason: clip(&s(o.get("reason")), 300) })
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Check a proposal against the memory and the original turns. Every cited
/// turn must be archived and summarized, every quote must appear (whitespace
/// collapsed, otherwise exact) in that turn's original text, and the change
/// must point at turns the evidence covers.
pub fn check_proposal(mem: &TurnMemory, p: &Proposal, originals: &[(u32, Vec<Message>)]) -> Result<(), String> {
    if p.evidence.is_empty() {
        return Err("no quoted evidence".into());
    }
    for (turn, quote) in &p.evidence {
        if *turn == 0 || *turn > mem.through_turn {
            return Err(format!("cited turn {} is not a summarized turn (1-{})", turn, mem.through_turn));
        }
        let Some((_, msgs)) = originals.iter().find(|(n, _)| n == turn) else {
            return Err(format!("cited turn {} is not in the archive", turn));
        };
        let q = squash(quote);
        if q.chars().count() < MIN_QUOTE_CHARS {
            return Err(format!("the quote from turn {} is too short to verify", turn));
        }
        if !squash(&render_turn(*turn, msgs)).contains(&q) {
            return Err(format!("the quote \"{}\" does not appear in turn {}", clip(quote, 80), turn));
        }
    }
    let cited = |t: u32| p.evidence.iter().any(|(n, _)| *n == t);
    match &p.change {
        RepairChange::Segment { from, to, summary } => {
            if summary.trim().is_empty() {
                return Err("the corrected segment is empty".into());
            }
            if !mem.segments.iter().any(|s| s.from_turn == *from && s.to_turn == *to) {
                return Err(format!("there is no segment for turns {}-{}", from, to));
            }
            if !p.evidence.iter().all(|(n, _)| n >= from && n <= to) {
                return Err("the evidence must come from the segment's own turns".into());
            }
        }
        RepairChange::Fact { text, turn, replaces } | RepairChange::Preference { text, turn, replaces } => {
            if text.trim().is_empty() {
                return Err("the repair has no text".into());
            }
            if !cited(*turn) {
                return Err(format!("source turn {} is not one of the cited turns", turn));
            }
            let list = if matches!(p.change, RepairChange::Fact { .. }) { &mem.facts } else { &mem.preferences };
            if let Some(r) = replaces {
                if !list.iter().any(|n| norm_key(&n.text) == norm_key(r)) {
                    return Err(format!("\"{}\" is not in the memory, so it cannot be replaced", clip(r, 80)));
                }
            }
            if list.iter().any(|n| norm_key(&n.text) == norm_key(text)) {
                return Err("the memory already says this".into());
            }
        }
        RepairChange::Decision { text, turn } => {
            if text.trim().is_empty() {
                return Err("the repair has no text".into());
            }
            if !cited(*turn) {
                return Err(format!("source turn {} is not one of the cited turns", turn));
            }
            if mem.all_decisions().any(|d| norm_key(&d.text) == norm_key(text)) {
                return Err("the memory already has this decision".into());
            }
        }
    }
    Ok(())
}

/// Apply a checked proposal: the next memory and the detail recorded in the
/// version history (enough to revert exactly this change).
pub fn apply_proposal(mem: &TurnMemory, p: &Proposal, now_ms: i64) -> Result<(TurnMemory, Value), String> {
    let mut next = mem.clone();
    let evidence: Vec<Value> = p.evidence.iter().map(|(t, q)| json!({"turn": t, "quote": q})).collect();
    let detail = match &p.change {
        RepairChange::Segment { from, to, summary } => {
            let seg = next.segments.iter_mut().find(|s| s.from_turn == *from && s.to_turn == *to).ok_or("segment not found")?;
            let before = std::mem::replace(&mut seg.summary, clip(summary, 700));
            json!({"kind": "segment", "fromTurn": from, "toTurn": to, "before": before, "after": seg.summary})
        }
        RepairChange::Fact { text, turn, replaces } | RepairChange::Preference { text, turn, replaces } => {
            let is_fact = matches!(p.change, RepairChange::Fact { .. });
            let kind = if is_fact { Kind::Fact } else { Kind::Preference };
            next.normalize();
            let reason = if p.reason.trim().is_empty() { "verified repair".to_string() } else { clip(&p.reason, 200) };
            let ops = ItemOps {
                add: vec![AddOp {
                    kind: kind.as_str().into(),
                    text: clip(text, 300),
                    turn: *turn,
                    supersedes: replaces
                        .as_ref()
                        .and_then(|r| next.items.iter().find(|i| i.is_current() && i.kind() == Some(kind) && (norm_key(&i.text) == norm_key(r) || i.id.eq_ignore_ascii_case(r.trim()))))
                        .map(|i| vec![i.id.clone()])
                        .unwrap_or_default(),
                    reason,
                    from_list: false,
                }],
                ..Default::default()
            };
            let mut errs = Vec::new();
            let (items, no) = items::apply_ops(&next, &ops, next.through_turn, "repair", &mut errs);
            if !errs.is_empty() {
                return Err(errs.join("; "));
            }
            let removed = ops.add[0]
                .supersedes
                .first()
                .and_then(|id| next.items.iter().find(|i| &i.id == id))
                .map(|o| json!({"text": o.text, "turn": o.turn(), "id": o.id}))
                .unwrap_or(Value::Null);
            next.items = items;
            next.next_item = no;
            items::mirror_lists(&mut next);
            let added = next.items.last().cloned().unwrap_or_default();
            json!({"kind": kind.as_str(), "added": {"text": added.text, "turn": added.turn(), "id": added.id}, "removed": removed})
        }
        RepairChange::Decision { text, turn } => {
            next.next_decision += 1;
            let id = format!("D{}", next.next_decision);
            next.decisions.current.push(Decision { id: id.clone(), text: clip(text, 300), turn: *turn, origin: "repair".into(), ..Default::default() });
            json!({"kind": "decision", "added": id, "text": text, "turn": turn})
        }
    };
    next.updated_at = now_ms;
    validate_transition(mem, &next, &[]).map_err(|e| e.join("; "))?;
    let mut d = detail;
    d["evidence"] = Value::Array(evidence);
    d["reason"] = Value::String(p.reason.clone());
    Ok((next, d))
}

/// Undo the change a repair version recorded, on top of the current memory.
/// Fails (and changes nothing) when later versions changed the same thing.
pub fn revert_detail(cur: &TurnMemory, detail: &Value, now_ms: i64) -> Result<TurnMemory, String> {
    let mut next = cur.clone();
    let mut allow: Vec<String> = Vec::new();
    match detail.get("kind").and_then(Value::as_str) {
        Some("segment") => {
            let (from, to) = (num(detail.get("fromTurn")).unwrap_or(0), num(detail.get("toTurn")).unwrap_or(0));
            let after = s(detail.get("after"));
            let seg = next.segments.iter_mut().find(|x| x.from_turn == from && x.to_turn == to).ok_or("that segment was merged or changed since; nothing to revert")?;
            if seg.summary.trim() != after {
                return Err("that segment changed again since the repair; nothing to revert".into());
            }
            seg.summary = s(detail.get("before"));
        }
        Some(k @ ("fact" | "preference")) => {
            next.normalize();
            let kind = if k == "fact" { Kind::Fact } else { Kind::Preference };
            let added = detail.get("added").cloned().unwrap_or(Value::Null);
            let (aid, atext) = (s(added.get("id")), s(added.get("text")));
            let i = next
                .items
                .iter()
                .position(|it| it.kind() == Some(kind) && it.is_current() && if aid.is_empty() { norm_key(&it.text) == norm_key(&atext) } else { it.id == aid })
                .ok_or("the repaired item is no longer in the memory; nothing to revert")?;
            if norm_key(&next.items[i].text) != norm_key(&atext) {
                return Err("the repaired item changed again since the repair; nothing to revert".into());
            }
            let gone = next.items.remove(i);
            allow.push(gone.id.clone());
            if let Some(r) = detail.get("removed").filter(|r| r.is_object()) {
                let (rid, rtext) = (s(r.get("id")), s(r.get("text")));
                let found = next.items.iter().position(|it| it.kind() == Some(kind) && if rid.is_empty() { norm_key(&it.text) == norm_key(&rtext) } else { it.id == rid });
                match found {
                    Some(j) => {
                        let it = &mut next.items[j];
                        it.history.push(items::ItemChange { turn: it.updated_turn, change: "reopened".into(), text: it.text.clone(), reason: "repair reverted".into() });
                        it.status = items::CURRENT.into();
                        it.superseded_by = None;
                        it.reason = "repair reverted".into();
                        allow.push(format!("reopen:{}", it.id));
                    }
                    None => {
                        // A repair from before items existed removed a plain note.
                        next.next_item += 1;
                        let t = num(r.get("turn")).unwrap_or(0);
                        next.items.push(items::MemoryItem {
                            id: format!("{}{}", kind.prefix(), next.next_item),
                            kind: kind.as_str().into(),
                            text: rtext,
                            status: items::CURRENT.into(),
                            source_turns: if t > 0 { vec![t] } else { Vec::new() },
                            updated_turn: t,
                            origin: "legacy".into(),
                            reason: "repair reverted".into(),
                            ..Default::default()
                        });
                    }
                }
            }
            items::mirror_lists(&mut next);
        }
        Some("decision") => {
            let id = s(detail.get("added"));
            if next.decisions.superseded.iter().any(|d| d.superseded_by.as_deref() == Some(id.as_str())) {
                return Err(format!("{} has since replaced another decision; revert would orphan it", id));
            }
            let i = next.decisions.current.iter().position(|d| d.id == id).ok_or("the repaired decision is no longer current; nothing to revert")?;
            next.decisions.current.remove(i);
            allow.push(id);
        }
        _ => return Err("this version is not a repair".into()),
    }
    next.updated_at = now_ms;
    validate_transition(cur, &next, &allow).map_err(|e| e.join("; "))?;
    Ok(next)
}
