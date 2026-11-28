//! Sub-agent lifetimes (plan §10, stage 7).
//!
//! | Lifetime   | Ends                                   | Cleanup |
//! |------------|----------------------------------------|---------|
//! | `temp`     | first terminal status                  | its report is handed back (and copied into the parent's context tree as `agent/<id>`), then it is deleted after `temp_keep_secs_after_finish` → `subagent.deleted {reason: "temp_done"}` |
//! | `reusable` | never on its own (the default)          | the user, or the `max_kept` prune |
//! | `standby`  | `now > last_used_at + ttl`, not running | deleted by the sweep → `{reason: "standby_expired"}`; reuse resets the clock |
//!
//! The sweep runs from `persist`, **before** the `max_kept` prune (plan §1.4):
//! otherwise a temp agent could be pruned without its parent's bookkeeping.
//! It never touches a running or queued agent, a paused one, or one whose own
//! children are still running (risk R5).
//!
//! What is deleted: the record, its chat, run log, branches and (when no other
//! agent shares its name and its memory is not the shared one) its memory.
//! Files it wrote in the workspace are **kept**: they are the user's work, and
//! a temp helper that was asked to write a file was asked for that file.

use std::collections::HashSet;

use super::*;

/// Standby TTL default: 1 day (plan §10 / open question 5: mobile storage).
pub(crate) const STANDBY_TTL_DEFAULT_SECS: u64 = 86_400;
pub(crate) const STANDBY_TTL_MIN_SECS: u64 = 300;
pub(crate) const STANDBY_TTL_MAX_SECS: u64 = 2_592_000;
/// Most seconds a finished temp agent is kept after its report was taken.
pub(crate) const TEMP_KEEP_MAX_SECS: u64 = 3_600;
/// A finished temp agent whose report nobody collected (a background run the
/// parent never waited for) is still deleted after this long, so temp agents
/// cannot pile up. Its report is copied to the parent's tree first.
pub(crate) const TEMP_UNCOLLECTED_GRACE_SECS: u64 = 600;
/// Most characters of a render_in_chat answer the app receives.
pub(crate) const RENDER_IN_CHAT_MAX_CHARS: usize = 20_000;
/// Most characters of a render_in_chat answer the parent's note keeps.
pub(crate) const RENDER_IN_CHAT_NOTE_CHARS: usize = 600;

/// Added to the spawn prompt of a render_in_chat sub-agent (plan §10).
pub(crate) const RENDER_IN_CHAT_PROMPT: &str = "\n- Your final answer is shown to the user directly, as a message from you. Write it complete and ready to read: no notes to the other agent, no \"as requested\", nothing left for someone else to finish.";

/// `temp`, `reusable` or `standby`; anything else is not a lifetime.
pub(crate) fn normalize_lifetime(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "temp" | "temporary" | "ephemeral" | "once" | "one-shot" | "oneshot" => Some("temp".into()),
        "reusable" | "keep" | "kept" | "persistent" => Some("reusable".into()),
        "standby" | "stand-by" | "idle" => Some("standby".into()),
        _ => None,
    }
}

pub(crate) fn clamp_ttl(secs: u64) -> u64 {
    secs.clamp(STANDBY_TTL_MIN_SECS, STANDBY_TTL_MAX_SECS)
}

/// The record's lifetime; records from before lifetimes are reusable.
pub(crate) fn lifetime_of(rec: &SubagentRecord) -> &str {
    rec.lifetime.as_deref().unwrap_or("reusable")
}

/// Ended for good: not running, not queued, not paused, and it has finished.
pub(crate) fn is_terminal(rec: &SubagentRecord) -> bool {
    !rec.is_active() && !rec.paused && rec.status != "paused" && rec.finished_at.is_some()
}

/// What the parent reads instead of a render_in_chat agent's full answer.
pub(crate) fn render_in_chat_note(name: &str, report: &str) -> String {
    let report = report.trim();
    let short = truncate_chars(report, RENDER_IN_CHAT_NOTE_CHARS);
    let clipped = if short.chars().count() < report.chars().count() { " (shortened)" } else { "" };
    format!(
        "\nThe user already sees its whole answer as a message from \"{name}\". Do not repeat it; at most add what it left out.\nNote of the answer{clipped}:\n{short}"
    )
}

/// Temp agents that ended before the app last closed: nobody can wait for
/// their report any more, so they count as reported and the next sweep may
/// delete them (plan test "temp crash cleanup"). Returns whether any changed.
pub(crate) fn release_orphaned_temps(records: &mut [SubagentRecord]) -> bool {
    let mut changed = false;
    for r in records.iter_mut() {
        if lifetime_of(r) == "temp" && is_terminal(r) && !r.reported {
            r.reported = true;
            changed = true;
        }
    }
    changed
}

/// Take out every record whose lifetime has ended, with the reason. Pure: the
/// caller removes their data and sends the events.
pub(crate) fn sweep(
    recs: &mut Vec<SubagentRecord>,
    settings: &SubagentSettings,
    now: i64,
    busy: &HashSet<String>,
) -> Vec<(SubagentRecord, &'static str)> {
    let keep_ms = (settings.temp_keep_secs_after_finish.min(TEMP_KEEP_MAX_SECS) as i64) * 1_000;
    let grace_ms = (settings.temp_keep_secs_after_finish.max(TEMP_UNCOLLECTED_GRACE_SECS) as i64) * 1_000;
    // An agent whose own children still run is not deleted under them.
    let parents_of_active: HashSet<String> = recs.iter().filter(|r| r.is_active()).filter_map(|r| r.parent_id.clone()).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < recs.len() {
        let r = &recs[i];
        let protected = busy.contains(&r.id) || r.is_active() || r.paused || parents_of_active.contains(&r.id);
        let reason = if protected {
            None
        } else {
            match lifetime_of(r) {
                "temp" if is_terminal(r) => {
                    let fin = r.finished_at.unwrap_or(r.started_at);
                    if (r.reported && now >= fin.saturating_add(keep_ms)) || now >= fin.saturating_add(grace_ms) {
                        Some("temp_done")
                    } else {
                        None
                    }
                }
                "standby" => {
                    let last = r.last_used_at.or(r.finished_at).unwrap_or(r.started_at);
                    let ttl = clamp_ttl(r.ttl_secs.unwrap_or(settings.standby_ttl_default_secs)) as i64 * 1_000;
                    if now > last.saturating_add(ttl) {
                        Some("standby_expired")
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        match reason {
            Some(reason) => out.push((recs.remove(i), reason)),
            None => i += 1,
        }
    }
    out
}

impl SubagentManager {
    /// The chat database the parent's context tree lives in.
    pub fn set_tree_db(&self, db_path: &str) {
        let path = db_path.trim();
        *self.tree_db.lock().unwrap() = if path.is_empty() { None } else { Some(path.to_string()) };
    }

    /// Run the lifetime sweep now (a turn boundary, or the app's start).
    pub fn gc_lifetimes(&self) {
        self.persist();
    }

    /// These reports were handed back to their parent. A temp agent among
    /// them may now go (at once, or after `temp_keep_secs_after_finish`).
    pub(crate) fn mark_reported(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        let mut changed = false;
        for id in ids {
            changed |= self
                .update(id, |r| {
                    if is_terminal(r) {
                        r.reported = true;
                    }
                })
                .is_some();
        }
        if changed {
            self.persist();
        }
    }

    /// Copy a finished agent's report into its parent's context tree as
    /// `agent/<id>` (a note the model can keep, drop or recall). Does nothing
    /// when the tree is off, the parent is itself a sub-agent (sub-agents have
    /// no tree of their own), or there is no report.
    pub(crate) fn note_in_parent_tree(&self, rec: &SubagentRecord) {
        let Some(db) = self.tree_db.lock().unwrap().clone() else { return };
        if rec.parent_session_key.starts_with("subagent:") || rec.parent_session_key.trim().is_empty() {
            return;
        }
        let report = rec.result.as_deref().unwrap_or("").trim();
        if report.is_empty() {
            return;
        }
        let title = rec.title.clone().unwrap_or_else(|| rec.name.clone());
        crate::context_tree::wiring::record_subagent_report(
            &db,
            &rec.parent_session_key,
            &rec.id,
            &title,
            &rec.status,
            report,
            rec.render_in_chat,
            lifetime_of(rec),
            now_ms(),
        );
    }

    /// The user deleted the agent: tombstone its `agent/<id>` node in the
    /// parent's tree (and drop the copied report).
    pub(crate) fn forget_in_parent_tree(&self, rec: &SubagentRecord) {
        let Some(db) = self.tree_db.lock().unwrap().clone() else { return };
        if rec.parent_session_key.starts_with("subagent:") || rec.parent_session_key.trim().is_empty() {
            return;
        }
        crate::context_tree::wiring::forget_subagent(&db, &rec.parent_session_key, &rec.id, now_ms());
    }

    /// Side effects of a sweep, after `registry.json` is written: copy a
    /// report nobody collected, free the memory, tell the app.
    pub(crate) fn after_retire(&self, retired: &[(SubagentRecord, &'static str)], remaining: &[SubagentRecord]) {
        let cb = self.last_app.lock().unwrap().clone();
        for (rec, reason) in retired {
            if *reason == "temp_done" && !rec.reported {
                self.note_in_parent_tree(rec);
            }
            let shares_name = remaining.iter().any(|r| r.name == rec.name)
                || retired.iter().any(|(o, _)| o.id != rec.id && o.name == rec.name && o.memory_mode == "shared");
            let memory = if rec.memory_mode == "shared" || shares_name { 0 } else { self.memory_clear(&rec.name) };
            {
                let mut asks = self.asks.lock().unwrap();
                let before = asks.len();
                asks.retain(|a| a.caller_session_key != rec.session_key && a.target_session_key != rec.session_key);
                if asks.len() != before {
                    fs_write_json(&self.state_dir.join("session_asks.json"), &*asks);
                }
            }
            if let Some(cb) = &cb {
                cb.on_event(
                    "subagent.deleted".into(),
                    json!({
                        "id": rec.id,
                        "name": rec.name,
                        "reason": reason,
                        "lifetime": lifetime_of(rec),
                        "parentSessionKey": rec.parent_session_key,
                        "result": {"id": rec.id, "name": rec.name, "chat": true, "memory": memory, "record": true, "filesKept": true},
                    })
                    .to_string(),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, lifetime: Option<&str>, status: &str, finished_at: Option<i64>) -> SubagentRecord {
        let mut r: SubagentRecord = serde_json::from_value(json!({
            "id": id, "name": id, "task": "t", "status": status,
            "parentSessionKey": "chat", "sessionKey": format!("subagent:{id}"),
            "depth": 1, "tools": [], "memoryMode": "private", "tokenBudget": 0,
            "maxSteps": 5, "timeoutSeconds": 60, "createdAt": 1_000,
            "startedAt": 1_000, "finishedAt": finished_at,
        }))
        .expect("a minimal old-style record loads");
        r.lifetime = lifetime.map(|s| s.to_string());
        r
    }

    #[test]
    fn old_json_without_lifetime_fields_loads_as_reusable() {
        let r = rec("sa_old", None, "finished", Some(2_000));
        assert_eq!(lifetime_of(&r), "reusable");
        assert!(!r.render_in_chat && !r.reported && r.ttl_secs.is_none());
        let back = serde_json::to_value(&r).unwrap();
        assert!(back.get("lifetime").is_none(), "nothing new is written for an old record");
    }

    #[test]
    fn a_temp_agent_goes_only_after_its_report_was_taken() {
        let s = SubagentSettings::default();
        let mut recs = vec![rec("sa_t", Some("temp"), "finished", Some(2_000))];
        assert!(sweep(&mut recs, &s, 3_000, &HashSet::new()).is_empty(), "not reported yet");
        recs[0].reported = true;
        let gone = sweep(&mut recs, &s, 3_000, &HashSet::new());
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].1, "temp_done");
        assert!(recs.is_empty());
    }

    #[test]
    fn an_uncollected_temp_agent_still_goes_after_the_grace() {
        let s = SubagentSettings::default();
        let mut recs = vec![rec("sa_t", Some("temp"), "finished", Some(2_000))];
        let later = 2_000 + TEMP_UNCOLLECTED_GRACE_SECS as i64 * 1_000;
        assert_eq!(sweep(&mut recs, &s, later, &HashSet::new()).len(), 1);
    }

    #[test]
    fn temp_keep_secs_delays_the_delete() {
        let s = SubagentSettings { temp_keep_secs_after_finish: 60, ..Default::default() };
        let mut recs = vec![rec("sa_t", Some("temp"), "finished", Some(2_000))];
        recs[0].reported = true;
        assert!(sweep(&mut recs, &s, 2_000 + 59_000, &HashSet::new()).is_empty());
        assert_eq!(sweep(&mut recs, &s, 2_000 + 60_000, &HashSet::new()).len(), 1);
    }

    #[test]
    fn standby_expires_on_a_fake_clock_and_reuse_resets_it() {
        let s = SubagentSettings::default();
        let mut r = rec("sa_s", Some("standby"), "finished", Some(2_000));
        r.ttl_secs = Some(300);
        r.last_used_at = Some(2_000);
        let mut recs = vec![r];
        assert!(sweep(&mut recs, &s, 2_000 + 300_000, &HashSet::new()).is_empty(), "exactly at the ttl it stays");
        recs[0].last_used_at = Some(200_000);
        assert!(sweep(&mut recs, &s, 2_000 + 300_001, &HashSet::new()).is_empty(), "reuse moved the clock");
        let gone = sweep(&mut recs, &s, 200_000 + 300_001, &HashSet::new());
        assert_eq!(gone[0].1, "standby_expired");
    }

    #[test]
    fn the_sweep_never_touches_running_queued_paused_or_busy_agents() {
        let s = SubagentSettings::default();
        let mut running = rec("sa_r", Some("standby"), "running", None);
        running.ttl_secs = Some(300);
        let queued = rec("sa_q", Some("standby"), "queued", None);
        let mut paused = rec("sa_p", Some("temp"), "paused", Some(2_000));
        paused.paused = true;
        paused.reported = true;
        let mut busy_one = rec("sa_b", Some("temp"), "finished", Some(2_000));
        busy_one.reported = true;
        let mut recs = vec![running, queued, paused, busy_one];
        let busy: HashSet<String> = ["sa_b".to_string()].into_iter().collect();
        assert!(sweep(&mut recs, &s, i64::MAX / 2, &busy).is_empty());
        assert_eq!(recs.len(), 4);
    }

    #[test]
    fn a_parent_is_not_deleted_under_its_running_child() {
        let s = SubagentSettings::default();
        let mut parent = rec("sa_p", Some("temp"), "finished", Some(2_000));
        parent.reported = true;
        let mut child = rec("sa_c", None, "running", None);
        child.parent_id = Some("sa_p".into());
        let mut recs = vec![parent, child];
        assert!(sweep(&mut recs, &s, 10_000, &HashSet::new()).is_empty());
    }

    #[test]
    fn temps_cut_off_by_a_restart_are_released() {
        let mut recs = vec![rec("sa_t", Some("temp"), "error", Some(2_000)), rec("sa_k", None, "error", Some(2_000))];
        assert!(release_orphaned_temps(&mut recs));
        assert!(recs[0].reported);
        assert!(!recs[1].reported, "only temp agents");
    }

    #[test]
    fn lifetimes_and_ttls_are_normalised() {
        assert_eq!(normalize_lifetime(" Temp ").as_deref(), Some("temp"));
        assert_eq!(normalize_lifetime("standby").as_deref(), Some("standby"));
        assert_eq!(normalize_lifetime("forever"), None);
        assert_eq!(clamp_ttl(1), STANDBY_TTL_MIN_SECS);
        assert_eq!(clamp_ttl(u64::MAX), STANDBY_TTL_MAX_SECS);
    }

    #[test]
    fn the_parent_gets_a_note_not_a_second_copy() {
        let long = "x".repeat(5_000);
        let note = render_in_chat_note("writer", &long);
        assert!(note.contains("Do not repeat it"));
        assert!(note.contains("(shortened)"));
        assert!(note.chars().count() < 1_000);
    }
}
