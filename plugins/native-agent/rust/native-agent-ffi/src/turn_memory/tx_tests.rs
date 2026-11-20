//! Phase 2: transaction safety, concurrent writers, corrupt JSON recovery,
//! schema versioning and additive migration.

use super::*;
use rusqlite::Connection;
use serde_json::json;
use std::sync::{Arc, Barrier};

fn file_db(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tm-tx-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("agent.db");
    let c = crate::db::open_db(p.to_str().unwrap()).unwrap();
    ensure_tables(&c).unwrap();
    p
}

fn mem(through: u32) -> TurnMemory {
    TurnMemory {
        through_turn: through,
        segments: vec![Segment { from_turn: 1, to_turn: through, topic: "t".into(), title: "t".into(), summary: format!("through {through}"), created_at: 0 }],
        ..Default::default()
    }
}

#[test]
fn write_tx_rolls_back_on_error_and_composes_as_a_savepoint() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
    let r: Result<(), rusqlite::Error> = write_tx(&c, |tx| {
        tx.execute("INSERT INTO t VALUES (1)", [])?;
        Err(rusqlite::Error::InvalidQuery)
    });
    assert!(r.is_err());
    let n: i64 = c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0, "failed write_tx left rows");
    // Nested: the inner failure rolls back only the inner part when the
    // outer one handles it; an outer failure rolls back everything.
    write_tx(&c, |tx| {
        tx.execute("INSERT INTO t VALUES (1)", [])?;
        let inner: Result<(), rusqlite::Error> = write_tx(tx, |t2| {
            t2.execute("INSERT INTO t VALUES (2)", [])?;
            Err(rusqlite::Error::InvalidQuery)
        });
        assert!(inner.is_err());
        Ok::<(), rusqlite::Error>(())
    })
    .unwrap();
    let xs: Vec<i64> = c.prepare("SELECT x FROM t").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
    assert_eq!(xs, vec![1]);
    assert!(c.is_autocommit(), "no transaction left open");
}

#[test]
fn write_tx_rolls_back_when_the_closure_panics() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE t (x INTEGER)").unwrap();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<(), rusqlite::Error> = write_tx(&c, |tx| {
            tx.execute("INSERT INTO t VALUES (1)", [])?;
            panic!("boom");
        });
    }));
    assert!(r.is_err());
    assert!(c.is_autocommit());
    let n: i64 = c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

/// The read-then-write in `store_result` (MAX()+1, insert) used to be a
/// DEFERRED transaction that could fail with SQLITE_BUSY_SNAPSHOT under a
/// second writer. With IMMEDIATE every writer waits its turn.
#[test]
fn concurrent_result_stores_on_separate_connections_all_succeed() {
    let p = file_db("results");
    let threads = 8;
    let per = 15;
    let gate = Arc::new(Barrier::new(threads));
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            let p = p.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                let c = crate::db::open_db(p.to_str().unwrap()).unwrap();
                gate.wait();
                for i in 0..per {
                    store_result(&c, "c", &format!("tu-{t}-{i}"), "read_file", None, &"x".repeat(3_000), false, Some(1), 1).expect("store_result failed under concurrency");
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("writer thread panicked");
    }
    let c = crate::db::open_db(p.to_str().unwrap()).unwrap();
    let (n, distinct, max): (i64, i64, i64) = c.query_row("SELECT COUNT(*), COUNT(DISTINCT result_no), MAX(result_no) FROM tool_results WHERE session_key = 'c'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(n, (threads * per) as i64);
    assert_eq!(distinct, n, "result numbers collided");
    assert_eq!(max, n, "result numbers have gaps");
}

/// Two writers saving on top of the same version: exactly one wins, the
/// other gets a version conflict (never a lost update, never a DB error).
#[test]
fn concurrent_saves_of_the_same_version_have_exactly_one_winner() {
    for round in 0..5 {
        let p = file_db(&format!("cas{round}"));
        let gate = Arc::new(Barrier::new(4));
        let handles: Vec<_> = (0..4u32)
            .map(|t| {
                let p = p.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    let c = crate::db::open_db(p.to_str().unwrap()).unwrap();
                    gate.wait();
                    save_version(&c, "c", 0, &mem(t + 1), "summary", &json!({}), None, 1)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let wins = results.iter().filter(|r| r.is_ok()).count();
        let conflicts = results.iter().filter(|r| matches!(r, Err(SaveError::Conflict { .. }))).count();
        assert_eq!(wins, 1, "round {round}: {results:?}");
        assert_eq!(conflicts, 3, "round {round}: {results:?}");
        let c = crate::db::open_db(p.to_str().unwrap()).unwrap();
        assert_eq!(load_memory(&c, "c").version, 1);
        assert_eq!(list_versions(&c, "c").len(), 1);
    }
}

#[test]
fn an_unreadable_memory_with_no_good_version_is_flagged_and_kept_aside_on_save() {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    save_version(&c, "c", 0, &mem(7), "summary", &json!({}), None, 1).unwrap();
    c.execute("UPDATE turn_memory SET memory_json = 'garbage' WHERE session_key = 'c'", []).unwrap();
    c.execute("UPDATE turn_memory_versions SET memory_json = 'garbage' WHERE session_key = 'c'", []).unwrap();
    let m = load_memory(&c, "c");
    assert!(m.unreadable, "not flagged");
    assert_eq!(m.version, 1, "keeps the live version so a save replaces the broken row");
    assert_eq!(m.recovered_from, None);
    // A new summary replaces it; the unreadable JSON is kept, not lost.
    save_version(&c, "c", m.version, &mem(3), "summary", &json!({}), None, 2).unwrap();
    let q: String = c.query_row("SELECT memory_json FROM turn_memory_quarantine WHERE session_key = 'c' AND version = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(q, "garbage");
    let after = load_memory(&c, "c");
    assert!(!after.unreadable);
    assert_eq!(after.through_turn, 3);
}

#[test]
fn a_recovered_memory_saves_on_top_of_the_broken_live_row() {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    save_version(&c, "c", 0, &mem(7), "summary", &json!({}), None, 1).unwrap();
    save_version(&c, "c", 1, &mem(14), "summary", &json!({}), None, 2).unwrap();
    c.execute("UPDATE turn_memory SET memory_json = '{oops' WHERE session_key = 'c'", []).unwrap();
    c.execute("UPDATE turn_memory_versions SET memory_json = '{oops' WHERE session_key = 'c' AND version = 2", []).unwrap();
    let m = load_memory(&c, "c");
    assert_eq!(m.recovered_from, Some(1));
    assert_eq!(m.through_turn, 7);
    assert_eq!(m.version, 2);
    let v = save_version(&c, "c", m.version, &m, "summary", &json!({}), None, 3).unwrap();
    assert_eq!(v, 3);
    assert_eq!(load_memory(&c, "c").recovered_from, None);
}

#[test]
fn a_memory_from_a_newer_build_is_read_but_never_overwritten() {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    let mut m = mem(7);
    m.schema_version = MEMORY_JSON_VERSION + 1;
    // Simulate the newer build's row directly.
    c.execute("INSERT INTO turn_memory (session_key, memory_json, version, updated_at) VALUES ('c', ?1, 1, 1)", [serde_json::to_string(&m).unwrap()]).unwrap();
    let loaded = load_memory(&c, "c");
    assert!(loaded.from_newer_build());
    assert_eq!(loaded.through_turn, 7);
    let r = save_version(&c, "c", 1, &loaded, "summary", &json!({}), None, 2);
    assert!(matches!(r, Err(SaveError::Db(_))), "{r:?}");
    assert_eq!(load_memory(&c, "c").version, 1);
}

#[test]
fn saved_memories_carry_the_json_format_version() {
    let c = Connection::open_in_memory().unwrap();
    ensure_tables(&c).unwrap();
    save_version(&c, "c", 0, &mem(7), "summary", &json!({}), None, 1).unwrap();
    let j: String = c.query_row("SELECT memory_json FROM turn_memory WHERE session_key = 'c'", [], |r| r.get(0)).unwrap();
    let v: serde_json::Value = serde_json::from_str(&j).unwrap();
    assert_eq!(v["schemaVersion"], MEMORY_JSON_VERSION);
}

/// A database made by the first release (the four tables, no meta table)
/// upgrades in place: rows kept, new tables added, version recorded, and
/// running the upgrade again changes nothing.
#[test]
fn the_schema_upgrade_from_the_first_release_is_additive_and_idempotent() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE turn_memory (session_key TEXT PRIMARY KEY, memory_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok', status_detail TEXT NOT NULL DEFAULT '', status_at INTEGER NOT NULL DEFAULT 0);
         INSERT INTO turn_memory (session_key, memory_json, version, updated_at) VALUES ('old', '{\"throughTurn\":7,\"segments\":[{\"fromTurn\":1,\"toTurn\":7,\"summary\":\"x\"}],\"facts\":[{\"text\":\"OLD-FACT\",\"turn\":2}]}', 3, 1);",
    )
    .unwrap();
    ensure_tables(&c).unwrap();
    let v: i64 = c.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, MEMORY_SCHEMA_VERSION);
    for t in ["turn_memory_versions", "turn_archive", "tool_results", "turn_memory_quarantine", "memory_meta"] {
        let n: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [t], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "{t} missing");
    }
    let m = load_memory(&c, "old");
    assert_eq!(m.version, 3);
    assert_eq!(m.items[0].text, "OLD-FACT", "old memory converts to items on load");
    assert_eq!(m.items[0].source_turns, vec![2]);
    ensure_tables(&c).unwrap();
    let n: i64 = c.query_row("SELECT COUNT(*) FROM memory_meta", [], |r| r.get(0)).unwrap();
    assert!(n >= 1);
    // A newer build's higher schema number is never lowered.
    c.execute("UPDATE memory_meta SET value = '99' WHERE key = 'schema_version'", []).unwrap();
    ensure_tables(&c).unwrap();
    let v: i64 = c.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 99);
}

/// Phase 3: the storage ceiling is a setting; old settings files load the
/// default, and values are clamped to the allowed range.
#[test]
fn the_stored_result_ceiling_is_a_clamped_setting_with_a_default() {
    let dir = std::env::temp_dir().join(format!("tm-settings-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let ws = dir.to_str().unwrap();
    std::fs::write(settings_path(ws), r#"{"enabled":true,"keepRecent":7,"batch":7}"#).unwrap();
    assert_eq!(load_settings(ws).max_stored_result_bytes, DEFAULT_STORED_RESULT_BYTES);
    assert_eq!(save_settings(ws, &json!({"maxStoredResultBytes": 1})).max_stored_result_bytes, 64 * 1024);
    assert_eq!(save_settings(ws, &json!({"maxStoredResultBytes": u64::MAX})).max_stored_result_bytes, MAX_STORED_RESULT_BYTES);
    assert_eq!(save_settings(ws, &json!({"maxStoredResultBytes": 2_000_000})).max_stored_result_bytes, 2_000_000);
    assert_eq!(load_settings(ws).keep_recent, 7);
}

/// Plan acceptance for Phase 2, literally: two connections doing
/// `store_result` concurrently 1 000 times produce contiguous unique
/// `result_no` with zero busy/snapshot failures.
#[test]
fn two_connections_store_1000_results_with_contiguous_unique_numbers() {
    let p = file_db("results1000");
    let gate = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|t| {
            let p = p.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                let c = crate::db::open_db(p.to_str().unwrap()).unwrap();
                gate.wait();
                for i in 0..500 {
                    store_result(&c, "c", &format!("tu-{t}-{i}"), "read_file", None, "x", false, Some(1), 1).expect("store_result failed under concurrency");
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("writer thread panicked");
    }
    let c = crate::db::open_db(p.to_str().unwrap()).unwrap();
    let (n, distinct, min, max): (i64, i64, i64, i64) = c.query_row("SELECT COUNT(*), COUNT(DISTINCT result_no), MIN(result_no), MAX(result_no) FROM tool_results WHERE session_key = 'c'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
    assert_eq!((n, distinct, min, max), (1000, 1000, 1, 1000));
}

/// A malformed value in a settings patch is ignored on its own; it never
/// resets the other settings to their defaults (before: `unwrap_or_default`).
#[test]
fn a_malformed_settings_value_does_not_reset_the_other_settings() {
    let dir = std::env::temp_dir().join(format!("tm-settings-bad-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("ws")).unwrap();
    let ws = dir.join("ws");
    let ws = ws.to_str().unwrap();
    let s = save_settings(ws, &json!({"keepRecent": 12, "batch": 9, "backgroundSummaries": true, "keepUnreferencedResultDays": 30}));
    assert_eq!((s.keep_recent, s.batch, s.background_summaries, s.keep_unreferenced_result_days), (12, 9, true, 30));
    let s = save_settings(ws, &json!({"batch": "nine", "keepRecent": -3, "enabled": "yes", "keepUnreferencedResultDays": 5}));
    assert_eq!((s.keep_recent, s.batch, s.enabled, s.background_summaries, s.keep_unreferenced_result_days), (12, 9, true, true, 5), "only the valid key applied");
    let back = load_settings(ws);
    assert_eq!((back.keep_recent, back.batch, back.background_summaries, back.keep_unreferenced_result_days), (12, 9, true, 5), "and that is what was saved");
}
