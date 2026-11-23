//! The item registry: one `ws_items` row per existing record, pointing at the
//! one place its bytes live (`loc`). Nothing is copied: `sync` only indexes,
//! and `read` resolves `loc` back to the real table or file.
//!
//! `loc` kinds:
//! - `db:sessions/<key>`                 a chat (messages are paged on demand)
//! - `db:turn_memory/<key>`              a chat's turn memory (summary)
//! - `db:tool_results/<key>/<n>`         one stored tool result
//! - `db:ctx_notes/<key>/<id>`           a context-tree note
//! - `db:ctx_temp_summaries/<key>/<id>`  a range summary
//! - `db:ctx_mem_file_store/<hash>`      file bytes a chat read
//! - `db:hub_messages/<id>`, `db:hub_posts/<id>`  legacy agent mail
//! - `fs:subagents/<id>`                 a sub-agent (its registry record)
//! - `fs:subagents/<id>/memory.json#<k>` one entry of a sub-agent's memory
//! - `fs:workspace/<path>`               a workspace file
//! - `host:memory#<id>` / `host:memory@key:<key>`  main memory (see longterm.rs)
//! - `idb:library/<id>`                  a file that only the WebView holds

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::ids::new_id;
use super::now_ms;

/// Kinds whose rows `sync` owns: any of these not seen in a full sync is
/// marked missing. Client-registered (`idb:`) items are never marked missing.
const SYNCED_PREFIXES: [&str; 12] = [
    "db:ws_messages/",
    "db:sessions/",
    "db:turn_memory/",
    "db:tool_results/",
    "db:ctx_notes/",
    "db:ctx_temp_summaries/",
    "db:ctx_mem_file_store/",
    "db:hub_messages/",
    "db:hub_posts/",
    "fs:subagents/",
    "fs:workspace/",
    "host:memory",
];

/// Most workspace files indexed in one sync (phones).
const MAX_WORKSPACE_FILES: usize = 5_000;

pub fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    super::ensure_meta(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ws_items (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            loc         TEXT NOT NULL UNIQUE,
            owner       TEXT NOT NULL,
            origin      TEXT NOT NULL,
            parent_id   TEXT,
            scope       TEXT,
            title       TEXT NOT NULL DEFAULT '',
            size_bytes  INTEGER NOT NULL DEFAULT 0,
            state       TEXT NOT NULL DEFAULT 'live',
            meta_json   TEXT NOT NULL DEFAULT '{}',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS ws_items_owner ON ws_items(owner, kind);
         CREATE INDEX IF NOT EXISTS ws_items_scope ON ws_items(owner, scope);
         CREATE INDEX IF NOT EXISTS ws_items_parent ON ws_items(parent_id);",
    )?;
    super::principals::ensure_tables(conn)?;
    if super::meta_get(conn, "schema_version")?.is_none() {
        super::meta_set(conn, "schema_version", &super::SCHEMA_VERSION.to_string())?;
    }
    Ok(())
}

/// One record to index.
#[derive(Debug, Clone, Default)]
pub struct Entry {
    pub kind: String,
    pub loc: String,
    pub owner: String,
    pub parent_loc: Option<String>,
    pub scope: Option<String>,
    pub title: String,
    pub size: i64,
    pub meta: Value,
    pub created_at: i64,
}

impl Entry {
    pub fn new(kind: &str, loc: String, owner: String, title: impl Into<String>) -> Self {
        Entry { kind: kind.into(), loc, owner, title: title.into(), meta: json!({}), ..Default::default() }
    }
}

/// Insert or refresh one item by `loc`; returns its id. The owner is set on
/// insert only: later moves (Phase 4) change it, a sync never takes it back.
/// A missing item that is seen again comes back to `live`; a trashed one
/// stays trashed.
pub fn touch(conn: &Connection, e: &Entry) -> rusqlite::Result<String> {
    ensure_tables(conn)?;
    let now = now_ms();
    let parent_id: Option<String> = match &e.parent_loc {
        Some(pl) => conn.query_row("SELECT id FROM ws_items WHERE loc = ?1", params![pl], |r| r.get(0)).optional()?,
        None => None,
    };
    let existing: Option<String> = conn.query_row("SELECT id FROM ws_items WHERE loc = ?1", params![e.loc], |r| r.get(0)).optional()?;
    let meta = if e.meta.is_null() { "{}".to_string() } else { e.meta.to_string() };
    let created = if e.created_at > 0 { e.created_at } else { now };
    match existing {
        Some(id) => {
            conn.execute(
                "UPDATE ws_items SET title = ?2, size_bytes = ?3, meta_json = json_patch(meta_json, ?4), updated_at = ?5,
                    parent_id = COALESCE(?6, parent_id), scope = COALESCE(?7, scope),
                    state = CASE WHEN state = 'missing' THEN 'live' ELSE state END
                 WHERE id = ?1",
                params![id, e.title, e.size, meta, now, parent_id, e.scope],
            )?;
            Ok(id)
        }
        None => {
            let id = new_id("it");
            conn.execute(
                "INSERT INTO ws_items (id, kind, loc, owner, origin, parent_id, scope, title, size_bytes, state, meta_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, 'live', ?9, ?10, ?11)",
                params![id, e.kind, e.loc, e.owner, parent_id, e.scope, e.title, e.size, meta, created, now],
            )?;
            // Every item has exactly one owner reference (Phase 4).
            super::refs::ensure_tables(conn)?;
            super::refs::add_owner(conn, &id, &e.owner)?;
            Ok(id)
        }
    }
}

/// What `sync` needs besides the database.
#[derive(Default)]
pub struct Sources<'a> {
    pub state_dir: Option<&'a Path>,
    pub workspace_dir: Option<&'a Path>,
    /// Main memory keys from the host (`MemoryProvider::list`), when the
    /// provider is attached. `None` = index only the engine's mirror.
    pub host_memory_keys: Option<Vec<String>>,
}

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub seen: usize,
    pub inserted: usize,
    pub missing: usize,
    pub revived: usize,
}

fn count_items(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM ws_items", [], |r| r.get(0)).unwrap_or(0)
}

fn table_exists(conn: &Connection, t: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", params![t], |_| Ok(())).optional().ok().flatten().is_some()
}

/// Read every source and upsert one item per record. Idempotent: a second
/// run with no change inserts nothing.
pub fn sync(conn: &Connection, src: &Sources) -> rusqlite::Result<SyncReport> {
    ensure_tables(conn)?;
    crate::context_tree::memory_checklist::ensure_tables(conn)?;
    super::longterm::ensure_columns(conn)?;
    super::longterm::relocate_keyed(conn)?;
    if let Some(dir) = src.state_dir {
        // Read paths without a Sources (the checklist) find mounted
        // sub-agent memory through this (Phase 4).
        let _ = super::meta_set(conn, "subagents_state_dir", &dir.to_string_lossy());
    }
    let before = count_items(conn);
    let missing_before: i64 = conn.query_row("SELECT COUNT(*) FROM ws_items WHERE state = 'missing'", [], |r| r.get(0))?;
    let entries = collect(conn, src)?;
    let mut seen: HashSet<String> = HashSet::new();
    crate::turn_memory::store::write_tx(conn, |tx| {
        for e in &entries {
            touch(tx, e)?;
            seen.insert(e.loc.clone());
        }
        // Anything synced before and not seen now: its source is gone.
        let mut st = tx.prepare("SELECT id, loc FROM ws_items WHERE state = 'live'")?;
        let live: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        drop(st);
        for (id, loc) in live {
            let synced = SYNCED_PREFIXES.iter().any(|p| loc.starts_with(p));
            // Without a state dir / workspace / host we cannot tell, so keep.
            let knowable = (!loc.starts_with("fs:subagents/") || src.state_dir.is_some())
                && (!loc.starts_with("fs:workspace/") || src.workspace_dir.is_some() || src.state_dir.is_some());
            if synced && knowable && !seen.contains(&loc) {
                tx.execute("UPDATE ws_items SET state = 'missing', updated_at = ?2 WHERE id = ?1", params![id, now_ms()])?;
            }
        }
        Ok::<(), rusqlite::Error>(())
    })?;
    super::principals::sync(conn, src.state_dir)?;
    let after = count_items(conn);
    let missing_after: i64 = conn.query_row("SELECT COUNT(*) FROM ws_items WHERE state = 'missing'", [], |r| r.get(0))?;
    super::meta_set(conn, "registry_synced_at", &now_ms().to_string())?;
    Ok(SyncReport {
        seen: seen.len(),
        inserted: (after - before).max(0) as usize,
        missing: missing_after.max(0) as usize,
        revived: (missing_before - missing_after).max(0) as usize,
    })
}

pub fn session_holder(key: &str) -> String {
    match key.strip_prefix("subagent:") {
        Some(id) => format!("agent:{id}"),
        None => format!("session:{key}"),
    }
}

/// Every record of every source, as entries (parents before children).
pub fn collect(conn: &Connection, src: &Sources) -> rusqlite::Result<Vec<Entry>> {
    let mut out: Vec<Entry> = Vec::new();

    // Sub-agents first, so their chats can point at them.
    let mut agent_ids: Vec<String> = Vec::new();
    if let Some(dir) = src.state_dir {
        for rec in read_registry(dir) {
            let id = rec["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            agent_ids.push(id.clone());
            let owner = match rec["parentId"].as_str().filter(|p| !p.is_empty()) {
                Some(p) => format!("agent:{p}"),
                None => {
                    let root = rec["rootSessionKey"].as_str().filter(|s| !s.is_empty()).or_else(|| rec["parentSessionKey"].as_str()).unwrap_or("");
                    session_holder(root)
                }
            };
            let parent_loc = rec["parentId"].as_str().filter(|p| !p.is_empty()).map(|p| format!("fs:subagents/{p}"));
            let name = rec["title"].as_str().filter(|t| !t.is_empty()).or_else(|| rec["name"].as_str()).unwrap_or(&id).to_string();
            let mut e = Entry::new("subagent", format!("fs:subagents/{id}"), owner, name);
            e.parent_loc = parent_loc;
            e.created_at = rec["createdAt"].as_i64().unwrap_or(0);
            e.meta = json!({
                "agentId": id, "name": rec["name"], "status": rec["status"], "sessionKey": rec["sessionKey"],
                "memoryMode": rec["memoryMode"], "depth": rec["depth"],
            });
            out.push(e);
            for f in rec["files"].as_array().cloned().unwrap_or_default() {
                let Some(path) = f["path"].as_str().filter(|p| !p.is_empty()) else { continue };
                let mut fe = Entry::new("file", format!("fs:workspace/{}", path.trim_start_matches('/')), format!("agent:{id}"), path);
                fe.parent_loc = Some(format!("fs:subagents/{id}"));
                fe.meta = json!({ "createdBy": id, "created": f["created"] });
                out.push(fe);
            }
            let mem_path = dir.join("memory").join(format!("{}.json", sanitize(&id)));
            let entries: Vec<Value> = std::fs::read(&mem_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            for m in entries {
                let Some(key) = m["key"].as_str() else { continue };
                let text = m["text"].as_str().unwrap_or("");
                // Phase 4: the entry id keeps the loc stable across key renames;
                // entries saved before ids existed keep the key.
                let eid = m["id"].as_str().filter(|x| !x.is_empty()).unwrap_or(key);
                let mut me = Entry::new("agent_memory", format!("fs:subagents/{id}/memory.json#{eid}"), format!("agent:{id}"), key);
                me.parent_loc = Some(format!("fs:subagents/{id}"));
                me.size = text.len() as i64;
                me.created_at = m["updatedAt"].as_i64().unwrap_or(0);
                me.scope = m["metadata"]["category"].as_str().filter(|c| c.starts_with("group:")).map(str::to_string);
                me.meta = json!({ "key": key, "metadata": m["metadata"] });
                out.push(me);
            }
        }
    }

    // Chats.
    {
        let mut st = conn.prepare(
            "SELECT s.session_key, s.created_at, COALESCE((SELECT COUNT(*) FROM messages m WHERE m.session_key = s.session_key), 0),
                    COALESCE((SELECT SUM(LENGTH(COALESCE(content, ''))) FROM messages m WHERE m.session_key = s.session_key), 0),
                    (SELECT content FROM messages m WHERE m.session_key = s.session_key AND m.role = 'user' ORDER BY sequence LIMIT 1)
             FROM sessions s",
        )?;
        let rows: Vec<(String, i64, i64, i64, Option<String>)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        for (key, created, n, bytes, first) in rows {
            let holder = session_holder(&key);
            let title: String = first.map(|t| t.chars().take(80).collect()).filter(|t: &String| !t.trim().is_empty()).unwrap_or_else(|| key.clone());
            let mut e = Entry::new("chat", format!("db:sessions/{key}"), holder, title);
            e.created_at = created;
            e.size = bytes;
            e.meta = json!({ "sessionKey": key, "messages": n });
            if let Some(id) = key.strip_prefix("subagent:") {
                e.parent_loc = Some(format!("fs:subagents/{id}"));
                e.meta["agentId"] = json!(id);
            }
            out.push(e);
        }
    }

    // Turn memory, stored results, notes, range summaries.
    if table_exists(conn, "turn_memory") {
        let mut st = conn.prepare("SELECT session_key, LENGTH(memory_json), updated_at FROM turn_memory")?;
        let rows: Vec<(String, i64, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        for (key, len, at) in rows {
            let mut e = Entry::new("summary", format!("db:turn_memory/{key}"), session_holder(&key), "Turn memory");
            e.parent_loc = Some(format!("db:sessions/{key}"));
            e.size = len;
            e.created_at = at;
            e.meta = json!({ "sessionKey": key });
            out.push(e);
        }
    }
    if table_exists(conn, "tool_results") {
        let mut st = conn.prepare("SELECT session_key, result_no, tool_name, bytes, created_at FROM tool_results")?;
        let rows: Vec<(String, i64, String, i64, i64)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        for (key, no, tool, bytes, at) in rows {
            let mut e = Entry::new("tool_result", format!("db:tool_results/{key}/{no}"), session_holder(&key), format!("{tool} result #{no}"));
            e.parent_loc = Some(format!("db:sessions/{key}"));
            e.size = bytes;
            e.created_at = at;
            e.meta = json!({ "sessionKey": key, "tool": tool, "resultNo": no });
            out.push(e);
        }
    }
    if table_exists(conn, "ctx_notes") {
        let mut st = conn.prepare("SELECT session_key, id, title, LENGTH(text), created_at FROM ctx_notes")?;
        let rows: Vec<(String, String, String, i64, i64)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        for (key, id, title, len, at) in rows {
            let mut e = Entry::new("note", format!("db:ctx_notes/{key}/{id}"), session_holder(&key), title);
            e.parent_loc = Some(format!("db:sessions/{key}"));
            e.size = len;
            e.created_at = at;
            e.meta = json!({ "sessionKey": key });
            out.push(e);
        }
    }
    if table_exists(conn, "ctx_temp_summaries") {
        let mut st = conn.prepare("SELECT session_key, id, COALESCE(focus, ''), LENGTH(text), created_at FROM ctx_temp_summaries")?;
        let rows: Vec<(String, String, String, i64, i64)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        for (key, id, focus, len, at) in rows {
            let title = if focus.is_empty() { "Range summary".to_string() } else { format!("Summary: {focus}") };
            let mut e = Entry::new("summary", format!("db:ctx_temp_summaries/{key}/{id}"), session_holder(&key), title);
            e.parent_loc = Some(format!("db:sessions/{key}"));
            e.size = len;
            e.created_at = at;
            e.meta = json!({ "sessionKey": key });
            out.push(e);
        }
    }

    // Files chats read: one item per hash, with the chats that read it.
    {
        let mut st = conn.prepare("SELECT hash, MIN(path), MAX(bytes), MIN(first_seen) FROM ctx_mem_file_store GROUP BY hash")?;
        let rows: Vec<(String, String, i64, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        drop(st);
        let mut st = conn.prepare("SELECT DISTINCT session_key FROM ctx_mem_files WHERE hash = ?1 ORDER BY session_key")?;
        let mut pst = conn.prepare("SELECT DISTINCT path FROM ctx_mem_file_store WHERE hash = ?1 ORDER BY path")?;
        for (hash, path, bytes, at) in rows {
            let sessions: Vec<String> = st.query_map(params![hash], |r| r.get(0))?.collect::<Result<_, _>>()?;
            let paths: Vec<String> = pst.query_map(params![hash], |r| r.get(0))?.collect::<Result<_, _>>()?;
            let owner = sessions.first().map(|s| session_holder(s)).unwrap_or_else(|| "user".into());
            let mut e = Entry::new("file", format!("db:ctx_mem_file_store/{hash}"), owner, path);
            e.size = bytes;
            e.created_at = at;
            e.scope = Some("read".into());
            e.meta = json!({ "hash": hash, "sessions": sessions, "paths": paths });
            out.push(e);
        }
    }

    // Main memory (read side; ids from longterm.rs).
    out.extend(super::longterm::entries(conn, src.host_memory_keys.as_deref())?);

    // Workspace files.
    if let Some(dir) = src.workspace_dir {
        let mut files = Vec::new();
        list_files(dir, dir, &mut files, 0);
        for (rel, size) in files.into_iter().take(MAX_WORKSPACE_FILES) {
            let mut e = Entry::new("file", format!("fs:workspace/{rel}"), "user".into(), rel.clone());
            e.size = size as i64;
            e.scope = Some("workspace".into());
            e.meta = json!({ "path": rel });
            out.push(e);
        }
    }

    // Legacy agent mail (moved to envelopes in Phase 2).
    if table_exists(conn, "hub_messages") {
        let mut st = conn.prepare("SELECT id, sender, recipient, kind, text, at_ms, session FROM hub_messages")?;
        let rows: Vec<(String, String, String, String, String, i64, String)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?.collect::<Result<_, _>>()?;
        for (id, from, to, kind, text, at, session) in rows {
            let owner = if session.is_empty() { "user".to_string() } else { session_holder(&session) };
            let mut e = Entry::new("message", format!("db:hub_messages/{id}"), owner, format!("{from} → {to}: {}", text.chars().take(60).collect::<String>()));
            e.size = text.len() as i64;
            e.created_at = at;
            e.scope = Some("legacy:hub".into());
            e.meta = json!({ "from": from, "to": to, "kind": kind });
            out.push(e);
        }
    }
    // The workspace message store (peer chats, agent mail, chat-to-chat).
    if table_exists(conn, "ws_messages") {
        let mut st = conn.prepare("SELECT id, conversation, from_pid, kind, text, created_at FROM ws_messages WHERE state <> 'purged'")?;
        let rows: Vec<(String, String, String, String, String, i64)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?.collect::<Result<_, _>>()?;
        for (id, conv, from, kind, text, at) in rows {
            let k = if conv.starts_with("group:") { "group_message" } else { "message" };
            let mut e = Entry::new(k, format!("db:ws_messages/{id}"), from.clone(), format!("{from}: {}", text.chars().take(60).collect::<String>()));
            e.size = text.len() as i64;
            e.created_at = at;
            e.scope = Some(conv.clone());
            e.meta = json!({ "conversation": conv, "from": from, "kind": kind });
            out.push(e);
        }
    }
    if table_exists(conn, "hub_posts") {
        let mut st = conn.prepare("SELECT id, author, title, LENGTH(body), at_ms FROM hub_posts")?;
        let rows: Vec<(String, String, String, i64, i64)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        for (id, author, title, len, at) in rows {
            let mut e = Entry::new("message", format!("db:hub_posts/{id}"), "user".into(), format!("{author}: {title}"));
            e.size = len;
            e.created_at = at;
            e.scope = Some("legacy:hub".into());
            e.meta = json!({ "author": author, "post": true });
            out.push(e);
        }
    }
    let _ = agent_ids;
    Ok(out)
}

/// The same file-name rule the sub-agent manager uses.
/// Does a sub-agent memory entry match the `#<ref>` of its loc (its id, or
/// its key for entries saved before ids)?
pub fn memory_entry_is(e: &Value, r: &str) -> bool {
    match e["id"].as_str().filter(|x| !x.is_empty()) {
        Some(id) => id == r,
        None => e["key"] == r,
    }
}

pub fn sanitize(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if (c == '-' || c == '_' || c == ' ' || c == '.') && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

pub fn read_registry(state_dir: &Path) -> Vec<Value> {
    std::fs::read(state_dir.join("registry.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn list_files(root: &Path, dir: &Path, out: &mut Vec<(String, u64)>, depth: usize) {
    if depth > 6 || out.len() >= MAX_WORKSPACE_FILES {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "subagents" {
            continue;
        }
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            list_files(root, &p, out, depth + 1);
        } else if md.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push((rel.to_string_lossy().replace('\\', "/"), md.len()));
            }
        }
    }
}

// ── Reading ──────────────────────────────────────────────────────────────────

pub fn item_json(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let meta: String = row.get("meta_json")?;
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "kind": row.get::<_, String>("kind")?,
        "loc": row.get::<_, String>("loc")?,
        "owner": row.get::<_, String>("owner")?,
        "origin": row.get::<_, String>("origin")?,
        "parentId": row.get::<_, Option<String>>("parent_id")?,
        "scope": row.get::<_, Option<String>>("scope")?,
        "title": row.get::<_, String>("title")?,
        "size": row.get::<_, i64>("size_bytes")?,
        "state": row.get::<_, String>("state")?,
        "meta": serde_json::from_str::<Value>(&meta).unwrap_or(json!({})),
        "createdAt": row.get::<_, i64>("created_at")?,
        "updatedAt": row.get::<_, i64>("updated_at")?,
    }))
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    ensure_tables(conn)?;
    conn.query_row("SELECT * FROM ws_items WHERE id = ?1", params![id], item_json).optional()
}

pub fn get_by_loc(conn: &Connection, loc: &str) -> rusqlite::Result<Option<Value>> {
    ensure_tables(conn)?;
    conn.query_row("SELECT * FROM ws_items WHERE loc = ?1", params![loc], item_json).optional()
}

pub fn query(conn: &Connection, sql_where: &str, args: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<Vec<Value>> {
    ensure_tables(conn)?;
    let mut st = conn.prepare(&format!("SELECT * FROM ws_items WHERE {sql_where}"))?;
    let rows = st.query_map(args, item_json)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Resolve `loc` and read the bytes from where they live. `range` is
/// `{offset, limit}` (messages for a chat, characters for text).
pub fn read(conn: &Connection, src: &Sources, id: &str, range: Option<&Value>) -> Result<Value, String> {
    let item = get(conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("No item {id}."))?;
    let loc = item["loc"].as_str().unwrap_or("").to_string();
    let offset = range.and_then(|r| r["offset"].as_u64()).unwrap_or(0) as usize;
    let limit = range.and_then(|r| r["limit"].as_u64()).unwrap_or(0) as usize;
    let page_text = |t: String| -> Value {
        let total = t.chars().count();
        let lim = if limit == 0 { 64_000 } else { limit };
        let text: String = t.chars().skip(offset).take(lim).collect();
        json!({ "text": text, "offset": offset, "total": total, "more": offset + lim < total })
    };
    let one = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> Result<String, String> {
        conn.query_row(sql, args, |r| r.get::<_, Option<String>>(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten()
            .ok_or_else(|| format!("The source of {id} is gone ({loc})."))
    };
    let body: Value = if let Some(key) = loc.strip_prefix("db:sessions/") {
        let lim = if limit == 0 { 50 } else { limit.min(500) };
        let mut st = conn
            .prepare("SELECT sequence, role, content, timestamp FROM messages WHERE session_key = ?1 ORDER BY sequence LIMIT ?2 OFFSET ?3")
            .map_err(|e| e.to_string())?;
        let msgs: Vec<Value> = st
            .query_map(params![key, lim as i64, offset as i64], |r| {
                Ok(json!({ "seq": r.get::<_, i64>(0)?, "role": r.get::<_, String>(1)?, "content": r.get::<_, Option<String>>(2)?, "at": r.get::<_, Option<i64>>(3)? }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM messages WHERE session_key = ?1", params![key], |r| r.get(0)).unwrap_or(0);
        json!({ "messages": msgs, "offset": offset, "total": total })
    } else if let Some(key) = loc.strip_prefix("db:turn_memory/") {
        page_text(one("SELECT memory_json FROM turn_memory WHERE session_key = ?1", &[&key])?)
    } else if let Some(rest) = loc.strip_prefix("db:tool_results/") {
        let (key, no) = rest.rsplit_once('/').ok_or("bad loc")?;
        let no: i64 = no.parse().map_err(|_| "bad loc")?;
        page_text(one("SELECT content FROM tool_results WHERE session_key = ?1 AND result_no = ?2", &[&key, &no])?)
    } else if let Some(rest) = loc.strip_prefix("db:ctx_notes/") {
        let (key, nid) = rest.rsplit_once('/').ok_or("bad loc")?;
        page_text(one("SELECT text FROM ctx_notes WHERE session_key = ?1 AND id = ?2", &[&key, &nid])?)
    } else if let Some(rest) = loc.strip_prefix("db:ctx_temp_summaries/") {
        let (key, sid) = rest.rsplit_once('/').ok_or("bad loc")?;
        page_text(one("SELECT text FROM ctx_temp_summaries WHERE session_key = ?1 AND id = ?2", &[&key, &sid])?)
    } else if let Some(hash) = loc.strip_prefix("db:ctx_mem_file_store/") {
        page_text(one("SELECT content FROM ctx_mem_file_store WHERE hash = ?1 AND content IS NOT NULL LIMIT 1", &[&hash])?)
    } else if let Some(mid) = loc.strip_prefix("db:hub_messages/") {
        page_text(one("SELECT text FROM hub_messages WHERE id = ?1", &[&mid])?)
    } else if let Some(pid) = loc.strip_prefix("db:hub_posts/") {
        page_text(one("SELECT body FROM hub_posts WHERE id = ?1", &[&pid])?)
    } else if let Some(mid) = loc.strip_prefix("db:ws_messages/") {
        page_text(one("SELECT text FROM ws_messages WHERE id = ?1", &[&mid])?)
    } else if let Some(rest) = loc.strip_prefix("fs:subagents/") {
        let dir = src.state_dir.ok_or("The sub-agent store is not available.")?;
        match rest.split_once("/memory.json#") {
            Some((aid, key)) => {
                let p = dir.join("memory").join(format!("{}.json", sanitize(aid)));
                let entries: Vec<Value> = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
                let e = entries.into_iter().find(|e| memory_entry_is(e, key)).ok_or_else(|| format!("The source of {id} is gone ({loc})."))?;
                json!({ "key": key, "text": e["text"], "metadata": e["metadata"] })
            }
            None => {
                let rec = read_registry(dir).into_iter().find(|r| r["id"] == rest).ok_or_else(|| format!("The source of {id} is gone ({loc})."))?;
                json!({ "subagent": rec })
            }
        }
    } else if let Some(rel) = loc.strip_prefix("fs:workspace/") {
        let root = src.workspace_dir.ok_or("The workspace is not available.")?;
        let p = safe_join(root, rel).ok_or("That path is outside the workspace.")?;
        let bytes = std::fs::read(&p).map_err(|_| format!("The source of {id} is gone ({loc})."))?;
        match String::from_utf8(bytes) {
            Ok(t) => page_text(t),
            Err(e) => json!({ "binary": true, "size": e.as_bytes().len() }),
        }
    } else if loc.starts_with("host:memory") {
        super::longterm::read(conn, &loc).ok_or_else(|| format!("The source of {id} is gone ({loc})."))?
    } else if loc.starts_with("idb:") {
        json!({ "clientOnly": true })
    } else {
        return Err(format!("Unknown location {loc}."));
    };
    Ok(json!({ "item": item, "content": body }))
}

/// `root/rel`, refusing anything that climbs out of `root`.
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim_start_matches('/');
    if rel.split('/').any(|c| c == "..") {
        return None;
    }
    Some(root.join(rel))
}

/// A file only the WebView holds (IndexedDB library, inline attachments).
pub fn register_client(conn: &Connection, req: &Value) -> Result<Value, String> {
    let loc = req["loc"].as_str().unwrap_or("").trim();
    if !loc.starts_with("idb:") {
        return Err("A client item's loc must start with idb:.".into());
    }
    let kind = req["kind"].as_str().unwrap_or("file");
    if !matches!(kind, "file" | "note") {
        return Err(format!("A client item cannot be a {kind}."));
    }
    let mut e = Entry::new(kind, loc.to_string(), req["owner"].as_str().unwrap_or("user").to_string(), req["title"].as_str().unwrap_or(loc));
    e.size = req["size"].as_i64().unwrap_or(0);
    e.scope = Some("attachments".into());
    e.meta = json!({ "clientOnly": true, "sessionKey": req["sessionKey"] });
    let id = touch(conn, &e).map_err(|err| err.to_string())?;
    Ok(json!({ "id": id }))
}

/// Counts per source versus per registry (drift check).
pub fn fsck(conn: &Connection, src: &Sources) -> Result<Value, String> {
    let entries = collect(conn, src).map_err(|e| e.to_string())?;
    let mut per: std::collections::BTreeMap<String, (i64, i64)> = Default::default();
    for e in &entries {
        per.entry(e.kind.clone()).or_default().0 += 1;
    }
    let mut st = conn.prepare("SELECT kind, COUNT(*) FROM ws_items WHERE state = 'live' AND loc NOT LIKE 'idb:%' GROUP BY kind").map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    for (k, n) in rows {
        per.entry(k).or_default().1 += n;
    }
    let kinds: Vec<Value> = per.iter().map(|(k, (s, r))| json!({ "kind": k, "source": s, "registry": r, "ok": s == r })).collect();
    let ok = per.values().all(|(s, r)| s == r);
    Ok(json!({ "ok": ok, "kinds": kinds }))
}
