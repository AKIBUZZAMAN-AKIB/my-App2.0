//! Goal lifecycle (G001, G002, …): persistent goals with a status, kept in
//! their own tables and not in the rolling summary, so a goal can change on
//! any turn without waiting for the 7+7 fold.
//!
//! Every change is an event with the turn it comes from, who proposed it
//! (`user_command`: the deterministic detector below, run on each new user
//! message; `summary`: a `goalOps` entry from the summarizer, accepted only
//! when its quoted evidence is in that turn's user text; `migration`: the
//! old free-text goal) and the evidence. Statuses and `current_goal_id` are a
//! deterministic replay of the events in turn order, so an event found late
//! (a fold reads turns 1-7 after turn 16 already switched goals) lands in its
//! place in history and cannot overwrite a newer state. A proposal that would
//! make the history invalid (resume a cancelled goal, complete one twice) is
//! rejected and nothing is written (ADR-A5: no unvalidated writes, never a
//! model tool call).
//!
//! Rules (task 2): a new goal pauses the active one; switching or resuming
//! activates an existing goal by its ID (no duplicate) and pauses the active
//! one; complete / cancel / supersede are distinct terminal statuses, set only
//! from explicit words, never because the topic changed; there is at most one
//! active goal and it is the current one. Goals are never deleted; a rewind
//! voids the events of removed turns (kept, marked) and replays.

use super::TurnMemory;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const ACTIVE: &str = "active";
pub const PAUSED: &str = "paused";
pub const COMPLETED: &str = "completed";
pub const CANCELLED: &str = "cancelled";
pub const SUPERSEDED: &str = "superseded";

pub const ORIGIN_USER: &str = "user_command";
pub const ORIGIN_SUMMARY: &str = "summary";
pub const ORIGIN_MIGRATION: &str = "migration";
/// The user changed it on the Goals tab of the app.
pub const ORIGIN_APP: &str = "user_app";

const MAX_TITLE_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 400;
const MAX_EVIDENCE_CHARS: usize = 300;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub goal_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// The user turn the goal comes from (0: unknown, e.g. migrated).
    #[serde(default)]
    pub source_turn: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    /// Only provenance that has no column: `supersededBy`, `migratedFrom`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

impl Goal {
    pub fn is_open(&self) -> bool {
        self.status == ACTIVE || self.status == PAUSED
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalEvent {
    pub seq: i64,
    pub goal_id: String,
    /// create | switch | resume | complete | cancel | supersede | update
    pub op: String,
    pub turn: u32,
    pub at_ms: i64,
    pub origin: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// supersede: the goal that replaces this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub related: Option<String>,
}

/// Goals with their replayed statuses, the current goal and which goal was
/// current after each turn that changed it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub goals: Vec<Goal>,
    pub current_goal_id: Option<String>,
    /// `(turn, current goal after that turn's events)`, in turn order.
    #[serde(skip)]
    pub timeline: Vec<(u32, Option<String>)>,
    #[serde(skip)]
    pub events: Vec<GoalEvent>,
}

impl GoalState {
    pub fn get(&self, id: &str) -> Option<&Goal> {
        self.goals.iter().find(|g| g.goal_id == id)
    }
    pub fn current(&self) -> Option<&Goal> {
        self.current_goal_id
            .as_deref()
            .and_then(|id| self.get(id))
            .filter(|g| g.status == ACTIVE)
    }
    /// The goal that was current when `turn` was written: the state after
    /// every event of that turn and before. None when no goal was active.
    pub fn goal_at(&self, turn: u32) -> Option<String> {
        if turn == 0 {
            return None;
        }
        self.timeline
            .iter()
            .take_while(|(t, _)| *t <= turn)
            .last()
            .and_then(|(_, g)| g.clone())
    }
}

fn clip(s: &str, max: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max {
        return t;
    }
    let mut out: String = t.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn goal_no(id: &str) -> Option<u32> {
    id.strip_prefix('G').and_then(|d| d.parse().ok())
}

pub fn goal_id(n: u32) -> String {
    format!("G{:03}", n)
}

// ── Replay ──────────────────────────────────────────────────────────────────

/// Rebuild statuses from events (sorted by turn, then insertion order).
/// Any invalid transition is an error naming the event.
pub fn replay(events: &[GoalEvent]) -> Result<GoalState, String> {
    let mut evs: Vec<&GoalEvent> = events.iter().collect();
    evs.sort_by_key(|e| (e.turn, e.seq));
    let mut goals: Vec<Goal> = Vec::new();
    let mut current: Option<String> = None;
    let mut timeline: Vec<(u32, Option<String>)> = Vec::new();
    for e in evs {
        let pos = goals.iter().position(|g| g.goal_id == e.goal_id);
        let pause_current =
            |goals: &mut Vec<Goal>, current: &Option<String>, except: &str, at: i64| {
                if let Some(c) = current {
                    if c != except {
                        if let Some(g) = goals
                            .iter_mut()
                            .find(|g| &g.goal_id == c && g.status == ACTIVE)
                        {
                            g.status = PAUSED.into();
                            g.updated_at = at;
                        }
                    }
                }
            };
        match e.op.as_str() {
            "create" => {
                if pos.is_some() {
                    return Err(format!("{} already exists (event {})", e.goal_id, e.seq));
                }
                if goal_no(&e.goal_id).is_none() || e.title.trim().is_empty() {
                    return Err(format!(
                        "create needs a G-number and a title (event {})",
                        e.seq
                    ));
                }
                pause_current(&mut goals, &current, &e.goal_id, e.at_ms);
                let metadata = (e.origin == ORIGIN_MIGRATION)
                    .then(|| serde_json::json!({ "migratedFrom": e.evidence }));
                goals.push(Goal {
                    goal_id: e.goal_id.clone(),
                    title: e.title.clone(),
                    description: e.description.clone(),
                    status: ACTIVE.into(),
                    created_at: e.at_ms,
                    updated_at: e.at_ms,
                    source_turn: e.turn,
                    completed_at: None,
                    metadata,
                });
                current = Some(e.goal_id.clone());
            }
            "switch" | "resume" => {
                let Some(i) = pos else {
                    return Err(format!(
                        "{} {} does not exist (event {})",
                        e.op, e.goal_id, e.seq
                    ));
                };
                if !goals[i].is_open() {
                    return Err(format!(
                        "{} is {}; it cannot be resumed (event {})",
                        e.goal_id, goals[i].status, e.seq
                    ));
                }
                pause_current(&mut goals, &current, &e.goal_id, e.at_ms);
                let g = &mut goals[i];
                if g.status != ACTIVE {
                    g.status = ACTIVE.into();
                    g.updated_at = e.at_ms;
                }
                current = Some(e.goal_id.clone());
            }
            "complete" | "cancel" | "supersede" => {
                let Some(i) = pos else {
                    return Err(format!(
                        "{} {} does not exist (event {})",
                        e.op, e.goal_id, e.seq
                    ));
                };
                if !goals[i].is_open() {
                    return Err(format!(
                        "{} is already {} (event {})",
                        e.goal_id, goals[i].status, e.seq
                    ));
                }
                let replacement =
                    if e.op == "supersede" {
                        let Some(by) = e.related.as_deref().filter(|by| {
                            *by != e.goal_id && goals.iter().any(|g| g.goal_id == *by)
                        }) else {
                            return Err(format!(
                                "supersede of {} names no earlier goal that replaces it (event {})",
                                e.goal_id, e.seq
                            ));
                        };
                        Some(by.to_string())
                    } else {
                        None
                    };
                let g = &mut goals[i];
                g.status = match e.op.as_str() {
                    "complete" => COMPLETED,
                    "cancel" => CANCELLED,
                    _ => SUPERSEDED,
                }
                .into();
                g.updated_at = e.at_ms;
                if e.op == "complete" {
                    g.completed_at = Some(e.at_ms);
                }
                if let Some(by) = &replacement {
                    let mut meta = g.metadata.clone().unwrap_or_else(|| serde_json::json!({}));
                    meta["supersededBy"] = serde_json::json!(by);
                    g.metadata = Some(meta);
                }
                if current.as_deref() == Some(e.goal_id.as_str()) {
                    // Never activate another goal on the user's behalf, except
                    // the one they said replaces it.
                    current = replacement
                        .filter(|by| goals.iter().any(|g| &g.goal_id == by && g.status == ACTIVE));
                }
            }
            "update" => {
                let Some(i) = pos else {
                    return Err(format!(
                        "update {} does not exist (event {})",
                        e.goal_id, e.seq
                    ));
                };
                let g = &mut goals[i];
                if !e.title.trim().is_empty() {
                    g.title = e.title.clone();
                }
                if !e.description.trim().is_empty() {
                    g.description = e.description.clone();
                }
                g.updated_at = e.at_ms;
            }
            other => return Err(format!("unknown goal op {:?} (event {})", other, e.seq)),
        }
        match timeline.last_mut() {
            Some((t, c)) if *t == e.turn => *c = current.clone(),
            _ => timeline.push((e.turn, current.clone())),
        }
    }
    debug_assert!(goals.iter().filter(|g| g.status == ACTIVE).count() <= 1);
    goals.sort_by_key(|g| goal_no(&g.goal_id).unwrap_or(u32::MAX));
    Ok(GoalState {
        goals,
        current_goal_id: current,
        timeline,
        events: events.to_vec(),
    })
}

// ── Storage ─────────────────────────────────────────────────────────────────

/// Tables (schema v6). `memory_goal_events` is the record; `memory_goals` and
/// `memory_goal_state` are its replay, rewritten in the same transaction.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS memory_goals (
        session_key TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source_turn INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        metadata_json TEXT,
        PRIMARY KEY (session_key, goal_id)
    );
    CREATE TABLE IF NOT EXISTS memory_goal_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        op TEXT NOT NULL,
        turn INTEGER NOT NULL,
        at_ms INTEGER NOT NULL,
        origin TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        related TEXT,
        voided_at INTEGER,
        void_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS memory_goal_events_by_turn ON memory_goal_events (session_key, turn, seq);
    CREATE TABLE IF NOT EXISTS memory_goal_state (
        session_key TEXT PRIMARY KEY,
        current_goal_id TEXT,
        last_detected_turn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
    );
";

fn load_events(conn: &Connection, key: &str) -> rusqlite::Result<Vec<GoalEvent>> {
    let mut st = conn.prepare(
        "SELECT seq, goal_id, op, turn, at_ms, origin, evidence, title, description, related
         FROM memory_goal_events WHERE session_key = ?1 AND voided_at IS NULL ORDER BY turn, seq",
    )?;
    let rows = st.query_map([key], |r| {
        Ok(GoalEvent {
            seq: r.get(0)?,
            goal_id: r.get(1)?,
            op: r.get(2)?,
            turn: r.get::<_, i64>(3)?.max(0) as u32,
            at_ms: r.get(4)?,
            origin: r.get(5)?,
            evidence: r.get(6)?,
            title: r.get(7)?,
            description: r.get(8)?,
            related: r.get(9)?,
        })
    })?;
    rows.collect()
}

/// The goals of a chat. Reads the materialized rows only when the events
/// cannot be replayed (never expected; kept so the UI still shows them).
pub fn load_state(conn: &Connection, key: &str) -> GoalState {
    if super::store::ensure_tables(conn).is_err() {
        return GoalState::default();
    }
    match load_events(conn, key)
        .map_err(|e| e.to_string())
        .and_then(|e| replay(&e))
    {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "goal events of {} do not replay ({}); showing the stored rows",
                key,
                e
            );
            load_materialized(conn, key)
        }
    }
}

/// The replayed goals inside an open transaction (no table check; empty
/// when the events cannot be read or replayed).
pub(crate) fn state_in(tx: &Connection, key: &str) -> GoalState {
    load_events(tx, key)
        .ok()
        .and_then(|e| replay(&e).ok())
        .unwrap_or_default()
}

fn load_materialized(conn: &Connection, key: &str) -> GoalState {
    let goals = conn
        .prepare("SELECT goal_id, title, description, status, created_at, updated_at, source_turn, completed_at, metadata_json FROM memory_goals WHERE session_key = ?1")
        .and_then(|mut st| {
            st.query_map([key], |r| {
                Ok(Goal {
                    goal_id: r.get(0)?,
                    title: r.get(1)?,
                    description: r.get(2)?,
                    status: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    source_turn: r.get::<_, i64>(6)?.max(0) as u32,
                    completed_at: r.get(7)?,
                    metadata: r.get::<_, Option<String>>(8)?.and_then(|s| serde_json::from_str(&s).ok()),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();
    let current = conn
        .query_row(
            "SELECT current_goal_id FROM memory_goal_state WHERE session_key = ?1",
            [key],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    GoalState {
        goals,
        current_goal_id: current,
        ..Default::default()
    }
}

fn persist(tx: &Connection, key: &str, st: &GoalState, now: i64) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM memory_goals WHERE session_key = ?1", [key])?;
    for g in &st.goals {
        tx.execute(
            "INSERT INTO memory_goals (session_key, goal_id, title, description, status, created_at, updated_at, source_turn, completed_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![key, g.goal_id, g.title, g.description, g.status, g.created_at, g.updated_at, g.source_turn as i64, g.completed_at, g.metadata.as_ref().map(|m| m.to_string())],
        )?;
    }
    tx.execute(
        "INSERT INTO memory_goal_state (session_key, current_goal_id, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(session_key) DO UPDATE SET current_goal_id = excluded.current_goal_id, updated_at = excluded.updated_at",
        params![key, st.current_goal_id, now],
    )?;
    Ok(())
}

fn insert_event(tx: &Connection, key: &str, e: &GoalEvent) -> rusqlite::Result<i64> {
    tx.execute(
        "INSERT INTO memory_goal_events (session_key, goal_id, op, turn, at_ms, origin, evidence, title, description, related)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![key, e.goal_id, e.op, e.turn as i64, e.at_ms, e.origin, e.evidence, e.title, e.description, e.related],
    )?;
    Ok(tx.last_insert_rowid())
}

// ── Proposals ───────────────────────────────────────────────────────────────

/// A proposed change, from the detector or the summarizer. `target` is a
/// goal ID or words naming a goal; for complete/cancel without a target the
/// current goal is meant.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    /// create | switch | resume | complete | cancel | supersede
    pub op: String,
    pub target: Option<String>,
    pub title: String,
    pub description: String,
    pub turn: u32,
    pub origin: String,
    pub evidence: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub op: String,
    pub goal_id: Option<String>,
    pub applied: bool,
    pub note: String,
    pub turn: u32,
    pub origin: String,
}

fn norm(s: &str) -> String {
    let mapped: String = bn_norm(s)
        .chars()
        .map(|c| {
            if c.is_ascii_punctuation() || "।॥—–“”‘’…«»".contains(c) {
                ' '
            } else {
                c.to_lowercase().next().unwrap_or(c)
            }
        })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

const STOP: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "our",
    "this",
    "that",
    "goal",
    "work",
    "working",
    "back",
    "let's",
    "lets",
    "again",
    "task",
    "project",
    "নিয়ে",
    "কাজ",
    "কাজে",
    "আবার",
    "লক্ষ্য",
];

fn words(s: &str) -> Vec<String> {
    norm(s)
        .split(' ')
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(w))
        .map(str::to_string)
        .collect()
}

fn ids_in(s: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\b[Gg](\d{1,5})\b").unwrap());
    re.captures_iter(s)
        .filter_map(|c| c[1].parse::<u32>().ok())
        .map(goal_id)
        .collect()
}

/// The goal `target` names: a G-number, else the goal whose title the words
/// match best (at least half of its significant words, a unique best).
/// `Ok(None)`: nothing matches; `Err`: ambiguous or unknown ID.
pub fn resolve<'a>(st: &'a GoalState, target: &str) -> Result<Option<&'a Goal>, String> {
    let ids = ids_in(target);
    if let Some(id) = ids.first() {
        return st
            .get(id)
            .map(Some)
            .ok_or_else(|| format!("there is no goal {}", id));
    }
    let t = norm(target);
    if t.chars().count() < 3 {
        return Ok(None);
    }
    let mut scored: Vec<(f32, &Goal)> = Vec::new();
    for g in &st.goals {
        let title = norm(&g.title);
        let score = if !title.is_empty()
            && (t.contains(&title) || (title.contains(&t) && t.chars().count() >= 4))
        {
            2.0
        } else {
            let ws = words(&g.title);
            if ws.is_empty() {
                0.0
            } else {
                let hit = ws.iter().filter(|w| t.contains(w.as_str())).count();
                let r = hit as f32 / ws.len() as f32;
                if hit >= 1 && r >= 0.5 {
                    r
                } else {
                    0.0
                }
            }
        };
        if score > 0.0 {
            scored.push((score, g));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    match scored.as_slice() {
        [] => Ok(None),
        [(_, g)] => Ok(Some(*g)),
        [(a, g), (b, h), ..] => {
            if a > b {
                Ok(Some(*g))
            } else {
                Err(format!(
                    "\"{}\" could mean {} or {}",
                    clip(target, 40),
                    g.goal_id,
                    h.goal_id
                ))
            }
        }
    }
}

/// Turn one proposal into events against the state, without writing.
fn plan(st: &GoalState, p: &Proposal, now: i64) -> Result<Vec<GoalEvent>, String> {
    let next_id = || {
        goal_id(
            st.goals
                .iter()
                .filter_map(|g| goal_no(&g.goal_id))
                .max()
                .unwrap_or(0)
                + 1,
        )
    };
    let ev = |goal: &str, op: &str| GoalEvent {
        goal_id: goal.into(),
        op: op.into(),
        turn: p.turn,
        at_ms: now,
        origin: p.origin.clone(),
        evidence: clip(&p.evidence, MAX_EVIDENCE_CHARS),
        ..Default::default()
    };
    let found = match p.target.as_deref() {
        Some(t) if !t.trim().is_empty() => resolve(st, t)?,
        _ => None,
    };
    match p.op.as_str() {
        "create" | "switch" => {
            // Words that name an open goal mean that goal (no duplicate).
            // A new title names an open goal only when it is that goal's
            // title (normalized); similar words are a new goal.
            let same_title = || {
                st.goals
                    .iter()
                    .find(|g| !p.title.trim().is_empty() && norm(&g.title) == norm(&p.title))
            };
            let named = found.or_else(same_title).filter(|g| g.is_open());
            if let Some(g) = named {
                if st.current_goal_id.as_deref() == Some(g.goal_id.as_str()) {
                    return Err(format!("{} is already the active goal", g.goal_id));
                }
                return Ok(vec![ev(
                    &g.goal_id,
                    if p.op == "create" { "resume" } else { "switch" },
                )]);
            }
            if p.op == "switch" && p.title.trim().is_empty() {
                return Err("switch names no goal".into());
            }
            let title = clip(
                if p.title.trim().is_empty() {
                    p.target.as_deref().unwrap_or_default()
                } else {
                    &p.title
                },
                MAX_TITLE_CHARS,
            );
            if title.is_empty() {
                return Err("a new goal needs a title".into());
            }
            let mut e = ev(&next_id(), "create");
            e.title = title;
            e.description = clip(&p.description, MAX_DESCRIPTION_CHARS);
            Ok(vec![e])
        }
        "resume" => {
            let g = found.ok_or_else(|| "resume names no known goal".to_string())?;
            if st.current_goal_id.as_deref() == Some(g.goal_id.as_str()) && g.status == ACTIVE {
                return Err(format!("{} is already the active goal", g.goal_id));
            }
            Ok(vec![ev(&g.goal_id, "resume")])
        }
        "complete" | "cancel" => {
            let g = match found {
                Some(g) => g,
                None if p.target.as_deref().is_none_or(|t| t.trim().is_empty()) => st
                    .current()
                    .ok_or_else(|| "there is no active goal".to_string())?,
                None => return Err("the goal named is not known".into()),
            };
            Ok(vec![ev(&g.goal_id, &p.op)])
        }
        "supersede" => {
            let old = match found {
                Some(g) => g,
                None => st
                    .current()
                    .ok_or_else(|| "there is no active goal to replace".to_string())?,
            };
            let title = clip(&p.title, MAX_TITLE_CHARS);
            if title.is_empty() {
                return Err("the replacing goal needs a title".into());
            }
            let new_id = next_id();
            let mut create = ev(&new_id, "create");
            create.title = title;
            create.description = clip(&p.description, MAX_DESCRIPTION_CHARS);
            let mut sup = ev(&old.goal_id, "supersede");
            sup.related = Some(new_id);
            Ok(vec![create, sup])
        }
        other => Err(format!("unknown goal op {:?}", other)),
    }
}

/// The same change already recorded (a retried turn, or the detector and the
/// summarizer seeing the same words).
///
/// A change made on the Goals tab is a deliberate click, never a repeat of
/// the words of a turn: all of them share the newest turn number, so without
/// this a "resume" after a "create" in the same turn would be dropped.
fn duplicate(st: &GoalState, e: &GoalEvent) -> bool {
    if e.origin == ORIGIN_APP {
        return false;
    }
    st.events.iter().any(|x| {
        x.turn == e.turn
            && (x.goal_id == e.goal_id
                || (e.op == "create" && x.op == "create" && norm(&x.title) == norm(&e.title)))
            && (x.op == e.op
                || (matches!(x.op.as_str(), "create" | "switch" | "resume")
                    && matches!(e.op.as_str(), "switch" | "resume")))
    })
}

/// Validate and record proposals in one transaction. Each one is planned
/// against the state left by the previous ones and kept only when the whole
/// history still replays; rejected ones change nothing and say why.
pub fn apply(
    conn: &Connection,
    key: &str,
    proposals: &[Proposal],
    now: i64,
) -> rusqlite::Result<(Vec<Outcome>, GoalState)> {
    super::store::ensure_tables(conn)?;
    super::store::write_tx(conn, |tx| {
        let mut events = load_events(tx, key)?;
        let mut st = replay(&events).unwrap_or_default();
        let mut out = Vec::new();
        let mut changed = false;
        for p in proposals {
            let mut o = Outcome {
                op: p.op.clone(),
                turn: p.turn,
                origin: p.origin.clone(),
                ..Default::default()
            };
            match plan(&st, p, now) {
                Err(why) => o.note = why,
                Ok(evs) => {
                    if evs.iter().all(|e| duplicate(&st, e)) {
                        o.goal_id = evs.first().map(|e| e.goal_id.clone());
                        o.note = "already recorded".into();
                    } else {
                        let mut trial = events.clone();
                        let base_seq = trial.iter().map(|e| e.seq).max().unwrap_or(0);
                        for (i, e) in evs.iter().enumerate() {
                            let mut e = e.clone();
                            e.seq = base_seq + 1 + i as i64;
                            trial.push(e);
                        }
                        match replay(&trial) {
                            Err(why) => o.note = why,
                            Ok(_) => {
                                for e in &evs {
                                    let mut e = e.clone();
                                    e.seq = insert_event(tx, key, &e)?;
                                    events.push(e);
                                }
                                st = replay(&events).unwrap_or_default();
                                o.applied = true;
                                o.goal_id = evs.first().map(|e| e.goal_id.clone());
                                o.op = evs.first().map(|e| e.op.clone()).unwrap_or_default();
                                changed = true;
                            }
                        }
                    }
                }
            }
            out.push(o);
        }
        if changed {
            persist(tx, key, &st, now)?;
        }
        Ok((out, st))
    })
}

/// Run the detector on the newest user message once per turn (a retried
/// turn is not read twice) and record what it finds.
pub fn detect_turn(
    conn: &Connection,
    key: &str,
    turn: u32,
    user_text: &str,
    now: i64,
) -> rusqlite::Result<Vec<Outcome>> {
    super::store::ensure_tables(conn)?;
    let last: u32 = conn
        .query_row(
            "SELECT last_detected_turn FROM memory_goal_state WHERE session_key = ?1",
            [key],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v.max(0) as u32)
        .unwrap_or(0);
    if turn == 0 || turn <= last {
        return Ok(Vec::new());
    }
    let proposals: Vec<Proposal> = detect(user_text)
        .into_iter()
        .map(|i| Proposal {
            op: i.op,
            target: i.target,
            title: i.title,
            description: String::new(),
            turn,
            origin: ORIGIN_USER.into(),
            evidence: i.evidence,
        })
        .collect();
    let out = if proposals.is_empty() {
        Vec::new()
    } else {
        apply(conn, key, &proposals, now)?.0
    };
    super::store::write_tx(conn, |tx| {
        tx.execute(
            "INSERT INTO memory_goal_state (session_key, current_goal_id, last_detected_turn, updated_at)
             VALUES (?1, (SELECT current_goal_id FROM memory_goal_state WHERE session_key = ?1), ?2, ?3)
             ON CONFLICT(session_key) DO UPDATE SET last_detected_turn = MAX(memory_goal_state.last_detected_turn, excluded.last_detected_turn)",
            params![key, turn as i64, now],
        )?;
        Ok::<(), rusqlite::Error>(())
    })?;
    Ok(out)
}

/// A rewind or reset removed turns after `keep_turns`: their events are
/// voided (kept, marked, no longer replayed) and the goals replayed.
pub fn void_after(
    tx: &Connection,
    key: &str,
    keep_turns: u32,
    reason: &str,
    now: i64,
) -> rusqlite::Result<usize> {
    void_from(tx, key, keep_turns as i64, reason, now)
}

/// Void every event of the chat, the schema-migration ones (turn 0)
/// included: a memory reset drops what they were derived from.
pub fn void_all(tx: &Connection, key: &str, reason: &str, now: i64) -> rusqlite::Result<usize> {
    void_from(tx, key, -1, reason, now)
}

fn void_from(
    tx: &Connection,
    key: &str,
    after_turn: i64,
    reason: &str,
    now: i64,
) -> rusqlite::Result<usize> {
    let n = tx.execute(
        "UPDATE memory_goal_events SET voided_at = ?3, void_reason = ?4 WHERE session_key = ?1 AND turn > ?2 AND voided_at IS NULL",
        params![key, after_turn, now, reason],
    )?;
    if n > 0 {
        let st = replay(&load_events(tx, key)?).unwrap_or_default();
        persist(tx, key, &st, now)?;
    }
    tx.execute("UPDATE memory_goal_state SET last_detected_turn = MIN(last_detected_turn, ?2) WHERE session_key = ?1", params![key, after_turn.max(0)])?;
    Ok(n)
}

/// Schema v6 upgrade: the free-text goal of each chat's memory becomes G001
/// (active, current), content kept word for word in the description. Its
/// source turn is unknown (0); nothing else is linked to it. Runs inside the
/// migration transaction and only for chats that have no goal yet.
pub(crate) fn migrate_legacy(tx: &Connection, now: i64) -> rusqlite::Result<usize> {
    let rows: Vec<(String, String, i64)> = {
        let mut st = tx.prepare("SELECT session_key, memory_json, updated_at FROM turn_memory")?;
        let r = st.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })?;
        r.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut n = 0;
    for (key, json, updated) in rows {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else {
            continue;
        };
        let goal = v
            .get("goal")
            .and_then(|g| g.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if goal.is_empty() {
            continue;
        }
        let has: i64 = tx.query_row(
            "SELECT COUNT(*) FROM memory_goal_events WHERE session_key = ?1",
            [&key],
            |r| r.get(0),
        )?;
        if has > 0 {
            continue;
        }
        let version = v.get("version").and_then(|x| x.as_u64()).unwrap_or(0);
        let at = if updated > 0 { updated } else { now };
        let e = GoalEvent {
            goal_id: goal_id(1),
            op: "create".into(),
            turn: 0,
            at_ms: at,
            origin: ORIGIN_MIGRATION.into(),
            evidence: format!("turn_memory.goal (memory version {})", version),
            title: clip(&goal, MAX_TITLE_CHARS),
            description: goal.clone(),
            related: None,
            seq: 0,
        };
        insert_event(tx, &key, &e)?;
        let st = replay(&load_events(tx, &key)?)
            .map_err(|m| rusqlite::Error::ToSqlConversionFailure(m.into()))?;
        persist(tx, &key, &st, at)?;
        n += 1;
    }
    Ok(n)
}

// ── Linking decisions and tasks ─────────────────────────────────────────────

/// Give decisions and open items that are new in `mem` (after `base`) the
/// goal that was current at their source turn; keep every goal link `base`
/// had (a superseded decision keeps its goal). No goal at that turn, or no
/// source turn: the link stays empty, never guessed.
pub fn link_records(base: &TurnMemory, mem: &mut TurnMemory, st: &GoalState) -> usize {
    use std::collections::HashMap;
    let mut old: HashMap<String, Option<String>> = HashMap::new();
    for d in base
        .decisions
        .current
        .iter()
        .chain(base.decisions.superseded.iter())
    {
        old.insert(format!("d:{}", d.id), d.goal_id.clone());
    }
    for it in &base.items {
        old.insert(format!("i:{}", it.id), it.goal_id.clone());
    }
    let mut linked = 0;
    let mut fix = |key: String, turn: u32, slot: &mut Option<String>| match old.get(&key) {
        Some(prev) => {
            if prev.is_some() {
                *slot = prev.clone();
            }
        }
        None => {
            if slot.is_none() && turn > base.through_turn {
                *slot = st.goal_at(turn);
                if slot.is_some() {
                    linked += 1;
                }
            }
        }
    };
    for d in mem
        .decisions
        .current
        .iter_mut()
        .chain(mem.decisions.superseded.iter_mut())
    {
        fix(format!("d:{}", d.id), d.turn, &mut d.goal_id);
    }
    for it in mem.items.iter_mut() {
        if it.kind() == Some(super::items::Kind::OpenItem) {
            let turn = it.turn();
            fix(format!("i:{}", it.id), turn, &mut it.goal_id);
        }
    }
    linked
}

// ── Proposals from the summarizer ───────────────────────────────────────────

/// `goalOps` of a summary: `[{op, goal?, title?, description?, turn, evidence}]`.
pub fn parse_summary_ops(v: Option<&serde_json::Value>) -> Vec<Proposal> {
    let Some(list) = v.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|x| {
            let s = |k: &str| {
                x.get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            };
            let op = s("op").to_lowercase();
            if !matches!(
                op.as_str(),
                "create" | "switch" | "resume" | "complete" | "cancel" | "supersede"
            ) {
                return None;
            }
            let target = Some(s("goal")).filter(|t| !t.is_empty());
            Some(Proposal {
                op,
                target,
                title: s("title"),
                description: s("description"),
                turn: x.get("turn").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                origin: ORIGIN_SUMMARY.into(),
                evidence: s("evidence"),
            })
        })
        .take(8)
        .collect()
}

const END_WORDS: &[&str] = &[
    "done",
    "complete",
    "finish",
    "finished",
    "shipped",
    "achieved",
    "accomplished",
    "released",
    "শেষ",
    "সম্পন্ন",
    "সম্পূর্ণ",
    "পূরণ",
];
const CANCEL_WORDS: &[&str] = &[
    "cancel",
    "drop",
    "abandon",
    "scrap",
    "stop",
    "no longer",
    "বাতিল",
    "বাদ",
];

/// Keep the summarizer's proposals whose evidence is the user's own words in
/// that turn (inside the folded range) and, for complete/cancel, says so.
/// The rest are returned with the reason they were not used.
pub fn validate_summary_ops(
    ops: Vec<Proposal>,
    from: u32,
    to: u32,
    user_text: &dyn Fn(u32) -> Option<String>,
) -> (Vec<Proposal>, Vec<String>) {
    let mut ok = Vec::new();
    let mut rejected = Vec::new();
    for p in ops {
        let why = if p.turn < from || p.turn > to {
            Some(format!("turn {} is outside {}-{}", p.turn, from, to))
        } else if norm(&p.evidence).chars().count() < 6 {
            Some("no evidence quoted".into())
        } else {
            match user_text(p.turn) {
                None => Some(format!("turn {} has no user text", p.turn)),
                Some(t) if !norm(&t).contains(&norm(&p.evidence)) => Some(format!(
                    "the evidence is not in the user's words in turn {}",
                    p.turn
                )),
                Some(_) => {
                    let ev = norm(&p.evidence);
                    let words: &[&str] = match p.op.as_str() {
                        "complete" => END_WORDS,
                        "cancel" => CANCEL_WORDS,
                        _ => &[],
                    };
                    if !words.is_empty() && !words.iter().any(|w| ev.contains(w)) {
                        Some(format!(
                            "the evidence does not say the goal was {}",
                            if p.op == "complete" {
                                "completed"
                            } else {
                                "cancelled"
                            }
                        ))
                    } else {
                        None
                    }
                }
            }
        };
        match why {
            Some(w) => rejected.push(format!("{} (turn {}): {}", p.op, p.turn, w)),
            None => ok.push(p),
        }
    }
    (ok, rejected)
}

/// Goals as the summarizer sees them (so it can name them by ID).
pub fn summary_context(st: &GoalState) -> serde_json::Value {
    serde_json::json!({
        "current": st.current_goal_id,
        "goals": st.goals.iter().map(|g| serde_json::json!({ "id": g.goal_id, "title": g.title, "status": g.status })).collect::<Vec<_>>(),
    })
}

// ── Deterministic detection of explicit goal commands ──────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Intent {
    pub op: String,
    pub target: Option<String>,
    pub title: String,
    pub evidence: String,
}

struct Rules {
    create: Vec<Regex>,
    switch: Vec<Regex>,
    resume: Vec<Regex>,
    complete: Vec<Regex>,
    cancel: Vec<Regex>,
    supersede: Regex,
    negated: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| {
        let re = |s: &str| Regex::new(&bn_norm(s)).unwrap();
        let lead = r"^(?i)(?:ok(?:ay)?[,.!]?\s+|so[,]?\s+|now[,]?\s+)?";
        Rules {
            create: vec![
                re(&format!(r"{lead}(?:let'?s\s+)?(?:start|begin|open|set|add)\s+(?:a\s+)?new\s+goal\s*[:\-]?\s*(?:to\s+)?(?P<t>.{{3,200}})$")),
                re(&format!(r"{lead}(?:(?:our|my|the)\s+)?(?:new|main|next)\s+goal\s*(?::|-|is\s+to|is)\s*(?P<t>.{{3,200}})$")),
                re(&format!(r"{lead}(?:(?:our|my|the)\s+)?goal\s*(?::|-|is\s+to)\s*(?P<t>.{{3,200}})$")),
                re(r"^(?:আমাদের\s+|আমার\s+)?(?:নতুন\s+)?(?:লক্ষ্য|লক্ষ)\s*(?::|-|হলো|হল|হচ্ছে)\s*(?P<t>.{2,200})$"),
                re(r"^(?:নতুন\s+)?গোল\s*[:\-]\s*(?P<t>.{2,200})$"),
            ],
            switch: vec![
                re(&format!(r"{lead}(?:let'?s\s+)?(?:temporarily\s+|quickly\s+|for\s+now,?\s+)?pause\s+(?:this|that|it|the\s+(?:current\s+)?goal)(?:\s+goal)?\s+and\s+(?:switch\s+to|work\s+on|focus\s+on|start)\s+(?P<t>.{{2,200}})$")),
                re(&format!(r"{lead}(?:let'?s\s+)?(?:temporarily\s+|quickly\s+|for\s+now,?\s+)?switch\s+(?:over\s+)?to\s+(?:the\s+|our\s+)?(?:other\s+)?goal\s+(?P<t>.{{2,200}})$")),
                re(&format!(r"{lead}(?:let'?s\s+)?(?:temporarily\s+|quickly\s+|for\s+now,?\s+)?switch\s+(?:over\s+)?to\s+(?P<t>.{{2,200}})$")),
                re(r"^(?:আপাতত|সাময়িকভাবে|এখন)\s+(?P<t>.{2,120}?)\s+নিয়ে\s+কাজ\s+(?:করি|করব|করো)"),
            ],
            resume: vec![
                re(&format!(r"{lead}(?:let'?s\s+)?(?:go\s+back|get\s+back|come\s+back|back|return|resume)(?:\s+(?:to|with|on|working\s+on))?\s+(?:the\s+|our\s+)?(?:goal\s+)?(?P<t>.{{2,200}})$")),
                re(r"^(?P<t>.{2,120}?)\s*(?:-?এ|-?তে)?\s+(?:আবার\s+)?ফিরে\s+(?:যাই|যাও|চলো|চল|আসি|যাব|যাচ্ছি)"),
            ],
            complete: vec![
                re(r"(?i)\b(?:mark|set|consider)\s+(?:the\s+|this\s+|our\s+|current\s+)?(?:goal(?:\s+(?P<id>G\d{1,5}))?|(?P<id2>G\d{1,5}))\s+(?:as\s+)?(?:done|complete|completed|finished|achieved)\b"),
                re(r"(?i)^(?:ok(?:ay)?[,.!]?\s+)?(?:the\s+|this\s+|our\s+|current\s+)?goal(?:\s+(?P<id>G\d{1,5}))?\s+(?:is\s+|has\s+been\s+)?(?:now\s+)?(?:done|complete|completed|finished|achieved|accomplished)\b"),
                re(r"(?i)^(?P<id>G\d{1,5})\s+(?:is\s+|has\s+been\s+)?(?:done|complete|completed|finished|achieved)\b"),
                re(r"(?i)\b(?:we(?:'re|\s+are)?\s+)?(?:done|finished)\s+with\s+(?:the|this|our)\s+goal\b"),
                re(r"(?:লক্ষ্য|লক্ষ|(?P<id>G\d{1,5}))\s*(?:টা|টি)?\s*(?:এখন\s+)?(?:শেষ|সম্পন্ন|সম্পূর্ণ|পূরণ)\s*(?:হয়েছে|হলো|হল|করলাম|করেছি|হয়ে\s*গেছে)"),
            ],
            cancel: vec![
                re(r"(?i)\b(?:cancel|drop|abandon|scrap)\s+(?:the\s+|this\s+|our\s+|current\s+)?goal(?:\s+(?P<id>G\d{1,5}))?\b"),
                re(r"(?i)\b(?:cancel|drop|abandon|scrap)\s+(?P<id>G\d{1,5})\b"),
                re(r"(?i)\bgoal(?:\s+(?P<id>G\d{1,5}))?\s+(?:is\s+)?(?:cancelled|canceled|abandoned|dropped)\b"),
                re(r"(?:লক্ষ্য|লক্ষ|(?P<id>G\d{1,5}))\s*(?:টা|টি)?\s*বাতিল"),
            ],
            supersede: re(r"(?i)^(?:let'?s\s+)?(?:replace|supersede)\s+(?:the\s+|this\s+|our\s+|current\s+)?goal(?:\s+(?P<id>G\d{1,5}))?\s+with\s+(?:a\s+new\s+one[:,]?\s*)?(?P<t>.{3,200})$"),
            negated: re(r"(?i)\b(?:don'?t|do\s+not|not\s+yet|isn'?t|is\s+not|never|haven'?t|wasn'?t)\b|হয়নি|হয় নি|করো না|কোরো না|না\s*$"),
        }
    })
}

/// One spelling for the Bengali letters with a nukta (precomposed or not),
/// so the patterns match either.
fn bn_norm(s: &str) -> String {
    s.replace('\u{09DF}', "\u{09AF}\u{09BC}")
        .replace('\u{09DC}', "\u{09A1}\u{09BC}")
        .replace('\u{09DD}', "\u{09A2}\u{09BC}")
}

fn title_of(t: &str) -> String {
    let t = t.trim().trim_end_matches(['.', '!', '।']).trim();
    clip(t, MAX_TITLE_CHARS)
}

/// Explicit goal commands in a user message, by line. Conservative: a word
/// like "switch" alone is not a goal change (the caller resolves targets
/// against known goals and drops what names nothing). Questions and negated
/// lines never complete or cancel a goal.
pub fn detect(text: &str) -> Vec<Intent> {
    let r = rules();
    let mut out = Vec::new();
    let head: String = text.chars().take(1500).collect();
    let head = bn_norm(&head);
    for raw in head.lines() {
        let line = raw.trim().trim_start_matches(['-', '*', '>']).trim();
        if line.chars().count() < 4 {
            continue;
        }
        let question = line.ends_with('?') || line.ends_with('？');
        let negated = r.negated.is_match(line);
        let ev = clip(line, MAX_EVIDENCE_CHARS);
        let id = |c: &regex::Captures| {
            c.name("id")
                .or_else(|| c.name("id2"))
                .map(|m| m.as_str().to_uppercase())
        };
        if let Some(c) = r.supersede.captures(line) {
            if !question && !negated {
                out.push(Intent {
                    op: "supersede".into(),
                    target: id(&c),
                    title: title_of(&c["t"]),
                    evidence: ev,
                });
                continue;
            }
        }
        if !question && !negated {
            if let Some(c) = r.complete.iter().find_map(|re| re.captures(line)) {
                out.push(Intent {
                    op: "complete".into(),
                    target: id(&c),
                    title: String::new(),
                    evidence: ev,
                });
                continue;
            }
            if let Some(c) = r.cancel.iter().find_map(|re| re.captures(line)) {
                out.push(Intent {
                    op: "cancel".into(),
                    target: id(&c),
                    title: String::new(),
                    evidence: ev,
                });
                continue;
            }
        }
        if question || negated {
            continue;
        }
        if let Some(c) = r.create.iter().find_map(|re| re.captures(line)) {
            out.push(Intent {
                op: "create".into(),
                target: None,
                title: title_of(&c["t"]),
                evidence: ev,
            });
            continue;
        }
        if let Some((i, c)) = r
            .switch
            .iter()
            .enumerate()
            .find_map(|(i, re)| re.captures(line).map(|c| (i, c)))
        {
            // "switch to X" without "goal" or "pause": only an existing goal
            // (resolved by the caller; a plain switch never creates one).
            let t = title_of(&c["t"]);
            let op = if i == 2 { "resume" } else { "switch" };
            out.push(Intent {
                op: op.into(),
                target: Some(t.clone()),
                title: if op == "switch" { t } else { String::new() },
                evidence: ev,
            });
            continue;
        }
        if let Some(c) = r.resume.iter().find_map(|re| re.captures(line)) {
            out.push(Intent {
                op: "resume".into(),
                target: Some(title_of(&c["t"])),
                title: String::new(),
                evidence: ev,
            });
            continue;
        }
    }
    out
}

#[cfg(test)]
#[path = "goals_tests.rs"]
mod tests;
