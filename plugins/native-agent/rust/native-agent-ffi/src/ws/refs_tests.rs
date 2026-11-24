//! Phase 4 tests: references, permissions, editing in place, the delete
//! policy, Trash, deleting a holder, and the sweep.

use super::host::{self, fake::FakeHost, HostMemory};
use super::registry::{self, Entry, Sources};
use super::{edit, refs, test_seed, trash};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::rc::Rc;

fn item(conn: &Connection, kind: &str, loc: &str, owner: &str, title: &str, meta: Value) -> String {
    let mut e = Entry::new(kind, loc.into(), owner.into(), title);
    e.meta = meta;
    registry::touch(conn, &e).unwrap()
}

fn get(conn: &Connection, id: &str) -> Value {
    registry::get(conn, id).unwrap().unwrap()
}

fn ref_state(conn: &Connection, item: &str, holder: &str) -> String {
    conn.query_row("SELECT state FROM ws_refs WHERE item_id = ?1 AND holder = ?2", params![item, holder], |r| r.get(0)).unwrap()
}

fn db() -> Connection {
    let c = test_seed::empty_db();
    trash::ensure_tables(&c).unwrap();
    c
}

fn host_with(entries: &[(&str, &str)]) -> Rc<FakeHost> {
    let h = Rc::new(FakeHost::default());
    for (k, t) in entries {
        h.store(k, t, None).unwrap();
    }
    h
}

fn notes_table(c: &Connection) {
    c.execute_batch("CREATE TABLE IF NOT EXISTS ctx_notes (session_key TEXT, id TEXT, text TEXT);").unwrap();
}

#[test]
fn every_item_gets_one_owner_ref() {
    let c = db();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "chat:s1", "n1", json!({}));
    let n: i64 = c.query_row("SELECT COUNT(*) FROM ws_refs WHERE item_id = ?1 AND mode = 'owner'", params![id], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    item(&c, "note", "db:ctx_notes/s1/n1", "chat:s1", "n1", json!({}));
    let n: i64 = c.query_row("SELECT COUNT(*) FROM ws_refs WHERE item_id = ?1", params![id], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

#[test]
fn share_rules_and_grant_ceiling() {
    let c = db();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "agent:a", "n1", json!({}));
    assert!(refs::share(&c, "agent:b", &id, "agent:c", "reference", "view", "").unwrap_err().contains("manage"));
    let r = refs::share(&c, "agent:a", &id, "agent:b", "reference", "edit", "").unwrap();
    assert_eq!(r["ref"]["perm"], "edit");
    assert!(refs::can(&c, "agent:b", &get(&c, &id), "use"));
    assert!(!refs::can(&c, "agent:b", &get(&c, &id), "manage"));
    assert!(refs::share(&c, "agent:b", &id, "agent:c", "reference", "view", "").is_err());
    assert!(refs::share(&c, "agent:a", &id, "agent:c", "owner", "view", "").is_err());
    assert!(refs::share(&c, "agent:a", &id, "agent:c", "reference", "admin", "").is_err());
    // A manage holder may grant up to manage, not the owner's ref.
    refs::share(&c, "agent:a", &id, "agent:m", "reference", "manage", "").unwrap();
    refs::share(&c, "agent:m", &id, "agent:c", "reference", "view", "").unwrap();
    // Revoke, then re-grant: the same ref and item come back.
    let rid = r["ref"]["id"].as_str().unwrap().to_string();
    refs::revoke(&c, "agent:a", &rid).unwrap();
    assert!(!refs::can(&c, "agent:b", &get(&c, &id), "view"));
    let again = refs::share(&c, "agent:a", &id, "agent:b", "reference", "view", "").unwrap();
    assert_eq!(again["ref"]["id"], rid);
    assert_eq!(refs::visible_to(&c, "agent:b").unwrap().len(), 1);
    let n: i64 = c.query_row("SELECT COUNT(*) FROM ws_audit WHERE item_id = ?1", params![id], |r| r.get(0)).unwrap();
    assert!(n >= 4);
}

#[test]
fn trash_suspends_refs_and_restore_brings_them_back() {
    let c = db();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "agent:a", "n1", json!({}));
    refs::share(&c, "agent:a", &id, "agent:b", "reference", "view", "").unwrap();
    let src = Sources::default();
    let out = trash::delete_item(&c, &src, "agent:a", &id, &trash::DeleteOpts { everywhere: true, ..Default::default() }).unwrap();
    assert_eq!(out["trashed"], true);
    assert_eq!(ref_state(&c, &id, "agent:b"), "suspended");
    assert!(!refs::can(&c, "agent:b", &get(&c, &id), "view"));
    assert_eq!(trash::list_trash(&c).unwrap().len(), 1);
    let after = out["purgeAfter"].as_i64().unwrap();
    assert!(after - super::now_ms() > 29 * 86_400_000);
    trash::restore(&c, "user", &id).unwrap();
    assert_eq!(ref_state(&c, &id, "agent:b"), "live");
    assert_eq!(get(&c, &id)["owner"], "agent:a");
    assert!(trash::restore(&c, "user", &id).is_err());
}

#[test]
fn shared_item_is_kept_unless_everywhere() {
    let c = db();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "agent:a", "n1", json!({}));
    refs::share(&c, "agent:a", &id, "agent:b", "reference", "view", "").unwrap();
    let e = trash::delete_item(&c, &Sources::default(), "agent:a", &id, &trash::DeleteOpts::default()).unwrap_err();
    assert!(e.contains("Shared with 1"));
    let dry = trash::delete_item(&c, &Sources::default(), "agent:a", &id, &trash::DeleteOpts { dry_run: true, ..Default::default() }).unwrap();
    assert_eq!(dry["sharedWith"].as_array().unwrap().len(), 1);
    assert_eq!(get(&c, &id)["state"], "live");
    // Only a manage holder deletes.
    assert!(trash::delete_item(&c, &Sources::default(), "agent:b", &id, &trash::DeleteOpts::default()).is_err());
}

#[test]
fn policy_resolution_most_specific_wins() {
    let c = db();
    let src = Sources::default();
    let it = json!({ "owner": "agent:a", "kind": "note" });
    let none = trash::Override::default();
    assert_eq!(trash::policy_for(&c, &it, None, &none).scope, "global");
    trash::set_policy(&c, &src, "user", "kind:note", "timed", Some(7 * 86_400), false, false).unwrap();
    assert_eq!(trash::policy_for(&c, &it, None, &none).retain_secs, Some(7 * 86_400));
    trash::set_policy(&c, &src, "user", "holder:agent:a", "direct", None, false, false).unwrap();
    assert!(trash::policy_for(&c, &it, None, &none).direct());
    // Deleting from another holder uses that holder's policy, else kind.
    assert_eq!(trash::policy_for(&c, &it, Some("agent:z"), &none).scope, "kind:note");
    let act = trash::Override { mode: Some("timed".into()), retain_secs: Some(None) };
    let p = trash::policy_for(&c, &it, None, &act);
    assert_eq!((p.scope.as_str(), p.retain_secs), ("action", None));
    assert!(trash::set_policy(&c, &src, "user", "nope", "timed", None, false, false).is_err());
    assert!(trash::set_policy(&c, &src, "user", "global", "soon", None, false, false).is_err());
    assert!(trash::clear_policy(&c, "user", "global").is_err());
    let v = trash::set_policy(&c, &src, "user", "global", "timed", Some(5), false, false).unwrap();
    assert_eq!(v["policy"]["retainSecs"], trash::MIN_RETAIN_SECS);
    assert_eq!(trash::clear_policy(&c, "user", "kind:note").unwrap()["removed"], true);
}

#[test]
fn until_emptied_is_never_swept() {
    let c = db();
    let src = Sources::default();
    trash::set_policy(&c, &src, "user", "global", "timed", None, false, false).unwrap();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "chat:s1", "n1", json!({}));
    let out = trash::trash(&c, &src, "user", &id).unwrap();
    assert!(out["purgeAfter"].is_null());
    let far = super::now_ms() + 20 * 365 * 86_400_000;
    assert_eq!(trash::sweep(&c, &src, far).unwrap()["purged"], 0);
}

#[test]
fn apply_to_existing_needs_confirm_when_items_become_due() {
    let c = db();
    let src = Sources::default();
    let id = item(&c, "tool_result", "db:tool_results/s1/1", "chat:s1", "r1", json!({}));
    trash::trash(&c, &src, "user", &id).unwrap();
    let v = trash::set_policy(&c, &src, "user", "global", "direct", None, true, false).unwrap();
    assert_eq!((v["saved"].clone(), v["due"].clone()), (json!(false), json!(1)));
    assert_eq!(get(&c, &id)["state"], "trashed");
    // The policy was not saved either.
    assert!(!trash::policy_for(&c, &get(&c, &id), None, &trash::Override::default()).direct());
    let v = trash::set_policy(&c, &src, "user", "global", "direct", None, true, true).unwrap();
    assert_eq!(v["purged"], 1);
    assert_eq!(get(&c, &id)["state"], "purged");
}

#[test]
fn deleting_a_holder_detaches_shared_items_and_undo_restores() {
    let c = db();
    let src = Sources::default();
    let shared = item(&c, "note", "db:ctx_notes/s9/n1", "agent:a", "shared", json!({}));
    let own = item(&c, "note", "db:ctx_notes/s9/n2", "agent:a", "own", json!({}));
    let others = item(&c, "note", "db:ctx_notes/s8/n3", "agent:z", "theirs", json!({}));
    refs::share(&c, "agent:a", &shared, "agent:b", "reference", "view", "").unwrap();
    refs::share(&c, "agent:z", &others, "agent:a", "reference", "view", "").unwrap();
    let dry = trash::delete_holder(&c, &src, "user", "agent:a", &trash::DeleteOpts { dry_run: true, ..Default::default() }).unwrap();
    assert_eq!(dry["counts"], json!({ "trash": 1, "purge": 0, "detach": 1, "revoke": 1, "affectedHolders": 0 }));
    assert_eq!(get(&c, &shared)["owner"], "agent:a");
    let out = trash::delete_holder(&c, &src, "user", "agent:a", &trash::DeleteOpts::default()).unwrap();
    let s = get(&c, &shared);
    assert_eq!((s["owner"].as_str(), s["state"].as_str()), (Some("detached"), Some("live")));
    assert_eq!(s["meta"]["origin"], "agent:a");
    assert_eq!(ref_state(&c, &shared, "agent:b"), "live");
    assert_eq!(get(&c, &own)["state"], "trashed");
    assert_eq!(ref_state(&c, &others, "agent:a"), "revoked");
    // Restoring while the holder is gone: to the library, from deleted.
    let r = trash::restore(&c, "user", &own).unwrap();
    assert_eq!((r["owner"].as_str(), r["fromDeleted"].as_bool()), (Some("detached"), Some(true)));
    // Undo of the holder delete gives the rest back.
    let u = trash::restore_batch(&c, "user", out["batch"].as_str().unwrap()).unwrap();
    assert_eq!(u["reattached"], 1);
    assert_eq!(get(&c, &shared)["owner"], "agent:a");
    assert_eq!(ref_state(&c, &others, "agent:a"), "live");
    assert!(trash::delete_holder(&c, &src, "user", "agent:main", &trash::DeleteOpts::default()).is_err());
    assert!(trash::delete_holder(&c, &src, "user", "user", &trash::DeleteOpts::default()).is_err());
}

#[test]
fn delete_everywhere_removes_shared_items_too() {
    let c = db();
    let src = Sources::default();
    let shared = item(&c, "note", "db:ctx_notes/s9/n1", "agent:a", "shared", json!({}));
    refs::share(&c, "agent:a", &shared, "agent:b", "reference", "view", "").unwrap();
    let out = trash::delete_holder(&c, &src, "user", "agent:a", &trash::DeleteOpts { everywhere: true, ..Default::default() }).unwrap();
    assert_eq!(out["counts"]["affectedHolders"], 1);
    assert_eq!(get(&c, &shared)["state"], "trashed");
    assert_eq!(ref_state(&c, &shared, "agent:b"), "suspended");
}

#[test]
fn direct_purge_revokes_refs() {
    let c = db();
    notes_table(&c);
    c.execute("INSERT INTO ctx_notes (session_key, id, title, text, created_at, updated_at) VALUES ('s1', 'n1', 'n1', 'x', 1, 1)", []).unwrap();
    let src = Sources::default();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "agent:a", "n1", json!({}));
    refs::share(&c, "agent:a", &id, "agent:b", "reference", "view", "").unwrap();
    let opts = trash::DeleteOpts { everywhere: true, action: trash::Override { mode: Some("direct".into()), retain_secs: None }, ..Default::default() };
    let out = trash::delete_item(&c, &src, "agent:a", &id, &opts).unwrap();
    assert_eq!(out["purged"], true);
    assert_eq!(ref_state(&c, &id, "agent:b"), "revoked");
    let n: i64 = c.query_row("SELECT COUNT(*) FROM ctx_notes", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn purge_deletes_at_the_source_and_sweep_runs_when_due() {
    let c = db();
    notes_table(&c);
    c.execute("INSERT INTO ctx_notes (session_key, id, title, text, created_at, updated_at) VALUES ('s1', 'n1', 'n1', 'hello', 1, 1)", []).unwrap();
    let src = Sources::default();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "chat:s1", "n1", json!({}));
    trash::trash(&c, &src, "user", &id).unwrap();
    assert_eq!(trash::sweep(&c, &src, super::now_ms()).unwrap()["purged"], 0);
    let later = super::now_ms() + 31 * 86_400_000;
    assert_eq!(trash::sweep(&c, &src, later).unwrap()["purged"], 1);
    let n: i64 = c.query_row("SELECT COUNT(*) FROM ctx_notes", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
    assert_eq!(get(&c, &id)["state"], "purged");
    assert_eq!(trash::take_auto_purged(&c), 1);
    assert_eq!(trash::take_auto_purged(&c), 0);
}

#[test]
fn workspace_file_is_deleted_on_purge() {
    let c = db();
    let dir = std::env::temp_dir().join(format!("ws_p4_{}", super::ids::new_id("t")));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "hi").unwrap();
    let src = Sources { workspace_dir: Some(dir.as_path()), ..Default::default() };
    let id = item(&c, "file", "fs:workspace/a.txt", "user", "a.txt", json!({}));
    trash::purge(&c, &src, "user", &id).unwrap();
    assert!(!dir.join("a.txt").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn host_purge_failure_stays_in_trash_and_is_retried() {
    let c = db();
    let src = Sources::default();
    let h = host_with(&[("fav", "blue")]);
    let id = item(&c, "memory_longterm", "host:memory#e1", "agent:main", "fav", json!({ "key": "fav" }));
    *h.fail.borrow_mut() = true;
    let hd: Rc<dyn HostMemory> = h.clone();
    let e = host::with_host(Some(hd.clone()), || trash::purge(&c, &src, "user", &id)).unwrap_err();
    assert!(e.contains("offline"));
    let it = get(&c, &id);
    assert_eq!(it["state"], "trashed");
    assert!(it["meta"]["purge_error"].as_str().unwrap().contains("offline"));
    *h.fail.borrow_mut() = false;
    let later = super::now_ms() + 1;
    let v = host::with_host(Some(hd), || trash::sweep(&c, &src, later)).unwrap();
    assert_eq!(v["purged"], 1);
    assert!(!h.entries.borrow().contains_key("fav"));
    // Without a host the purge says so and keeps it.
    let id2 = item(&c, "memory_longterm", "host:memory#e2", "agent:main", "x", json!({ "key": "x" }));
    assert!(trash::purge(&c, &src, "user", &id2).unwrap_err().contains("not available"));
}

#[test]
fn trashing_main_memory_flags_the_host_and_sharing_pins_it() {
    let c = db();
    let src = Sources::default();
    let h = host_with(&[("fav", "blue")]);
    let hd: Rc<dyn HostMemory> = h.clone();
    let id = item(&c, "memory_longterm", "host:memory#e1", "agent:main", "fav", json!({ "key": "fav" }));
    host::with_host(Some(hd.clone()), || {
        let r = refs::share(&c, "agent:main", &id, "agent:a", "reference", "view", "").unwrap();
        assert_eq!(r["pinned"], true);
        assert_eq!(h.entries.borrow()["fav"].1["pinned"], true);
        trash::trash(&c, &src, "user", &id).unwrap();
        assert!(h.entries.borrow()["fav"].1.get("trashed_at").is_some());
        assert!(h.entries.borrow()["fav"].1.get("pinned").is_none());
        trash::restore(&c, "user", &id).unwrap();
        let meta = h.entries.borrow()["fav"].1.clone();
        assert!(meta.get("trashed_at").is_none());
        assert_eq!(meta["pinned"], true);
    });
    trash::trash(&c, &src, "user", &id).unwrap();
    assert!(get(&c, &id)["meta"].get("hostPending").is_some());
    host::with_host(Some(hd), || trash::sweep(&c, &src, super::now_ms())).unwrap();
    assert!(get(&c, &id)["meta"].get("hostPending").is_none());
    assert!(h.entries.borrow()["fav"].1.get("trashed_at").is_some());
}

#[test]
fn edit_in_place_is_seen_by_every_holder() {
    let c = db();
    notes_table(&c);
    c.execute("INSERT INTO ctx_notes (session_key, id, title, text, created_at, updated_at) VALUES ('s1', 'n1', 'n1', 'old', 1, 1)", []).unwrap();
    let src = Sources::default();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "agent:a", "n1", json!({}));
    refs::share(&c, "agent:a", &id, "agent:b", "reference", "view", "").unwrap();
    assert!(edit::edit(&c, &src, "agent:b", &id, "nope", "").is_err());
    refs::share(&c, "agent:a", &id, "agent:b", "reference", "edit", "").unwrap();
    edit::edit(&c, &src, "agent:b", &id, "new text", "").unwrap();
    let t: String = c.query_row("SELECT text FROM ctx_notes WHERE id = 'n1'", [], |r| r.get(0)).unwrap();
    assert_eq!(t, "new text");
    assert!(edit::edit(&c, &src, "agent:a", &id, "   ", "").is_err());
}

#[test]
fn edit_main_memory_keeps_its_flags() {
    let c = db();
    c.execute_batch("CREATE TABLE IF NOT EXISTS ctx_mem_longterm (key TEXT PRIMARY KEY, text TEXT, updated_at INTEGER, removed INTEGER DEFAULT 0);").unwrap();
    let h = host_with(&[("fav", "blue")]);
    h.store("fav", "", Some(&json!({ "__merge": true, "pinned": true }))).unwrap();
    let hd: Rc<dyn HostMemory> = h.clone();
    let id = item(&c, "memory_longterm", "host:memory#e1", "agent:main", "fav", json!({ "key": "fav" }));
    host::with_host(Some(hd), || edit::edit(&c, &Sources::default(), "user", &id, "green", "")).unwrap();
    let (text, meta) = h.entries.borrow()["fav"].clone();
    assert_eq!((text.as_str(), meta["pinned"].clone()), ("green", json!(true)));
    assert!(edit::edit(&c, &Sources::default(), "user", &id, "red", "").unwrap_err().contains("not available"));
}

#[test]
fn idb_items_are_queued_for_the_webview() {
    let c = db();
    let src = Sources::default();
    let id = item(&c, "page", "idb:pages/p1", "user", "p1", json!({}));
    trash::purge(&c, &src, "user", &id).unwrap();
    let q = trash::client_purges(&c).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(trash::client_purged(&c, &[id]).unwrap(), 1);
    assert!(trash::client_purges(&c).unwrap().is_empty());
}

#[test]
fn workspace_requests_reach_the_new_ops() {
    let c = db();
    let state = std::env::temp_dir().join(format!("ws_p4s_{}", super::ids::new_id("t")));
    std::fs::create_dir_all(&state).unwrap();
    let id = item(&c, "note", "db:ctx_notes/s1/n1", "user", "n1", json!({}));
    let req = |op: &str, body: Value| super::request(&c, std::path::Path::new(""), &state, "s1", op, &body);
    let shared = req("workspace.items.share", json!({ "itemId": id, "holder": "agent:a", "perm": "use" })).unwrap();
    assert_eq!(shared["ref"]["mode"], "reference");
    let holders = req("workspace.items.holders", json!({ "itemId": id })).unwrap();
    assert_eq!(holders["refs"].as_array().unwrap().len(), 2);
    let pol = req("workspace.items.policy.get", json!({ "id": id })).unwrap();
    assert_eq!(pol["effective"]["mode"], "timed");
    let prev = req("workspace.items.deletePreview", json!({ "id": id })).unwrap();
    assert_eq!(prev["dryRun"], true);
    let d = req("workspace.items.delete", json!({ "id": id, "everywhere": true })).unwrap();
    assert_eq!(d["trashed"], true);
    let t = req("workspace.items.trashList", json!({})).unwrap();
    assert_eq!(t["items"].as_array().unwrap().len(), 1);
    let u = req("workspace.items.restoreBatch", json!({ "batch": d["batch"] })).unwrap();
    assert_eq!(u["restored"], 1);
    let e = req("workspace.items.emptyTrash", json!({})).unwrap();
    assert_eq!(e["needsConfirm"], true);
    let _ = std::fs::remove_dir_all(&state);
}
