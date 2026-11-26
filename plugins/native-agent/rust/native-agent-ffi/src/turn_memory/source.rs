//! Source-grounded turns (Phase 5, ADR-5): the turn index of a chat and the
//! original messages of its turns, read from the stored transcript
//! (`messages`, the source of truth), plus a deterministic coverage check.
//!
//! The turn index is derived from the transcript every time it is needed
//! (`split_turns` + a hash per turn), never stored: the transcript is
//! rewritten as a whole on save, and a stored index would be a second copy
//! that can drift (the W-2 class of bug). `turn_archive` is only a fallback
//! for a turn the transcript no longer has, and a cross-check: a turn whose
//! archived copy differs from the transcript is reported, and the
//! transcript wins.

use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

use super::{jobs, split_turns, TurnMemory};
use crate::types::Message;

/// One turn of the transcript: its number, its messages
/// (`messages[start..end]`) and a hash of them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRef {
    pub no: u32,
    pub start: usize,
    pub end: usize,
    pub hash: String,
}

fn hash_msgs(no: u32, msgs: &[Message]) -> String {
    jobs::input_hash(&[(no, msgs.to_vec())])
}

/// The turn index of a transcript.
pub fn turn_index(messages: &[Message]) -> Vec<TurnRef> {
    split_turns(messages)
        .iter()
        .map(|t| TurnRef {
            no: t.no,
            start: t.start,
            end: t.end,
            hash: hash_msgs(t.no, &messages[t.start..t.end]),
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// The stored transcript.
    Transcript,
    /// `turn_archive` only (the transcript no longer has the turn).
    Archive,
}

#[derive(Debug, Clone, Default)]
pub struct SourceTurns {
    /// Turns found, in order.
    pub turns: Vec<(u32, Vec<Message>)>,
    pub origins: HashMap<u32, Origin>,
    /// Asked-for turns found nowhere, as ranges.
    pub missing: Vec<(u32, u32)>,
    /// Turns whose archived copy differs from the transcript (the
    /// transcript was used).
    pub archive_differs: Vec<u32>,
}

impl SourceTurns {
    pub fn from_archive(&self) -> Vec<u32> {
        let mut v: Vec<u32> = self
            .origins
            .iter()
            .filter(|(_, o)| **o == Origin::Archive)
            .map(|(n, _)| *n)
            .collect();
        v.sort_unstable();
        v
    }
}

/// Ranges of consecutive numbers.
pub fn ranges(nums: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for &n in nums {
        match out.last_mut() {
            Some((_, b)) if *b + 1 == n => *b = n,
            _ => out.push((n, n)),
        }
    }
    out
}

pub fn ranges_text(r: &[(u32, u32)]) -> String {
    r.iter()
        .map(|(a, b)| {
            if a == b {
                format!("turn {}", a)
            } else {
                format!("turns {}-{}", a, b)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Original messages of turns `from..=to`: from the transcript, else from
/// the archive; what is in neither is reported in `missing`.
pub fn load_source_turns(conn: &Connection, session_key: &str, from: u32, to: u32) -> SourceTurns {
    let mut out = SourceTurns::default();
    if to < from || from == 0 {
        return out;
    }
    let messages = crate::db::load_session_messages_raw(conn, session_key).unwrap_or_default();
    let index = turn_index(&messages);
    let archived: HashMap<u32, Vec<Message>> = super::load_turns(conn, session_key, from, to)
        .into_iter()
        .collect();
    let mut missing = Vec::new();
    for n in from..=to {
        match index.get((n - 1) as usize) {
            Some(t) => {
                let msgs = messages[t.start..t.end].to_vec();
                if let Some(a) = archived.get(&n) {
                    if hash_msgs(n, a) != t.hash {
                        out.archive_differs.push(n);
                    }
                }
                out.origins.insert(n, Origin::Transcript);
                out.turns.push((n, msgs));
            }
            None => match archived.get(&n) {
                Some(a) => {
                    out.origins.insert(n, Origin::Archive);
                    out.turns.push((n, a.clone()));
                }
                None => missing.push(n),
            },
        }
    }
    out.missing = ranges(&missing);
    out
}

/// Deterministic coverage of a memory against its chat (no model): which
/// turns the summary covers, whether its segments tile them exactly, whether
/// every decision and item points at a turn that exists, and whether the
/// originals of the summarized turns can still be read.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub ok: bool,
    pub through_turn: u32,
    pub transcript_turns: u32,
    /// Turns after the summary that reach the model as originals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsummarized: Option<(u32, u32)>,
    /// Summarized turns no segment covers.
    pub gaps: Vec<(u32, u32)>,
    /// Turns covered by more than one segment.
    pub overlaps: Vec<(u32, u32)>,
    /// Segment turns past the end of the summary.
    pub beyond_summary: Vec<(u32, u32)>,
    /// Decisions with no source turn, or one past the summary.
    pub decisions_without_source: Vec<String>,
    /// Items (with known turns) whose source turn is past the summary. Items
    /// carried over from the old list format have no turns and are counted
    /// in `legacy_items`, not here.
    pub items_without_source: Vec<String>,
    pub legacy_items: usize,
    /// Summarized turns whose originals are found nowhere.
    pub originals_missing: Vec<(u32, u32)>,
    /// Summarized turns read from the archive only.
    pub archive_only: Vec<(u32, u32)>,
    /// Turns whose archived copy differs from the transcript.
    pub archive_differs: Vec<u32>,
    pub problems: Vec<String>,
}

pub fn coverage(conn: &Connection, session_key: &str, mem: &TurnMemory) -> Coverage {
    let messages = crate::db::load_session_messages_raw(conn, session_key).unwrap_or_default();
    let transcript_turns = split_turns(&messages).len() as u32;
    let src = if mem.through_turn > 0 {
        load_source_turns(conn, session_key, 1, mem.through_turn)
    } else {
        SourceTurns::default()
    };
    coverage_of(mem, transcript_turns, &src)
}

/// `coverage` from loaded parts (pure; tested directly).
pub fn coverage_of(mem: &TurnMemory, transcript_turns: u32, src: &SourceTurns) -> Coverage {
    let through = mem.through_turn;
    let mut c = Coverage {
        through_turn: through,
        transcript_turns,
        legacy_items: 0,
        ..Default::default()
    };
    if transcript_turns > through {
        c.unsummarized = Some((through + 1, transcript_turns));
    }
    let mut times: HashMap<u32, u32> = HashMap::new();
    let mut beyond = BTreeSet::new();
    for s in &mem.segments {
        for t in s.from_turn.max(1)..=s.to_turn {
            if t > through {
                beyond.insert(t);
            } else {
                *times.entry(t).or_default() += 1;
            }
        }
    }
    let gaps: Vec<u32> = (1..=through).filter(|t| !times.contains_key(t)).collect();
    let mut over: Vec<u32> = times
        .iter()
        .filter(|(_, n)| **n > 1)
        .map(|(t, _)| *t)
        .collect();
    over.sort_unstable();
    c.gaps = ranges(&gaps);
    c.overlaps = ranges(&over);
    c.beyond_summary = ranges(&beyond.into_iter().collect::<Vec<_>>());
    for d in mem
        .decisions
        .current
        .iter()
        .chain(mem.decisions.superseded.iter())
    {
        if d.turn == 0 || d.turn > through {
            c.decisions_without_source.push(d.id.clone());
        }
    }
    for it in &mem.items {
        if it.source_turns.is_empty() {
            c.legacy_items += 1;
        } else if it.source_turns.iter().any(|t| *t == 0 || *t > through) {
            c.items_without_source.push(it.id.clone());
        }
    }
    c.originals_missing = src.missing.clone();
    c.archive_only = ranges(&src.from_archive());
    c.archive_differs = src.archive_differs.clone();
    if through > transcript_turns && c.archive_only.is_empty() && c.originals_missing.is_empty() {
        // Cannot happen with a loaded source, but keep the check honest.
        c.problems.push(format!(
            "the summary ends at turn {} but the transcript has {} turns",
            through, transcript_turns
        ));
    }
    if !c.gaps.is_empty() {
        c.problems
            .push(format!("no segment covers {}", ranges_text(&c.gaps)));
    }
    if !c.overlaps.is_empty() {
        c.problems.push(format!(
            "{} covered by more than one segment",
            ranges_text(&c.overlaps)
        ));
    }
    if !c.beyond_summary.is_empty() {
        c.problems.push(format!(
            "segments name {} past the summary",
            ranges_text(&c.beyond_summary)
        ));
    }
    if !c.decisions_without_source.is_empty() {
        c.problems.push(format!(
            "decisions without a source turn: {}",
            c.decisions_without_source.join(", ")
        ));
    }
    if !c.items_without_source.is_empty() {
        c.problems.push(format!(
            "items without a source turn: {}",
            c.items_without_source.join(", ")
        ));
    }
    if !c.originals_missing.is_empty() {
        c.problems.push(format!(
            "the originals of {} are not stored",
            ranges_text(&c.originals_missing)
        ));
    }
    // Archive-only and differing copies are informational: the transcript
    // is the source of truth and the archive is a fallback.
    c.ok = c.problems.is_empty();
    c
}

/// Context from before turn 1 that is not this memory: a session summary an
/// older build's compaction wrote into the transcript (W-1 keeps it). The
/// model sees it in full; the memory screen shows that it is there.
pub fn legacy_context(messages: &[Message]) -> Option<serde_json::Value> {
    let first = messages
        .iter()
        .position(|m| m.is_user_prompt())
        .unwrap_or(messages.len());
    let pre: Vec<String> = messages[..first]
        .iter()
        .filter(|m| !super::is_memory_message(m))
        .map(|m| m.text())
        .filter(|t| !t.trim().is_empty())
        .collect();
    if pre.is_empty() {
        return None;
    }
    let text = pre.join("\n\n");
    let preview: String = text.chars().take(600).collect();
    Some(
        serde_json::json!({ "messages": pre.len(), "chars": text.chars().count(), "preview": preview, "truncated": text.chars().count() > 600 }),
    )
}
