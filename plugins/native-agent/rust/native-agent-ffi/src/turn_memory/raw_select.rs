//! Raw-vs-summary selection for summarized turns.
//!
//! When turns are summarized, their range summary replaces them in the
//! request by default. The original turns are never lost (the stored
//! transcript keeps every message, tool call and result), and this module
//! lets the user (or the agent) choose, per chat:
//!
//! * per range: `summary` (default), `raw` (send the original turns and leave
//!   the range summary out) or `both` (send the original turns and keep the
//!   summary);
//! * per turn: send one original turn beside its range's summary.
//!
//! The choice is stored as one row per chat. [`plan`] turns it into the list
//! of original turns to put back in the request (in turn order) and the
//! ranges whose summary is left out of the memory block. The fold
//! (`memory_loop`) applies the plan; the context tree numbers the restored
//! turns by their real turn numbers (`wiring::TurnNumbers`), so excluding a
//! turn or a tool call never hits the wrong turn.

use super::TurnMemory;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS memory_raw_select (
    session_key TEXT PRIMARY KEY,
    selection   TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);";

/// Most original turns restored at once, so a stray "raw" on a huge range
/// cannot blow the request up. The newest ones win.
pub const MAX_RAW_TURNS: usize = 120;

pub const SUMMARY: &str = "summary";
pub const RAW: &str = "raw";
pub const BOTH: &str = "both";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RangeChoice {
    pub from_turn: u32,
    pub to_turn: u32,
    /// "summary", "raw" or "both".
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RawSelection {
    pub ranges: Vec<RangeChoice>,
    /// Single summarized turns sent as written, beside their range summary.
    pub turns: Vec<u32>,
    pub updated_at: i64,
}

/// What the fold does with a selection against the current memory.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawPlan {
    /// Original turns to restore, ascending, all within `1..=through_turn`.
    pub raw_turns: Vec<u32>,
    /// Ranges whose summary is left out of the memory block.
    pub skip_ranges: Vec<[u32; 2]>,
    /// Turns asked for but dropped by [`MAX_RAW_TURNS`].
    pub capped: usize,
}

impl RawPlan {
    pub fn is_empty(&self) -> bool {
        self.raw_turns.is_empty() && self.skip_ranges.is_empty()
    }
}

pub fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn load(conn: &Connection, session_key: &str) -> RawSelection {
    if ensure_schema(conn).is_err() {
        return RawSelection::default();
    }
    conn.query_row(
        "SELECT selection FROM memory_raw_select WHERE session_key = ?1",
        params![session_key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or_default()
}

pub fn save(conn: &Connection, session_key: &str, sel: &RawSelection) -> Result<()> {
    ensure_schema(conn)?;
    if sel.ranges.is_empty() && sel.turns.is_empty() {
        conn.execute(
            "DELETE FROM memory_raw_select WHERE session_key = ?1",
            params![session_key],
        )?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO memory_raw_select (session_key, selection, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(session_key) DO UPDATE SET selection = excluded.selection, updated_at = excluded.updated_at",
        params![session_key, serde_json::to_string(sel)?, sel.updated_at],
    )?;
    Ok(())
}

pub fn clear(conn: &Connection, session_key: &str) -> Result<()> {
    ensure_schema(conn)?;
    conn.execute(
        "DELETE FROM memory_raw_select WHERE session_key = ?1",
        params![session_key],
    )?;
    Ok(())
}

/// Set one range's mode. A mode of "summary" removes the choice.
pub fn set_range(sel: &mut RawSelection, from: u32, to: u32, mode: &str) {
    sel.ranges
        .retain(|r| !(r.from_turn == from && r.to_turn == to));
    if mode == RAW || mode == BOTH {
        sel.ranges.push(RangeChoice {
            from_turn: from,
            to_turn: to,
            mode: mode.to_string(),
        });
        sel.ranges.sort_by_key(|r| (r.from_turn, r.to_turn));
    }
}

/// Send (or stop sending) one original turn.
pub fn set_turn(sel: &mut RawSelection, turn: u32, raw: bool) {
    sel.turns.retain(|t| *t != turn);
    if raw && turn > 0 {
        sel.turns.push(turn);
        sel.turns.sort_unstable();
    }
}

/// The mode of the range `[from, to]` ("summary" when none was chosen).
pub fn range_mode<'a>(sel: &'a RawSelection, from: u32, to: u32) -> &'a str {
    sel.ranges
        .iter()
        .find(|r| r.from_turn == from && r.to_turn == to)
        .map(|r| r.mode.as_str())
        .unwrap_or(SUMMARY)
}

/// Resolve a selection against the memory. Choices for ranges that no longer
/// exist (after a revert or a reset) and turns past `through_turn` are
/// ignored, so a stale choice can never restore a turn that is already in
/// the view or drop a summary it does not name.
pub fn plan(mem: &TurnMemory, sel: &RawSelection) -> RawPlan {
    let mut turns: BTreeSet<u32> = BTreeSet::new();
    let mut skip = Vec::new();
    for s in &mem.segments {
        match range_mode(sel, s.from_turn, s.to_turn) {
            RAW => {
                skip.push([s.from_turn, s.to_turn]);
                turns.extend(s.from_turn..=s.to_turn);
            }
            BOTH => turns.extend(s.from_turn..=s.to_turn),
            _ => {}
        }
    }
    turns.extend(sel.turns.iter().copied());
    let mut raw: Vec<u32> = turns
        .into_iter()
        .filter(|t| *t >= 1 && *t <= mem.through_turn)
        .collect();
    let capped = raw.len().saturating_sub(MAX_RAW_TURNS);
    if capped > 0 {
        raw.drain(..capped);
    }
    RawPlan {
        raw_turns: raw,
        skip_ranges: skip,
        capped,
    }
}

/// The memory the block is selected from: the same records, without the
/// summaries of the ranges sent raw.
pub fn block_memory(mem: &TurnMemory, plan: &RawPlan) -> TurnMemory {
    if plan.skip_ranges.is_empty() {
        return mem.clone();
    }
    let mut m = mem.clone();
    m.segments
        .retain(|s| !plan.skip_ranges.contains(&[s.from_turn, s.to_turn]));
    m
}

#[cfg(test)]
mod tests {
    use super::super::{Segment, TurnMemory};
    use super::*;

    fn mem() -> TurnMemory {
        let seg = |a: u32, b: u32| Segment {
            from_turn: a,
            to_turn: b,
            summary: "s".into(),
            ..Default::default()
        };
        TurnMemory {
            through_turn: 9,
            segments: vec![seg(1, 3), seg(4, 6), seg(7, 9)],
            ..Default::default()
        }
    }

    #[test]
    fn summary_is_the_default() {
        let p = plan(&mem(), &RawSelection::default());
        assert!(p.is_empty());
        assert_eq!(block_memory(&mem(), &p).segments.len(), 3);
    }

    #[test]
    fn raw_range_restores_its_turns_and_drops_its_summary() {
        let mut sel = RawSelection::default();
        set_range(&mut sel, 4, 6, RAW);
        let p = plan(&mem(), &sel);
        assert_eq!(p.raw_turns, vec![4, 5, 6]);
        assert_eq!(p.skip_ranges, vec![[4, 6]]);
        let b = block_memory(&mem(), &p);
        assert_eq!(
            b.segments.iter().map(|s| s.from_turn).collect::<Vec<_>>(),
            vec![1, 7]
        );
    }

    #[test]
    fn both_keeps_the_summary_and_single_turns_merge_in_order() {
        let mut sel = RawSelection::default();
        set_range(&mut sel, 7, 9, BOTH);
        set_turn(&mut sel, 2, true);
        set_turn(&mut sel, 8, true);
        let p = plan(&mem(), &sel);
        assert_eq!(p.raw_turns, vec![2, 7, 8, 9]);
        assert!(p.skip_ranges.is_empty());
        set_range(&mut sel, 7, 9, SUMMARY);
        set_turn(&mut sel, 8, false);
        assert_eq!(plan(&mem(), &sel).raw_turns, vec![2]);
    }

    #[test]
    fn stale_choices_are_ignored() {
        let mut sel = RawSelection::default();
        set_range(&mut sel, 1, 5, RAW); // no such range
        set_turn(&mut sel, 12, true); // not summarized yet
        assert!(plan(&mem(), &sel).is_empty());
    }

    #[test]
    fn selection_round_trips_through_the_table() {
        let conn = Connection::open_in_memory().unwrap();
        let mut sel = RawSelection {
            updated_at: 5,
            ..Default::default()
        };
        set_range(&mut sel, 1, 3, BOTH);
        set_turn(&mut sel, 5, true);
        save(&conn, "k", &sel).unwrap();
        assert_eq!(load(&conn, "k"), sel);
        assert_eq!(load(&conn, "other"), RawSelection::default());
        clear(&conn, "k").unwrap();
        assert_eq!(load(&conn, "k"), RawSelection::default());
    }
}
