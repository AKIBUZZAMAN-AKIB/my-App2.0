//! Phase 4: the durable job queue (`jobs.rs`) and its commit rules.
//! Test strategy E1-E5: idempotent enqueue, single flight, lease expiry and
//! recovery, backoff and give-up, cancellation on rewind/reset, exactly one
//! version per job, portion reuse on retry.

use super::jobs::{self, Enqueued};
use super::*;
use rusqlite::Connection;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

fn db_file(name: &str) -> (String, Connection) {
    let path = std::env::temp_dir().join(format!("tm-jobs-{}-{}.db", name, uuid::Uuid::new_v4()));
    let path = path.display().to_string();
    let conn = crate::db::open_db(&path).unwrap();
    ensure_tables(&conn).unwrap();
    (path, conn)
}

fn mem(through: u32) -> TurnMemory {
    let mut m = TurnMemory {
        through_turn: through,
        ..Default::default()
    };
    if through > 0 {
        m.segments.push(Segment {
            from_turn: 1,
            to_turn: through,
            topic: "t".into(),
            title: "t".into(),
            summary: "s".into(),
            created_at: 0,
            ..Default::default()
        });
    }
    m.normalize();
    m
}

const K: &str = "chat";

#[test]
fn enqueue_is_idempotent_and_single_flight() {
    let (_p, c) = db_file("idem");
    assert_eq!(
        jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 10).unwrap(),
        Enqueued::Queued("1-7-aaaaaaaaaaaaaaaa".into())
    );
    // The same batch again: one row, nothing changes.
    for _ in 0..3 {
        assert!(
            matches!(jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 11).unwrap(), Enqueued::Exists { status, .. } if status == "queued")
        );
    }
    // Another batch of the same chat waits (partial unique index).
    assert_eq!(
        jobs::enqueue(&c, K, 8, 14, 1, "bbbbbbbbbbbbbbbbbbbb", 12).unwrap(),
        Enqueued::Busy
    );
    // Another chat is independent.
    assert!(matches!(
        jobs::enqueue(&c, "other", 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 12).unwrap(),
        Enqueued::Queued(_)
    ));
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM memory_jobs WHERE session_key = ?1",
            [K],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn the_index_refuses_a_second_active_job_even_by_hand() {
    let (_p, c) = db_file("index");
    jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 1).unwrap();
    let r = c.execute("INSERT INTO memory_jobs (session_key, job_key, from_turn, to_turn, base_version, input_hash, status) VALUES (?1, 'x', 1, 7, 0, 'h', 'running')", [K]);
    assert!(r.is_err(), "a second active job of one chat is impossible");
    // Finished jobs do not count.
    c.execute("INSERT INTO memory_jobs (session_key, job_key, from_turn, to_turn, base_version, input_hash, status) VALUES (?1, 'y', 1, 7, 0, 'h', 'done')", [K]).unwrap();
}

#[test]
fn claim_takes_one_job_and_a_live_lease_blocks_others() {
    let (_p, c) = db_file("claim");
    jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 100).unwrap();
    let j = jobs::claim(&c, K, "w1", 100, 1_000).unwrap().unwrap();
    assert_eq!(
        (
            j.status.as_str(),
            j.attempts,
            j.lease_owner.as_deref(),
            j.lease_until
        ),
        ("running", 1, Some("w1"), 1_100)
    );
    assert!(
        jobs::claim(&c, K, "w2", 500, 1_000).unwrap().is_none(),
        "the lease is live"
    );
    assert!(jobs::heartbeat(&c, K, &j.job_key, "w1", 900, 1_000));
    assert!(
        jobs::claim(&c, K, "w2", 1_500, 1_000).unwrap().is_none(),
        "the heartbeat moved the lease to 1900"
    );
    assert!(
        !jobs::heartbeat(&c, K, &j.job_key, "w2", 900, 1_000),
        "only the owner renews"
    );
    // The worker died: the lease runs out and another worker takes it over.
    let j2 = jobs::claim(&c, K, "w2", 2_000, 1_000).unwrap().unwrap();
    assert_eq!((j2.lease_owner.as_deref(), j2.attempts), (Some("w2"), 2));
    assert!(!jobs::holds(&c, K, &j.job_key, "w1"));
    assert!(
        !jobs::heartbeat(&c, K, &j.job_key, "w1", 2_100, 1_000),
        "the old worker learns it lost the job"
    );
}

#[test]
fn concurrent_claims_give_the_job_to_exactly_one_worker() {
    let (path, c) = db_file("race");
    jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 1).unwrap();
    let won = std::sync::Arc::new(AtomicUsize::new(0));
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let (path, won) = (path.clone(), won.clone());
            std::thread::spawn(move || {
                let c = crate::db::open_db(&path).unwrap();
                if jobs::claim(&c, K, &format!("w{}", i), 5, 60_000)
                    .unwrap()
                    .is_some()
                {
                    won.fetch_add(1, Ordering::SeqCst);
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(won.load(Ordering::SeqCst), 1);
}

#[test]
fn failures_back_off_exponentially_then_give_up() {
    let (_p, c) = db_file("backoff");
    jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 0).unwrap();
    let mut now = 0;
    let mut delays = Vec::new();
    for attempt in 1..=jobs::MAX_ATTEMPTS {
        let j = jobs::claim(&c, K, "w", now, 1_000).unwrap().expect("due");
        assert_eq!(j.attempts, attempt);
        let after = jobs::fail(&c, K, &j.job_key, "w", "provider said 503", now)
            .unwrap()
            .unwrap();
        if attempt < jobs::MAX_ATTEMPTS {
            assert_eq!(after.status, "queued");
            let d = after.next_attempt_at - now;
            delays.push(d);
            // Not due before its time.
            assert!(jobs::claim(&c, K, "w", after.next_attempt_at - 1, 1_000)
                .unwrap()
                .is_none());
            now = after.next_attempt_at;
        } else {
            assert_eq!(after.status, "failed");
            assert_eq!(after.last_error.as_deref(), Some("provider said 503"));
        }
    }
    // Equal jitter: each delay is in [exp/2, exp], exp doubling from the base.
    for (i, d) in delays.iter().enumerate() {
        let exp = (jobs::BACKOFF_BASE_MS << i).min(jobs::BACKOFF_CAP_MS);
        assert!(
            *d >= exp / 2 && *d <= exp,
            "attempt {} delay {} not in [{}, {}]",
            i + 1,
            d,
            exp / 2,
            exp
        );
    }
    assert!(
        jobs::claim(&c, K, "w", now + 10_000_000, 1_000)
            .unwrap()
            .is_none(),
        "a failed job is not claimed"
    );
    assert!(jobs::backoff_ms(40, "x") <= jobs::BACKOFF_CAP_MS, "capped");
    assert_eq!(
        jobs::backoff_ms(3, "k"),
        jobs::backoff_ms(3, "k"),
        "deterministic"
    );
    // The same batch is not queued again at once …
    assert!(
        matches!(jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", now + 1).unwrap(), Enqueued::Exists { status, .. } if status == "failed")
    );
    // … but the user can retry it, attempts reset …
    assert!(jobs::retry_now(&c, K, now + 2).unwrap().is_some());
    let j = jobs::claim(&c, K, "w", now + 2, 1_000).unwrap().unwrap();
    assert_eq!(j.attempts, 1);
    jobs::fail(&c, K, &j.job_key, "w", "x", now + 3).unwrap();
    // … and a later turn queues it again once FAILED_REQUEUE_MS passed.
    c.execute("UPDATE memory_jobs SET status = 'failed'", [])
        .unwrap();
    assert!(matches!(
        jobs::enqueue(
            &c,
            K,
            1,
            7,
            0,
            "aaaaaaaaaaaaaaaaaaaa",
            now + 4 + jobs::FAILED_REQUEUE_MS
        )
        .unwrap(),
        Enqueued::Queued(_)
    ));
}

#[test]
fn a_job_that_kills_the_app_every_time_still_ends_failed() {
    let (_p, c) = db_file("crashloop");
    jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 0).unwrap();
    let mut now = 0;
    for i in 0..jobs::MAX_ATTEMPTS {
        let j = jobs::claim(&c, K, &format!("p{}#1", i), now, 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(j.attempts, i + 1);
        // The process dies; the next one recovers the job at startup.
        now += 10;
        assert_eq!(
            jobs::recover_not_owned_by(&c, &format!("p{}#", i + 1), now).unwrap(),
            1
        );
    }
    assert!(jobs::claim(&c, K, "last#1", now, 1_000).unwrap().is_none());
    assert_eq!(jobs::list(&c, K, 5)[0].status, "failed");
    assert!(jobs::list(&c, K, 5)[0]
        .last_error
        .as_deref()
        .unwrap()
        .contains("gave up"));
}

#[test]
fn startup_recovery_frees_only_jobs_of_other_processes() {
    let (_p, c) = db_file("recover");
    jobs::enqueue(&c, "a", 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 0).unwrap();
    jobs::enqueue(&c, "b", 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 0).unwrap();
    jobs::claim(&c, "a", "old#3", 0, 60_000).unwrap().unwrap();
    jobs::claim(&c, "b", "new#1", 0, 60_000).unwrap().unwrap();
    assert_eq!(jobs::recover_not_owned_by(&c, "new#", 5).unwrap(), 1);
    assert_eq!(jobs::active(&c, "a").unwrap().status, "queued");
    assert_eq!(jobs::active(&c, "b").unwrap().status, "running");
    assert_eq!(jobs::next_due(&c, "a", 5), Some(0), "runnable at once");
    // Lease-based recovery (no owner check) only takes expired leases.
    assert_eq!(jobs::recover_expired(&c, 100).unwrap(), 0);
    assert_eq!(jobs::recover_expired(&c, 70_000).unwrap(), 1);
}

#[test]
fn the_save_and_the_done_mark_are_one_transaction_and_need_the_lease() {
    let (_p, c) = db_file("commit");
    jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 0).unwrap();
    let j = jobs::claim(&c, K, "w1", 0, 1_000).unwrap().unwrap();
    jobs::put_part(&c, K, &j.job_key, 0, "h", "portion text", 0).unwrap();
    // Lease taken over by w2 (w1 stalled): w1 may not save.
    let j2 = jobs::claim(&c, K, "w2", 5_000, 1_000).unwrap().unwrap();
    let r = store::save_version_for_job(
        &c,
        K,
        0,
        &mem(7),
        "summary",
        &json!({}),
        None,
        Some((&j.job_key, "w1")),
        5_001,
    );
    assert!(matches!(r, Err(store::SaveError::JobLost(_))), "{:?}", r);
    assert_eq!(load_memory(&c, K).version, 0, "nothing saved");
    // w2 saves: version and done in one go; parts are cleaned up.
    let v = store::save_version_for_job(
        &c,
        K,
        0,
        &mem(7),
        "summary",
        &json!({}),
        None,
        Some((&j2.job_key, "w2")),
        5_002,
    )
    .unwrap();
    assert_eq!(v, 1);
    let done = jobs::get(&c, K, &j.job_key).unwrap();
    assert_eq!(
        (done.status.as_str(), done.result_version),
        ("done", Some(1))
    );
    assert_eq!(jobs::part_count(&c, K, &j.job_key), 0);
    // Done is final: a second save for the job is refused, no second version.
    let again = store::save_version_for_job(
        &c,
        K,
        1,
        &mem(7),
        "summary",
        &json!({}),
        None,
        Some((&j2.job_key, "w2")),
        5_003,
    );
    assert!(matches!(again, Err(store::SaveError::JobLost(_))));
    assert_eq!(list_versions(&c, K).len(), 1);
    // Re-enqueueing the finished batch is a no-op.
    assert!(
        matches!(jobs::enqueue(&c, K, 1, 7, 0, "aaaaaaaaaaaaaaaaaaaa", 6_000).unwrap(), Enqueued::Exists { status, .. } if status == "done")
    );
}

#[test]
fn rewind_and_reset_cancel_the_active_job_in_the_same_transaction() {
    let (_p, c) = db_file("cancel");
    save_version(&c, K, 0, &mem(7), "summary", &json!({}), None, 1).unwrap();
    jobs::enqueue(&c, K, 8, 14, 1, "bbbbbbbbbbbbbbbbbbbb", 2).unwrap();
    let j = jobs::claim(&c, K, "w", 2, 60_000).unwrap().unwrap();
    jobs::put_part(&c, K, &j.job_key, 0, "h", "turn 9 secret text", 3).unwrap();
    store::forget_after(&c, K, 10, 4).unwrap();
    let after = jobs::get(&c, K, &j.job_key).unwrap();
    assert_eq!(after.status, "cancelled");
    assert_eq!(
        jobs::part_count(&c, K, &j.job_key),
        0,
        "parts with removed text are gone"
    );
    assert!(
        !jobs::heartbeat(&c, K, &j.job_key, "w", 5, 60_000),
        "the worker learns at its next heartbeat"
    );
    let r = store::save_version_for_job(
        &c,
        K,
        1,
        &mem(14),
        "summary",
        &json!({}),
        None,
        Some((&j.job_key, "w")),
        6,
    );
    assert!(
        matches!(r, Err(store::SaveError::JobLost(_))),
        "a cancelled job never commits"
    );
    assert_eq!(load_memory(&c, K).through_turn, 7);
    // A put_part after the cancel is dropped.
    assert!(!jobs::put_part(&c, K, &j.job_key, 1, "h", "late", 7).unwrap());
    // The same batch can be queued again later (the text may be the same).
    assert!(matches!(
        jobs::enqueue(&c, K, 8, 14, 1, "bbbbbbbbbbbbbbbbbbbb", 8).unwrap(),
        Enqueued::Queued(_)
    ));
    reset_memory(&c, K, "test", 9).unwrap();
    assert!(jobs::active(&c, K).is_none(), "reset cancels too");
    // Clearing the chat removes the queue rows.
    jobs::enqueue(&c, K, 1, 7, 0, "cccccccccccccccccccc", 10).unwrap();
    store::delete_memory(&c, K).unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM memory_jobs WHERE session_key = ?1",
            [K],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn the_input_hash_changes_with_any_turn_text() {
    let a = vec![(
        1u32,
        vec![Message::user("hi"), Message::assistant_text("yo")],
    )];
    let mut b = a.clone();
    b[0].1[1] = Message::assistant_text("yo!");
    assert_ne!(jobs::input_hash(&a), jobs::input_hash(&b));
    assert_eq!(jobs::input_hash(&a), jobs::input_hash(&a.clone()));
    let c = vec![(2u32, a[0].1.clone())];
    assert_ne!(
        jobs::input_hash(&a),
        jobs::input_hash(&c),
        "turn numbers count"
    );
}

/// A portion cache in memory.
#[derive(Default)]
struct MemParts(Mutex<std::collections::HashMap<(u32, String), String>>);
impl jobs::PartCache for MemParts {
    fn get(&self, n: u32, h: &str) -> Option<String> {
        self.0.lock().unwrap().get(&(n, h.to_string())).cloned()
    }
    fn put(&self, n: u32, h: &str, t: &str) {
        self.0
            .lock()
            .unwrap()
            .insert((n, h.to_string()), t.to_string());
    }
}

struct Flaky {
    portion_calls: AtomicUsize,
    fail_portion_once: Mutex<bool>,
}
impl TextModel for Flaky {
    async fn complete(&self, system: &str, user: String, _max: u32) -> Result<String, String> {
        if system.starts_with("You are one of several summarizer sub-agents") {
            self.portion_calls.fetch_add(1, Ordering::SeqCst);
            if user.contains("PORTION 2 of") {
                let mut f = self.fail_portion_once.lock().unwrap();
                if *f {
                    *f = false;
                    return Err("timeout".into());
                }
            }
            return Ok(json!({"segments": [], "facts": [{"text": user.lines().find(|l| l.starts_with("PORTION")).unwrap_or(""), "turn": 1}]}).to_string());
        }
        // The merge call: one segment for the whole batch.
        Ok(json!({"goal": "g", "segments": [{"fromTurn": 1, "toTurn": 6, "topic": "t", "title": "t", "summary": "s"}], "decisions": {"current": []}}).to_string())
    }
}

#[tokio::test]
async fn a_retry_repeats_only_the_portion_that_failed() {
    let turns: Vec<(u32, Vec<Message>)> = (1..=6)
        .map(|i| {
            (
                i,
                vec![
                    Message::user(&format!("q{} {}", i, "x".repeat(4_000))),
                    Message::assistant_text("a"),
                ],
            )
        })
        .collect();
    let ids = std::collections::HashMap::new();
    let cache = MemParts::default();
    let model = Flaky {
        portion_calls: AtomicUsize::new(0),
        fail_portion_once: Mutex::new(true),
    };
    let count = |s: &str| s.len() / 4 + 1;
    let job = SummarizeJob {
        turns: &turns,
        from: 1,
        to: 6,
        input_limit: 1_500,
        max_output: 512,
        result_ids: &ids,
        now_ms: 1,
        parts: Some(&cache),
    };
    let first = summarize_range(&model, &TurnMemory::default(), &job, &count).await;
    assert!(first.is_err(), "portion 2 failed");
    let n1 = model.portion_calls.load(Ordering::SeqCst);
    assert!(n1 >= 3, "the batch was split into portions ({})", n1);
    let kept = cache.0.lock().unwrap().len();
    assert_eq!(kept, n1 - 1, "every portion but the failed one was kept");
    let second = summarize_range(&model, &TurnMemory::default(), &job, &count)
        .await
        .expect("retry succeeds");
    assert_eq!(
        model.portion_calls.load(Ordering::SeqCst) - n1,
        1,
        "only the failed portion ran again"
    );
    assert_eq!(second.memory.through_turn, 6);
    // A changed batch never reuses a cached portion (the key is the prompt).
    let mut other = turns.clone();
    other[0].1[0] = Message::user("changed");
    let job2 = SummarizeJob {
        turns: &other,
        ..job
    };
    let before = model.portion_calls.load(Ordering::SeqCst);
    let _ = summarize_range(&model, &TurnMemory::default(), &job2, &count).await;
    assert!(model.portion_calls.load(Ordering::SeqCst) - before >= 1);
}
