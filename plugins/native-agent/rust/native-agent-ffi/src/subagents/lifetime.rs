//! Sub-agent lifetimes (context tree plan, stage 7).
//!
//! - `reusable` (the default, and every record made before this existed): kept
//!   until the user deletes it or `max_kept` pushes it out, as before.
//! - `temp`: deleted once its report reached the parent (a tool result) and
//!   `temp_keep_secs` have passed. A report nobody collected is kept for the
//!   standby TTL, so a background run's answer is not lost.
//! - `standby`: deleted when it has been idle (not running, not reused) for its
//!   TTL (`ttl_secs`, else the context tree's `standby_ttl_secs`). Every reuse
//!   starts the clock again.
//!
//! Before a temp agent is deleted its report is kept in the parent's context
//! tree as a note (`out`: recallable, not sent), so `ctx recall` still finds it.
//! `render_in_chat` shows the answer in the chat as its own message; the parent
//! then gets a note (`in`) instead of the whole text a second time.
//!
//! A sweep only deletes the agent's chat, logs, record and (when no other agent
//! shares its name) its private memory. Files it created are the user's work
//! and stay. Sweeps run at fixed points (a finished run, a delivered report, a
//! sub-agent tool call, the app's list), never inside `persist()`, so they never
//! run while another lock of the manager is held.

use super::*;
use std::sync::atomic::Ordering;

/// The context tree's limits for `standby_ttl_secs`.
pub const MIN_STANDBY_TTL_SECS: u64 = 300;
pub const MAX_STANDBY_TTL_SECS: u64 = 2_592_000;
/// Most characters of a report kept as a note in the parent's tree.
pub const KEPT_REPORT_CHARS: usize = 4_000;

/// Lifetime settings, copied from the context tree settings by the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifetimePolicy {
    /// Seconds a temp agent stays after its report was delivered (0–3,600).
    pub temp_keep_secs: u64,
    /// Default idle life of a standby agent (300–2,592,000).
    pub standby_ttl_secs: u64,
    /// Default for `render_in_chat` of temp agents.
    pub render_in_chat: bool,
}

impl Default for LifetimePolicy {
    fn default() -> Self {
        let s = crate::context_tree::settings::Settings::default();
        LifetimePolicy {
            temp_keep_secs: s.temp_keep_secs,
            standby_ttl_secs: s.standby_ttl_secs,
            render_in_chat: s.render_in_chat,
        }
    }
}

impl LifetimePolicy {
    pub fn from_tree_settings(s: &crate::context_tree::settings::Settings) -> Self {
        LifetimePolicy {
            temp_keep_secs: s.temp_keep_secs.min(3_600),
            standby_ttl_secs: s
                .standby_ttl_secs
                .clamp(MIN_STANDBY_TTL_SECS, MAX_STANDBY_TTL_SECS),
            render_in_chat: s.render_in_chat,
        }
    }
}

/// Normalise a `lifetime` argument: `Ok(None)` is reusable.
pub fn parse_lifetime(raw: Option<&str>) -> Result<Option<String>, String> {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        None | Some("") | Some("reusable") | Some("keep") | Some("permanent") => Ok(None),
        Some("temp") | Some("temporary") | Some("once") => Ok(Some("temp".into())),
        Some("standby") => Ok(Some("standby".into())),
        Some(other) => Err(format!(
            "Unknown lifetime \"{}\": use temp, reusable or standby.",
            other
        )),
    }
}

/// Why a record should be deleted now, if it should. Pure: no clock, no I/O.
pub fn expiry(r: &SubagentRecord, p: &LifetimePolicy, now: i64) -> Option<&'static str> {
    if r.is_active() || r.status == "waiting_approval" {
        return None;
    }
    let last = r
        .finished_at
        .unwrap_or(r.started_at)
        .max(r.started_at)
        .max(r.created_at);
    match r.lifetime.as_deref() {
        Some("temp") => {
            let done = r.finished_at?;
            let keep = if r.report_delivered {
                p.temp_keep_secs
            } else {
                p.temp_keep_secs.max(p.standby_ttl_secs)
            };
            (now >= done.saturating_add((keep as i64) * 1000)).then_some("temp_done")
        }
        Some("standby") => {
            let ttl = r
                .standby_ttl_secs
                .unwrap_or(p.standby_ttl_secs)
                .clamp(MIN_STANDBY_TTL_SECS, MAX_STANDBY_TTL_SECS);
            (now >= last.saturating_add((ttl as i64) * 1000)).then_some("standby_expired")
        }
        _ => None,
    }
}

impl SubagentManager {
    pub fn lifetime_policy(&self) -> LifetimePolicy {
        *self.lifetimes.lock().unwrap()
    }

    /// Set from the context tree settings (at start and after every save).
    pub fn set_lifetime_policy(&self, p: LifetimePolicy) {
        *self.lifetimes.lock().unwrap() = p;
    }

    /// The memory database with the context tree (for keeping reports).
    pub fn set_tree_db(&self, db_path: &str) {
        *self.tree_db.lock().unwrap() = Some(db_path.to_string()).filter(|p| !p.is_empty());
    }

    pub(crate) fn remember_app(&self, app: &Option<Arc<dyn NativeEventCallback>>) {
        if let Some(cb) = app {
            *self.last_app.lock().unwrap() = Some(cb.clone());
        }
    }

    /// Lifetime fields of a new record from its spawn arguments:
    /// (lifetime, standby TTL, render_in_chat).
    pub(crate) fn lifetime_fields(
        &self,
        spec: &SpawnSpec,
    ) -> Result<(Option<String>, Option<u64>, bool), String> {
        let lifetime = parse_lifetime(spec.lifetime.as_deref())?;
        let p = self.lifetime_policy();
        let render = spec
            .render_in_chat
            .unwrap_or(p.render_in_chat && lifetime.as_deref() == Some("temp"));
        let ttl = match lifetime.as_deref() {
            Some("standby") => spec
                .ttl_secs
                .map(|t| t.clamp(MIN_STANDBY_TTL_SECS, MAX_STANDBY_TTL_SECS)),
            _ => None,
        };
        Ok((lifetime, ttl, render))
    }

    /// A reused agent may change its lifetime (`lifetime` given on reuse).
    pub(crate) fn update_lifetime_on_reuse(
        &self,
        id: &str,
        spec: &SpawnSpec,
    ) -> Result<(), String> {
        if spec.lifetime.is_none() && spec.ttl_secs.is_none() && spec.render_in_chat.is_none() {
            return Ok(());
        }
        let lifetime = match &spec.lifetime {
            Some(l) => Some(parse_lifetime(Some(l))?),
            None => None,
        };
        self.update(id, |r| {
            if let Some(l) = lifetime {
                r.lifetime = l;
            }
            if let Some(t) = spec.ttl_secs {
                r.standby_ttl_secs = Some(t.clamp(MIN_STANDBY_TTL_SECS, MAX_STANDBY_TTL_SECS));
            }
            if let Some(b) = spec.render_in_chat {
                r.render_in_chat = b;
            }
        });
        self.persist();
        Ok(())
    }

    /// Keep a report in the parent's context tree as a note. Returns its id, or
    /// None when the tree is off, unknown or failed (the report is then only in
    /// the parent's tool result, as before).
    pub(crate) fn keep_report_in_tree(
        &self,
        r: &SubagentRecord,
        send_with_requests: bool,
    ) -> Option<String> {
        let db = self.tree_db.lock().unwrap().clone()?;
        let report = r.result.as_deref().unwrap_or("").trim();
        if report.is_empty() || r.parent_session_key.is_empty() {
            return None;
        }
        let ws = self.workspace.lock().unwrap().clone().unwrap_or_default();
        crate::context_tree::wiring::keep_subagent_result(
            &db,
            &ws,
            &r.parent_session_key,
            &r.id,
            &r.name,
            &truncate_chars(report, KEPT_REPORT_CHARS),
            send_with_requests,
            now_ms(),
        )
    }

    /// A report reached the parent: mark it, so a temp agent may go.
    pub(crate) fn mark_report_delivered(&self, id: &str) {
        if self.update(id, |r| r.report_delivered = true).is_some() {
            self.persist();
        }
    }

    /// Delete every temp / standby agent whose time is up. Returns what was
    /// deleted (id, name, reason), and sends `subagent.deleted` for each.
    pub fn sweep_lifetimes(&self) -> Vec<Value> {
        if self.sweeping.swap(true, Ordering::SeqCst) {
            return Vec::new();
        }
        let p = self.lifetime_policy();
        let now = now_ms();
        let due: Vec<(SubagentRecord, &'static str)> = self
            .list()
            .into_iter()
            .filter_map(|r| expiry(&r, &p, now).map(|why| (r, why)))
            .collect();
        let mut out = Vec::new();
        for (rec, why) in due {
            // Its report outlives it in the parent's tree (`ctx recall` finds it).
            if why == "temp_done" && rec.kept_note.is_none() {
                let _ = self.keep_report_in_tree(&rec, false);
            }
            let shared_name = self
                .list()
                .iter()
                .any(|o| o.id != rec.id && o.name == rec.name);
            let parts: Vec<&str> = if shared_name || rec.memory_mode == "shared" {
                vec!["chat", "logs"]
            } else {
                vec!["chat", "memory", "logs"]
            };
            let mut result = self.apply_delete(&rec.id, &parts, true);
            result["reason"] = json!(why);
            let app = self.last_app.lock().unwrap().clone();
            if let Some(cb) = app {
                cb.on_event(
                    "subagent.deleted".into(),
                    json!({"id": rec.id, "name": rec.name, "reason": why, "result": result})
                        .to_string(),
                );
            }
            out.push(json!({"id": rec.id, "name": rec.name, "reason": why}));
        }
        self.sweeping.store(false, Ordering::SeqCst);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(lifetime: Option<&str>, status: &str, finished: Option<i64>) -> SubagentRecord {
        let mut r: SubagentRecord = serde_json::from_value(json!({
            "id": "sa_1", "name": "helper", "task": "t", "status": status, "sessionKey": "subagent:sa_1",
            "parentSessionKey": "chat", "depth": 1, "startedAt": 1_000, "createdAt": 1_000,
            "tools": [], "memoryMode": "private", "tokenBudget": 0, "maxSteps": 1, "timeoutSeconds": 60,
        }))
        .expect("record");
        r.lifetime = lifetime.map(str::to_string);
        r.finished_at = finished;
        r
    }

    #[test]
    fn parse_lifetime_accepts_the_three_names() {
        assert_eq!(parse_lifetime(None).unwrap(), None);
        assert_eq!(parse_lifetime(Some("reusable")).unwrap(), None);
        assert_eq!(
            parse_lifetime(Some(" Temp ")).unwrap().as_deref(),
            Some("temp")
        );
        assert_eq!(
            parse_lifetime(Some("standby")).unwrap().as_deref(),
            Some("standby")
        );
        assert!(parse_lifetime(Some("forever")).is_err());
    }

    #[test]
    fn reusable_and_running_agents_never_expire() {
        let p = LifetimePolicy {
            temp_keep_secs: 0,
            standby_ttl_secs: 300,
            render_in_chat: false,
        };
        assert_eq!(
            expiry(&rec(None, "finished", Some(2_000)), &p, i64::MAX / 2),
            None
        );
        let mut running = rec(Some("temp"), "running", None);
        running.report_delivered = true;
        assert_eq!(expiry(&running, &p, i64::MAX / 2), None);
        assert_eq!(
            expiry(&rec(Some("standby"), "queued", None), &p, i64::MAX / 2),
            None
        );
    }

    #[test]
    fn temp_goes_after_delivery_and_keep_secs() {
        let p = LifetimePolicy {
            temp_keep_secs: 60,
            standby_ttl_secs: 3_600,
            render_in_chat: false,
        };
        let mut r = rec(Some("temp"), "finished", Some(10_000));
        // Not delivered: kept for the standby TTL so the report is not lost.
        assert_eq!(expiry(&r, &p, 10_000 + 61_000), None);
        assert_eq!(expiry(&r, &p, 10_000 + 3_600_000), Some("temp_done"));
        r.report_delivered = true;
        assert_eq!(expiry(&r, &p, 10_000 + 59_000), None);
        assert_eq!(expiry(&r, &p, 10_000 + 60_000), Some("temp_done"));
    }

    #[test]
    fn standby_uses_its_own_ttl_then_the_default_and_clamps() {
        let p = LifetimePolicy {
            temp_keep_secs: 0,
            standby_ttl_secs: 600,
            render_in_chat: false,
        };
        let mut r = rec(Some("standby"), "finished", Some(5_000));
        assert_eq!(expiry(&r, &p, 5_000 + 599_000), None);
        assert_eq!(expiry(&r, &p, 5_000 + 600_000), Some("standby_expired"));
        r.standby_ttl_secs = Some(10); // below the minimum: 300 s
        assert_eq!(expiry(&r, &p, 5_000 + 299_000), None);
        assert_eq!(expiry(&r, &p, 5_000 + 300_000), Some("standby_expired"));
    }
}
