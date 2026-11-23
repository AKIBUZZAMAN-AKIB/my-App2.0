//! `items.tree(viewer, holder)`: what a viewer may see of a holder. The panel
//! and (from Phase 5) the prompt assembler use the same projection, so the
//! two never disagree.

use rusqlite::Connection;
use serde_json::{json, Value};

use super::registry;

const DEFAULT_LIMIT: usize = 200;

fn page(items: Vec<Value>, limit: usize) -> Value {
    let total = items.len();
    let shown: Vec<Value> = items.into_iter().take(limit).collect();
    json!({ "items": shown, "total": total, "more": total > limit })
}

fn q(conn: &Connection, w: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>, String> {
    registry::query(conn, w, args).map_err(|e| e.to_string())
}

/// The whole tree for one holder, or the "All" view when `holder` is None.
pub fn tree(conn: &Connection, holder: Option<&str>, viewer: &str, limit: Option<usize>) -> Result<Value, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).max(1);
    let visible = |items: Vec<Value>| -> Vec<Value> { items.into_iter().filter(|i| super::can_see(conn, viewer, i)).collect() };
    let Some(holder) = holder.filter(|h| !h.is_empty()) else {
        let chats = q(conn, "kind = 'chat' AND owner LIKE 'session:%' AND state NOT IN ('purged', 'trashed') ORDER BY updated_at DESC", &[])?;
        let agents = q(conn, "kind = 'subagent' AND state NOT IN ('purged', 'trashed') ORDER BY created_at DESC", &[])?;
        let files = q(conn, "kind = 'file' AND state NOT IN ('purged', 'trashed') ORDER BY title", &[])?;
        let memory = q(conn, "kind IN ('memory_longterm', 'agent_memory') AND state NOT IN ('purged', 'trashed') ORDER BY kind, title", &[])?;
        let notes = q(conn, "kind IN ('note', 'summary') AND state NOT IN ('purged', 'trashed') ORDER BY updated_at DESC", &[])?;
        let messages = q(conn, "kind IN ('message', 'group_message') AND state NOT IN ('purged', 'trashed') ORDER BY created_at DESC", &[])?;
        let missing = q(conn, "state = 'missing' ORDER BY updated_at DESC", &[])?;
        let groups = q(conn, "kind = 'group' AND state NOT IN ('purged', 'trashed') ORDER BY title", &[])?;
        return Ok(json!({
            "holder": null,
            "viewer": viewer,
            "sections": {
                "chats": page(visible(chats), limit),
                "subagents": page(visible(agents), limit),
                "files": page(visible(files), limit),
                "memory": page(visible(memory), limit),
                "notes": page(visible(notes), limit),
                "messages": page(visible(messages), limit),
                "groups": page(visible(groups), limit),
                "missing": page(visible(missing), limit),
            }
        }));
    };

    let session_key = holder.strip_prefix("session:").map(str::to_string).or_else(|| holder.strip_prefix("agent:").map(|id| format!("subagent:{id}")));
    let chat = match &session_key {
        Some(k) => registry::get_by_loc(conn, &format!("db:sessions/{k}")).map_err(|e| e.to_string())?,
        None => None,
    };
    let mut chat_parts = Vec::new();
    if let Some(c) = &chat {
        let cid = c["id"].as_str().unwrap_or("").to_string();
        chat_parts = q(conn, "parent_id = ?1 AND state NOT IN ('purged', 'trashed') ORDER BY kind, created_at", &[&cid])?;
    }
    let agents = agent_tree(conn, holder, 0)?;
    let mut agent_ids: Vec<String> = Vec::new();
    collect_agent_ids(&agents, &mut agent_ids);

    let read_files: Vec<Value> = match &session_key {
        Some(k) => q(conn, "kind = 'file' AND loc LIKE 'db:ctx_mem_file_store/%' AND state NOT IN ('purged', 'trashed') ORDER BY title", &[])?
            .into_iter()
            .filter(|f| f["meta"]["sessions"].as_array().is_some_and(|s| s.iter().any(|x| x == k.as_str())))
            .collect(),
        None => Vec::new(),
    };
    let workspace = q(conn, "kind = 'file' AND loc LIKE 'fs:workspace/%' AND owner = 'user' AND state NOT IN ('purged', 'trashed') ORDER BY title", &[])?;
    let attachments = q(conn, "loc LIKE 'idb:%' AND state NOT IN ('purged', 'trashed') ORDER BY created_at DESC", &[])?
        .into_iter()
        .filter(|a| a["meta"]["sessionKey"].is_null() || a["meta"]["sessionKey"].as_str() == session_key.as_deref())
        .collect::<Vec<_>>();
    let mut agent_files = Vec::new();
    for id in &agent_ids {
        agent_files.extend(q(conn, "kind = 'file' AND owner = ?1 AND state NOT IN ('purged', 'trashed') ORDER BY title", &[&format!("agent:{id}")])?);
    }
    let own_memory = q(conn, "kind = 'agent_memory' AND owner = ?1 AND state NOT IN ('purged', 'trashed') ORDER BY title", &[&holder])?;
    let main_memory = q(conn, "kind = 'memory_longterm' AND state NOT IN ('purged', 'trashed') ORDER BY title", &[])?;
    let shared = super::shared_with(conn, holder)?;
    let groups = super::groups_of(conn, holder)?;
    Ok(json!({
        "holder": holder,
        "viewer": viewer,
        "chat": chat,
        "sections": {
            "chat": page(visible(chat_parts), limit),
            "files": {
                "read": page(visible(read_files), limit),
                "workspace": page(visible(workspace), limit),
                "attachments": page(visible(attachments), limit),
                "subagentFiles": page(visible(agent_files), limit),
            },
            "subagents": agents,
            "memory": {
                "own": page(visible(own_memory), limit),
                "main": page(visible(main_memory), limit),
            },
            "groups": page(groups, limit),
            "sharedWithMe": page(shared, limit),
        }
    }))
}

/// The sub-agents owned by `holder`, each with its chat, memory, files and
/// its own sub-agents.
fn agent_tree(conn: &Connection, holder: &str, depth: usize) -> Result<Vec<Value>, String> {
    if depth > 8 {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for a in q(conn, "kind = 'subagent' AND owner = ?1 AND state NOT IN ('purged', 'trashed') ORDER BY created_at", &[&holder])? {
        let aid = a["meta"]["agentId"].as_str().unwrap_or("").to_string();
        let pid = format!("agent:{aid}");
        let chat = registry::get_by_loc(conn, &format!("db:sessions/subagent:{aid}")).map_err(|e| e.to_string())?;
        let memory = q(conn, "kind = 'agent_memory' AND owner = ?1 AND state NOT IN ('purged', 'trashed') ORDER BY title", &[&pid])?;
        let files = q(conn, "kind = 'file' AND owner = ?1 AND state NOT IN ('purged', 'trashed') ORDER BY title", &[&pid])?;
        let children = agent_tree(conn, &pid, depth + 1)?;
        out.push(json!({ "item": a, "chat": chat, "memory": memory, "files": files, "subagents": children }));
    }
    Ok(out)
}

fn collect_agent_ids(nodes: &[Value], out: &mut Vec<String>) {
    for n in nodes {
        if let Some(id) = n["item"]["meta"]["agentId"].as_str() {
            out.push(id.to_string());
        }
        if let Some(kids) = n["subagents"].as_array() {
            collect_agent_ids(kids, out);
        }
    }
}
