//! The few numbers a user may change, and the one switch that decides whether the
//! tree exists at all.
//!
//! Two rules shaped this file:
//!
//! 0. **Always on.** The checklist has no off: `enabled` is always true and a
//!    patch with `enabled: false` is ignored (the memory checklist replaces
//!    the separate memory tool, so the tree must always exist).
//! 1. **One source of truth.** The (legacy) switch is `ctx_meta.enabled` — the same row
//!    [`super::wiring::enabled`] reads before every request. Nothing caches it, so
//!    turning the tree off takes effect on the next turn and never needs a restart.
//! 2. **A bad number must never be able to break a chat.** Every value is clamped
//!    on the way in *and* on the way out, and a missing or unparsable row falls
//!    back to the default instead of failing the read.
//!
//! The clamps come from the plan (`IMPLEMENTATION-PLAN.md` §12, "Settings"):
//! `temp_keep_secs` 0–3,600 · `standby_ttl_secs` 300–2,592,000 ·
//! threshold 10–90 %.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Default share of the selectable window at which the engine starts compacting.
pub const DEFAULT_THRESHOLD_PERCENT: u64 = 70;
/// Default size of the summary the model may ask for.
pub const DEFAULT_SUMMARY_TOKENS: u32 = 600;
/// Default grace period before a finished temp sub-agent is deleted.
pub const DEFAULT_TEMP_KEEP_SECS: u64 = 0;
/// Default life of a standby sub-agent (one day).
pub const DEFAULT_STANDBY_TTL_SECS: u64 = 86_400;
/// Policy retries before a task falls back to T7 for good (0–5).
pub const DEFAULT_POLICY_MAX_RETRIES: u64 = 2;
/// Turns T5 keeps before the newest one (1–10).
pub const DEFAULT_POLICY_RECENT_TURNS: u64 = 2;

pub use crate::context_policy::PolicyMode;

/// Everything a user may change about the tree, with the defaults applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// The switch. `false` means no assembly, no tools, no panel — the engine
    /// behaves exactly as it did before the feature existed.
    pub enabled: bool,
    /// Percent of the selectable window at which compaction starts (10–90).
    pub threshold_percent: u64,
    /// Default size of a requested summary (100–4,000 tokens).
    pub summary_tokens: u32,
    /// Grace period before a finished temp sub-agent is deleted (0–3,600 s).
    pub temp_keep_secs: u64,
    /// Life of a standby sub-agent (300–2,592,000 s, i.e. 5 min – 30 days).
    pub standby_ttl_secs: u64,
    /// Copy a temp sub-agent's final answer into the chat as its own bubble.
    pub render_in_chat: bool,
    /// The task context policy switch: `off` (T7 only, the default), `manual`
    /// (pins and the model's `ctx task`) or `auto` (rules too).
    pub policy_mode: PolicyMode,
    /// How often a task may fall back and retry before it stays on T7.
    pub policy_max_retries: u64,
    /// The default `recent_turns` of T5.
    pub policy_recent_turns: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            enabled: true,
            threshold_percent: DEFAULT_THRESHOLD_PERCENT,
            summary_tokens: DEFAULT_SUMMARY_TOKENS,
            temp_keep_secs: DEFAULT_TEMP_KEEP_SECS,
            standby_ttl_secs: DEFAULT_STANDBY_TTL_SECS,
            render_in_chat: false,
            policy_mode: PolicyMode::Off,
            policy_max_retries: DEFAULT_POLICY_MAX_RETRIES,
            policy_recent_turns: DEFAULT_POLICY_RECENT_TURNS,
        }
    }
}

impl Settings {
    /// Read every known key. Unknown keys are ignored; known keys with junk values
    /// are clamped to their default, never to something the caller cannot trust.
    pub fn load(conn: &Connection) -> rusqlite::Result<Settings> {
        let mut s = Settings::default();
        let mut stmt = conn.prepare("SELECT key, value FROM ctx_meta")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (key, value) = row?;
            match key.as_str() {
                // Always on: an old stored 0 is not honoured.
                "enabled" => s.enabled = true,
                "threshold_percent" => {
                    s.threshold_percent = clamp_u64(&value, 10, 90, DEFAULT_THRESHOLD_PERCENT)
                }
                "summary_tokens" => {
                    s.summary_tokens = clamp_u64(&value, 100, 4_000, DEFAULT_SUMMARY_TOKENS as u64) as u32
                }
                "temp_keep_secs" => {
                    s.temp_keep_secs = clamp_u64(&value, 0, 3_600, DEFAULT_TEMP_KEEP_SECS)
                }
                "standby_ttl_secs" => {
                    s.standby_ttl_secs = clamp_u64(&value, 300, 2_592_000, DEFAULT_STANDBY_TTL_SECS)
                }
                "render_in_chat" => s.render_in_chat = value.trim() == "1",
                "policy_mode" => s.policy_mode = PolicyMode::parse_or_off(&value),
                "policy_max_retries" => {
                    s.policy_max_retries = clamp_u64(&value, 0, 5, DEFAULT_POLICY_MAX_RETRIES)
                }
                "policy_recent_turns" => {
                    s.policy_recent_turns = clamp_u64(&value, 1, 10, DEFAULT_POLICY_RECENT_TURNS)
                }
                _ => {}
            }
        }
        Ok(s)
    }

    /// Apply a partial change (`{"enabled": true, "threshold_percent": 60}`) and
    /// store it. Returns the settings as stored, after clamping — so the screen
    /// shows what the engine will really use, not what was typed.
    pub fn save(conn: &Connection, patch: &Value) -> rusqlite::Result<Settings> {
        let mut s = Settings::load(conn)?;
        // Always on: `enabled` in a patch is accepted and ignored.
        s.enabled = true;
        if let Some(v) = patch.get("threshold_percent").and_then(|v| v.as_u64()) {
            s.threshold_percent = v.clamp(10, 90);
        }
        if let Some(v) = patch.get("summary_tokens").and_then(|v| v.as_u64()) {
            s.summary_tokens = v.clamp(100, 4_000) as u32;
        }
        if let Some(v) = patch.get("temp_keep_secs").and_then(|v| v.as_u64()) {
            s.temp_keep_secs = v.clamp(0, 3_600);
        }
        if let Some(v) = patch.get("standby_ttl_secs").and_then(|v| v.as_u64()) {
            s.standby_ttl_secs = v.clamp(300, 2_592_000);
        }
        if let Some(v) = patch.get("render_in_chat").and_then(|v| v.as_bool()) {
            s.render_in_chat = v;
        }
        if let Some(v) = patch.get("policy_mode").and_then(|v| v.as_str()) {
            s.policy_mode = PolicyMode::parse_or_off(v);
        }
        if let Some(v) = patch.get("policy_max_retries").and_then(|v| v.as_u64()) {
            s.policy_max_retries = v.clamp(0, 5);
        }
        if let Some(v) = patch.get("policy_recent_turns").and_then(|v| v.as_u64()) {
            s.policy_recent_turns = v.clamp(1, 10);
        }
        for (key, value) in [
            ("enabled", if s.enabled { "1".to_string() } else { "0".to_string() }),
            ("threshold_percent", s.threshold_percent.to_string()),
            ("summary_tokens", s.summary_tokens.to_string()),
            ("temp_keep_secs", s.temp_keep_secs.to_string()),
            ("standby_ttl_secs", s.standby_ttl_secs.to_string()),
            ("render_in_chat", if s.render_in_chat { "1".to_string() } else { "0".to_string() }),
            ("policy_mode", s.policy_mode.as_str().to_string()),
            ("policy_max_retries", s.policy_max_retries.to_string()),
            ("policy_recent_turns", s.policy_recent_turns.to_string()),
        ] {
            conn.execute(
                "INSERT INTO ctx_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
        }
        Ok(s)
    }

    /// The same settings as JSON, for the settings screen and for `ctx view`.
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "thresholdPercent": self.threshold_percent,
            "summaryTokens": self.summary_tokens,
            "tempKeepSecs": self.temp_keep_secs,
            "standbyTtlSecs": self.standby_ttl_secs,
            "renderInChat": self.render_in_chat,
            "policyMode": self.policy_mode.as_str(),
            "policyMaxRetries": self.policy_max_retries,
            "policyRecentTurns": self.policy_recent_turns,
        })
    }
}

/// Read one settings value without loading the whole struct.
pub fn number(conn: &Connection, key: &str) -> Option<u64> {
    conn.query_row("SELECT value FROM ctx_meta WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .and_then(|v| v.trim().parse::<u64>().ok())
}

fn clamp_u64(raw: &str, lo: u64, hi: u64, default: u64) -> u64 {
    match raw.trim().parse::<u64>() {
        Ok(v) => v.clamp(lo, hi),
        Err(_) => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_tree::store;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::ensure_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn an_empty_database_means_on_and_defaults() {
        let conn = db();
        let s = Settings::load(&conn).unwrap();
        assert!(s.enabled, "the checklist is always on");
        assert_eq!(s.threshold_percent, DEFAULT_THRESHOLD_PERCENT);
        assert_eq!(s.summary_tokens, DEFAULT_SUMMARY_TOKENS);
        assert_eq!(s.standby_ttl_secs, DEFAULT_STANDBY_TTL_SECS);
    }

    #[test]
    fn a_partial_patch_changes_only_what_it_names() {
        let conn = db();
        let s = Settings::save(&conn, &json!({ "enabled": true })).unwrap();
        assert!(s.enabled);
        assert_eq!(s.threshold_percent, DEFAULT_THRESHOLD_PERCENT);
        let s = Settings::save(&conn, &json!({ "threshold_percent": 55 })).unwrap();
        assert!(s.enabled, "saving a number must not flip the switch");
        assert_eq!(s.threshold_percent, 55);
        let back = Settings::load(&conn).unwrap();
        assert_eq!(back, s, "what was saved is what is read back");
    }

    #[test]
    fn every_number_is_clamped_on_the_way_in_and_on_the_way_out() {
        let conn = db();
        let s = Settings::save(
            &conn,
            &json!({ "threshold_percent": 500, "summary_tokens": 1, "temp_keep_secs": 999_999, "standby_ttl_secs": 1 }),
        )
        .unwrap();
        assert_eq!(s.threshold_percent, 90);
        assert_eq!(s.summary_tokens, 100);
        assert_eq!(s.temp_keep_secs, 3_600);
        assert_eq!(s.standby_ttl_secs, 300);

        // A hand-edited row must not be able to exceed the clamp either.
        conn.execute("UPDATE ctx_meta SET value = '999' WHERE key = 'threshold_percent'", []).unwrap();
        assert_eq!(Settings::load(&conn).unwrap().threshold_percent, 90);
        conn.execute("UPDATE ctx_meta SET value = 'lots' WHERE key = 'threshold_percent'", []).unwrap();
        assert_eq!(Settings::load(&conn).unwrap().threshold_percent, DEFAULT_THRESHOLD_PERCENT);
    }

    #[test]
    fn the_switch_is_the_same_row_the_engine_reads() {
        // `wiring::enabled` is `SELECT value FROM ctx_meta WHERE key = 'enabled'`
        // compared with "1". This test pins that exact spelling, so the screen and
        // the engine cannot drift apart into two flags.
        let conn = db();
        Settings::save(&conn, &json!({ "enabled": true })).unwrap();
        let raw: String = conn
            .query_row("SELECT value FROM ctx_meta WHERE key = 'enabled'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "1");
        let s = Settings::save(&conn, &json!({ "enabled": false })).unwrap();
        assert!(s.enabled, "there is no off");
        let raw: String = conn
            .query_row("SELECT value FROM ctx_meta WHERE key = 'enabled'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "1", "an off request is not stored");
        assert!(number(&conn, "threshold_percent").is_some());
        assert!(number(&conn, "no_such_key").is_none());
    }

    #[test]
    fn the_json_is_named_for_the_screen_not_for_the_database() {
        let s = Settings::default();
        let j = s.to_json();
        assert_eq!(j["thresholdPercent"], DEFAULT_THRESHOLD_PERCENT);
        assert_eq!(j["renderInChat"], false);
        assert!(j.get("threshold_percent").is_none(), "one spelling per field");
        assert_eq!(j["policyMode"], "off");
        assert_eq!(j["policyMaxRetries"], DEFAULT_POLICY_MAX_RETRIES);
        assert_eq!(j["policyRecentTurns"], DEFAULT_POLICY_RECENT_TURNS);
    }

    #[test]
    fn the_policy_settings_default_off_and_are_clamped() {
        let conn = db();
        let s = Settings::load(&conn).unwrap();
        assert_eq!(s.policy_mode, PolicyMode::Off, "T7-only compatibility is the default");
        let s = Settings::save(&conn, &json!({ "policy_mode": "auto", "policy_max_retries": 99, "policy_recent_turns": 0 })).unwrap();
        assert_eq!(s.policy_mode, PolicyMode::Auto);
        assert_eq!(s.policy_max_retries, 5);
        assert_eq!(s.policy_recent_turns, 1);
        assert_eq!(Settings::load(&conn).unwrap(), s);
        let s = Settings::save(&conn, &json!({ "policy_mode": "sometimes" })).unwrap();
        assert_eq!(s.policy_mode, PolicyMode::Off, "a wrong mode is off");
        conn.execute("UPDATE ctx_meta SET value = 'AUTO' WHERE key = 'policy_mode'", []).unwrap();
        conn.execute("UPDATE ctx_meta SET value = '42' WHERE key = 'policy_recent_turns'", []).unwrap();
        conn.execute("UPDATE ctx_meta SET value = 'x' WHERE key = 'policy_max_retries'", []).unwrap();
        let s = Settings::load(&conn).unwrap();
        assert_eq!(s.policy_mode, PolicyMode::Off);
        assert_eq!(s.policy_recent_turns, 10);
        assert_eq!(s.policy_max_retries, DEFAULT_POLICY_MAX_RETRIES);
    }
}
