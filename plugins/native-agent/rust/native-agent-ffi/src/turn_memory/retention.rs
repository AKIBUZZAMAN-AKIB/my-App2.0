//! Phase 6: retention of stored tool results (ADR-8, P2/P3).
//!
//! Stored originals (`tool_results`, Phase 3) used to live until the chat was
//! deleted, including the results of turns a rewind had removed. This module
//! frees them, under one rule: **a result that anything still refers to is
//! never removed.** It is a mark-and-sweep over the chat's own rows:
//!
//! * mark: a result is referenced when its `tool_use_id` or its `#R<n>` appears
//!   in a transcript message, the live memory, any kept memory version (so a
//!   revert keeps working), an archived turn, a quarantined memory row, a part
//!   of a background job, or another referenced result; or when it belongs to
//!   a turn an active background job covers;
//! * sweep: an unreferenced result older than the grace period is pruned when
//!   it has been unreferenced for longer than the keep window, or, oldest
//!   first, while the chat's stored results are over the storage budget.
//!
//! Pruning keeps the row and its number: the content is replaced by a short
//! stub that says what happened, and `pruned_at` / `pruned_reason` /
//! `pruned_bytes` record it. Numbers are therefore never reused (an old `#R5`
//! can never point at a new result), an older build reading the row shows the
//! honest stub, and the UI and recall can say "removed by cleanup" instead of
//! a bare "unavailable". Everything runs in one IMMEDIATE transaction: a crash
//! or an error leaves every row as it was. Any reference source that cannot be
//! read aborts the run and deletes nothing.

use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Default storage budget for one chat's stored results.
pub const DEFAULT_RESULT_BUDGET_BYTES: u64 = 64 * 1024 * 1024;
pub const MIN_RESULT_BUDGET_BYTES: u64 = 1024 * 1024;
pub const MAX_RESULT_BUDGET_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Default days an unreferenced result is kept while the chat is under budget.
pub const DEFAULT_KEEP_UNREFERENCED_DAYS: u32 = 7;
pub const MAX_KEEP_UNREFERENCED_DAYS: u32 = 365;
/// A result younger than this is never pruned, referenced or not: it may
/// belong to a turn whose transcript is not saved yet (git gc's
/// `gc.pruneExpire` grace period, for the same race).
pub const GRACE_MS: i64 = 60 * 60 * 1000;
/// Automatic runs after a turn happen at most this often per chat, unless
/// the chat is over budget.
pub const AUTO_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Policy {
    pub budget_bytes: u64,
    pub keep_unreferenced_ms: i64,
    pub grace_ms: i64,
}

impl Policy {
    pub fn from_settings(s: &MemorySettings) -> Self {
        Policy { budget_bytes: s.result_budget_bytes, keep_unreferenced_ms: s.keep_unreferenced_result_days as i64 * DAY_MS, grace_ms: GRACE_MS }
    }
}

impl Default for Policy {
    fn default() -> Self {
        Policy { budget_bytes: DEFAULT_RESULT_BUDGET_BYTES, keep_unreferenced_ms: DEFAULT_KEEP_UNREFERENCED_DAYS as i64 * DAY_MS, grace_ms: GRACE_MS }
    }
}

/// One stored result as the sweep sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultState {
    pub id: String,
    pub tool_name: String,
    pub bytes: u64,
    pub turn: Option<u32>,
    pub created_at: i64,
    /// Where it is referenced from ("transcript", "memory", "version 7",
    /// "archive", "job", "result #R3", ...); empty when nothing refers to it.
    pub referenced_by: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub dry_run: bool,
    pub budget_bytes: u64,
    /// Live (not pruned) results before this run.
    pub live_results: usize,
    pub live_bytes: u64,
    pub referenced_results: usize,
    pub referenced_bytes: u64,
    pub unreferenced_results: usize,
    pub unreferenced_bytes: u64,
    /// Pruned by this run (or, in a dry run, that would be).
    pub pruned: Vec<String>,
    pub pruned_bytes: u64,
    /// Live bytes after this run.
    pub bytes_after: u64,
    /// Still over budget after pruning everything allowed: what is left is
    /// referenced (or too young) and is never removed.
    pub over_budget: bool,
    /// Unreferenced results kept, with the reason ("younger than the grace
    /// period", "kept for 7 days after it stopped being referenced").
    pub kept_unreferenced: Vec<(String, String)>,
    pub results: Vec<ResultState>,
}

/// What the chat's reference sources mention.
#[derive(Default)]
struct Marks {
    /// tool_use_id → where.
    ids: HashMap<String, Vec<String>>,
    /// result number → where.
    nos: HashMap<u64, Vec<String>>,
    /// Turn ranges of active background jobs.
    job_ranges: Vec<(u32, u32)>,
}

impl Marks {
    /// Record every candidate tool_use_id and every `#R<n>` in `text`.
    /// Tool-use IDs are matched exactly, as a JSON string (`"toolu_1"`, also
    /// when the JSON is itself escaped inside a string) or as a bare token.
    /// A false match keeps a result, never removes one.
    fn scan(&mut self, text: &str, candidates: &HashSet<String>, place: &str) {
        for n in referenced_result_ids(text) {
            push_place(self.nos.entry(n).or_default(), place);
        }
        if candidates.is_empty() {
            return;
        }
        let mut hit = |tok: &str| {
            if !tok.is_empty() && candidates.contains(tok) {
                push_place(self.ids.entry(tok.to_string()).or_default(), place);
            }
        };
        for seg in text.split('"') {
            hit(seg.trim_matches('\\'));
        }
        for tok in text.split(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))) {
            hit(tok);
        }
    }
}

fn push_place(v: &mut Vec<String>, place: &str) {
    if v.len() < 8 && !v.iter().any(|p| p == place) {
        v.push(place.to_string());
    }
}

struct Row {
    no: u64,
    tool_use_id: String,
    tool_name: String,
    bytes: u64,
    turn: Option<u32>,
    created_at: i64,
}

fn live_rows(conn: &Connection, key: &str) -> rusqlite::Result<Vec<Row>> {
    let mut st = conn.prepare("SELECT result_no, tool_use_id, tool_name, bytes, turn_no, created_at FROM tool_results WHERE session_key = ?1 AND pruned_at IS NULL ORDER BY created_at, result_no")?;
    let rows = st.query_map([key], |r| {
        Ok(Row {
            no: r.get::<_, i64>(0)? as u64,
            tool_use_id: r.get(1)?,
            tool_name: r.get(2)?,
            bytes: r.get::<_, i64>(3)?.max(0) as u64,
            turn: r.get::<_, Option<i64>>(4)?.map(|t| t.max(0) as u32),
            created_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Read every reference source of the chat. Any error aborts (the caller
/// then removes nothing).
fn mark(conn: &Connection, key: &str, rows: &[Row]) -> rusqlite::Result<Marks> {
    let candidates: HashSet<String> = rows.iter().map(|r| r.tool_use_id.clone()).collect();
    let mut m = Marks::default();
    let each = |sql: &str, place: &dyn Fn(&rusqlite::Row) -> rusqlite::Result<String>, m: &mut Marks| -> rusqlite::Result<()> {
        let mut st = conn.prepare(sql)?;
        let mut q = st.query([key])?;
        while let Some(r) = q.next()? {
            let text: Option<String> = r.get(0)?;
            let where_ = place(r)?;
            if let Some(t) = text {
                m.scan(&t, &candidates, &where_);
            }
        }
        Ok(())
    };
    // The transcript: content, and the tool_call_id column for completeness.
    each("SELECT content FROM messages WHERE session_key = ?1", &|_| Ok("transcript".into()), &mut m)?;
    each("SELECT tool_call_id FROM messages WHERE session_key = ?1 AND tool_call_id IS NOT NULL", &|_| Ok("transcript".into()), &mut m)?;
    each("SELECT memory_json FROM turn_memory WHERE session_key = ?1", &|_| Ok("memory".into()), &mut m)?;
    each("SELECT memory_json, version FROM turn_memory_versions WHERE session_key = ?1", &|r| Ok(format!("version {}", r.get::<_, i64>(1)?)), &mut m)?;
    each("SELECT detail_json, version FROM turn_memory_versions WHERE session_key = ?1", &|r| Ok(format!("version {}", r.get::<_, i64>(1)?)), &mut m)?;
    each("SELECT messages_json FROM turn_archive WHERE session_key = ?1", &|_| Ok("archive".into()), &mut m)?;
    each("SELECT memory_json FROM turn_memory_quarantine WHERE session_key = ?1", &|_| Ok("quarantine".into()), &mut m)?;
    each("SELECT output_text FROM memory_job_parts WHERE session_key = ?1", &|_| Ok("job".into()), &mut m)?;
    let mut st = conn.prepare("SELECT from_turn, to_turn FROM memory_jobs WHERE session_key = ?1 AND status IN ('queued', 'running')")?;
    m.job_ranges = st.query_map([key], |r| Ok((r.get::<_, i64>(0)?.max(0) as u32, r.get::<_, i64>(1)?.max(0) as u32)))?.collect::<rusqlite::Result<_>>()?;
    // Results referenced only by another referenced result (a stored recall
    // output that cites #R3): follow to a fixpoint.
    let mut seen: HashSet<u64> = HashSet::new();
    loop {
        let by_no: HashMap<u64, &Row> = rows.iter().map(|r| (r.no, r)).collect();
        let next: Vec<u64> = rows
            .iter()
            .filter(|r| !seen.contains(&r.no) && (m.ids.contains_key(&r.tool_use_id) || m.nos.contains_key(&r.no) || in_job(&m.job_ranges, r.turn)))
            .map(|r| r.no)
            .collect();
        if next.is_empty() {
            break;
        }
        for no in next {
            seen.insert(no);
            let Some(r) = by_no.get(&no) else { continue };
            let content: Option<String> = conn
                .query_row("SELECT content FROM tool_results WHERE session_key = ?1 AND result_no = ?2", params![key, no as i64], |x| x.get(0))
                .optional()?;
            for n in referenced_result_ids(content.as_deref().unwrap_or("")) {
                if n != r.no {
                    push_place(m.nos.entry(n).or_default(), &format!("result #R{}", r.no));
                }
            }
        }
    }
    Ok(m)
}

fn in_job(ranges: &[(u32, u32)], turn: Option<u32>) -> bool {
    match turn {
        // A result with no turn while a job runs: keep it.
        None => !ranges.is_empty(),
        Some(t) => ranges.iter().any(|(a, b)| t >= *a && t <= *b),
    }
}

/// The text a pruned row keeps, read by older builds as the result itself.
pub fn stub_text(id: &str, at_ms: i64, reason: &str) -> String {
    let day = chrono::DateTime::from_timestamp_millis(at_ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
    format!("[result #{} was removed by storage cleanup on {}: {}. Its content is no longer stored; run the tool again if it is needed.]", id, day, reason)
}

pub const REASON_UNREFERENCED: &str = "nothing in this chat referred to it any more";
pub const REASON_BUDGET: &str = "nothing in this chat referred to it any more and the chat was over its storage budget";

/// Classify and (unless `dry_run`) prune one chat's results. One IMMEDIATE
/// transaction; on any error nothing changes.
pub fn prune_results(conn: &Connection, key: &str, policy: Policy, now_ms: i64, dry_run: bool) -> Result<Report, String> {
    ensure_tables(conn).map_err(|e| e.to_string())?;
    let run = |c: &Connection| -> rusqlite::Result<Report> {
        let rows = live_rows(c, key)?;
        let marks = mark(c, key, &rows)?;
        let mut rep = Report { dry_run, budget_bytes: policy.budget_bytes, ..Default::default() };
        let mut eligible: Vec<(&Row, bool)> = Vec::new(); // (row, past keep window)
        for r in &rows {
            rep.live_results += 1;
            rep.live_bytes += r.bytes;
            let mut by: Vec<String> = Vec::new();
            for p in marks.ids.get(&r.tool_use_id).into_iter().flatten().chain(marks.nos.get(&r.no).into_iter().flatten()) {
                push_place(&mut by, p);
            }
            if in_job(&marks.job_ranges, r.turn) {
                push_place(&mut by, "active background job");
            }
            let id = format!("R{}", r.no);
            if by.is_empty() {
                rep.unreferenced_results += 1;
                rep.unreferenced_bytes += r.bytes;
                let age = now_ms - r.created_at;
                if age < policy.grace_ms {
                    rep.kept_unreferenced.push((id.clone(), "younger than the grace period".into()));
                } else {
                    eligible.push((r, age >= policy.keep_unreferenced_ms));
                }
            } else {
                rep.referenced_results += 1;
                rep.referenced_bytes += r.bytes;
            }
            rep.results.push(ResultState { id, tool_name: r.tool_name.clone(), bytes: r.bytes, turn: r.turn, created_at: r.created_at, referenced_by: by });
        }
        // Sweep: everything past the keep window, then oldest first while over budget.
        let mut live = rep.live_bytes;
        let mut chosen: Vec<(&Row, &str)> = Vec::new();
        for (r, expired) in &eligible {
            if *expired {
                chosen.push((r, REASON_UNREFERENCED));
                live -= r.bytes;
            }
        }
        for (r, expired) in &eligible {
            if !*expired {
                if live > policy.budget_bytes {
                    chosen.push((r, REASON_BUDGET));
                    live -= r.bytes;
                } else {
                    rep.kept_unreferenced.push((format!("R{}", r.no), format!("kept for {} days after it stopped being referenced", policy.keep_unreferenced_ms / DAY_MS)));
                }
            }
        }
        for (i, (r, reason)) in chosen.iter().enumerate() {
            let id = format!("R{}", r.no);
            if !dry_run {
                let stub = stub_text(&id, now_ms, reason);
                let n = c.execute(
                    "UPDATE tool_results SET content = ?3, bytes = ?4, pruned_at = ?5, pruned_reason = ?6, pruned_bytes = ?7 WHERE session_key = ?1 AND result_no = ?2 AND pruned_at IS NULL",
                    params![key, r.no as i64, stub, stub.len() as i64, now_ms, reason, r.bytes as i64],
                )?;
                if n != 1 {
                    return Err(rusqlite::Error::StatementChangedRows(n));
                }
                if i == 0 {
                    failpoint("prune")?;
                }
            }
            rep.pruned.push(id);
            rep.pruned_bytes += r.bytes;
        }
        rep.bytes_after = live;
        rep.over_budget = live > policy.budget_bytes;
        if !dry_run {
            c.execute(
                "INSERT INTO memory_retention (session_key, last_run_at, last_pruned, last_pruned_bytes, live_bytes, referenced_bytes, over_budget, last_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
                 ON CONFLICT(session_key) DO UPDATE SET last_run_at = excluded.last_run_at, last_pruned = excluded.last_pruned, last_pruned_bytes = excluded.last_pruned_bytes, live_bytes = excluded.live_bytes, referenced_bytes = excluded.referenced_bytes, over_budget = excluded.over_budget, last_error = NULL",
                params![key, now_ms, rep.pruned.len() as i64, rep.pruned_bytes as i64, live as i64, rep.referenced_bytes as i64, rep.over_budget as i64],
            )?;
        }
        Ok(rep)
    };
    let res = if dry_run { run(conn) } else { write_tx(conn, run) };
    if let Err(e) = &res {
        if !dry_run {
            // Record the failure outside the rolled-back transaction.
            let _ = conn.execute(
                "INSERT INTO memory_retention (session_key, last_run_at, last_error) VALUES (?1, ?2, ?3) ON CONFLICT(session_key) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error",
                params![key, now_ms, e.to_string()],
            );
        }
    }
    res.map_err(|e| e.to_string())
}

/// The automatic run after a turn: at most every [`AUTO_INTERVAL_MS`] per
/// chat, or right away when the chat's stored results are over budget.
/// Returns `None` when it did not run.
pub fn maybe_prune(conn: &Connection, key: &str, policy: Policy, now_ms: i64) -> Option<Result<Report, String>> {
    ensure_tables(conn).ok()?;
    let live: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM tool_results WHERE session_key = ?1 AND pruned_at IS NULL", [key], |r| r.get(0)).ok()?;
    let last: Option<i64> = conn.query_row("SELECT last_run_at FROM memory_retention WHERE session_key = ?1", [key], |r| r.get(0)).optional().ok()?.flatten();
    let due = last.map(|l| now_ms - l >= AUTO_INTERVAL_MS).unwrap_or(true);
    if !due && (live as u64) <= policy.budget_bytes {
        return None;
    }
    Some(prune_results(conn, key, policy, now_ms, false))
}

/// Retention (Phase 6) after a chat's transcript was saved: the main chat
/// and every sub-agent session call this once their save succeeded, so both
/// prune stored tool results the same way. Only after the transcript that
/// references the turn's results is saved; their grace period covers the
/// rest. Throttled per chat by [`maybe_prune`]; off unless
/// `autoPruneResults` is on.
pub fn after_turn_saved(conn: &Connection, workspace_path: &str, key: &str) {
    let settings = super::load_settings(workspace_path);
    if !settings.auto_prune_results {
        return;
    }
    if let Some(Err(e)) = maybe_prune(conn, key, Policy::from_settings(&settings), chrono::Utc::now().timestamp_millis()) {
        eprintln!("retention failed for {}: {}", key, e);
    }
}

/// A cheap summary for `memory.get` (SQL sums only, no reference scan).
pub fn summary(conn: &Connection, key: &str, policy: Policy) -> Value {
    if ensure_tables(conn).is_err() {
        return Value::Null;
    }
    let (live_n, live_b): (i64, i64) = conn
        .query_row("SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM tool_results WHERE session_key = ?1 AND pruned_at IS NULL", [key], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((0, 0));
    let (pruned_n, pruned_b): (i64, i64) = conn
        .query_row("SELECT COUNT(*), COALESCE(SUM(pruned_bytes), 0) FROM tool_results WHERE session_key = ?1 AND pruned_at IS NOT NULL", [key], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((0, 0));
    let archive_b: i64 = conn.query_row("SELECT COALESCE(SUM(LENGTH(messages_json)), 0) FROM turn_archive WHERE session_key = ?1", [key], |r| r.get(0)).unwrap_or(0);
    let versions_b: i64 = conn
        .query_row("SELECT COALESCE(SUM(LENGTH(memory_json) + COALESCE(LENGTH(detail_json), 0)), 0) FROM turn_memory_versions WHERE session_key = ?1", [key], |r| r.get(0))
        .unwrap_or(0);
    let last = conn
        .query_row("SELECT last_run_at, last_pruned, last_pruned_bytes, last_error FROM memory_retention WHERE session_key = ?1", [key], |r| {
            Ok(serde_json::json!({"at": r.get::<_, Option<i64>>(0)?, "pruned": r.get::<_, Option<i64>>(1)?, "prunedBytes": r.get::<_, Option<i64>>(2)?, "error": r.get::<_, Option<String>>(3)?}))
        })
        .optional()
        .ok()
        .flatten();
    serde_json::json!({
        "resultCount": live_n,
        "resultBytes": live_b,
        "prunedCount": pruned_n,
        "prunedBytes": pruned_b,
        "archiveBytes": archive_b,
        "versionBytes": versions_b,
        "budgetBytes": policy.budget_bytes,
        "keepUnreferencedDays": policy.keep_unreferenced_ms / DAY_MS,
        "overBudget": (live_b as u64) > policy.budget_bytes,
        "lastCleanup": last,
    })
}

/// When and why a result was pruned: `(id, pruned_at, reason, original bytes)`.
pub fn pruned_info(conn: &Connection, key: &str, id: &str) -> Option<(String, i64, String, u64)> {
    let no: i64 = id.trim().trim_start_matches('#').trim_start_matches('R').parse().ok()?;
    conn.query_row(
        "SELECT pruned_at, COALESCE(pruned_reason, ''), COALESCE(pruned_bytes, 0) FROM tool_results WHERE session_key = ?1 AND result_no = ?2 AND pruned_at IS NOT NULL",
        params![key, no],
        |r| Ok((format!("R{}", no), r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?.max(0) as u64)),
    )
    .ok()
}
