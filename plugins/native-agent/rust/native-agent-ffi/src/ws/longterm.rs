//! Main memory by fixed id.
//!
//! The main memory lives in the host app behind `MemoryProvider`. Each entry
//! gets a deterministic id, `mem_` + base32(SHA-256(key + "\0" + createdAt))
//! cut to 26 characters, added in place by the host provider (no copy).
//!
//! Read side (Phase 1): every entry the engine knows becomes a
//! `memory_longterm` item owned by `agent:main`:
//! - with an id (the host returned one): `loc host:memory#<id>`, editable
//!   from Phase 4 on;
//! - without (older host build): `loc host:memory@key:<key>`, read-only.
//!
//! The engine's mirror, `ctx_mem_longterm`, gets an `entry_id` column; the
//! `memory_store` mirror writes the id the host returned.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::registry::Entry;

/// The deterministic id of one provider record.
pub fn entry_id(key: &str, created_at: i64) -> String {
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    h.update([0u8]);
    h.update(created_at.to_string().as_bytes());
    let b32 = super::ids::base32(&h.finalize());
    format!("mem_{}", &b32[..26])
}

pub fn ensure_columns(conn: &Connection) -> rusqlite::Result<()> {
    crate::context_tree::memory_checklist::ensure_tables(conn)?;
    if conn.prepare("SELECT entry_id FROM ctx_mem_longterm LIMIT 0").is_err() {
        conn.execute("ALTER TABLE ctx_mem_longterm ADD COLUMN entry_id TEXT", [])?;
    }
    Ok(())
}

/// Record the host's id for a key (from a `store` result).
pub fn set_entry_id(conn: &Connection, key: &str, id: &str) -> rusqlite::Result<()> {
    ensure_columns(conn)?;
    conn.execute("UPDATE ctx_mem_longterm SET entry_id = ?2 WHERE key = ?1", params![key.trim(), id])?;
    Ok(())
}

/// The id of a `store` / `search` result, when the host sent one.
pub fn id_of_result(result: &Value) -> Option<String> {
    result.get("id").and_then(Value::as_str).filter(|s| s.starts_with("mem_")).map(str::to_string)
}

/// One item per main-memory entry: every entry in the mirror, plus every key
/// the host listed (beyond the mirror's cap of 200).
pub fn entries(conn: &Connection, host_keys: Option<&[String]>) -> rusqlite::Result<Vec<Entry>> {
    ensure_columns(conn)?;
    let mut st = conn.prepare("SELECT key, text, updated_at, entry_id FROM ctx_mem_longterm WHERE removed = 0 ORDER BY key")?;
    let rows: Vec<(String, String, i64, Option<String>)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (key, text, at, id) in rows {
        seen.insert(key.clone());
        out.push(entry_for(&key, id.as_deref(), text.len() as i64, at));
    }
    for key in host_keys.unwrap_or(&[]) {
        if seen.insert(key.clone()) {
            out.push(entry_for(key, None, 0, 0));
        }
    }
    Ok(out)
}

fn entry_for(key: &str, id: Option<&str>, size: i64, at: i64) -> Entry {
    let (loc, read_only) = match id {
        Some(id) => (format!("host:memory#{id}"), false),
        None => (format!("host:memory@key:{key}"), true),
    };
    let mut e = Entry::new("memory_longterm", loc, "agent:main".into(), key);
    e.size = size;
    e.created_at = at;
    e.scope = Some("main".into());
    e.meta = json!({ "key": key, "entryId": id, "readOnly": read_only });
    e
}

/// An entry indexed by key before the host gave it an id keeps its item:
/// its `loc` moves from `host:memory@key:<key>` to `host:memory#<id>`.
pub fn relocate_keyed(conn: &Connection) -> rusqlite::Result<usize> {
    ensure_columns(conn)?;
    super::registry::ensure_tables(conn)?;
    let mut st = conn.prepare("SELECT key, entry_id FROM ctx_mem_longterm WHERE entry_id IS NOT NULL AND removed = 0")?;
    let rows: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let mut n = 0;
    for (key, id) in rows {
        n += conn.execute(
            "UPDATE ws_items SET loc = ?2, meta_json = json_set(meta_json, '$.entryId', ?3, '$.readOnly', json('false'))
             WHERE loc = ?1 AND NOT EXISTS (SELECT 1 FROM ws_items WHERE loc = ?2)",
            params![format!("host:memory@key:{key}"), format!("host:memory#{id}"), id],
        )?;
    }
    Ok(n)
}

/// Read one entry from the mirror by id or key.
pub fn read(conn: &Connection, loc: &str) -> Option<Value> {
    ensure_columns(conn).ok()?;
    let row = if let Some(id) = loc.strip_prefix("host:memory#") {
        conn.query_row("SELECT key, text, entry_id FROM ctx_mem_longterm WHERE entry_id = ?1 AND removed = 0", params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .optional()
        .ok()
        .flatten()
    } else if let Some(key) = loc.strip_prefix("host:memory@key:") {
        conn.query_row("SELECT key, text, entry_id FROM ctx_mem_longterm WHERE key = ?1 AND removed = 0", params![key], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .optional()
        .ok()
        .flatten()
        .or_else(|| Some((key.to_string(), String::new(), None)))
    } else {
        None
    }?;
    Some(json!({ "key": row.0, "text": row.1, "entryId": row.2, "readOnly": row.2.is_none() }))
}

/// The main agent's `memory_forget` on an indexed entry (plan.md, Phase 4
/// item 7). Shared with a sub-agent: the entry is detached from main memory
/// (hidden from the main agent, kept with its pins for the holders). Not
/// shared: it goes by the delete policy (Trash or purge). None when the
/// entry is not indexed, so the caller forgets it the old way.
pub fn model_forget(conn: &Connection, provider: &std::sync::Arc<dyn crate::MemoryProvider>, key: &str) -> Option<serde_json::Value> {
    use super::{refs, registry, trash};
    let host: std::rc::Rc<dyn super::host::HostMemory> = std::rc::Rc::new(crate::HostMemoryAdapter(provider.clone()));
    super::host::with_host(Some(host), || {
        trash::ensure_tables(conn).ok()?;
        let it = registry::query(conn, "kind = 'memory_longterm' AND state = 'live' AND json_extract(meta_json, '$.key') = ?1", &[&key]).ok()?.into_iter().next()?;
        let id = it["id"].as_str()?.to_string();
        let others: Vec<String> = refs::live_shares(conn, &id).ok()?.iter().filter(|r| r["holder"] != "agent:main").filter_map(|r| r["holderName"].as_str().map(str::to_string)).collect();
        if !others.is_empty() {
            trash::reown(conn, &id, "detached").ok()?;
            let _ = conn.execute(
                "UPDATE ws_items SET meta_json = json_set(meta_json, '$.mainHidden', json('true'), '$.origin', 'agent:main', '$.fromDeleted', 'Main memory') WHERE id = ?1",
                rusqlite::params![id],
            );
            let it = registry::get(conn, &id).ok()??;
            trash::host_flag(conn, &it, serde_json::json!({ "main_hidden": true }));
            refs::audit(conn, "agent:main", "forget_shared", Some(&id), None, serde_json::json!({ "keptFor": others }));
            return Some(serde_json::json!({
                "success": true,
                "action": "detached",
                "message": format!("Removed {key} from your memory. It is shared with {}, so it stays for them.", others.join(", ")),
            }));
        }
        match trash::trash(conn, &super::registry::Sources::default(), "agent:main", &id) {
            Ok(v) if v["purged"] == true => Some(serde_json::json!({ "success": true, "action": "purged", "message": format!("Forgot {key}.") })),
            Ok(_) => Some(serde_json::json!({ "success": true, "action": "trashed", "message": format!("Forgot {key}. The user can restore it from Trash.") })),
            Err(e) => Some(serde_json::json!({ "success": false, "message": format!("Could not forget {key}: {e}") })),
        }
    })
}
