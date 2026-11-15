//! Schema v5: full-text index over archived turns (fts.rs).

use super::*;
use crate::types::Message;
use rusqlite::Connection;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    conn
}

fn archive_all(conn: &Connection, key: &str, msgs: &[Message]) {
    let turns = split_turns(msgs);
    archive_turns(conn, key, msgs, &turns, 1).unwrap();
}

fn fts_rows(conn: &Connection, key: &str) -> i64 {
    conn.query_row("SELECT count(*) FROM turn_fts WHERE session_key = ?1", [key], |r| r.get(0)).unwrap()
}

#[test]
fn the_bundled_sqlite_has_fts5_and_the_index_is_created() {
    let conn = db();
    assert!(fts::available(&conn));
    let meta: String = conn.query_row("SELECT value FROM memory_meta WHERE key = 'fts'", [], |r| r.get(0)).unwrap();
    assert!(meta.starts_with("ok"), "{}", meta);
    let v: i64 = conn.query_row("SELECT CAST(value AS INTEGER) FROM memory_meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 5);
}

#[test]
fn bengali_words_are_found_whole_and_by_their_stem() {
    let conn = db();
    let msgs = vec![
        Message::user("প্রকল্পের নাম কাগজের নৌকা রাখব"),
        Message::assistant_text("ঠিক আছে"),
        Message::user("কেউ নামের গাছ লাগাবে"),
        Message::assistant_text("আচ্ছা"),
        Message::user("ঢাকা থেকে রাজশাহী যাত্রা"),
        Message::assistant_text("বাসে যাবেন"),
    ];
    archive_all(&conn, "c", &msgs);
    assert_eq!(fts::search_turns(&conn, "c", "কাগজ", 10, 5), vec![1], "stem matches the inflected word only");
    assert_eq!(fts::search_turns(&conn, "c", "রাজশাহীতে কীভাবে যাব?", 10, 5).first(), Some(&3));
    // The default tokenizer would split গাছ into গ + ছ and match কাগজের; ours does not.
    assert_eq!(fts::search_turns(&conn, "c", "গাছ", 10, 5), vec![2]);
}

#[test]
fn a_detail_missing_from_the_index_is_found_among_hundreds_of_turns() {
    let conn = db();
    let mut msgs = Vec::new();
    for i in 1..=300u32 {
        let user = if i == 237 { "The build failed with error E0597 borrowed value does not live long enough".to_string() } else { format!("step {} of the ledger import, সাধারণ কাজ {}", i, i) };
        msgs.push(Message::user(&user));
        msgs.push(Message::assistant_text(&format!("done {}", i)));
    }
    archive_all(&conn, "c", &msgs);
    assert_eq!(fts::search_turns(&conn, "c", "what was the E0597 error?", 300, 12).first(), Some(&237));
    // Only summarized turns are searched.
    assert!(fts::search_turns(&conn, "c", "E0597", 200, 12).is_empty());
}

#[test]
fn search_never_crosses_into_another_chat() {
    let conn = db();
    archive_all(&conn, "a", &[Message::user("the secret codename is bluefinch"), Message::assistant_text("ok")]);
    archive_all(&conn, "b", &[Message::user("nothing here"), Message::assistant_text("ok")]);
    assert_eq!(fts::search_turns(&conn, "a", "bluefinch", 10, 5), vec![1]);
    assert!(fts::search_turns(&conn, "b", "bluefinch", 10, 5).is_empty());
}

#[test]
fn rewind_reset_and_rewrite_keep_the_index_in_step_with_the_archive() {
    let conn = db();
    let mut msgs = Vec::new();
    for i in 1..=6u32 {
        msgs.push(Message::user(&format!("alpha{} topic", i)));
        msgs.push(Message::assistant_text("ok"));
    }
    archive_all(&conn, "c", &msgs);
    assert_eq!(fts_rows(&conn, "c"), 6);
    forget_after(&conn, "c", 4, 2).unwrap();
    assert_eq!(fts_rows(&conn, "c"), 4);
    assert!(fts::search_turns(&conn, "c", "alpha5", 10, 5).is_empty());
    // A rewritten turn is re-indexed, not duplicated.
    let mut changed = msgs[..8].to_vec();
    changed[0] = Message::user("gamma replaced text");
    archive_all(&conn, "c", &changed);
    assert_eq!(fts_rows(&conn, "c"), 4);
    assert_eq!(fts::search_turns(&conn, "c", "gamma", 10, 5), vec![1]);
    assert!(fts::search_turns(&conn, "c", "alpha1", 10, 5).is_empty());
    reset_memory(&conn, "c", "test", 3).unwrap();
    assert_eq!(fts_rows(&conn, "c"), 0);
}

#[test]
fn an_existing_v4_database_is_backfilled_without_losing_rows() {
    let conn = db();
    let msgs = vec![Message::user("orchid deployment notes"), Message::assistant_text("ok"), Message::user("second turn"), Message::assistant_text("ok")];
    archive_all(&conn, "c", &msgs);
    // Simulate a database written by schema v4: no index, version 4.
    conn.execute_batch("DROP TRIGGER turn_archive_fts_delete; DROP TABLE turn_fts; UPDATE memory_meta SET value = '4' WHERE key = 'schema_version';").unwrap();
    let before: i64 = conn.query_row("SELECT count(*) FROM turn_archive", [], |r| r.get(0)).unwrap();
    ensure_tables(&conn).unwrap();
    let after: i64 = conn.query_row("SELECT count(*) FROM turn_archive", [], |r| r.get(0)).unwrap();
    assert_eq!(before, after);
    assert_eq!(fts_rows(&conn, "c"), 2);
    assert_eq!(fts::search_turns(&conn, "c", "orchid", 10, 5), vec![1]);
    let meta: String = conn.query_row("SELECT value FROM memory_meta WHERE key = 'fts'", [], |r| r.get(0)).unwrap();
    assert_eq!(meta, "ok; backfilled 2 turns");
}

#[test]
fn without_the_index_search_is_empty_and_archiving_still_works() {
    let conn = db();
    conn.execute_batch("DROP TRIGGER turn_archive_fts_delete; DROP TABLE turn_fts;").unwrap();
    archive_all(&conn, "c", &[Message::user("plain text"), Message::assistant_text("ok")]);
    assert!(fts::search_turns(&conn, "c", "plain", 10, 5).is_empty());
    assert_eq!(load_turns(&conn, "c", 1, 1).len(), 1);
}

#[test]
fn index_hits_and_text_hits_merge_into_disjoint_sorted_ranges() {
    use super::fts::merge_hits;
    assert_eq!(merge_hits(&[(10, 12), (1, 2)], &[3, 11, 40, 41]), vec![(1, 3), (10, 12), (40, 41)]);
    assert!(merge_hits(&[], &[]).is_empty());
}
