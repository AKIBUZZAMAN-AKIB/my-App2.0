//! Phase 6: retention of stored tool results (ADR-8, test strategy H).
//! Referenced data is never removed; rewind orphans are; revert keeps
//! working after a cleanup; the budget is enforced on unreferenced results
//! only; a failure halfway changes nothing; numbers are never reused.

use super::retention::{self, Policy};
use super::*;
use crate::types::{ContentBlock, Message};
use rusqlite::Connection;
use serde_json::json;

const K: &str = "c";
const HOUR: i64 = 60 * 60 * 1000;
const DAY: i64 = 24 * HOUR;
/// "Now" for every test: far after the results were stored.
const NOW: i64 = 100 * DAY;

fn tool_turn(no: u32, id: &str) -> Vec<Message> {
    vec![
        Message::user(&format!("turn {} please run a command", no)),
        Message::assistant_blocks(vec![ContentBlock::ToolUse { id: id.into(), name: "execute_command".into(), input: json!({"command": "ls"}), provider_metadata: None }]),
        Message::tool_result(id, &format!("output {} (cut for display)", no), false),
        Message::assistant_text("done"),
    ]
}

fn chat(n: u32) -> Vec<Message> {
    (1..=n).flat_map(|i| tool_turn(i, &format!("toolu_{}", i))).collect()
}

fn save(conn: &Connection, msgs: &[Message]) {
    crate::db::save_session(conn, K, "main", &serde_json::to_string(msgs).unwrap(), None, None, 1, None).unwrap();
}

/// A chat of `n` tool turns, each with a stored original of `size` bytes
/// stored at `at`.
fn setup(n: u32, size: usize, at: i64) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    save(&conn, &chat(n));
    for i in 1..=n {
        let body = format!("{}{}", i, "x".repeat(size.saturating_sub(1)));
        store_result(&conn, K, &format!("toolu_{}", i), "execute_command", Some("ls"), &body, false, Some(i), at).unwrap();
    }
    conn
}

fn keep_days(d: i64) -> Policy {
    Policy { keep_unreferenced_ms: d * DAY, ..Policy::default() }
}

fn live(conn: &Connection) -> Vec<String> {
    let mut st = conn.prepare("SELECT result_no FROM tool_results WHERE session_key = ?1 AND pruned_at IS NULL ORDER BY result_no").unwrap();
    st.query_map([K], |r| Ok(format!("R{}", r.get::<_, i64>(0)?))).unwrap().map(Result::unwrap).collect()
}

fn total_rows(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM tool_results WHERE session_key = ?1", [K], |r| r.get(0)).unwrap()
}

#[test]
fn referenced_results_are_never_pruned_even_far_over_budget() {
    let conn = setup(4, 600_000, 0);
    let tiny = Policy { budget_bytes: 1, keep_unreferenced_ms: 0, grace_ms: 0 };
    let rep = retention::prune_results(&conn, K, tiny, NOW, false).unwrap();
    assert!(rep.pruned.is_empty(), "every result is in the transcript: {:?}", rep.pruned);
    assert_eq!(rep.referenced_results, 4);
    assert!(rep.over_budget, "what is left is referenced, and the report says the chat is over budget");
    assert_eq!(live(&conn), vec!["R1", "R2", "R3", "R4"]);
    assert!(rep.results.iter().all(|r| r.referenced_by == vec!["transcript".to_string()]));
    assert_eq!(load_result(&conn, K, "R3").unwrap().content.len(), 600_000);
}

#[test]
fn rewind_orphans_are_pruned_and_the_kept_turns_stay() {
    let conn = setup(6, 2_000, 0);
    // Rewind to turn 3: turns 4-6 and their tool calls leave the transcript.
    save(&conn, &chat(3));
    forget_after(&conn, K, 3, NOW).unwrap();
    // Inside the keep window nothing goes yet (the user can still look).
    let rep = retention::prune_results(&conn, K, keep_days(365 * 10), NOW, false).unwrap();
    assert!(rep.pruned.is_empty());
    assert_eq!(rep.unreferenced_results, 3);
    assert_eq!(rep.kept_unreferenced.len(), 3);
    // Past it, exactly the orphans go.
    let rep = retention::prune_results(&conn, K, keep_days(7), NOW, false).unwrap();
    assert_eq!(rep.pruned, vec!["R4", "R5", "R6"]);
    assert_eq!(live(&conn), vec!["R1", "R2", "R3"]);
    assert!(load_result(&conn, K, "R5").is_none());
    assert!(load_result(&conn, K, "toolu_5").is_none());
    let (id, at, reason, bytes) = retention::pruned_info(&conn, K, "#R5").unwrap();
    assert_eq!((id.as_str(), at, bytes), ("R5", NOW, 2_000));
    assert_eq!(reason, retention::REASON_UNREFERENCED);
    // The row and its number stay; an older build reading it sees the stub.
    assert_eq!(total_rows(&conn), 6);
    let stub: String = conn.query_row("SELECT content FROM tool_results WHERE session_key = ?1 AND result_no = 5", [K], |r| r.get(0)).unwrap();
    assert!(stub.starts_with("[result #R5 was removed by storage cleanup on "), "{}", stub);
    // The list says when and why.
    let list = list_results(&conn, K);
    assert_eq!(list["results"].as_array().unwrap().len(), 3);
    let gone = list["unavailable"].as_array().unwrap();
    assert_eq!(gone.iter().map(|g| g["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["R4", "R5", "R6"]);
    assert_eq!(gone[1]["prunedAt"], json!(NOW));
    assert_eq!(gone[1]["bytes"], json!(2_000));
    // A second run is a no-op.
    assert!(retention::prune_results(&conn, K, keep_days(7), NOW + 1, false).unwrap().pruned.is_empty());
}

#[test]
fn numbers_are_never_reused_after_pruning_the_newest() {
    let conn = setup(3, 100, 0);
    save(&conn, &chat(2));
    let rep = retention::prune_results(&conn, K, keep_days(0), NOW, false).unwrap();
    assert_eq!(rep.pruned, vec!["R3"]);
    let (id, fresh) = store_result(&conn, K, "toolu_new", "web_fetch", None, "new", false, Some(3), NOW).unwrap();
    assert!(fresh);
    assert_eq!(id, "R4", "an old #R3 must never point at a different result");
}

#[test]
fn the_same_call_stored_again_revives_its_number() {
    let conn = setup(2, 100, 0);
    save(&conn, &chat(1));
    retention::prune_results(&conn, K, keep_days(0), NOW, false).unwrap();
    assert!(load_result(&conn, K, "R2").is_none());
    let (id, fresh) = store_result(&conn, K, "toolu_2", "execute_command", None, "again", false, Some(2), NOW).unwrap();
    assert_eq!((id.as_str(), fresh), ("R2", true));
    assert_eq!(load_result(&conn, K, "R2").unwrap().content, "again");
    assert!(retention::pruned_info(&conn, K, "R2").is_none());
}

#[test]
fn memory_versions_archive_and_jobs_keep_their_results_and_revert_still_reads_them() {
    let conn = setup(5, 1_000, 0);
    // Version 1 cites #R2; the live memory (version 2, a repair) no longer does.
    let mut v1 = TurnMemory { through_turn: 2, ..Default::default() };
    v1.segments.push(Segment { from_turn: 1, to_turn: 2, topic: "t".into(), title: "t".into(), summary: "the listing is in #R2".into(), created_at: 0 });
    store::save_version(&conn, K, 0, &v1, "summary", &json!({}), None, 1).unwrap();
    let mut v2 = v1.clone();
    v2.segments[0].summary = "the listing".into();
    store::save_version(&conn, K, 1, &v2, "repair", &json!({"before": "the listing is in #R2"}), None, 2).unwrap();
    // Turn 3's tool call survives only in the archive; turn 4 is covered by
    // an active background job; turn 5 is gone everywhere.
    let all = chat(5);
    let turns = split_turns(&all);
    let mut m3 = v2.clone();
    m3.through_turn = 3;
    store::save_version(&conn, K, 2, &m3, "summary", &json!({}), Some(ArchiveTurns { messages: &all, turns: &turns[2..3] }), 3).unwrap();
    save(&conn, &chat(1)); // the transcript only holds turn 1 now
    conn.execute("INSERT INTO memory_jobs (session_key, job_key, from_turn, to_turn, base_version, input_hash, status) VALUES (?1, 'j', 4, 4, 3, 'h', 'queued')", [K]).unwrap();
    let rep = retention::prune_results(&conn, K, keep_days(0), NOW, false).unwrap();
    assert_eq!(rep.pruned, vec!["R5"], "{:?}", rep.results);
    let by = |id: &str| rep.results.iter().find(|r| r.id == id).unwrap().referenced_by.clone();
    assert_eq!(by("R1"), vec!["transcript"]);
    assert!(by("R2").iter().any(|p| p.starts_with("version ")), "{:?}", by("R2"));
    assert_eq!(by("R3"), vec!["archive"]);
    assert_eq!(by("R4"), vec!["active background job"]);
    // Revert to version 1's text: the result it cites is still readable.
    let (old, _, _) = load_version(&conn, K, 1).unwrap();
    let cur = load_memory(&conn, K);
    store::save_version(&conn, K, cur.version, &old, "revert", &json!({"revertedVersion": 2}), None, NOW).unwrap();
    assert!(load_memory(&conn, K).segments[0].summary.contains("#R2"));
    assert_eq!(load_result(&conn, K, "R2").unwrap().content.len(), 1_000);
}

#[test]
fn a_result_cited_only_by_a_version_that_left_the_history_can_go() {
    let conn = setup(1, 500, 0);
    save(&conn, &[]);
    let mut m = TurnMemory { through_turn: 1, ..Default::default() };
    m.segments.push(Segment { from_turn: 1, to_turn: 1, topic: "t".into(), title: "t".into(), summary: "see #R1".into(), created_at: 0 });
    let mut v = store::save_version(&conn, K, 0, &m, "summary", &json!({}), None, 1).unwrap();
    assert!(retention::prune_results(&conn, K, keep_days(0), NOW, true).unwrap().pruned.is_empty());
    m.segments[0].summary = "nothing cited".into();
    for i in 0..KEEP_VERSIONS {
        v = store::save_version(&conn, K, v, &m, "summary", &json!({}), None, 2 + i).unwrap();
    }
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM turn_memory_versions WHERE session_key = ?1", [K], |r| r.get(0)).unwrap();
    assert_eq!(n, KEEP_VERSIONS, "versions stay capped at KEEP_VERSIONS");
    assert_eq!(retention::prune_results(&conn, K, keep_days(0), NOW, false).unwrap().pruned, vec!["R1"]);
}

#[test]
fn a_result_cited_by_a_referenced_result_is_kept() {
    let conn = setup(2, 100, 0);
    // Turn 2's stored output (a recall) cites #R1; turn 1 left the transcript.
    conn.execute("UPDATE tool_results SET content = 'recalled: see #R1' WHERE session_key = ?1 AND result_no = 2", [K]).unwrap();
    let msgs: Vec<Message> = chat(2).into_iter().skip(4).collect();
    save(&conn, &msgs);
    let rep = retention::prune_results(&conn, K, keep_days(0), NOW, false).unwrap();
    assert!(rep.pruned.is_empty(), "{:?}", rep.results);
    assert_eq!(rep.results[0].referenced_by, vec!["result #R2"]);
}

#[test]
fn the_budget_prunes_unreferenced_results_oldest_first_and_stops_under_it() {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    save(&conn, &chat(1));
    store_result(&conn, K, "toolu_1", "execute_command", None, &"a".repeat(400_000), false, Some(1), 0).unwrap();
    for (i, at) in [(2, 10 * DAY), (3, 20 * DAY), (4, 30 * DAY)] {
        store_result(&conn, K, &format!("toolu_{}", i), "execute_command", None, &"b".repeat(400_000), false, Some(i), at).unwrap();
    }
    // 1.6 MB stored, 0.4 MB referenced, budget 1 MB, keep window not reached.
    let p = Policy { budget_bytes: 1_000_000, keep_unreferenced_ms: 365 * DAY, grace_ms: HOUR };
    let dry = retention::prune_results(&conn, K, p, NOW, true).unwrap();
    assert_eq!(dry.pruned, vec!["R2", "R3"], "oldest unreferenced first, until under budget");
    assert_eq!(live(&conn).len(), 4, "a dry run changes nothing");
    let rep = retention::prune_results(&conn, K, p, NOW, false).unwrap();
    assert_eq!(rep.pruned, vec!["R2", "R3"]);
    assert_eq!(rep.bytes_after, 800_000);
    assert!(!rep.over_budget);
    assert_eq!(rep.pruned_bytes, 800_000);
    assert_eq!(live(&conn), vec!["R1", "R4"]);
    let r = retention::pruned_info(&conn, K, "R2").unwrap();
    assert_eq!(r.2, retention::REASON_BUDGET);
    let s = retention::summary(&conn, K, p);
    assert_eq!(s["resultBytes"], json!(800_000));
    assert_eq!(s["prunedCount"], json!(2));
    assert_eq!(s["lastCleanup"]["pruned"], json!(2));
    assert_eq!(s["overBudget"], json!(false));
}

#[test]
fn young_results_are_never_pruned_while_their_turn_may_be_unsaved() {
    let conn = setup(1, 100, 0);
    // A turn in flight stored R2 but its transcript is not saved yet.
    store_result(&conn, K, "toolu_inflight", "web_fetch", None, &"z".repeat(5_000_000), false, Some(2), NOW - 60_000).unwrap();
    let p = Policy { budget_bytes: 1, keep_unreferenced_ms: 0, grace_ms: HOUR };
    let rep = retention::prune_results(&conn, K, p, NOW, false).unwrap();
    assert!(rep.pruned.is_empty());
    assert_eq!(rep.kept_unreferenced, vec![("R2".to_string(), "younger than the grace period".to_string())]);
    // An hour later, still unreferenced (the turn crashed): it goes.
    assert_eq!(retention::prune_results(&conn, K, p, NOW + HOUR, false).unwrap().pruned, vec!["R2"]);
}

#[test]
fn a_failure_halfway_changes_nothing() {
    let conn = setup(4, 1_000, 0);
    save(&conn, &chat(1));
    store::FAIL_AFTER.with(|f| *f.borrow_mut() = Some("prune"));
    let res = retention::prune_results(&conn, K, keep_days(0), NOW, false);
    store::FAIL_AFTER.with(|f| *f.borrow_mut() = None);
    assert!(res.is_err());
    assert_eq!(live(&conn), vec!["R1", "R2", "R3", "R4"], "the first prune was rolled back");
    assert_eq!(load_result(&conn, K, "R2").unwrap().content.len(), 1_000);
    let err: Option<String> = conn.query_row("SELECT last_error FROM memory_retention WHERE session_key = ?1", [K], |r| r.get(0)).unwrap();
    assert!(err.unwrap().contains("injected failure"));
    // The next run does the work.
    assert_eq!(retention::prune_results(&conn, K, keep_days(0), NOW, false).unwrap().pruned, vec!["R2", "R3", "R4"]);
}

#[test]
fn an_unreadable_reference_source_aborts_without_pruning() {
    let conn = setup(3, 100, 0);
    save(&conn, &chat(1));
    conn.execute_batch("ALTER TABLE turn_archive RENAME TO turn_archive_gone").unwrap();
    assert!(retention::prune_results(&conn, K, keep_days(0), NOW, false).is_err());
    conn.execute_batch("ALTER TABLE turn_archive_gone RENAME TO turn_archive").unwrap();
    assert_eq!(live(&conn).len(), 3, "a source that cannot be read means nothing is removed");
}

#[test]
fn automatic_runs_are_throttled_unless_over_budget() {
    let conn = setup(2, 100, 0);
    save(&conn, &chat(1));
    let p = keep_days(365);
    assert!(retention::maybe_prune(&conn, K, p, NOW).is_some(), "first run");
    assert!(retention::maybe_prune(&conn, K, p, NOW + HOUR).is_none(), "inside the interval");
    assert!(retention::maybe_prune(&conn, K, p, NOW + retention::AUTO_INTERVAL_MS).is_some());
    let over = Policy { budget_bytes: 50, ..p };
    let r = retention::maybe_prune(&conn, K, over, NOW + retention::AUTO_INTERVAL_MS + 1).expect("over budget runs now").unwrap();
    assert_eq!(r.pruned, vec!["R2"]);
}

#[test]
fn the_migration_is_additive_and_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    // A database from before Phase 6, with a stored result.
    conn.execute_batch(
        "CREATE TABLE tool_results (session_key TEXT NOT NULL, result_no INTEGER NOT NULL, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, source TEXT, content TEXT NOT NULL, is_error INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, turn_no INTEGER, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_key, tool_use_id), UNIQUE (session_key, result_no));
         INSERT INTO tool_results VALUES ('c', 1, 'toolu_1', 'web_fetch', NULL, 'old body', 0, 8, 1, 5);
         CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO memory_meta VALUES ('schema_version', '3');",
    )
    .unwrap();
    ensure_tables(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    assert_eq!(load_result(&conn, "c", "R1").unwrap().content, "old body");
    let v: i64 = conn.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, MEMORY_SCHEMA_VERSION);
    assert_eq!(MEMORY_SCHEMA_VERSION, 6);
    let pruned: Option<i64> = conn.query_row("SELECT pruned_at FROM tool_results WHERE result_no = 1", [], |r| r.get(0)).unwrap();
    assert!(pruned.is_none());
    // v6 only adds tables: the stored result row is untouched and the goal
    // tables exist (a v3 database has no memory, so no goal is migrated).
    let (n, body): (i64, String) = conn.query_row("SELECT COUNT(*), MAX(content) FROM tool_results", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((n, body.as_str()), (1, "old body"));
    let goals: i64 = conn.query_row("SELECT COUNT(*) FROM memory_goals", [], |r| r.get(0)).unwrap();
    assert_eq!(goals, 0);
}

#[test]
fn clearing_the_chat_removes_its_retention_row() {
    let conn = setup(1, 100, 0);
    retention::prune_results(&conn, K, keep_days(0), NOW, false).unwrap();
    delete_memory(&conn, K).unwrap();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_retention WHERE session_key = ?1", [K], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn settings_carry_the_budget_and_keep_window_clamped() {
    // The settings file lives beside the workspace, so give it its own parent.
    let dir = std::env::temp_dir().join(format!("tm-ret-{}", uuid::Uuid::new_v4())).join("workspace");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = dir.to_str().unwrap();
    let d = load_settings(ws);
    assert_eq!(d.result_budget_bytes, retention::DEFAULT_RESULT_BUDGET_BYTES);
    assert_eq!(d.keep_unreferenced_result_days, 7);
    let s = save_settings(ws, &json!({"resultBudgetBytes": 1, "keepUnreferencedResultDays": 9999}));
    assert_eq!(s.result_budget_bytes, retention::MIN_RESULT_BUDGET_BYTES);
    assert_eq!(s.keep_unreferenced_result_days, retention::MAX_KEEP_UNREFERENCED_DAYS);
    assert_eq!(Policy::from_settings(&s).keep_unreferenced_ms, 365 * DAY);
}
