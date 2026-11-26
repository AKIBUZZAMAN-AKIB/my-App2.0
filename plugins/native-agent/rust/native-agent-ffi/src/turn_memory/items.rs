//! Facts, preferences, files and open items with stable IDs and an explicit
//! lifecycle (ADR-2). Code carries every item forward; an item only leaves
//! the current set through an operation that names it and gives a reason.
//! The summarizer never re-sends the full lists, so nothing can disappear
//! by being left out, and there is no cap that drops items.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::{clip, norm_key, slots, Note, TurnMemory};

pub const MAX_ITEM_CHARS: usize = 300;
/// Earlier wordings kept on an item (newest last).
const MAX_ITEM_HISTORY: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Fact,
    Preference,
    File,
    OpenItem,
}

impl Kind {
    pub const ALL: [Kind; 4] = [Kind::Fact, Kind::Preference, Kind::File, Kind::OpenItem];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Fact => "fact",
            Kind::Preference => "preference",
            Kind::File => "file",
            Kind::OpenItem => "openItem",
        }
    }

    pub fn prefix(self) -> char {
        match self {
            Kind::Fact => 'F',
            Kind::Preference => 'P',
            Kind::File => 'L',
            Kind::OpenItem => 'O',
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        match s
            .trim()
            .to_ascii_lowercase()
            .replace(['_', ' ', '-'], "")
            .as_str()
        {
            "fact" | "facts" => Some(Kind::Fact),
            "preference" | "preferences" | "pref" => Some(Kind::Preference),
            "file" | "files" | "identifier" | "path" => Some(Kind::File),
            "openitem" | "openitems" | "todo" | "task" => Some(Kind::OpenItem),
            _ => None,
        }
    }

    fn from_id(id: &str) -> Option<Kind> {
        let c = id.trim().chars().next()?.to_ascii_uppercase();
        Kind::ALL.into_iter().find(|k| k.prefix() == c)
    }
}

pub const CURRENT: &str = "current";
pub const DONE: &str = "done";
pub const RETIRED: &str = "retired";
pub const SUPERSEDED: &str = "superseded";

/// One earlier state of an item.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemChange {
    pub turn: u32,
    /// "updated", "done", "retired", "superseded" or "reopened".
    pub change: String,
    /// The text before the change.
    pub text: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryItem {
    /// Stable ID assigned by code: F3 (fact), P1 (preference), L2 (file or
    /// identifier), O4 (open item). Never reused in a chat.
    pub id: String,
    /// "fact", "preference", "file" or "openItem".
    pub kind: String,
    pub text: String,
    /// "current", "done", "retired" or "superseded".
    pub status: String,
    /// Turns the item comes from (empty only for items carried over from the
    /// earlier list format, whose turns are unknown).
    pub source_turns: Vec<u32>,
    /// Turn of the last change (creation, update or status change).
    pub updated_turn: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// Why it last changed status or wording.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
    /// "summary", "repair" or "legacy".
    #[serde(skip_serializing_if = "String::is_empty")]
    pub origin: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<ItemChange>,
    /// Subject of a fact or preference ("server port"), when the
    /// summarizer names one; see `slots`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// Open items only: the goal that was current when the task was raised,
    /// set by code (`goals::link_records`). None when unknown. A task's own
    /// status never follows its goal's status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_id: Option<String>,
}

impl MemoryItem {
    pub fn is_current(&self) -> bool {
        self.status == CURRENT
    }

    pub fn kind(&self) -> Option<Kind> {
        Kind::parse(&self.kind)
    }

    /// First source turn (0 when unknown).
    pub fn turn(&self) -> u32 {
        self.source_turns.first().copied().unwrap_or(0)
    }
}

// ── Summarizer operations ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AddOp {
    pub kind: String,
    pub text: String,
    pub turn: u32,
    /// IDs of current items of the same kind this new item replaces.
    pub supersedes: Vec<String>,
    pub reason: String,
    /// Entry came from a full list in the earlier answer format.
    pub from_list: bool,
    /// The model's temporary label for this new item ("T1"), so another
    /// new item in the same answer can supersede it.
    pub ref_id: String,
    /// Subject ("server port"), optional.
    pub key: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdateOp {
    pub id: String,
    pub text: String,
    pub turn: u32,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CloseOp {
    pub id: String,
    /// "done" or "retired".
    pub status: String,
    pub turn: u32,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ItemOps {
    pub add: Vec<AddOp>,
    pub update: Vec<UpdateOp>,
    pub close: Vec<CloseOp>,
}

impl ItemOps {
    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.update.is_empty() && self.close.is_empty()
    }
}

fn s(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn ids(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(x)) if !x.trim().is_empty() => vec![x.trim().to_string()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Parse the `items` object of an answer:
/// `{"add": [{kind, text, turn, supersedes?, reason?}], "update": [{id, text, turn, reason}],
///   "close": [{id, status: "done"|"retired", turn, reason}]}`.
pub fn parse_ops(v: Option<&Value>, num: &dyn Fn(Option<&Value>) -> Option<u32>) -> ItemOps {
    let mut ops = ItemOps::default();
    let Some(Value::Object(o)) = v else {
        return ops;
    };
    let list = |k: &str| match o.get(k) {
        Some(Value::Array(a)) => a.clone(),
        Some(x @ Value::Object(_)) => vec![x.clone()],
        _ => Vec::new(),
    };
    for x in list("add") {
        ops.add.push(AddOp {
            kind: s(x.get("kind")),
            text: s(x.get("text")),
            turn: num(x.get("turn")).unwrap_or(0),
            supersedes: ids(x.get("supersedes").or_else(|| x.get("replaces"))),
            reason: s(x.get("reason")),
            from_list: false,
            ref_id: s(x
                .get("id")
                .or_else(|| x.get("ref"))
                .or_else(|| x.get("tempId"))),
            key: s(x
                .get("key")
                .or_else(|| x.get("subject"))
                .or_else(|| x.get("slot"))),
        });
    }
    for x in list("update") {
        ops.update.push(UpdateOp {
            id: s(x.get("id")),
            text: s(x.get("text")),
            turn: num(x.get("turn")).unwrap_or(0),
            reason: s(x.get("reason")),
        });
    }
    for (key, status) in [("close", ""), ("done", DONE), ("retire", RETIRED)] {
        for x in list(key) {
            let st = if status.is_empty() {
                s(x.get("status")).to_lowercase()
            } else {
                status.to_string()
            };
            ops.close.push(CloseOp {
                id: s(x.get("id")),
                status: st,
                turn: num(x.get("turn")).unwrap_or(0),
                reason: s(x.get("reason")),
            });
        }
    }
    ops
}

/// Entries of a full list in the earlier answer format (`facts`, `files`, …)
/// become additions. Entries already current are no-ops, and items left out
/// are kept: a list can add but never remove.
pub fn list_adds(kind: Kind, notes: &[Note]) -> Vec<AddOp> {
    notes
        .iter()
        .map(|n| AddOp {
            kind: kind.as_str().into(),
            text: n.text.clone(),
            turn: n.turn,
            from_list: true,
            ..Default::default()
        })
        .collect()
}

// ── Applying operations ───────────────────────────────────────────────────────────────

fn item_number(id: &str) -> Option<u32> {
    let t = id.trim();
    Kind::from_id(t)?;
    let rest = &t[1..];
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

pub fn max_item_number(items: &[MemoryItem]) -> u32 {
    items
        .iter()
        .filter_map(|i| item_number(&i.id))
        .max()
        .unwrap_or(0)
}

fn find(items: &[MemoryItem], id: &str) -> Option<usize> {
    items
        .iter()
        .position(|i| i.id.eq_ignore_ascii_case(id.trim()))
}

fn push_history(it: &mut MemoryItem, turn: u32, change: &str, reason: &str) {
    it.history.push(ItemChange {
        turn,
        change: change.into(),
        text: it.text.clone(),
        reason: reason.into(),
    });
    if it.history.len() > MAX_ITEM_HISTORY {
        let extra = it.history.len() - MAX_ITEM_HISTORY;
        it.history.drain(..extra);
    }
}

/// Apply `ops` (turns `1..=to` are valid sources) to `mem.items`. Errors are
/// collected for one corrective call; nothing is applied on error by the
/// caller. Returns the new item list and the highest item number.
pub fn apply_ops(
    mem: &TurnMemory,
    ops: &ItemOps,
    to: u32,
    origin: &str,
    errs: &mut Vec<String>,
) -> (Vec<MemoryItem>, u32) {
    // Strict for callers other than the summarizer (repairs): an unknown ID
    // is an error there.
    let mut dropped = Vec::new();
    let out = apply_ops_logged(mem, ops, to, origin, errs, &mut dropped);
    errs.extend(dropped);
    out
}

/// `apply_ops`; an update, close or supersede naming an item that does not
/// exist changes nothing that exists, so it is dropped into `dropped`
/// instead of being an error.
pub fn apply_ops_logged(
    mem: &TurnMemory,
    ops: &ItemOps,
    to: u32,
    origin: &str,
    errs: &mut Vec<String>,
    dropped: &mut Vec<String>,
) -> (Vec<MemoryItem>, u32) {
    let mut items = mem.items.clone();
    let mut next_no = mem.next_item.max(max_item_number(&items));
    let valid_turn = |t: u32| t >= 1 && t <= to;
    let mut touched: HashSet<String> = HashSet::new();

    for u in &ops.update {
        let Some(i) = find(&items, &u.id) else {
            dropped.push(format!("update names unknown item {}", u.id));
            continue;
        };
        if !items[i].is_current() {
            errs.push(format!(
                "{} is {}, not current; add a new item instead of updating it",
                items[i].id, items[i].status
            ));
            continue;
        }
        let text = clip(&u.text, MAX_ITEM_CHARS);
        if text.is_empty() {
            errs.push(format!("update of {} has no text", items[i].id));
            continue;
        }
        if !valid_turn(u.turn) {
            errs.push(format!(
                "update of {} needs its source turn (a number from 1 to {}), not {}",
                items[i].id, to, u.turn
            ));
            continue;
        }
        if !touched.insert(items[i].id.to_uppercase()) {
            errs.push(format!("{} is changed twice in one answer", items[i].id));
            continue;
        }
        let it = &mut items[i];
        if norm_key(&it.text) == norm_key(&text) {
            if !it.source_turns.contains(&u.turn) {
                it.source_turns.push(u.turn);
            }
            continue;
        }
        let reason = if u.reason.is_empty() {
            "reworded".to_string()
        } else {
            clip(&u.reason, 200)
        };
        push_history(it, u.turn, "updated", &reason);
        it.text = text;
        it.reason = reason;
        it.updated_turn = u.turn;
        if !it.source_turns.contains(&u.turn) {
            it.source_turns.push(u.turn);
        }
    }

    for c in &ops.close {
        let Some(i) = find(&items, &c.id) else {
            dropped.push(format!("close names unknown item {}", c.id));
            continue;
        };
        if !items[i].is_current() {
            errs.push(format!("{} is already {}", items[i].id, items[i].status));
            continue;
        }
        let status = match c.status.as_str() {
            DONE | "completed" | "resolved" => DONE,
            RETIRED | "obsolete" | "removed" | "invalid" | "wrong" => RETIRED,
            other => {
                errs.push(format!(
                    "close of {} needs status \"done\" or \"retired\", not \"{}\"",
                    items[i].id, other
                ));
                continue;
            }
        };
        if c.reason.trim().is_empty() {
            errs.push(format!("closing {} needs a reason", items[i].id));
            continue;
        }
        if !valid_turn(c.turn) {
            errs.push(format!(
                "closing {} needs the turn where it happened (1 to {}), not {}",
                items[i].id, to, c.turn
            ));
            continue;
        }
        if !touched.insert(items[i].id.to_uppercase()) {
            errs.push(format!("{} is changed twice in one answer", items[i].id));
            continue;
        }
        let it = &mut items[i];
        let reason = clip(&c.reason, 200);
        push_history(it, c.turn, status, &reason);
        it.status = status.into();
        it.reason = reason;
        it.updated_turn = c.turn;
    }

    // Pass 1: create every new item (stable IDs by code) and map the
    // model's temporary labels to them.
    let mut refs: HashMap<String, String> = HashMap::new();
    let mut pending: Vec<(String, Kind, u32, &AddOp)> = Vec::new();
    for a in &ops.add {
        let Some(kind) = Kind::parse(&a.kind) else {
            errs.push(format!(
                "item \"{}\" has unknown kind \"{}\" (use fact, preference, file or openItem)",
                clip(&a.text, 60),
                a.kind
            ));
            continue;
        };
        let text = clip(&a.text, MAX_ITEM_CHARS);
        if text.is_empty() {
            continue;
        }
        // Already current with the same wording: refresh its source turns.
        if let Some(i) = items.iter().position(|x| {
            x.is_current() && x.kind() == Some(kind) && norm_key(&x.text) == norm_key(&text)
        }) {
            if valid_turn(a.turn) && !items[i].source_turns.contains(&a.turn) {
                items[i].source_turns.push(a.turn);
            }
            if items[i].key.is_empty() && !a.key.is_empty() {
                items[i].key = clip(&a.key, 60);
            }
            let existing = items[i].id.clone();
            declare(&mut refs, &a.ref_id, &existing, dropped);
            continue;
        }
        // An earlier-format list re-sent an item that is no longer current:
        // a list cannot revive a closed item.
        if a.from_list
            && items
                .iter()
                .any(|x| x.kind() == Some(kind) && norm_key(&x.text) == norm_key(&text))
        {
            continue;
        }
        let mut turn = a.turn;
        if !valid_turn(turn) {
            if a.from_list && matches!(kind, Kind::File | Kind::OpenItem) && turn == 0 {
                turn = to;
            } else {
                errs.push(format!(
                    "{} \"{}\" needs its source turn (a number from 1 to {}), not {}",
                    kind.as_str(),
                    clip(&text, 80),
                    to,
                    a.turn
                ));
                continue;
            }
        }
        next_no += 1;
        let id = format!("{}{}", kind.prefix(), next_no);
        if find(&mem.items, &a.ref_id).is_none() {
            declare(&mut refs, &a.ref_id, &id, dropped);
        }
        pending.push((id.clone(), kind, turn, a));
        items.push(MemoryItem {
            id,
            kind: kind.as_str().into(),
            text,
            status: CURRENT.into(),
            source_turns: vec![turn],
            updated_turn: turn,
            superseded_by: None,
            reason: String::new(),
            origin: origin.into(),
            history: Vec::new(),
            key: clip(&a.key, 60),
            goal_id: None,
        });
    }
    // Pass 2: every new item has its stable ID, so `supersedes` may name a
    // temporary label declared anywhere in this answer, a stored ID, or a
    // new item's ID.
    for (id, kind, turn, a) in pending {
        for old in &a.supersedes {
            let target = refs
                .get(&old.trim().to_uppercase())
                .cloned()
                .or_else(|| find(&items, old).map(|i| items[i].id.clone()));
            let Some(i) = target.and_then(|t| find(&items, &t)) else {
                dropped.push(format!(
                    "new {} supersedes unknown item {}",
                    kind.as_str(),
                    old
                ));
                continue;
            };
            if items[i].id == id {
                dropped.push(format!(
                    "new {} {} names itself in supersedes",
                    kind.as_str(),
                    id
                ));
                continue;
            }
            if !items[i].is_current() {
                errs.push(format!("{} is already {}", items[i].id, items[i].status));
                continue;
            }
            if !touched.insert(items[i].id.to_uppercase()) {
                errs.push(format!("{} is changed twice in one answer", items[i].id));
                continue;
            }
            let reason = if a.reason.trim().is_empty() {
                format!("replaced by {}", id)
            } else {
                clip(&a.reason, 200)
            };
            let it = &mut items[i];
            push_history(it, turn, SUPERSEDED, &reason);
            it.status = SUPERSEDED.into();
            it.superseded_by = Some(id.clone());
            it.reason = reason;
            it.updated_turn = turn;
        }
    }
    (items, next_no)
}

/// Maps a new item's temporary label to its stable ID. A label that is
/// itself a stored item's ID is not mapped (the stored item wins).
fn declare(refs: &mut HashMap<String, String>, label: &str, id: &str, dropped: &mut Vec<String>) {
    let l = label.trim().to_uppercase();
    if l.is_empty() || l == id.to_uppercase() {
        return;
    }
    if refs.contains_key(&l) {
        dropped.push(format!(
            "temporary item label {} is used twice; the first use is kept",
            label.trim()
        ));
        return;
    }
    refs.insert(l, id.to_string());
}

/// The slot rule (`slots`) for current facts and current preferences:
/// one that a strictly later current item of the same kind about the same
/// subject replaces is superseded by it. Files and open items never take
/// part (two files or two tasks are not one value replacing another).
pub fn supersede_same_slot(items: &mut [MemoryItem], _to: u32, auto: &mut Vec<String>) {
    for kind in [Kind::Fact, Kind::Preference] {
        let idx: Vec<usize> = (0..items.len())
            .filter(|&i| items[i].is_current() && items[i].kind() == Some(kind))
            .collect();
        let entries: Vec<slots::Entry<'_>> = idx
            .iter()
            .map(|&i| slots::Entry {
                key: &items[i].key,
                text: &items[i].text,
                turn: items[i].turn(),
            })
            .collect();
        let mut ambiguous = Vec::new();
        let plan = slots::plan(&entries, &mut ambiguous);
        for (a, b) in ambiguous {
            auto.push(format!("{} and {} look like the same subject but come from the same turn; both kept current", items[idx[a]].id, items[idx[b]].id));
        }
        let moves: Vec<(usize, String, u32, String)> = plan
            .into_iter()
            .map(|(a, b, label)| {
                (
                    idx[a],
                    items[idx[b]].id.clone(),
                    items[idx[b]].turn(),
                    label,
                )
            })
            .collect();
        for (i, by, turn, label) in moves {
            let it = &mut items[i];
            let reason = format!(
                "replaced by a later {} about the same subject ({}); linked automatically",
                kind.as_str(),
                label
            );
            auto.push(format!(
                "{} (\"{}\") superseded by {} at turn {}: same subject {}",
                it.id,
                clip(&it.text, 60),
                by,
                turn,
                label
            ));
            push_history(it, turn, SUPERSEDED, &reason);
            it.status = SUPERSEDED.into();
            it.superseded_by = Some(by);
            it.reason = reason;
            it.updated_turn = turn;
        }
    }
}

// ── The earlier list fields ──────────────────────────────────────────────────────────

/// Items from a memory written in the earlier format (plain lists, no IDs).
pub fn from_lists(mem: &TurnMemory) -> (Vec<MemoryItem>, u32) {
    let mut items = Vec::new();
    let mut no = 0;
    let mut push = |kind: Kind, text: &str, turn: u32| {
        let text = clip(text, MAX_ITEM_CHARS);
        if text.is_empty() {
            return;
        }
        no += 1;
        items.push(MemoryItem {
            id: format!("{}{}", kind.prefix(), no),
            kind: kind.as_str().into(),
            text,
            status: CURRENT.into(),
            source_turns: if turn > 0 { vec![turn] } else { Vec::new() },
            updated_turn: turn,
            origin: "legacy".into(),
            ..Default::default()
        });
    };
    for n in &mem.facts {
        push(Kind::Fact, &n.text, n.turn);
    }
    for n in &mem.preferences {
        push(Kind::Preference, &n.text, n.turn);
    }
    for f in &mem.files {
        push(Kind::File, f, 0);
    }
    for o in &mem.open_items {
        push(Kind::OpenItem, o, 0);
    }
    (items, no)
}

/// Rebuild the earlier list fields from the current items. Older builds
/// and the UI read these; the items are authoritative.
pub fn mirror_lists(mem: &mut TurnMemory) {
    let cur = |k: Kind| {
        mem.items
            .iter()
            .filter(move |i| i.is_current() && i.kind() == Some(k))
    };
    mem.facts = cur(Kind::Fact)
        .map(|i| Note {
            text: i.text.clone(),
            turn: i.turn(),
        })
        .collect();
    mem.preferences = cur(Kind::Preference)
        .map(|i| Note {
            text: i.text.clone(),
            turn: i.turn(),
        })
        .collect();
    mem.files = cur(Kind::File).map(|i| i.text.clone()).collect();
    mem.open_items = cur(Kind::OpenItem).map(|i| i.text.clone()).collect();
}

/// The gate for items, part of `validate_transition`: no item disappears,
/// a current item only stops being current with a reason, IDs stay unique.
pub fn validate(
    prev: &TurnMemory,
    next: &TurnMemory,
    allow_removed: &[String],
    errs: &mut Vec<String>,
) {
    let mut seen = HashSet::new();
    for it in &next.items {
        if !seen.insert(it.id.to_uppercase()) {
            errs.push(format!("item ID {} appears twice", it.id));
        }
        if it.kind().is_none() {
            errs.push(format!("item {} has unknown kind {}", it.id, it.kind));
        }
        if ![CURRENT, DONE, RETIRED, SUPERSEDED].contains(&it.status.as_str()) {
            errs.push(format!("item {} has unknown status {}", it.id, it.status));
        }
        if it.source_turns.iter().any(|t| *t > next.through_turn) {
            errs.push(format!(
                "item {} has a source turn beyond the summary (1-{})",
                it.id, next.through_turn
            ));
        }
        if it.status == SUPERSEDED {
            match &it.superseded_by {
                Some(by) if find(&next.items, by).is_some() && !by.eq_ignore_ascii_case(&it.id) => {
                }
                _ => errs.push(format!(
                    "item {} is superseded without an existing replacement",
                    it.id
                )),
            }
        }
    }
    let allowed = |id: &str| allow_removed.iter().any(|a| a.eq_ignore_ascii_case(id));
    for p in &prev.items {
        if allowed(&p.id) {
            continue;
        }
        match find(&next.items, &p.id).map(|i| &next.items[i]) {
            None => errs.push(format!(
                "{} {} (\"{}\") was lost",
                p.kind,
                p.id,
                clip(&p.text, 80)
            )),
            Some(n) if p.is_current() && !n.is_current() && n.reason.trim().is_empty() => errs
                .push(format!(
                    "{} {} stopped being current without a reason",
                    p.kind, p.id
                )),
            Some(n)
                if !p.is_current() && n.is_current() && !allowed(&format!("reopen:{}", p.id)) =>
            {
                errs.push(format!(
                    "{} {} was {} and became current again",
                    p.kind, p.id, p.status
                ))
            }
            _ => {}
        }
    }
}

/// The earlier summary's items as the summarizer sees them.
pub fn public_items(mem: &TurnMemory) -> Vec<Value> {
    mem.items
        .iter()
        .filter(|i| i.is_current())
        .map(|i| {
            let mut v =
                serde_json::json!({"id": i.id, "kind": i.kind, "text": i.text, "turn": i.turn()});
            if !i.key.is_empty() {
                v["key"] = Value::String(i.key.clone());
            }
            v
        })
        .collect()
}

/// The current items as the model sees them, grouped by kind.
pub fn render_items(mem: &TurnMemory, out: &mut String) {
    for (kind, label) in [
        (Kind::Fact, "Facts"),
        (Kind::Preference, "User preferences"),
        (Kind::File, "Files and identifiers"),
        (Kind::OpenItem, "Open items"),
    ] {
        let list: Vec<&MemoryItem> = mem
            .items
            .iter()
            .filter(|i| i.is_current() && i.kind() == Some(kind))
            .collect();
        if list.is_empty() {
            continue;
        }
        out.push_str(&format!("\n{}:\n", label));
        for i in list {
            let t = if i.turn() == 0 {
                String::new()
            } else {
                format!(" (turn {})", i.turn())
            };
            out.push_str(&format!("- {}{}: {}\n", i.id, t, i.text));
        }
    }
    // Closed items (Phase 7): only their lineage reaches the model, never
    // their old text (only current items are stated as facts), so it can say
    // "F1 was replaced by F2 in turn 9" and recall the source turns for the
    // old wording. The latest few are listed; the rest are counted.
    let mut closed: Vec<&MemoryItem> = mem.items.iter().filter(|i| !i.is_current()).collect();
    if closed.is_empty() {
        return;
    }
    closed.sort_by_key(|i| std::cmp::Reverse(i.updated_turn));
    out.push_str(
        "\nClosed or replaced items (history only, old text not shown; do not act on these):\n",
    );
    for i in closed.iter().take(MAX_RENDERED_CLOSED) {
        let at = if i.updated_turn == 0 {
            String::new()
        } else {
            format!(" at turn {}", i.updated_turn)
        };
        let by = i
            .superseded_by
            .as_deref()
            .map(|b| format!(" by {}", b))
            .unwrap_or_default();
        let why = if i.reason.is_empty() {
            String::new()
        } else {
            format!(" (reason: {})", i.reason)
        };
        let from = if i.source_turns.is_empty() {
            String::new()
        } else {
            format!(", from turn {}", i.turn())
        };
        out.push_str(&format!(
            "- {}{}: {}{}{}{}\n",
            i.id, from, i.status, by, at, why
        ));
    }
    if closed.len() > MAX_RENDERED_CLOSED {
        out.push_str(&format!(
            "- \u{2026} and {} older closed items.\n",
            closed.len() - MAX_RENDERED_CLOSED
        ));
    }
}

/// Closed items shown to the model (the newest; the rest are counted).
pub const MAX_RENDERED_CLOSED: usize = 10;
