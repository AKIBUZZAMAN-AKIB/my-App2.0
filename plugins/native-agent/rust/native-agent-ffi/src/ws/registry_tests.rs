//! Phase 1 tests: registry, projection and main-memory ids.

use super::registry::{self, Sources};
use super::test_seed::{self, agent_session, AGENT_A, AGENT_B, CHAT_1, CHAT_2};
use super::{longterm, projection};
use rusqlite::params;
use serde_json::json;

fn src(s: &test_seed::Seed) -> Sources<'_> {
    Sources { state_dir: Some(&s.state_dir), workspace_dir: None, host_memory_keys: None }
}

fn n_items(c: &rusqlite::Connection) -> i64 {
    c.query_row("SELECT COUNT(*) FROM ws_items", [], |r| r.get(0)).unwrap()
}

#[test]
fn sync_is_idempotent() {
    let s = test_seed::seed();
    let first = registry::sync(&s.conn, &src(&s)).unwrap();
    assert!(first.inserted > 0);
    let n = n_items(&s.conn);
    let second = registry::sync(&s.conn, &src(&s)).unwrap();
    assert_eq!(second.inserted, 0);
    assert_eq!(n_items(&s.conn), n);
}

#[test]
fn every_source_has_one_item_per_loc() {
    let s = test_seed::seed();
    let ws = std::env::temp_dir().join(format!("ws-files-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(ws.join("docs")).unwrap();
    std::fs::write(ws.join("docs/plan.md"), "# plan").unwrap();
    s.conn.execute("INSERT INTO ctx_notes (session_key, id, title, text, created_at, updated_at) VALUES (?1, 'n1', 'Note', 'body', 1, 1)", params![CHAT_1]).unwrap();
    longterm::ensure_columns(&s.conn).unwrap();
    crate::context_tree::memory_checklist::long_term_put(&s.conn, "city", "Rajshahi", 1).unwrap();
    let sources = Sources { state_dir: Some(&s.state_dir), workspace_dir: Some(&ws), host_memory_keys: None };
    registry::sync(&s.conn, &sources).unwrap();
    for loc in [
        format!("db:sessions/{CHAT_1}"),
        format!("db:sessions/{CHAT_2}"),
        format!("db:sessions/{}", agent_session(AGENT_A)),
        format!("db:turn_memory/{CHAT_1}"),
        format!("db:ctx_notes/{CHAT_1}/n1"),
        "db:ctx_mem_file_store/h1".to_string(),
        format!("fs:subagents/{AGENT_A}"),
        format!("fs:subagents/{AGENT_B}"),
        format!("fs:subagents/{AGENT_A}/memory.json#topic"),
        "fs:workspace/docs/plan.md".to_string(),
        "host:memory@key:city".to_string(),
    ] {
        let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM ws_items WHERE loc = ?1", params![loc], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "{loc}");
    }
    let hub: i64 = s.conn.query_row("SELECT COUNT(*) FROM ws_items WHERE loc LIKE 'db:ws_messages/%'", [], |r| r.get(0)).unwrap();
    assert_eq!(hub, 1);
    let fsck = registry::fsck(&s.conn, &sources).unwrap();
    assert_eq!(fsck["ok"], true, "{fsck}");
}

#[test]
fn subagent_chat_nested_under_parent() {
    let s = test_seed::seed();
    registry::sync(&s.conn, &src(&s)).unwrap();
    let a = registry::get_by_loc(&s.conn, &format!("fs:subagents/{AGENT_A}")).unwrap().unwrap();
    let b = registry::get_by_loc(&s.conn, &format!("fs:subagents/{AGENT_B}")).unwrap().unwrap();
    let chat_a = registry::get_by_loc(&s.conn, &format!("db:sessions/{}", agent_session(AGENT_A))).unwrap().unwrap();
    assert_eq!(a["owner"], format!("session:{CHAT_1}"));
    assert_eq!(b["owner"], format!("agent:{AGENT_A}"));
    assert_eq!(b["parentId"], a["id"]);
    assert_eq!(chat_a["parentId"], a["id"]);
    assert_eq!(chat_a["owner"], format!("agent:{AGENT_A}"));
    let tree = projection::tree(&s.conn, Some(&format!("session:{CHAT_1}")), "user", None).unwrap();
    let agents = tree["sections"]["subagents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["item"]["id"], a["id"]);
    assert_eq!(agents[0]["chat"]["id"], chat_a["id"]);
    assert_eq!(agents[0]["memory"].as_array().unwrap().len(), 1);
    assert_eq!(agents[0]["subagents"][0]["item"]["id"], b["id"]);
    // the All view lists only main chats as chats
    let all = projection::tree(&s.conn, None, "user", None).unwrap();
    assert_eq!(all["sections"]["chats"]["total"], 2);
    assert_eq!(all["sections"]["subagents"]["total"], 2);
}

#[test]
fn missing_source_marks_missing_not_deleted() {
    let s = test_seed::seed();
    registry::sync(&s.conn, &src(&s)).unwrap();
    let n = n_items(&s.conn);
    s.conn.execute("DELETE FROM messages WHERE session_key = ?1", params![CHAT_2]).unwrap();
    s.conn.execute("DELETE FROM sessions WHERE session_key = ?1", params![CHAT_2]).unwrap();
    let r = registry::sync(&s.conn, &src(&s)).unwrap();
    assert_eq!(n_items(&s.conn), n, "nothing deleted");
    assert!(r.missing >= 1);
    let chat = registry::get_by_loc(&s.conn, &format!("db:sessions/{CHAT_2}")).unwrap().unwrap();
    assert_eq!(chat["state"], "missing");
    // comes back when the source does
    s.conn.execute("INSERT INTO sessions (session_key, created_at, updated_at) VALUES (?1, 1, 1)", params![CHAT_2]).unwrap();
    registry::sync(&s.conn, &src(&s)).unwrap();
    assert_eq!(registry::get_by_loc(&s.conn, &format!("db:sessions/{CHAT_2}")).unwrap().unwrap()["state"], "live");
}

#[test]
fn loc_unique_rejects_duplicate() {
    let c = test_seed::empty_db();
    registry::ensure_tables(&c).unwrap();
    c.execute("INSERT INTO ws_items (id, kind, loc, owner, origin, created_at, updated_at) VALUES ('a', 'file', 'fs:workspace/x', 'user', 'user', 1, 1)", []).unwrap();
    let dup = c.execute("INSERT INTO ws_items (id, kind, loc, owner, origin, created_at, updated_at) VALUES ('b', 'file', 'fs:workspace/x', 'user', 'user', 1, 1)", []);
    assert!(dup.is_err());
    // touch refreshes instead of inserting
    let id = registry::touch(&c, &registry::Entry::new("file", "fs:workspace/x".into(), "user".into(), "x")).unwrap();
    assert_eq!(id, "a");
}

#[test]
fn items_read_resolves_each_loc_kind() {
    let s = test_seed::seed();
    let ws = std::env::temp_dir().join(format!("ws-files-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("a.txt"), "workspace text").unwrap();
    s.conn.execute("INSERT INTO ctx_notes (session_key, id, title, text, created_at, updated_at) VALUES (?1, 'n1', 'Note', 'note body', 1, 1)", params![CHAT_1]).unwrap();
    s.conn.execute("INSERT INTO ctx_temp_summaries (session_key, id, text, focus, made_by, created_at) VALUES (?1, 's1', 'summary body', 'x', 'model', 1)", params![CHAT_1]).unwrap();
    crate::context_tree::memory_checklist::long_term_put(&s.conn, "city", "Rajshahi", 1).unwrap();
    let sources = Sources { state_dir: Some(&s.state_dir), workspace_dir: Some(&ws), host_memory_keys: None };
    registry::sync(&s.conn, &sources).unwrap();
    let read = |loc: &str| {
        let id = registry::get_by_loc(&s.conn, loc).unwrap().unwrap_or_else(|| panic!("{loc}"))["id"].as_str().unwrap().to_string();
        registry::read(&s.conn, &sources, &id, None).unwrap()["content"].clone()
    };
    assert_eq!(read(&format!("db:sessions/{CHAT_1}"))["messages"][0]["content"], "plan the launch");
    assert_eq!(read(&format!("db:sessions/{CHAT_1}"))["total"], 2);
    assert_eq!(read(&format!("db:turn_memory/{CHAT_1}"))["text"], "{}");
    assert_eq!(read(&format!("db:ctx_notes/{CHAT_1}/n1"))["text"], "note body");
    assert_eq!(read(&format!("db:ctx_temp_summaries/{CHAT_1}/s1"))["text"], "summary body");
    assert_eq!(read("db:ctx_mem_file_store/h1")["text"], "hello");
    assert_eq!(read(&format!("fs:subagents/{AGENT_A}/memory.json#topic"))["text"], "rust");
    assert_eq!(read(&format!("fs:subagents/{AGENT_A}"))["subagent"]["name"], "researcher");
    assert_eq!(read("fs:workspace/a.txt")["text"], "workspace text");
    assert_eq!(read("host:memory@key:city")["text"], "Rajshahi");
    let hub = s.conn.query_row("SELECT loc FROM ws_items WHERE loc LIKE 'db:ws_messages/%'", [], |r| r.get::<_, String>(0)).unwrap();
    assert_eq!(read(&hub)["text"], "schema is in notes.md");
    let client = registry::register_client(&s.conn, &json!({"loc": "idb:library/f1", "title": "photo.png", "size": 10})).unwrap();
    let r = registry::read(&s.conn, &sources, client["id"].as_str().unwrap(), None).unwrap();
    assert_eq!(r["content"]["clientOnly"], true);
    assert!(registry::register_client(&s.conn, &json!({"loc": "db:sessions/x"})).is_err());
    // paging
    let id = registry::get_by_loc(&s.conn, &format!("db:ctx_notes/{CHAT_1}/n1")).unwrap().unwrap()["id"].as_str().unwrap().to_string();
    let p = registry::read(&s.conn, &sources, &id, Some(&json!({"offset": 5, "limit": 2}))).unwrap();
    assert_eq!(p["content"]["text"], "bo");
    // a path that climbs out of the workspace is refused
    assert!(registry::safe_join(&ws, "../etc/passwd").is_none());
}

#[test]
fn longterm_id_is_deterministic() {
    let a = longterm::entry_id("city", 1_700_000_000_000);
    assert_eq!(a, longterm::entry_id("city", 1_700_000_000_000));
    assert_ne!(a, longterm::entry_id("city", 1_700_000_000_001));
    assert_ne!(a, longterm::entry_id("town", 1_700_000_000_000));
    assert!(a.starts_with("mem_") && a.len() == 30, "{a}");
    // Pinned value: the Kotlin and Swift providers must produce the same id.
    assert_eq!(a, PINNED_CITY_ID);
}

/// `entry_id("city", 1700000000000)`; the host provider tests pin the same value.
pub const PINNED_CITY_ID: &str = include_str!("pinned_id.txt");

#[test]
fn longterm_items_indexed_beyond_mirror_cap() {
    let s = test_seed::seed();
    for i in 0..200 {
        crate::context_tree::memory_checklist::long_term_put(&s.conn, &format!("k{i}"), "v", i).unwrap();
    }
    let host: Vec<String> = (0..2000).map(|i| format!("k{i}")).collect();
    let sources = Sources { state_dir: Some(&s.state_dir), workspace_dir: None, host_memory_keys: Some(host) };
    registry::sync(&s.conn, &sources).unwrap();
    let n: i64 = s.conn.query_row("SELECT COUNT(*) FROM ws_items WHERE kind = 'memory_longterm'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2000);
    let owner: String = s.conn.query_row("SELECT DISTINCT owner FROM ws_items WHERE kind = 'memory_longterm'", [], |r| r.get(0)).unwrap();
    assert_eq!(owner, "agent:main");
}

#[test]
fn mirror_stores_entry_id() {
    let dir = std::env::temp_dir().join(format!("ws-mirror-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("agent.db");
    let db_path = db.to_string_lossy().to_string();
    {
        let c = crate::db::open_db(&db_path).unwrap();
        crate::context_tree::memory_checklist::ensure_tables(&c).unwrap();
    }
    let id = longterm::entry_id("city", 5);
    crate::tool_runner::mirror_long_term("memory_store", &json!({"key": "city", "text": "Rajshahi"}), &json!({"success": true, "key": "city", "id": id}), &db_path);
    let c = crate::db::open_db(&db_path).unwrap();
    let got: Option<String> = c.query_row("SELECT entry_id FROM ctx_mem_longterm WHERE key = 'city'", [], |r| r.get(0)).unwrap();
    assert_eq!(got.as_deref(), Some(id.as_str()));
    let items = longterm::entries(&c, None).unwrap();
    assert_eq!(items[0].loc, format!("host:memory#{id}"));
    assert_eq!(items[0].meta["readOnly"], false);
    // an item indexed by key before the id arrived keeps its row
    let c2 = test_seed::empty_db();
    crate::context_tree::memory_checklist::long_term_put(&c2, "city", "Rajshahi", 1).unwrap();
    let src0 = Sources { state_dir: None, workspace_dir: None, host_memory_keys: None };
    registry::sync(&c2, &src0).unwrap();
    let before = registry::get_by_loc(&c2, "host:memory@key:city").unwrap().unwrap();
    longterm::set_entry_id(&c2, "city", &id).unwrap();
    registry::sync(&c2, &src0).unwrap();
    let after = registry::get_by_loc(&c2, &format!("host:memory#{id}")).unwrap().unwrap();
    assert_eq!(before["id"], after["id"]);
    assert_eq!(after["state"], "live");
}

#[test]
fn longterm_without_id_is_read_only() {
    let c = test_seed::empty_db();
    crate::context_tree::memory_checklist::long_term_put(&c, "city", "Rajshahi", 1).unwrap();
    let items = longterm::entries(&c, None).unwrap();
    assert_eq!(items[0].loc, "host:memory@key:city");
    assert_eq!(items[0].meta["readOnly"], true);
}

#[test]
fn principals_cover_user_main_agents_and_chats() {
    let s = test_seed::seed();
    registry::sync(&s.conn, &src(&s)).unwrap();
    let all = super::principals::list(&s.conn).unwrap();
    let pids: Vec<&str> = all.iter().filter_map(|p| p["pid"].as_str()).collect();
    for pid in ["user", "agent:main", "session:chat-1", "session:chat-2"] {
        assert!(pids.contains(&pid), "{pid}");
    }
    assert!(pids.contains(&format!("agent:{AGENT_A}").as_str()));
    assert_eq!(super::principals::display_name(&s.conn, &format!("agent:{AGENT_A}")), "researcher");
    // a removed agent stays, marked deleted
    std::fs::write(s.state_dir.join("registry.json"), "[]").unwrap();
    super::principals::sync(&s.conn, Some(&s.state_dir)).unwrap();
    assert_eq!(super::principals::get(&s.conn, &format!("agent:{AGENT_A}")).unwrap().unwrap()["state"], "deleted");
}

#[test]
fn request_routes_tree_and_read() {
    let s = test_seed::seed();
    let ws = std::path::Path::new("");
    let tree = super::request(&s.conn, ws, &s.state_dir, CHAT_1, "items.tree", &json!({})).unwrap();
    assert_eq!(tree["holder"], format!("session:{CHAT_1}"));
    let all = super::request(&s.conn, ws, &s.state_dir, CHAT_1, "items.tree", &json!({"all": true})).unwrap();
    assert!(all["holder"].is_null());
    let chat_id = tree["chat"]["id"].as_str().unwrap();
    let r = super::request(&s.conn, ws, &s.state_dir, CHAT_1, "items.read", &json!({"id": chat_id})).unwrap();
    assert_eq!(r["content"]["total"], 2);
    assert!(super::request(&s.conn, ws, &s.state_dir, CHAT_1, "nope", &json!({})).is_err());
}
