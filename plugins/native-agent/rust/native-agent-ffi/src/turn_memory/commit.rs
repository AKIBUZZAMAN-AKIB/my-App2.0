//! Saving a new memory version with optimistic concurrency and a bounded
//! retry.
//!
//! A and B both read version 10. A saves 11. B's save finds the live version
//! is no longer 10 (a conflict), reloads 11, rebuilds its change on top of it
//! (no model call: the parsed update is re-applied and re-validated) and
//! saves 12. After `MAX_SAVE_TRIES` conflicts, or a database error, the
//! memory goes to the visible `pending` state ("summary failed, will retry");
//! the next turn plans the same batch again, since the checkpoint did not
//! move.

use super::store::{self, ArchiveTurns, SaveError};
use super::TurnMemory;
use rusqlite::Connection;
use serde_json::Value;

pub const MAX_SAVE_TRIES: u32 = 3;
pub const PENDING_TEXT: &str = "summary failed, will retry";

/// What a rebuild on top of the latest version gives.
pub enum Rebuild {
    /// The change rebuilt and validated on top of the latest version.
    Ready(TurnMemory),
    /// The latest version already contains this change (another writer did
    /// it): nothing to save.
    AlreadyDone,
    /// The change no longer fits the latest version.
    Invalid(String),
}

#[derive(Debug, PartialEq)]
pub enum CommitOutcome {
    Saved { version: u64, tries: u32 },
    AlreadyDone { version: u64 },
    /// Not saved; the memory is in the pending state with this reason.
    Pending { reason: String, tries: u32 },
}

pub struct CommitJob<'a> {
    pub session_key: &'a str,
    pub kind: &'a str,
    pub detail: Value,
    pub archive: Option<ArchiveTurns<'a>>,
    pub now_ms: i64,
}

/// Save `candidate` (built on version `expected`), rebuilding it with
/// `rebuild` on a conflict, at most `MAX_SAVE_TRIES` saves in all.
pub fn commit(conn: &Connection, job: CommitJob<'_>, expected: u64, candidate: TurnMemory, rebuild: impl FnMut(&TurnMemory) -> Rebuild) -> CommitOutcome {
    commit_with(conn, job, expected, candidate, rebuild, |_| {})
}

/// `commit` with a hook that runs before each save attempt (tests use it to
/// make another writer win the race).
pub fn commit_with(conn: &Connection, job: CommitJob<'_>, mut expected: u64, mut candidate: TurnMemory, mut rebuild: impl FnMut(&TurnMemory) -> Rebuild, mut before_save: impl FnMut(u32)) -> CommitOutcome {
    let CommitJob { session_key, kind, detail, archive, now_ms } = job;
    let archive = archive.map(|a| (a.messages, a.turns));
    let mut last = String::new();
    for attempt in 1..=MAX_SAVE_TRIES {
        before_save(attempt);
        let a = archive.map(|(messages, turns)| ArchiveTurns { messages, turns });
        match store::save_version(conn, session_key, expected, &candidate, kind, &detail, a, now_ms) {
            Ok(version) => return CommitOutcome::Saved { version, tries: attempt },
            Err(SaveError::Conflict { current }) => {
                last = format!("another update saved version {} first", current);
                if attempt == MAX_SAVE_TRIES {
                    break;
                }
                let latest = store::load_memory(conn, session_key);
                match rebuild(&latest) {
                    Rebuild::Ready(m) => {
                        candidate = m;
                        expected = latest.version;
                    }
                    Rebuild::AlreadyDone => return CommitOutcome::AlreadyDone { version: latest.version },
                    Rebuild::Invalid(why) => {
                        last = format!("could not rebuild on version {}: {}", latest.version, why);
                        let _ = store::set_status(conn, session_key, "pending", &format!("{} ({})", PENDING_TEXT, last), now_ms);
                        return CommitOutcome::Pending { reason: last, tries: attempt };
                    }
                }
            }
            Err(SaveError::Db(e)) => {
                last = format!("could not save: {}", e);
                let _ = store::set_status(conn, session_key, "pending", &format!("{} ({})", PENDING_TEXT, last), now_ms);
                return CommitOutcome::Pending { reason: last, tries: attempt };
            }
        }
    }
    let reason = format!("{} after {} tries", last, MAX_SAVE_TRIES);
    let _ = store::set_status(conn, session_key, "pending", &format!("{} ({})", PENDING_TEXT, reason), now_ms);
    CommitOutcome::Pending { reason, tries: MAX_SAVE_TRIES }
}

/// The rebuild for a summary of turns `from..=to` built on `base`:
/// re-apply the parsed update on the latest version when its checkpoint is
/// still `from - 1`. What another writer added in between (a repaired
/// decision, fact or preference) is carried over: the update did not know
/// about it, so it is kept rather than counted as dropped.
pub fn summary_rebuild<'a>(base: &'a TurnMemory, up: &'a super::SummaryUpdate, from: u32, to: u32, now_ms: i64) -> impl FnMut(&TurnMemory) -> Rebuild + 'a {
    move |latest: &TurnMemory| {
        if latest.through_turn >= to {
            return Rebuild::AlreadyDone;
        }
        if latest.through_turn + 1 != from {
            return Rebuild::Invalid(format!("the summary now ends at turn {}, not {}", latest.through_turn, from.saturating_sub(1)));
        }
        let mut up2 = up.clone();
        for d in &latest.decisions.current {
            if base.decision(&d.id).is_none() {
                up2.has_decisions = true;
                up2.current.push(super::DecisionOut { id: d.id.clone(), ..Default::default() });
            }
        }
        let carry = |new: &mut Option<Vec<super::Note>>, latest: &[super::Note], base: &[super::Note]| {
            if let Some(list) = new.as_mut() {
                for n in latest {
                    let added = !base.iter().any(|b| super::norm_key(&b.text) == super::norm_key(&n.text));
                    if added && !list.iter().any(|x| super::norm_key(&x.text) == super::norm_key(&n.text)) {
                        list.push(n.clone());
                    }
                }
            }
        };
        carry(&mut up2.facts, &latest.facts, &base.facts);
        carry(&mut up2.preferences, &latest.preferences, &base.preferences);
        match super::apply_update(latest, &up2, from, to, now_ms) {
            Ok(mut m) => {
                m.calls = latest.calls.max(m.calls);
                Rebuild::Ready(m)
            }
            Err(e) => Rebuild::Invalid(e.join("; ")),
        }
    }
}
