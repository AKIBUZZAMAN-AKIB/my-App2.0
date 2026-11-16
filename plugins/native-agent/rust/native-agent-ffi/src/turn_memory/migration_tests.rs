//! Upgrading real older databases to schema v6.
//!
//! `fixtures/memory-v5.db` was written by the previous build (schema 5, the
//! commit before the goal lifecycle) from a 22-turn Bengali chat: rolling
//! memory through turn 14 (2 versions), 22 archived turns with their FTS5
//! index, 46 transcript messages and a free-text goal.

use super::store::MEMORY_SCHEMA_VERSION;
use super::*;
use rusqlite::Connection;

const FIXTURE: &[u8] = include_bytes!("fixtures/memory-v5.db");
const KEY: &str = "chat-v5";

fn fixture_copy(name: &str) -> (std::path::PathBuf, Connection) {
    let dir = std::env::temp_dir().join(format!("tm-migration-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("agent.db");
    std::fs::write(&path, FIXTURE).unwrap();
    let conn = crate::db::open_db(path.to_str().unwrap()).unwrap();
    (path, conn)
}

fn schema(conn: &Connection) -> i64 {
    conn.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap()
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn snapshot(conn: &Connection) -> (String, i64, i64, i64, i64) {
    (
        conn.query_row("SELECT memory_json FROM turn_memory WHERE session_key = ?1", [KEY], |r| r.get(0)).unwrap(),
        count(conn, "SELECT COUNT(*) FROM turn_memory_versions"),
        count(conn, "SELECT COUNT(*) FROM turn_archive"),
        count(conn, "SELECT COUNT(*) FROM messages"),
        count(conn, "SELECT COUNT(*) FROM turn_fts"),
    )
}

#[test]
fn a_v5_database_from_the_previous_build_upgrades_to_v6() {
    let (path, conn) = fixture_copy("v5");
    assert_eq!(schema(&conn), 5);
    let before = snapshot(&conn);
    let old: serde_json::Value = serde_json::from_str(&before.0).unwrap();
    let goal_text = old["goal"].as_str().unwrap().to_string();
    assert!(goal_text.contains("নীলপদ্ম"));

    ensure_tables(&conn).unwrap();
    assert_eq!(schema(&conn), MEMORY_SCHEMA_VERSION);
    assert_eq!(MEMORY_SCHEMA_VERSION, 6);

    // The free-text goal is G001, active and current, its text verbatim.
    let st = goals::load_state(&conn, KEY);
    assert_eq!(st.goals.len(), 1);
    let g = &st.goals[0];
    assert_eq!((g.goal_id.as_str(), g.status.as_str(), g.source_turn), ("G001", "active", 0));
    assert_eq!(g.description, goal_text, "the whole goal string, unchanged");
    assert!(goal_text.starts_with(g.title.trim_end_matches('…')), "the title is its start");
    assert_eq!(st.current_goal_id.as_deref(), Some("G001"));
    let origin: String = conn.query_row("SELECT origin FROM memory_goal_events WHERE session_key = ?1", [KEY], |r| r.get(0)).unwrap();
    assert_eq!(origin, "migration");

    // Nothing that was there changes: memory row, versions, archive,
    // transcript, FTS rows.
    assert_eq!(snapshot(&conn), before, "the upgrade only adds");
    let mem = load_memory(&conn, KEY);
    assert_eq!((mem.version, mem.through_turn), (2, 14));
    assert_eq!(mem.decisions.current.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec!["D1", "D2", "D3", "D4", "D5"]);
    assert_eq!(mem.items.len(), 9);
    assert_eq!(mem.segments.len(), 6);
    assert!(mem.decisions.current.iter().all(|d| d.goal_id.is_none()), "no goal link is invented for old decisions");
    assert!(mem.items.iter().all(|i| i.goal_id.is_none()), "nor for old items");
    assert!(mem.items.iter().any(|i| i.text.contains("9150")), "facts readable");
    assert_eq!(list_versions(&conn, KEY).len(), 2);
    assert_eq!(load_turns(&conn, KEY, 1, 22).len(), 22);

    // FTS5 still answers over the archived turns.
    assert!(fts::available(&conn));
    let hits = fts::search_turns(&conn, KEY, "kakatua staging", 22, 5);
    assert!(!hits.is_empty(), "FTS finds the staging host");

    // The selected block starts with the migrated goal.
    let words = |s: &str| s.split_whitespace().count();
    let block = select::select(&select::Input { mem: &mem, goals: &st, query: "what is the deadline?", previous: "", fts_turns: &[], max_tokens: 2_000 }, &words).text;
    assert!(block.contains("Current goal: G001 [active]"), "{block}");

    // Reopening is a no-op: no second G001, no new event, same version.
    drop(conn);
    let conn = crate::db::open_db(path.to_str().unwrap()).unwrap();
    ensure_tables(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memory_goal_events"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM memory_goals"), 1);
    assert_eq!(schema(&conn), 6);
    let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(ok, "ok");
    let fts_ok: Result<(), _> = conn.execute_batch("INSERT INTO turn_fts(turn_fts) VALUES('integrity-check')");
    assert!(fts_ok.is_ok(), "{fts_ok:?}");
}

/// A failure in the middle of the upgrade rolls everything back: the
/// database stays v5 and readable, and the next open upgrades it.
#[test]
fn an_interrupted_v6_upgrade_rolls_back_and_runs_again() {
    let (_path, conn) = fixture_copy("interrupted");
    let before = snapshot(&conn);
    // A table in the way with the wrong columns: the v6 step fails after
    // some of its tables were created inside the transaction.
    conn.execute_batch("CREATE TABLE memory_goal_events (bogus TEXT)").unwrap();
    assert!(ensure_tables(&conn).is_err());
    assert_eq!(schema(&conn), 5, "still v5");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('memory_goals', 'context_assembly_audit')"), 0, "the tables made before the failure are gone");
    assert_eq!(snapshot(&conn), before);
    // load_memory refuses a store it cannot upgrade (it answers empty, as
    // before); the rows themselves are intact.
    assert_eq!(count(&conn, "SELECT through_turn FROM turn_memory WHERE session_key = 'chat-v5'"), 14);
    conn.execute_batch("DROP TABLE memory_goal_events").unwrap();
    ensure_tables(&conn).unwrap();
    assert_eq!(schema(&conn), 6);
    assert_eq!(goals::load_state(&conn, KEY).current_goal_id.as_deref(), Some("G001"));
    assert_eq!(load_memory(&conn, KEY).through_turn, 14);
}

/// A v1 database (no meta table, no version column) with a goal string.
#[test]
fn a_v1_database_gets_its_goal_as_g001() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE turn_memory (session_key TEXT PRIMARY KEY, memory_json TEXT NOT NULL, through_turn INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
         INSERT INTO turn_memory VALUES ('chat-v1', '{\"throughTurn\":7,\"goal\":\"ship the v1 build\",\"segments\":[{\"fromTurn\":1,\"toTurn\":7,\"topic\":\"build\",\"title\":\"t\",\"summary\":\"s\"}],\"decisions\":{\"current\":[{\"id\":\"D1\",\"text\":\"Use Rust\",\"turn\":2}]}}', 7, 1000);
         INSERT INTO turn_memory VALUES ('chat-nogoal', '{\"throughTurn\":7,\"segments\":[]}', 7, 1000);",
    )
    .unwrap();
    ensure_tables(&conn).unwrap();
    assert_eq!(schema(&conn), 6);
    let st = goals::load_state(&conn, "chat-v1");
    assert_eq!(st.current_goal_id.as_deref(), Some("G001"));
    assert_eq!(st.goals[0].description, "ship the v1 build");
    assert!(goals::load_state(&conn, "chat-nogoal").goals.is_empty(), "no goal string, no goal");
    let mem = load_memory(&conn, "chat-v1");
    assert_eq!(mem.decisions.current[0].text, "Use Rust");
    assert!(mem.decisions.current[0].goal_id.is_none());
}
