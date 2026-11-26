//! Nodes of the context tree: ids, kinds, states, the transition table and the
//! value score used when the engine (not the model) has to choose.
//!
//! Design rules enforced here:
//!
//! * an id is stable, human-readable and **never reused**; its prefix says what
//!   it points at, so a log line or a model reply can be read without a lookup;
//! * `sys/core` and every `ess/*` node are **pinned** and always sent;
//! * a state change that would hide something locked, or that would need a note
//!   the node does not have, is refused with a machine-readable reason;
//! * a file node carries the hash of the slice it read, so "the file changed
//!   since you read it" is answerable without reading it again.

use serde::{Deserialize, Serialize};

/// Marker of the checklist block the model sees every step.
pub const CHECKLIST_MARKER: &str = "[native-agent-context-tree-v1]";
/// Marker of the block written after a restart, compaction or a large eviction.
pub const RESUME_MARKER: &str = "[native-agent-resume-v1]";
/// The one node every request must contain.
pub const CORE_NODE_ID: &str = "sys/core";

/// Longest note a node carries when it is in state `Note` (spec §4.4).
pub const MAX_NOTE_CHARS: usize = 600;
/// Longest one-line title (anything longer is cut, never trusted as markup).
pub const MAX_TITLE_CHARS: usize = 120;

/// A node identifier such as `sys/core`, `turn/15/call/3/result`,
/// `sum/1-7`, `res/R12`, `file/f9#L120-340`, `note/n7`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(String);

/// What a node points at. Derived from the id prefix, never stored separately
/// for anything but diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    /// A part of the system prompt (`sys/*`).
    SysPart,
    /// An essential: goal, decision, fact, preference, file, open item (`ess/*`).
    Essential,
    /// A turn of the transcript (`turn/N`).
    Turn,
    /// One tool call or its result inside a turn (`turn/N/call/K[/result]`).
    TurnPart,
    /// An immutable policy turn-range summary (`sum/A-B`).
    Summary,
    /// A stored tool result (`res/R#`).
    Result,
    /// A file the model read, or a slice of it (`file/f#`, `file/f#L...`).
    File,
    /// A temp summary made by the model (`tmp/*`).
    TempSummary,
    /// A note in the model's notebook (`note/*`).
    Note,
    /// The strategy file (`strat/*`).
    Strategy,
    /// A sub-agent and what it returned (`agent/*`).
    Subagent,
    /// A category (`cat/*`).
    Category,
}

impl NodeKind {
    /// The kind implied by an id prefix, if the prefix is a known one.
    pub fn of_id(id: &NodeId) -> Option<NodeKind> {
        let prefix = id.0.split('/').next().unwrap_or_default();
        Some(match prefix {
            "sys" => NodeKind::SysPart,
            "ess" => NodeKind::Essential,
            "turn" => {
                // turn/N is a whole turn, turn/N/call/K[/result] is a part of it.
                if id.0.matches('/').count() >= 2 {
                    NodeKind::TurnPart
                } else {
                    NodeKind::Turn
                }
            }
            "sum" => NodeKind::Summary,
            "res" => NodeKind::Result,
            "file" => NodeKind::File,
            "tmp" => NodeKind::TempSummary,
            "note" => NodeKind::Note,
            "strat" => NodeKind::Strategy,
            "agent" => NodeKind::Subagent,
            "cat" => NodeKind::Category,
            _ => return None,
        })
    }

    /// Title of the category this kind is filed under by default.
    pub fn home_category(&self) -> &'static str {
        match self {
            NodeKind::SysPart => "sys",
            NodeKind::Essential => "ess",
            NodeKind::Turn | NodeKind::TurnPart | NodeKind::Summary => "turns",
            NodeKind::Result => "results",
            NodeKind::File => "files",
            NodeKind::TempSummary => "tmp",
            NodeKind::Note => "notes",
            NodeKind::Strategy => "strat",
            NodeKind::Subagent => "agents",
            NodeKind::Category => "root",
        }
    }

    /// Weight used by [`value_score`]: what this kind is worth keeping when room
    /// is short. Essentials dominate; temp output is the first to go.
    pub fn weight(&self) -> f64 {
        match self {
            NodeKind::SysPart => 100.0,
            NodeKind::Essential => 90.0,
            NodeKind::Strategy => 60.0,
            NodeKind::Note => 45.0,
            NodeKind::Summary => 40.0,
            NodeKind::File => 35.0,
            NodeKind::Turn => 30.0,
            NodeKind::TurnPart => 25.0,
            NodeKind::Result => 20.0,
            NodeKind::Subagent => 20.0,
            NodeKind::TempSummary => 10.0,
            NodeKind::Category => 0.0,
        }
    }
}

impl NodeId {
    /// Parse and validate an id. Rejects anything whose prefix is unknown, that
    /// carries control characters, or that is longer than 160 bytes — a node id
    /// travels through JSON events, logs and the UI, so it has to be boring.
    pub fn parse(raw: &str) -> Result<NodeId, String> {
        let s = raw.trim();
        if s.is_empty() {
            return Err("empty node id".into());
        }
        if s.len() > 160 {
            return Err("node id too long".into());
        }
        if s.chars().any(|c| c.is_control()) {
            return Err("node id has control characters".into());
        }
        let id = NodeId(s.to_string());
        if NodeKind::of_id(&id).is_none() {
            return Err(format!("unknown node id prefix in {s:?}"));
        }
        Ok(id)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The category this node is filed under, overridable by the store.
    pub fn home_category(&self) -> &'static str {
        NodeKind::of_id(self)
            .map(|k| k.home_category())
            .unwrap_or("root")
    }

    /// A file slice id (`file/f9#L120-340`) names its parent (`file/f9`).
    pub fn file_parent(&self) -> Option<&str> {
        self.0.split_once('#').map(|(head, _)| head)
    }

    pub fn kind(&self) -> Option<NodeKind> {
        NodeKind::of_id(self)
    }
}

/// What is sent for a node in this state (spec §4.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemState {
    /// Full content.
    In,
    /// Only the node's note.
    Note,
    /// A temp summary instead of the content.
    Temp,
    /// Not sent at all (still listed, still recallable).
    Out,
}

impl ItemState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ItemState::In => "in",
            ItemState::Note => "note",
            ItemState::Temp => "temp",
            ItemState::Out => "out",
        }
    }

    pub fn parse(raw: &str) -> Option<ItemState> {
        Some(match raw.trim().to_ascii_lowercase().as_str() {
            "in" => ItemState::In,
            "note" => ItemState::Note,
            "temp" => ItemState::Temp,
            "out" => ItemState::Out,
            _ => return None,
        })
    }

    /// True when the node contributes tokens to the request.
    pub fn is_sent(&self) -> bool {
        !matches!(self, ItemState::Out)
    }
}

/// Who decided a node stays: none, the engine (locked), the policy (essentials),
/// or the model itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pin {
    None,
    /// `sys/core`: never leaves, never changes.
    Locked,
    /// `ess/*`: never leaves; its content is produced by the summarizer.
    Policy,
    /// The model asked for it to stay.
    Ai,
}

impl Pin {
    /// A pinned node is always sent; the safety net may not evict it (an AI pin
    /// can be demoted last, below everything else, and that is logged).
    pub fn is_hard(&self) -> bool {
        matches!(self, Pin::Locked | Pin::Policy)
    }
}

/// Who created a node, and therefore who may change it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    System,
    Policy,
    Ai,
    Subagent(String),
}

impl Owner {
    /// Only the model may move or delete what the model created.
    pub fn is_ai(&self) -> bool {
        matches!(self, Owner::Ai)
    }
}

/// Why a transition was refused. These strings are part of the tool contract
/// (they appear in `ctx` results and in the UI), so they never change wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    /// `sys/core` or an essential: the transition is not allowed at all.
    Locked,
    /// The node needs a note before it can be hidden with one.
    NoteRequired,
    /// Only `ctx_summarize` may put a node into `Temp`.
    UseSummarize,
    /// The node is already in the requested state.
    Unchanged,
}

impl Refusal {
    pub fn as_str(&self) -> &'static str {
        match self {
            Refusal::Locked => "locked",
            Refusal::NoteRequired => "note_required",
            Refusal::UseSummarize => "use_summarize",
            Refusal::Unchanged => "unchanged",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a node came from, so the UI can say "turns 12–14", "page 3–5 of
/// report.pdf" or "the web page you fetched in turn 9".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// `workspace`, `upload`, `web`, `subagent`, `tool`, `memory`, `user`, `engine`.
    pub source: String,
    /// Path, URL, result id or sub-agent id.
    pub locator: Option<String>,
    /// `L120-340`, `p3-5` or `b0-65535`.
    pub range: Option<String>,
    pub turn: Option<u32>,
    pub call_index: Option<u32>,
    /// SHA-256 of the slice as it was read; a mismatch later means the file moved on.
    pub content_hash: Option<String>,
}

/// One node of the tree. `tokens_full`/`tokens_note` are counted with the meter
/// of `token_model`, so a model switch can mark them stale instead of lying.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: NodeId,
    pub session_key: String,
    pub kind: NodeKind,
    /// Home category id (`sys`, `ess`, `turns`, `files`, … or `cat/c3`).
    pub parent: String,
    /// Up to four extra AI categories this node also belongs to.
    pub tags: Vec<String>,
    /// Sort key inside the parent (gaps of 1024 so reordering is cheap).
    pub order: i64,
    pub title: String,
    pub state: ItemState,
    pub pin: Pin,
    pub owner: Owner,
    pub tokens_full: u32,
    pub tokens_note: u32,
    pub token_model: String,
    pub note: Option<String>,
    pub provenance: Provenance,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub loaded_at: Option<i64>,
    pub turn: Option<u32>,
    pub rev: i64,
    pub deleted: bool,
}

impl Node {
    /// Tokens this node contributes in its current state.
    pub fn tokens_in_context(&self) -> u32 {
        match self.state {
            ItemState::In => self.tokens_full,
            ItemState::Note => self.tokens_note,
            // A temp summary's own node carries the summary's cost.
            ItemState::Temp => self.tokens_note,
            ItemState::Out => 0,
        }
    }

    /// True when the model may change this node's state at all.
    pub fn is_mutable_by_ai(&self) -> bool {
        !self.pin.is_hard()
    }
}

/// The place a node keeps in the window, decided by [`value_score`].
///
/// Higher is more worth keeping. This is deliberately deterministic and free of
/// randomness: when the engine has to choose, two identical runs must choose the
/// same nodes, or a bug report is not reproducible.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ValueInput {
    pub kind: NodeKind,
    /// Turn number the engine is on now (0 when unknown).
    pub now_turn: u32,
    /// Turn this node was created in, when known.
    pub turn: Option<u32>,
    /// Times it was sent or recalled, saturating.
    pub hits: u32,
    /// Last time it was sent or recalled, in ms.
    pub last_used_at: Option<i64>,
    /// Now, in ms.
    pub now_ms: i64,
    /// True when a category cap is already exceeded: over-cap nodes go first.
    pub over_cap: bool,
    pub tokens_full: u32,
}

/// Recency half-life in turns.
pub const RECENCY_HALF_LIFE_TURNS: f64 = 40.0;

/// Score a node. Locked and policy pins are handled by the caller (they are
/// never scored); everything else gets a number from these five signals only.
pub fn value_score(v: &ValueInput) -> f64 {
    let age_turns = v.now_turn.saturating_sub(v.turn.unwrap_or(v.now_turn)) as f64;
    let mut score = v.kind.weight();

    // Recency by turn distance, halving every RECENCY_HALF_LIFE_TURNS turns.
    score += 30.0 * 0.5f64.powf(age_turns / RECENCY_HALF_LIFE_TURNS);

    // Recency by wall clock (a restart resets turn numbers, not time).
    if let Some(last) = v.last_used_at {
        let idle_ms = v.now_ms.saturating_sub(last).max(0) as f64;
        let idle_hours = idle_ms / 3_600_000.0;
        score += 20.0 * 0.5f64.powf(idle_hours / 6.0);
    }

    // Usage: log-scaled, so a node used once is not worth ten times one used
    // never, and a node used 100 times does not drown everything else.
    score += 12.0 * ((1.0 + v.hits as f64).ln());

    // A node whose category is over its cap is the cheapest thing to move out.
    if v.over_cap {
        score -= 25.0;
    }

    // Tie-break: the cheaper (smaller) node wins when scores are equal, so the
    // engine frees room with as few losses as possible.
    score -= (v.tokens_full as f64) / 100_000.0;
    score
}

/// Order nodes for eviction: lowest value first. Deterministic for equal scores
/// (bigger nodes first, then by id) so the same tree always evicts the same way.
pub fn eviction_order<'a>(
    nodes: impl IntoIterator<Item = &'a Node>,
    now_turn: u32,
    now_ms: i64,
) -> Vec<(NodeId, f64)> {
    let mut scored: Vec<(NodeId, f64)> = nodes
        .into_iter()
        .filter(|n| n.is_mutable_by_ai() && n.state.is_sent())
        .map(|n| {
            let v = ValueInput {
                kind: n.kind,
                now_turn,
                turn: n.turn,
                hits: 0,
                last_used_at: n.last_used_at,
                now_ms,
                over_cap: false,
                tokens_full: n.tokens_full,
            };
            (n.id.clone(), value_score(&v))
        })
        .collect();
    scored.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.as_str().cmp(b.0.as_str()))
    });
    scored
}

/// Validate a state change the model asked for (spec §4.5, exactly).
///
/// `has_note` is true when the node already carries a note; `note_given` is true
/// when the request carries a new one.
pub fn can_transition(
    from: ItemState,
    to: ItemState,
    pin: Pin,
    has_note: bool,
    note_given: bool,
) -> Result<ItemState, Refusal> {
    // Law: locked and policy-pinned nodes are always in, whatever is asked.
    if pin.is_hard() {
        return match to {
            ItemState::In => Ok(ItemState::In),
            _ => Err(Refusal::Locked),
        };
    }
    if from == to {
        return Err(Refusal::Unchanged);
    }
    match (from, to) {
        // Back into the window.
        (ItemState::Out, ItemState::In) | (ItemState::Note, ItemState::In) => Ok(ItemState::In),
        // Out of the window.
        (ItemState::In, ItemState::Out) | (ItemState::Note, ItemState::Out) => Ok(ItemState::Out),
        // Keep only a note: the note must exist or be given with the request.
        (ItemState::In, ItemState::Note)
        | (ItemState::Out, ItemState::Note)
        | (ItemState::Temp, ItemState::Note) => {
            if has_note || note_given {
                Ok(ItemState::Note)
            } else {
                Err(Refusal::NoteRequired)
            }
        }
        // Leaving 'temp' puts the original back; the engine then drops the temp
        // summary once it has no sources left in 'temp'. Reversible on purpose.
        (ItemState::Temp, ItemState::In) | (ItemState::Temp, ItemState::Out) => Ok(to),
        // Replaced by a temp summary — only through summarize, which sets
        // `temp_of` on the source nodes in the same transaction.
        (ItemState::In, ItemState::Temp)
        | (ItemState::Note, ItemState::Temp)
        | (ItemState::Out, ItemState::Temp) => Err(Refusal::UseSummarize),
        // Same state: reached only when the early return above is refactored
        // away. Listed explicitly (a guard would not satisfy exhaustiveness, and
        // a catch-all would hide a state added later).
        (ItemState::In, ItemState::In)
        | (ItemState::Note, ItemState::Note)
        | (ItemState::Out, ItemState::Out)
        | (ItemState::Temp, ItemState::Temp) => Err(Refusal::Unchanged),
    }
}

/// Cut a title to something safe to put in a prompt or a log line: one line, no
/// marker strings, no control characters, at most [`MAX_TITLE_CHARS`].
pub fn safe_title(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    for marker in [CHECKLIST_MARKER, RESUME_MARKER, "[native-agent-"] {
        if s.contains(marker) {
            s = s.replace(marker, "");
        }
    }
    let trimmed = s.trim();
    if trimmed.chars().count() > MAX_TITLE_CHARS {
        trimmed
            .chars()
            .take(MAX_TITLE_CHARS - 1)
            .collect::<String>()
            + "…"
    } else {
        trimmed.to_string()
    }
}

impl std::fmt::Display for NodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Storage-facing names. These are the strings in the SQLite rows and in the
/// audit log, so they are spelled once, here, and parsed back here.
impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeKind::SysPart => "sysPart",
            NodeKind::Essential => "essential",
            NodeKind::Turn => "turn",
            NodeKind::TurnPart => "turnPart",
            NodeKind::Summary => "summary",
            NodeKind::Result => "result",
            NodeKind::File => "file",
            NodeKind::TempSummary => "tempSummary",
            NodeKind::Note => "note",
            NodeKind::Strategy => "strategy",
            NodeKind::Subagent => "subagent",
            NodeKind::Category => "category",
        }
    }

    /// The inverse of [`NodeKind::as_str`]. Unknown values are `None`: a row
    /// written by a newer build must be skipped, not misread.
    pub fn of_str(raw: &str) -> Option<NodeKind> {
        Some(match raw {
            "sysPart" => NodeKind::SysPart,
            "essential" => NodeKind::Essential,
            "turn" => NodeKind::Turn,
            "turnPart" => NodeKind::TurnPart,
            "summary" => NodeKind::Summary,
            "result" => NodeKind::Result,
            "file" => NodeKind::File,
            "tempSummary" => NodeKind::TempSummary,
            "note" => NodeKind::Note,
            "strategy" => NodeKind::Strategy,
            "subagent" => NodeKind::Subagent,
            "category" => NodeKind::Category,
            _ => return None,
        })
    }

    /// The id prefix a freshly allocated id of this kind uses. Summary and
    /// strategy are singletons per session, so they never take a number.
    pub fn id_prefix(&self) -> &'static str {
        match self {
            NodeKind::SysPart => "sys",
            NodeKind::Essential => "ess",
            NodeKind::Turn => "turn",
            NodeKind::TurnPart => "turn",
            NodeKind::Summary => "sum",
            NodeKind::Result => "res",
            NodeKind::File => "file",
            NodeKind::TempSummary => "tmp",
            NodeKind::Note => "note",
            NodeKind::Strategy => "strat",
            NodeKind::Subagent => "agent",
            NodeKind::Category => "cat",
        }
    }
}

impl Pin {
    pub fn as_str(&self) -> &'static str {
        match self {
            Pin::None => "none",
            Pin::Locked => "locked",
            Pin::Policy => "policy",
            Pin::Ai => "ai",
        }
    }

    pub fn parse(raw: &str) -> Option<Pin> {
        Some(match raw {
            "none" => Pin::None,
            "locked" => Pin::Locked,
            "policy" => Pin::Policy,
            "ai" => Pin::Ai,
            _ => return None,
        })
    }
}

impl Owner {
    pub fn as_str(&self) -> String {
        match self {
            Owner::System => "system".into(),
            Owner::Policy => "policy".into(),
            Owner::Ai => "ai".into(),
            Owner::Subagent(id) => format!("subagent:{id}"),
        }
    }

    /// Parse the stored form. `subagent:<id>` keeps its id; an unknown value
    /// falls back to the most restrictive owner (`Policy`), never to `Ai`.
    pub fn parse(raw: &str) -> Option<Owner> {
        Some(match raw {
            "system" => Owner::System,
            "policy" => Owner::Policy,
            "ai" => Owner::Ai,
            other => match other.strip_prefix("subagent:") {
                Some(id) => Owner::Subagent(id.to_string()),
                None => Owner::Policy,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: NodeKind, state: ItemState, pin: Pin) -> Node {
        Node {
            id: NodeId::parse(id).unwrap(),
            session_key: "chat-1".into(),
            kind,
            parent: kind.home_category().into(),
            tags: vec![],
            order: 0,
            title: id.into(),
            state,
            pin,
            owner: Owner::Policy,
            tokens_full: 100,
            tokens_note: 20,
            token_model: "gpt-4o".into(),
            note: None,
            provenance: Provenance::default(),
            created_at: 0,
            last_used_at: None,
            loaded_at: None,
            turn: None,
            rev: 1,
            deleted: false,
        }
    }

    #[test]
    fn ids_carry_their_kind_and_reject_junk() {
        assert_eq!(
            NodeId::parse("sys/core").unwrap().kind(),
            Some(NodeKind::SysPart)
        );
        assert_eq!(
            NodeId::parse("turn/15").unwrap().kind(),
            Some(NodeKind::Turn)
        );
        assert_eq!(
            NodeId::parse("turn/15/call/3").unwrap().kind(),
            Some(NodeKind::TurnPart)
        );
        assert_eq!(
            NodeId::parse("turn/15/call/3/result").unwrap().kind(),
            Some(NodeKind::TurnPart)
        );
        assert_eq!(
            NodeId::parse("sum/1-7").unwrap().kind(),
            Some(NodeKind::Summary)
        );
        assert_eq!(
            NodeId::parse("res/R12").unwrap().kind(),
            Some(NodeKind::Result)
        );
        assert_eq!(
            NodeId::parse("file/f9#L120-340").unwrap().kind(),
            Some(NodeKind::File)
        );
        assert_eq!(
            NodeId::parse("file/f9#L120-340").unwrap().file_parent(),
            Some("file/f9")
        );
        assert!(NodeId::parse("").is_err());
        assert!(NodeId::parse("history/1").is_err());
        assert!(NodeId::parse("sys/\u{7}core").is_err());
        assert!(NodeId::parse(&"a".repeat(200)).is_err());
    }

    #[test]
    fn locked_nodes_can_only_stay_in() {
        for pin in [Pin::Locked, Pin::Policy] {
            assert_eq!(
                can_transition(ItemState::In, ItemState::In, pin, true, true),
                Ok(ItemState::In)
            );
            for to in [ItemState::Out, ItemState::Note, ItemState::Temp] {
                assert_eq!(
                    can_transition(ItemState::In, to, pin, true, true),
                    Err(Refusal::Locked)
                );
            }
        }
    }

    #[test]
    fn hiding_with_a_note_needs_one() {
        assert_eq!(
            can_transition(ItemState::In, ItemState::Note, Pin::None, false, false),
            Err(Refusal::NoteRequired)
        );
        assert_eq!(
            can_transition(ItemState::In, ItemState::Note, Pin::None, true, false),
            Ok(ItemState::Note)
        );
        assert_eq!(
            can_transition(ItemState::In, ItemState::Note, Pin::None, false, true),
            Ok(ItemState::Note)
        );
        // Excluding needs nothing: it is reversible with ctx_recall.
        assert_eq!(
            can_transition(ItemState::In, ItemState::Out, Pin::None, false, false),
            Ok(ItemState::Out)
        );
    }

    #[test]
    fn temp_is_only_reachable_through_summarize() {
        for from in [ItemState::In, ItemState::Note, ItemState::Out] {
            assert_eq!(
                can_transition(from, ItemState::Temp, Pin::Ai, true, true),
                Err(Refusal::UseSummarize)
            );
        }
        // Temp -> Temp is not a transition at all.
        assert_eq!(
            can_transition(ItemState::Temp, ItemState::Temp, Pin::Ai, true, true),
            Err(Refusal::Unchanged)
        );
        // Leaving temp is a normal include/exclude.
        assert_eq!(
            can_transition(ItemState::Temp, ItemState::In, Pin::Ai, true, false),
            Ok(ItemState::In)
        );
        assert_eq!(
            can_transition(ItemState::Temp, ItemState::Out, Pin::Ai, true, false),
            Ok(ItemState::Out)
        );
    }

    #[test]
    fn no_op_is_reported_as_unchanged() {
        for s in [
            ItemState::In,
            ItemState::Note,
            ItemState::Out,
            ItemState::Temp,
        ] {
            assert_eq!(
                can_transition(s, s, Pin::None, true, true),
                Err(Refusal::Unchanged)
            );
        }
    }

    #[test]
    fn essentials_and_core_weigh_more_than_temp_output() {
        let base = ValueInput {
            kind: NodeKind::Essential,
            now_turn: 100,
            turn: Some(99),
            hits: 0,
            last_used_at: None,
            now_ms: 1_000,
            over_cap: false,
            tokens_full: 100,
        };
        let ess = value_score(&base);
        let tmp = value_score(&ValueInput {
            kind: NodeKind::TempSummary,
            ..base
        });
        assert!(ess > tmp, "essentials {ess} must outweigh temp {tmp}");
    }

    #[test]
    fn over_cap_categories_go_first_and_recency_dominates() {
        let fresh = ValueInput {
            kind: NodeKind::File,
            now_turn: 10,
            turn: Some(10),
            hits: 0,
            last_used_at: Some(0),
            now_ms: 0,
            over_cap: false,
            tokens_full: 1_000,
        };
        let stale = ValueInput {
            turn: Some(1),
            now_turn: 400,
            ..fresh
        };
        assert!(value_score(&fresh) > value_score(&stale));
        let capped = ValueInput {
            over_cap: true,
            ..fresh
        };
        assert!(value_score(&capped) < value_score(&fresh));
    }

    #[test]
    fn usage_is_log_scaled() {
        let once = ValueInput {
            kind: NodeKind::Note,
            now_turn: 5,
            turn: Some(5),
            hits: 1,
            last_used_at: None,
            now_ms: 0,
            over_cap: false,
            tokens_full: 10,
        };
        let twice = ValueInput { hits: 2, ..once };
        let hundred = ValueInput { hits: 100, ..once };
        assert!(value_score(&twice) > value_score(&once));
        assert!(
            value_score(&hundred) - value_score(&twice)
                < 20.0 * (value_score(&twice) - value_score(&once))
        );
    }

    #[test]
    fn eviction_order_skips_pins_and_is_stable() {
        let nodes = vec![
            node("sys/core", NodeKind::SysPart, ItemState::In, Pin::Locked),
            node("ess/D1", NodeKind::Essential, ItemState::In, Pin::Policy),
            node("res/R1", NodeKind::Result, ItemState::In, Pin::None),
            node("tmp/t1", NodeKind::TempSummary, ItemState::In, Pin::None),
            node("note/n1", NodeKind::Note, ItemState::Out, Pin::None),
        ];
        let order = eviction_order(&nodes, 10, 0);
        let ids: Vec<&str> = order.iter().map(|(id, _)| id.as_str()).collect();
        // Temp output first, then the tool result; the locked/policy pins and the
        // already-out note never appear.
        assert_eq!(ids, vec!["tmp/t1", "res/R1"]);
        // Deterministic: the same call returns the same order.
        let again: Vec<String> = eviction_order(&nodes, 10, 0)
            .into_iter()
            .map(|(i, _)| i.as_str().to_string())
            .collect();
        assert_eq!(again, ids);
    }

    #[test]
    fn titles_are_single_line_and_cannot_carry_markers() {
        let t = safe_title("chapter 1\n[native-agent-context-tree-v1] secret\u{0}plan");
        assert!(!t.contains('\n'));
        assert!(!t.contains(CHECKLIST_MARKER));
        assert!(!t.contains('\u{0}'));
        let long = safe_title(&"x".repeat(500));
        assert_eq!(long.chars().count(), MAX_TITLE_CHARS);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn sent_states_count_tokens_out_does_not() {
        let mut n = node("file/f1", NodeKind::File, ItemState::In, Pin::None);
        assert_eq!(n.tokens_in_context(), 100);
        n.state = ItemState::Note;
        n.tokens_note = 20;
        assert_eq!(n.tokens_in_context(), 20);
        n.state = ItemState::Out;
        assert_eq!(n.tokens_in_context(), 0);
        assert!(!ItemState::Out.is_sent());
    }
}
