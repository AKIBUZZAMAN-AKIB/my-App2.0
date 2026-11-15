//! Durable background-summary jobs (Phase 4, ADR-4).
//!
//! A job asks for one batch of turns `from..=to` to be summarized on top of
//! memory version `base_version`. It lives in `memory_jobs` so that a crash,
//! an app kill or a provider error never loses it, and a retry never makes a
//! second version:
//!
//! - **Idempotent creation.** `job_key = "{from}-{to}-{input_hash16}"` is the
//!   primary key with the chat; enqueueing the same batch again is a no-op
//!   (Stripe-style idempotency key). The same key comes back to life only
//!   when the earlier job was cancelled or superseded, or failed long ago.
//! - **Single flight.** A partial unique index allows at most one
//!   `queued`/`running` job per chat (sqlite.org/partialindex.html); batches
//!   are sequential because each one builds on the previous version.
//! - **Lease.** A worker claims a job with `BEGIN IMMEDIATE` and an expiring
//!   lease (`lease_until`), renews it while it works, and must still hold it
//!   in the transaction that saves the version (the SQS visibility-timeout
//!   pattern). An expired lease (app killed) makes the job claimable again;
//!   a cancelled or reclaimed job can never commit.
//! - **Backoff.** A failed attempt goes back to `queued` with
//!   `next_attempt_at = now + backoff(attempts)`: exponential, capped, with
//!   "equal jitter" (half fixed, half spread), after AWS's "Exponential
//!   Backoff and Jitter". After `max_attempts` the job is `failed` with its
//!   last error; the memory screen can retry it.
//! - **Parts.** Finished portion summaries of a job are kept in
//!   `memory_job_parts`, keyed by a hash of their exact prompt, so a retry
//!   only repeats the portion that failed (LangGraph "pending writes").
//!   Parts are working state: they are deleted when the job is done,
//!   cancelled or superseded, and never shown or used as memory.
//!
//! Nothing here calls a model; the worker lives in `agent_loop::memory_loop`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::types::Message;

/// How long a claim stays valid without a heartbeat.
pub const LEASE_MS: i64 = 5 * 60_000;
/// How often a running worker renews its lease.
pub const HEARTBEAT_MS: u64 = 60_000;
/// Attempts before a job is `failed` (the first run counts).
pub const MAX_ATTEMPTS: u32 = 5;
/// First retry delay before jitter; doubles per attempt.
pub const BACKOFF_BASE_MS: i64 = 10_000;
/// Largest retry delay.
pub const BACKOFF_CAP_MS: i64 = 15 * 60_000;
/// A `failed` job is queued again automatically by a later turn once this
/// long has passed since it failed (the user can also retry at once).
pub const FAILED_REQUEUE_MS: i64 = 30 * 60_000;

pub const ACTIVE: [&str; 2] = ["queued", "running"];

/// Tables of the job queue (also cleared with the chat).
pub(super) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_jobs (
            session_key TEXT NOT NULL,
            job_key TEXT NOT NULL,
            from_turn INTEGER NOT NULL,
            to_turn INTEGER NOT NULL,
            base_version INTEGER NOT NULL,
            input_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 5,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            lease_owner TEXT,
            lease_until INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            result_version INTEGER,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, job_key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS memory_jobs_one_active
            ON memory_jobs(session_key) WHERE status IN ('queued', 'running');
        CREATE INDEX IF NOT EXISTS memory_jobs_by_status ON memory_jobs(status, lease_until);
        CREATE TABLE IF NOT EXISTS memory_job_parts (
            session_key TEXT NOT NULL,
            job_key TEXT NOT NULL,
            part_no INTEGER NOT NULL,
            part_hash TEXT NOT NULL,
            output_text TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_key, job_key, part_no)
        );",
    )
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub session_key: String,
    pub job_key: String,
    pub from_turn: u32,
    pub to_turn: u32,
    pub base_version: u64,
    pub input_hash: String,
    pub status: String,
    pub attempts: u32,
    pub max_attempts: u32,
    pub next_attempt_at: i64,
    pub lease_owner: Option<String>,
    pub lease_until: i64,
    pub last_error: Option<String>,
    pub result_version: Option<u64>,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLS: &str = "session_key, job_key, from_turn, to_turn, base_version, input_hash, status, attempts, max_attempts, next_attempt_at, lease_owner, lease_until, last_error, result_version, created_at, updated_at";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        session_key: r.get(0)?,
        job_key: r.get(1)?,
        from_turn: r.get::<_, i64>(2)?.max(0) as u32,
        to_turn: r.get::<_, i64>(3)?.max(0) as u32,
        base_version: r.get::<_, i64>(4)?.max(0) as u64,
        input_hash: r.get(5)?,
        status: r.get(6)?,
        attempts: r.get::<_, i64>(7)?.max(0) as u32,
        max_attempts: r.get::<_, i64>(8)?.max(1) as u32,
        next_attempt_at: r.get(9)?,
        lease_owner: r.get(10)?,
        lease_until: r.get(11)?,
        last_error: r.get(12)?,
        result_version: r.get::<_, Option<i64>>(13)?.map(|v| v.max(0) as u64),
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

/// Hash of the exact input of a batch: every message of turns `from..=to`.
/// A rewind or an edit changes it, so a job made for other text is never
/// committed (it is `superseded`).
pub fn input_hash(turns: &[(u32, Vec<Message>)]) -> String {
    let mut h = Sha256::new();
    for (no, msgs) in turns {
        h.update(no.to_le_bytes());
        h.update(serde_json::to_vec(msgs).unwrap_or_default());
        h.update([0u8]);
    }
    hex(&h.finalize())
}

pub fn text_hash(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

pub fn job_key(from: u32, to: u32, input_hash: &str) -> String {
    format!("{}-{}-{}", from, to, &input_hash[..input_hash.len().min(16)])
}

/// Retry delay after `attempts` failed attempts (1-based): exponential from
/// `BACKOFF_BASE_MS`, capped at `BACKOFF_CAP_MS`, then "equal jitter": half
/// of it fixed, the other half spread by a hash of the job and attempt, so
/// many chats that failed together do not retry together, and the result is
/// deterministic for tests.
pub fn backoff_ms(attempts: u32, job_key: &str) -> i64 {
    let exp = BACKOFF_BASE_MS.saturating_mul(1i64 << attempts.saturating_sub(1).min(20)).min(BACKOFF_CAP_MS);
    let half = exp / 2;
    let spread = u64::from_le_bytes(Sha256::digest(format!("{}#{}", job_key, attempts).as_bytes())[..8].try_into().unwrap_or([0; 8]));
    half + (spread % (half as u64 + 1)) as i64
}

#[derive(Debug, PartialEq)]
pub enum Enqueued {
    /// A new job (or a cancelled/superseded/old failed one made queued again).
    Queued(String),
    /// The same job already exists (queued, running, done, or recently failed).
    Exists { job_key: String, status: String },
    /// Another job of this chat is active; this one waits for it.
    Busy,
}

/// Enqueue the summary of turns `from..=to` on top of `base_version`.
/// Idempotent by `job_key`.
pub fn enqueue(conn: &Connection, session_key: &str, from: u32, to: u32, base_version: u64, input_hash: &str, now_ms: i64) -> rusqlite::Result<Enqueued> {
    super::ensure_tables(conn)?;
    let key = job_key(from, to, input_hash);
    let res = super::write_tx(conn, |tx| {
        let changed = tx.execute(
            &format!(
                "INSERT INTO memory_jobs ({}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, ?7, ?8, NULL, 0, NULL, NULL, ?8, ?8)
                 ON CONFLICT(session_key, job_key) DO UPDATE SET
                    status = 'queued', attempts = 0, base_version = excluded.base_version, next_attempt_at = excluded.next_attempt_at,
                    lease_owner = NULL, lease_until = 0, last_error = NULL, result_version = NULL, updated_at = excluded.updated_at
                 WHERE memory_jobs.status IN ('cancelled', 'superseded')
                    OR (memory_jobs.status = 'failed' AND memory_jobs.updated_at < ?9)",
                COLS
            ),
            params![session_key, key, from as i64, to as i64, base_version as i64, input_hash, MAX_ATTEMPTS as i64, now_ms, now_ms - FAILED_REQUEUE_MS],
        )?;
        if changed > 0 {
            return Ok(Enqueued::Queued(key.clone()));
        }
        let status: String = tx.query_row("SELECT status FROM memory_jobs WHERE session_key = ?1 AND job_key = ?2", params![session_key, key], |r| r.get(0))?;
        Ok(Enqueued::Exists { job_key: key.clone(), status })
    });
    match res {
        // The partial unique index: another job of this chat is active.
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => Ok(Enqueued::Busy),
        other => other,
    }
}

const CLAIMABLE: &str = "((status = 'queued' AND next_attempt_at <= ?2) OR (status = 'running' AND lease_until < ?2))";

/// Claim the next runnable job of a chat for `owner`: a queued job whose
/// retry time has come, or a running job whose lease expired (its worker
/// died). Counts the attempt. A job out of attempts becomes `failed`.
pub fn claim(conn: &Connection, session_key: &str, owner: &str, now_ms: i64, lease_ms: i64) -> rusqlite::Result<Option<Job>> {
    super::ensure_tables(conn)?;
    super::write_tx(conn, |tx| {
        loop {
            let job: Option<Job> = tx
                .query_row(&format!("SELECT {} FROM memory_jobs WHERE session_key = ?1 AND {} ORDER BY from_turn LIMIT 1", COLS, CLAIMABLE), params![session_key, now_ms], row)
                .optional()?;
            let Some(job) = job else { return Ok(None) };
            if job.attempts >= job.max_attempts {
                let why = format!("gave up after {} attempts{}", job.attempts, job.last_error.as_deref().map(|e| format!(": {}", e)).unwrap_or_default());
                tx.execute(
                    "UPDATE memory_jobs SET status = 'failed', lease_owner = NULL, last_error = ?3, updated_at = ?4 WHERE session_key = ?1 AND job_key = ?2",
                    params![session_key, job.job_key, why, now_ms],
                )?;
                continue;
            }
            tx.execute(
                "UPDATE memory_jobs SET status = 'running', lease_owner = ?3, lease_until = ?4, attempts = attempts + 1, updated_at = ?5 WHERE session_key = ?1 AND job_key = ?2",
                params![session_key, job.job_key, owner, now_ms + lease_ms, now_ms],
            )?;
            return tx.query_row(&format!("SELECT {} FROM memory_jobs WHERE session_key = ?1 AND job_key = ?2", COLS), params![session_key, job.job_key], row).optional();
        }
    })
}

/// Is a job of this chat runnable now (or will one be, and when)?
/// `Some(0)` = now; `Some(t)` = at `t`; `None` = no active job.
pub fn next_due(conn: &Connection, session_key: &str, now_ms: i64) -> Option<i64> {
    super::ensure_tables(conn).ok()?;
    conn.query_row(
        "SELECT CASE WHEN status = 'queued' THEN next_attempt_at ELSE lease_until END FROM memory_jobs WHERE session_key = ?1 AND status IN ('queued', 'running')",
        [session_key],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(|t| if t <= now_ms { 0 } else { t })
}

/// Renew the lease. False when the job is no longer this worker's (it was
/// cancelled, superseded or reclaimed): the worker must stop.
pub fn heartbeat(conn: &Connection, session_key: &str, job_key: &str, owner: &str, now_ms: i64, lease_ms: i64) -> bool {
    super::write_tx(conn, |tx| {
        tx.execute(
            "UPDATE memory_jobs SET lease_until = ?4, updated_at = ?5 WHERE session_key = ?1 AND job_key = ?2 AND lease_owner = ?3 AND status = 'running'",
            params![session_key, job_key, owner, now_ms + lease_ms, now_ms],
        )
    })
    .map(|n| n == 1)
    .unwrap_or(false)
}

/// Still running and owned by `owner`?
pub fn holds(conn: &Connection, session_key: &str, job_key: &str, owner: &str) -> bool {
    conn.query_row("SELECT 1 FROM memory_jobs WHERE session_key = ?1 AND job_key = ?2 AND lease_owner = ?3 AND status = 'running'", params![session_key, job_key, owner], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// Mark the job done inside the caller's transaction (the one that saves
/// the version). False when the lease is gone: the caller rolls back.
pub fn finish_in(tx: &Connection, session_key: &str, job_key: &str, owner: &str, version: Option<u64>, now_ms: i64) -> rusqlite::Result<bool> {
    let n = tx.execute(
        "UPDATE memory_jobs SET status = 'done', result_version = ?4, lease_owner = NULL, last_error = NULL, updated_at = ?5 WHERE session_key = ?1 AND job_key = ?2 AND lease_owner = ?3 AND status = 'running'",
        params![session_key, job_key, owner, version.map(|v| v as i64), now_ms],
    )?;
    if n == 1 {
        tx.execute("DELETE FROM memory_job_parts WHERE session_key = ?1 AND job_key = ?2", params![session_key, job_key])?;
    }
    Ok(n == 1)
}

/// `finish_in` in its own transaction (nothing to save: already done).
pub fn finish(conn: &Connection, session_key: &str, job_key: &str, owner: &str, version: Option<u64>, now_ms: i64) -> rusqlite::Result<bool> {
    super::write_tx(conn, |tx| finish_in(tx, session_key, job_key, owner, version, now_ms))
}

/// A failed attempt: back to `queued` with a backoff delay, or `failed`
/// when attempts ran out. Returns the job as it is now (None when the lease
/// was gone: someone else owns or cancelled it).
pub fn fail(conn: &Connection, session_key: &str, job_key: &str, owner: &str, error: &str, now_ms: i64) -> rusqlite::Result<Option<Job>> {
    let error = super::clip(error, 500);
    super::write_tx(conn, |tx| {
        let job: Option<Job> = tx
            .query_row(&format!("SELECT {} FROM memory_jobs WHERE session_key = ?1 AND job_key = ?2 AND lease_owner = ?3 AND status = 'running'", COLS), params![session_key, job_key, owner], row)
            .optional()?;
        let Some(job) = job else { return Ok(None) };
        if job.attempts >= job.max_attempts {
            tx.execute(
                "UPDATE memory_jobs SET status = 'failed', lease_owner = NULL, lease_until = 0, last_error = ?3, updated_at = ?4 WHERE session_key = ?1 AND job_key = ?2",
                params![session_key, job_key, error, now_ms],
            )?;
        } else {
            let at = now_ms + backoff_ms(job.attempts, job_key);
            tx.execute(
                "UPDATE memory_jobs SET status = 'queued', lease_owner = NULL, lease_until = 0, last_error = ?3, next_attempt_at = ?4, updated_at = ?5 WHERE session_key = ?1 AND job_key = ?2",
                params![session_key, job_key, error, at, now_ms],
            )?;
        }
        tx.query_row(&format!("SELECT {} FROM memory_jobs WHERE session_key = ?1 AND job_key = ?2", COLS), params![session_key, job_key], row).optional()
    })
}

/// The batch's text changed (or its checkpoint moved on): the job can never
/// be committed. Its parts go.
pub fn supersede(conn: &Connection, session_key: &str, job_key: &str, owner: &str, reason: &str, now_ms: i64) -> rusqlite::Result<bool> {
    super::write_tx(conn, |tx| {
        let n = tx.execute(
            "UPDATE memory_jobs SET status = 'superseded', lease_owner = NULL, last_error = ?4, updated_at = ?5 WHERE session_key = ?1 AND job_key = ?2 AND lease_owner = ?3 AND status = 'running'",
            params![session_key, job_key, owner, reason, now_ms],
        )?;
        tx.execute("DELETE FROM memory_job_parts WHERE session_key = ?1 AND job_key = ?2", params![session_key, job_key])?;
        Ok(n == 1)
    })
}

/// Cancel every active job of a chat (rewind, reset, revert). Composes with
/// the caller's transaction. Their parts are deleted: they may hold text of
/// turns that were just removed. Returns how many were cancelled.
pub fn cancel_active(conn: &Connection, session_key: &str, reason: &str, now_ms: i64) -> rusqlite::Result<usize> {
    super::write_tx(conn, |tx| {
        tx.execute(
            "DELETE FROM memory_job_parts WHERE session_key = ?1 AND job_key IN (SELECT job_key FROM memory_jobs WHERE session_key = ?1 AND status IN ('queued', 'running'))",
            [session_key],
        )?;
        tx.execute(
            "UPDATE memory_jobs SET status = 'cancelled', lease_owner = NULL, lease_until = 0, last_error = ?2, updated_at = ?3 WHERE session_key = ?1 AND status IN ('queued', 'running')",
            params![session_key, reason, now_ms],
        )
    })
}

/// Make a failed (or waiting) job of the chat runnable now, attempts reset
/// ("retry" on the memory screen). Returns the job key when one was found.
pub fn retry_now(conn: &Connection, session_key: &str, now_ms: i64) -> rusqlite::Result<Option<String>> {
    super::ensure_tables(conn)?;
    super::write_tx(conn, |tx| {
        if let Some(k) = tx
            .query_row("SELECT job_key FROM memory_jobs WHERE session_key = ?1 AND status = 'queued'", [session_key], |r| r.get::<_, String>(0))
            .optional()?
        {
            tx.execute("UPDATE memory_jobs SET next_attempt_at = ?3, attempts = 0, updated_at = ?3 WHERE session_key = ?1 AND job_key = ?2", params![session_key, k, now_ms])?;
            return Ok(Some(k));
        }
        if tx.query_row("SELECT 1 FROM memory_jobs WHERE session_key = ?1 AND status = 'running'", [session_key], |_| Ok(())).optional()?.is_some() {
            return Ok(None);
        }
        let failed: Option<String> = tx
            .query_row("SELECT job_key FROM memory_jobs WHERE session_key = ?1 AND status = 'failed' ORDER BY updated_at DESC LIMIT 1", [session_key], |r| r.get(0))
            .optional()?;
        if let Some(k) = &failed {
            tx.execute(
                "UPDATE memory_jobs SET status = 'queued', attempts = 0, next_attempt_at = ?3, last_error = NULL, updated_at = ?3 WHERE session_key = ?1 AND job_key = ?2",
                params![session_key, k, now_ms],
            )?;
        }
        Ok(failed)
    })
}

/// Startup recovery: running jobs whose lease expired (the app was killed
/// while they ran) become queued and runnable now. All chats. Their
/// attempt was already counted at claim time, so a job that crashes the
/// app every time still ends as `failed`.
pub fn recover_expired(conn: &Connection, now_ms: i64) -> rusqlite::Result<usize> {
    super::ensure_tables(conn)?;
    super::write_tx(conn, |tx| {
        tx.execute(
            "UPDATE memory_jobs SET status = 'queued', lease_owner = NULL, lease_until = 0, next_attempt_at = ?1, last_error = COALESCE(last_error, 'interrupted (the app stopped while it ran)'), updated_at = ?1 WHERE status = 'running' AND lease_until < ?1",
            [now_ms],
        )
    })
}

/// Startup recovery by owner: every running job whose lease owner is not of
/// this process (`owner_prefix`) belonged to a process that is gone, so it
/// is queued again at once instead of waiting for its lease to run out.
pub fn recover_not_owned_by(conn: &Connection, owner_prefix: &str, now_ms: i64) -> rusqlite::Result<usize> {
    super::ensure_tables(conn)?;
    super::write_tx(conn, |tx| {
        tx.execute(
            "UPDATE memory_jobs SET status = 'queued', lease_owner = NULL, lease_until = 0, next_attempt_at = ?1, last_error = COALESCE(last_error, 'interrupted (the app stopped while it ran)'), updated_at = ?1 WHERE status = 'running' AND (lease_owner IS NULL OR substr(lease_owner, 1, length(?2)) != ?2)",
            params![now_ms, owner_prefix],
        )
    })
}

pub fn get(conn: &Connection, session_key: &str, job_key: &str) -> Option<Job> {
    conn.query_row(&format!("SELECT {} FROM memory_jobs WHERE session_key = ?1 AND job_key = ?2", COLS), params![session_key, job_key], row).optional().ok().flatten()
}

/// Jobs of a chat, newest first.
pub fn list(conn: &Connection, session_key: &str, limit: usize) -> Vec<Job> {
    if super::ensure_tables(conn).is_err() {
        return Vec::new();
    }
    let Ok(mut stmt) = conn.prepare(&format!("SELECT {} FROM memory_jobs WHERE session_key = ?1 ORDER BY updated_at DESC, from_turn DESC LIMIT ?2", COLS)) else {
        return Vec::new();
    };
    stmt.query_map(params![session_key, limit as i64], row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// The active job of a chat, if any.
pub fn active(conn: &Connection, session_key: &str) -> Option<Job> {
    super::ensure_tables(conn).ok()?;
    conn.query_row(&format!("SELECT {} FROM memory_jobs WHERE session_key = ?1 AND status IN ('queued', 'running')", COLS), [session_key], row).optional().ok().flatten()
}

/// A finished portion of a job, when its prompt hash still matches.
pub fn get_part(conn: &Connection, session_key: &str, job_key: &str, part_no: u32, part_hash: &str) -> Option<String> {
    conn.query_row(
        "SELECT output_text FROM memory_job_parts WHERE session_key = ?1 AND job_key = ?2 AND part_no = ?3 AND part_hash = ?4",
        params![session_key, job_key, part_no as i64, part_hash],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Keep a finished portion, only while the job is still active.
pub fn put_part(conn: &Connection, session_key: &str, job_key: &str, part_no: u32, part_hash: &str, text: &str, now_ms: i64) -> rusqlite::Result<bool> {
    super::write_tx(conn, |tx| {
        let n = tx.execute(
            "INSERT INTO memory_job_parts (session_key, job_key, part_no, part_hash, output_text, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM memory_jobs WHERE session_key = ?1 AND job_key = ?2 AND status IN ('queued', 'running'))
             ON CONFLICT(session_key, job_key, part_no) DO UPDATE SET part_hash = excluded.part_hash, output_text = excluded.output_text, created_at = excluded.created_at",
            params![session_key, job_key, part_no as i64, part_hash, text, now_ms],
        )?;
        Ok(n == 1)
    })
}

pub fn part_count(conn: &Connection, session_key: &str, job_key: &str) -> usize {
    conn.query_row("SELECT COUNT(*) FROM memory_job_parts WHERE session_key = ?1 AND job_key = ?2", params![session_key, job_key], |r| r.get::<_, i64>(0)).map(|n| n as usize).unwrap_or(0)
}

/// Where finished portions of a summary are kept between attempts.
pub trait PartCache: Send + Sync {
    fn get(&self, part_no: u32, part_hash: &str) -> Option<String>;
    fn put(&self, part_no: u32, part_hash: &str, text: &str);
}

/// `PartCache` over the database file (a short connection per call, so the
/// cache is `Sync` and holds no connection across a model call).
pub struct DbPartCache {
    pub db_path: String,
    pub session_key: String,
    pub job_key: String,
}

impl PartCache for DbPartCache {
    fn get(&self, part_no: u32, part_hash: &str) -> Option<String> {
        let conn = crate::db::open_db(&self.db_path).ok()?;
        get_part(&conn, &self.session_key, &self.job_key, part_no, part_hash)
    }
    fn put(&self, part_no: u32, part_hash: &str, text: &str) {
        if let Ok(conn) = crate::db::open_db(&self.db_path) {
            let _ = put_part(&conn, &self.session_key, &self.job_key, part_no, part_hash, text, chrono::Utc::now().timestamp_millis());
        }
    }
}
