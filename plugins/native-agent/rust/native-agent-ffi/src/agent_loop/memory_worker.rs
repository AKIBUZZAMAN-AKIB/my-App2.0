//! Background summaries (Phase 4, ADR-4): the in-process worker that runs
//! the durable jobs of `turn_memory::jobs` on the existing Tokio runtime.
//!
//! - The user's turn never waits for a summary: `memory_loop::apply` only
//!   queues the next due batch and folds with the latest *committed*
//!   version; every turn after it reaches the model as its original.
//! - One worker per chat in this process (`WORKERS`), and at most one
//!   active job per chat in the database (partial unique index), so batches
//!   run one after another, each on top of the version before it.
//! - A job reads the stored transcript (`messages`, the source of truth),
//!   checks that the turns still hash to the job's `input_hash`, and saves
//!   its version and marks itself `done` in one transaction, only while it
//!   still holds its lease. A rewind/reset/clear cancels it in the database
//!   (same transaction as the change) and here (`cancel`), so its model call
//!   stops and nothing it produced is saved.
//! - A worker that dies (app killed) leaves an expiring lease; the next
//!   worker claims the job when the lease ends, and `recover_orphans` at
//!   startup frees jobs of an earlier process at once.

use super::memory_loop::{Abort, RouteTextModel};
use super::{RoutePlan, WebLlmPending};
use crate::event_bus;
use crate::runtime_config::AgentRuntimeConfig;
use crate::tokens::TokenMeter;
use crate::turn_memory::{self as tm, commit, jobs, results};
use crate::types::Message;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

/// Everything a job needs that outlives the turn that queued it.
pub(crate) struct WorkerEnv {
    pub(super) db_path: String,
    pub(super) workspace_path: String,
    pub(super) session_key: String,
    pub(super) callback: Option<Arc<dyn crate::NativeEventCallback>>,
    pub(super) route_plan: RoutePlan,
    pub(super) runtime_config: AgentRuntimeConfig,
    pub(super) webllm_pending: WebLlmPending,
    pub(super) meter: TokenMeter,
    pub(super) context_budget: usize,
    pub(super) max_output: u32,
}

struct Slot {
    generation: u64,
    abort: Arc<AtomicBool>,
    wake: Arc<Notify>,
}

static WORKERS: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// The last model route each chat used, so the memory screen's "retry" can
/// start a job before the next turn.
static ENVS: LazyLock<Mutex<HashMap<String, Arc<WorkerEnv>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static GENERATION: AtomicU64 = AtomicU64::new(1);
/// This process: lease owners are `"{INSTANCE}#{generation}"`.
pub(crate) static INSTANCE: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().simple().to_string());

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Messages of turns `from..=to` of the stored transcript.
pub(crate) fn slices_of(messages: &[Message], turns: &[tm::Turn], from: u32, to: u32) -> Vec<(u32, Vec<Message>)> {
    turns[(from - 1) as usize..to as usize].iter().map(|t| (t.no, messages[t.start..t.end].to_vec())).collect()
}

/// Plan from the stored transcript and queue the first due batch.
/// Idempotent: the same batch is never queued twice. `complete_hint` is the
/// number of complete turns the running turn sees (its own prompt is not
/// stored yet, so every stored turn is complete); without it the last
/// stored turn is treated as possibly unfinished.
pub(crate) fn enqueue_due(conn: &rusqlite::Connection, session_key: &str, workspace_path: &str, complete_hint: Option<u32>, now: i64) -> Option<jobs::Enqueued> {
    let settings = tm::load_settings(workspace_path);
    if !settings.enabled {
        return None;
    }
    let messages = crate::db::load_session_messages_raw(conn, session_key).ok()?;
    let turns = tm::split_turns(&messages);
    let stored = turns.len() as u32;
    let complete = match complete_hint {
        Some(c) => c.min(stored),
        None => stored.saturating_sub(1),
    };
    if complete == 0 {
        return None;
    }
    let mem = tm::load_memory(conn, session_key);
    if mem.from_newer_build() || mem.unreadable && mem.through_turn > 0 || mem.through_turn > complete {
        return None;
    }
    let (from, to) = *tm::plan_batches(complete, mem.through_turn, &settings).first()?;
    let hash = jobs::input_hash(&slices_of(&messages, &turns, from, to));
    jobs::enqueue(conn, session_key, from, to, mem.version, &hash, now).ok()
}

/// Queue what is due for the chat and make sure its worker runs.
pub(crate) fn queue_and_kick(env: Arc<WorkerEnv>, complete: u32, handle: &tokio::runtime::Handle) -> Option<jobs::Enqueued> {
    let queued = crate::db::open_db(&env.db_path).ok().and_then(|c| enqueue_due(&c, &env.session_key, &env.workspace_path, Some(complete), now_ms()));
    kick(env, handle);
    queued
}

/// Start the chat's worker, or wake it when it already runs.
pub(crate) fn kick(env: Arc<WorkerEnv>, handle: &tokio::runtime::Handle) {
    let key = env.session_key.clone();
    if let Ok(mut e) = ENVS.lock() {
        e.insert(key.clone(), env.clone());
    }
    let Ok(mut w) = WORKERS.lock() else { return };
    if let Some(slot) = w.get(&key) {
        slot.wake.notify_one();
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    let abort = Arc::new(AtomicBool::new(false));
    let wake = Arc::new(Notify::new());
    w.insert(key, Slot { generation, abort: abort.clone(), wake: wake.clone() });
    drop(w);
    handle.spawn(run(env, generation, abort, wake));
}

/// Start the worker of a chat with the route it last used ("retry" on the
/// memory screen). False when this process has not run a turn of the chat
/// yet: the job then runs on the next turn.
pub(crate) fn kick_known(session_key: &str, handle: &tokio::runtime::Handle) -> bool {
    let env = ENVS.lock().ok().and_then(|e| e.get(session_key).cloned());
    match env {
        Some(env) => {
            kick(env, handle);
            true
        }
        None => false,
    }
}

/// Stop the chat's worker now (its model call is dropped). The caller has
/// cancelled the job in the database, so nothing it made is saved; a later
/// turn starts a fresh worker.
pub(crate) fn cancel(session_key: &str) {
    if let Some(slot) = WORKERS.lock().ok().and_then(|mut w| w.remove(session_key)) {
        slot.abort.store(true, Ordering::SeqCst);
        slot.wake.notify_one();
    }
}

/// Does this process run a worker for the chat?
pub(crate) fn is_running(session_key: &str) -> bool {
    WORKERS.lock().map(|w| w.contains_key(session_key)).unwrap_or(false)
}

fn leave(key: &str, generation: u64) {
    if let Ok(mut w) = WORKERS.lock() {
        if w.get(key).map(|s| s.generation) == Some(generation) {
            w.remove(key);
        }
    }
}

/// Longest wait for a retry or a lease before the worker exits (the next
/// turn starts it again).
const MAX_IDLE_WAIT_MS: i64 = jobs::BACKOFF_CAP_MS + jobs::LEASE_MS;

async fn run(env: Arc<WorkerEnv>, generation: u64, abort: Arc<AtomicBool>, wake: Arc<Notify>) {
    let key = env.session_key.clone();
    let owner = format!("{}#{}", *INSTANCE, generation);
    loop {
        if abort.load(Ordering::SeqCst) {
            break;
        }
        let claimed = crate::db::open_db(&env.db_path).ok().and_then(|c| jobs::claim(&c, &key, &owner, now_ms(), jobs::LEASE_MS).ok().flatten());
        if let Some(job) = claimed {
            if run_job(&env, &job, &owner, &abort).await {
                if let Ok(c) = crate::db::open_db(&env.db_path) {
                    enqueue_due(&c, &key, &env.workspace_path, None, now_ms());
                }
            }
            continue;
        }
        // Nothing runnable now. Decide under the registry lock, so a job
        // queued meanwhile either is seen here or finds no worker and
        // starts one.
        let wait_until = {
            let Ok(mut w) = WORKERS.lock() else { break };
            if w.get(&key).map(|s| s.generation) != Some(generation) {
                break;
            }
            let now = now_ms();
            match crate::db::open_db(&env.db_path).ok().and_then(|c| jobs::next_due(&c, &key, now)) {
                Some(0) => None,
                Some(t) if t - now <= MAX_IDLE_WAIT_MS => Some(t),
                _ => {
                    w.remove(&key);
                    return;
                }
            }
        };
        if let Some(t) = wait_until {
            let ms = (t - now_ms()).max(0) as u64 + 50;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                _ = wake.notified() => {}
            }
        }
    }
    leave(&key, generation);
}

/// Run one claimed job. True when it ended well (done or not needed) and the
/// next due batch may be queued.
async fn run_job(env: &WorkerEnv, job: &jobs::Job, owner: &str, abort: &Arc<AtomicBool>) -> bool {
    let key = env.session_key.as_str();
    let callback = env.callback.as_deref();
    let (from, to) = (job.from_turn, job.to_turn);
    let base_payload = |extra: serde_json::Value| {
        let mut v = serde_json::json!({"fromTurn": from, "toTurn": to, "jobKey": job.job_key, "attempt": job.attempts, "maxAttempts": job.max_attempts, "background": true, "sessionKey": key});
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in e {
                o.insert(k.clone(), x.clone());
            }
        }
        v
    };

    // ── Check the job still fits the chat (before any model call) ──
    let Ok(conn) = crate::db::open_db(&env.db_path) else {
        // The lease runs out and the job is claimed again.
        return false;
    };
    let mem = tm::load_memory(&conn, key);
    if mem.through_turn >= to {
        let _ = jobs::finish(&conn, key, &job.job_key, owner, None, now_ms());
        return true;
    }
    if mem.through_turn + 1 != from || mem.from_newer_build() {
        let _ = jobs::supersede(&conn, key, &job.job_key, owner, &format!("the summary now ends at turn {}, not {}", mem.through_turn, from - 1), now_ms());
        return true;
    }
    let Ok(messages) = crate::db::load_session_messages_raw(&conn, key) else {
        let _ = jobs::fail(&conn, key, &job.job_key, owner, "could not read the stored transcript", now_ms());
        return false;
    };
    let turns = tm::split_turns(&messages);
    if (to as usize) > turns.len() {
        let _ = jobs::supersede(&conn, key, &job.job_key, owner, "those turns are no longer in the transcript", now_ms());
        return true;
    }
    let originals = slices_of(&messages, &turns, from, to);
    if jobs::input_hash(&originals) != job.input_hash {
        let _ = jobs::supersede(&conn, key, &job.job_key, owner, "the turns changed after the job was queued", now_ms());
        return true;
    }
    let ids = tm::result_ids(&conn, key);
    let mut slices = originals;
    results::use_stored_originals(&mut slices, &|tu| ids.get(tu).and_then(|id| tm::load_result(&conn, key, id)).map(|r| r.content));
    drop(conn);

    // ── Summarize, renewing the lease ──
    let _busy = tm::mark_summarizing(key, from, to);
    event_bus::emit(callback, "memory.summarizing", &base_payload(serde_json::json!({"version": mem.version})));
    let model = RouteTextModel::owned(env.route_plan.clone(), env.runtime_config.clone(), env.callback.clone(), env.webllm_pending.clone(), key.to_string(), Abort::Flag(abort.clone()));
    let input_limit = (env.context_budget.saturating_mul(2) / 3).clamp(1_500, 120_000);
    let out_tokens = env.max_output.min(4_096);
    let now = now_ms();
    let cache = jobs::DbPartCache { db_path: env.db_path.clone(), session_key: key.to_string(), job_key: job.job_key.clone() };
    let sjob = tm::SummarizeJob { turns: &slices, from, to, input_limit, max_output: out_tokens, result_ids: &ids, now_ms: now, parts: Some(&cache) };
    let mut mem = mem;
    if let Ok(c) = crate::db::open_db(&env.db_path) {
        super::memory_loop::with_tracked_goals(&c, key, &mut mem);
    }
    let meter = &env.meter;
    let count = |s: &str| meter.text(s);
    let work = tm::summarize_range(&model, &mem, &sjob, &count);
    tokio::pin!(work);
    let outcome = loop {
        tokio::select! {
            r = &mut work => break Some(r),
            _ = tokio::time::sleep(Duration::from_millis(jobs::HEARTBEAT_MS)) => {
                let held = crate::db::open_db(&env.db_path).map(|c| jobs::heartbeat(&c, key, &job.job_key, owner, now_ms(), jobs::LEASE_MS)).unwrap_or(true);
                if !held || abort.load(Ordering::SeqCst) {
                    break None;
                }
            }
        }
    };
    let Some(result) = outcome else {
        event_bus::emit(callback, "memory.cancelled", &base_payload(serde_json::json!({"reason": "the job was cancelled or taken over"})));
        return false;
    };
    let Ok(conn) = crate::db::open_db(&env.db_path) else { return false };
    match result {
        Ok(out) => {
            super::memory_loop::summary_goal_ops(callback, &conn, key, &out.update.goal_ops, from, to, &slices);
            let detail = serde_json::json!({
                "fromTurn": from, "toTurn": to, "portions": out.portions, "calls": out.calls,
                "readerCalls": out.reader_calls, "corrections": out.corrections, "droppedRefs": out.dropped_refs, "autoSuperseded": out.auto_superseded, "background": true, "jobKey": job.job_key, "attempt": job.attempts,
                "current": out.memory.decisions.current.iter().map(|d| d.id.clone()).collect::<Vec<_>>(),
                "superseded": out.memory.decisions.superseded.iter().filter(|d| !mem.decisions.superseded.iter().any(|p| p.id == d.id)).map(|d| serde_json::json!({"id": d.id, "by": d.superseded_by})).collect::<Vec<_>>(),
            });
            let batch = &turns[(from - 1) as usize..to as usize];
            let cjob = commit::CommitJob { session_key: key, kind: "summary", detail, archive: Some(tm::ArchiveTurns { messages: &messages, turns: batch }), now_ms: now };
            match commit::commit_for_job(&conn, cjob, (&job.job_key, owner), mem.version, out.memory, commit::summary_rebuild(&mem, &out.update, from, to, now)) {
                commit::CommitOutcome::Saved { version, tries } => {
                    let m = tm::load_memory(&conn, key);
                    if tm::load_status(&conn, key).status != "ok" {
                        let _ = tm::set_status(&conn, key, "ok", "", now_ms());
                    }
                    event_bus::emit(
                        callback,
                        "memory.updated",
                        &base_payload(serde_json::json!({"throughTurn": m.through_turn, "version": version, "saveTries": tries, "portions": out.portions, "calls": out.calls, "readerCalls": out.reader_calls, "corrections": out.corrections, "segments": m.segments.len(), "currentDecisions": m.decisions.current.len(), "supersededDecisions": m.decisions.superseded.len()})),
                    );
                    true
                }
                commit::CommitOutcome::AlreadyDone { version } => {
                    event_bus::emit(callback, "memory.updated", &base_payload(serde_json::json!({"throughTurn": tm::load_memory(&conn, key).through_turn, "version": version, "alreadyDone": true})));
                    true
                }
                commit::CommitOutcome::Pending { reason, tries } => {
                    failed(&conn, env, job, owner, &format!("the summary did not pass validation after {} tries: {}", tries, reason), &base_payload);
                    false
                }
                commit::CommitOutcome::JobLost { reason } => {
                    event_bus::emit(callback, "memory.cancelled", &base_payload(serde_json::json!({"reason": reason})));
                    false
                }
            }
        }
        Err(error) => {
            if abort.load(Ordering::SeqCst) {
                // Cancelled here: whoever cancelled settled the job.
                event_bus::emit(callback, "memory.cancelled", &base_payload(serde_json::json!({"reason": "cancelled"})));
                return false;
            }
            failed(&conn, env, job, owner, &error, &base_payload);
            false
        }
    }
}

/// A failed attempt: retry later with backoff, or give up (the memory
/// screen can retry). The memory stays as it was; turns stay unsummarized.
fn failed(conn: &rusqlite::Connection, env: &WorkerEnv, job: &jobs::Job, owner: &str, error: &str, payload: &dyn Fn(serde_json::Value) -> serde_json::Value) {
    let key = env.session_key.as_str();
    tracing::warn!(session = %key, job = %job.job_key, %error, "background summary failed");
    let now = now_ms();
    let Ok(Some(after)) = jobs::fail(conn, key, &job.job_key, owner, error, now) else {
        return;
    };
    let detail = if after.status == "failed" {
        format!("{} ({}; gave up after {} attempts, retry from the memory screen)", commit::PENDING_TEXT, tm::clip(error, 300), after.attempts)
    } else {
        format!("{} ({}; retry {} of {})", commit::PENDING_TEXT, tm::clip(error, 300), after.attempts + 1, after.max_attempts)
    };
    let _ = tm::set_status(conn, key, "pending", &detail, now);
    event_bus::emit(
        env.callback.as_deref(),
        "memory.failed",
        &payload(serde_json::json!({"error": error, "message": commit::PENDING_TEXT, "jobStatus": after.status, "retryAt": if after.status == "queued" { serde_json::json!(after.next_attempt_at) } else { serde_json::Value::Null }})),
    );
}

/// Startup: jobs another process left running (it was killed) are queued
/// again, runnable now. Jobs of this process are left alone.
pub(crate) fn recover_orphans(conn: &rusqlite::Connection) -> usize {
    jobs::recover_not_owned_by(conn, &format!("{}#", *INSTANCE), now_ms()).unwrap_or(0)
}
