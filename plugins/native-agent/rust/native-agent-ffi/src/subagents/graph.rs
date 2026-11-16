//! The delegation graph of one chat, rebuilt from what the engine keeps on
//! disk (registry.json and each sub-agent's log), so the app can draw it
//! after a reload or after the agents have finished.

use super::*;

/// Events returned per graph, newest kept.
const GRAPH_EVENTS_CAP: usize = 400;

impl SubagentManager {
    /// Nodes, parent edges and a time-ordered event list for the sub-agents
    /// started from chat `session_key` (all chats when `None`).
    ///
    /// Every node names its real parent (`parentId`, `None` = the chat's
    /// main agent), so nested agents hang under the agent that spawned them.
    pub fn graph(&self, session_key: Option<&str>, max_events: usize) -> Value {
        let max_events = if max_events == 0 { GRAPH_EVENTS_CAP } else { max_events.min(GRAPH_EVENTS_CAP * 4) };
        let mut recs: Vec<SubagentRecord> = self
            .list()
            .into_iter()
            .filter(|r| match session_key {
                Some(k) => r.root_session_key == k || r.parent_session_key == k,
                None => true,
            })
            .collect();
        recs.sort_by_key(|r| r.created_at);
        let ids: HashSet<String> = recs.iter().map(|r| r.id.clone()).collect();
        let nodes: Vec<Value> = recs
            .iter()
            .map(|r| {
                // A parent that was deleted: draw it under the main agent and say so.
                let parent = r.parent_id.clone().filter(|p| ids.contains(p));
                json!({
                    "id": r.id,
                    "name": r.name,
                    "title": r.title,
                    "description": r.description,
                    "task": truncate_chars(&r.task, 240),
                    "status": r.status,
                    "depth": r.depth,
                    "parentId": parent,
                    "parentMissing": r.parent_id.is_some() && parent.is_none(),
                    "parentSessionKey": r.parent_session_key,
                    "rootSessionKey": r.root_session_key,
                    "sessionKey": r.session_key,
                    "spawnToolCallId": r.spawn_tool_call_id,
                    "createdAt": r.created_at,
                    "finishedAt": r.finished_at,
                    "steps": r.steps,
                    "tokens": r.total_tokens(),
                    "hidden": r.hidden,
                })
            })
            .collect();
        let edges: Vec<Value> = recs
            .iter()
            .map(|r| json!({ "from": r.parent_id.clone().filter(|p| ids.contains(p)), "to": r.id }))
            .collect();
        let mut events: Vec<Value> = Vec::new();
        for r in &recs {
            let parent = r.parent_id.clone().filter(|p| ids.contains(p));
            let mut saw_start = false;
            for mut e in self.read_log(&r.id, GRAPH_EVENTS_CAP) {
                let ev = e.get("event").and_then(Value::as_str).unwrap_or("").to_string();
                // Tool calls and step ticks are too fine for the diagram.
                if matches!(ev.as_str(), "subagent.tool_use" | "subagent.tool_call" | "subagent.tool_result" | "subagent.step" | "subagent.progress") {
                    continue;
                }
                if ev == "subagent.started" || ev == "subagent.queued" {
                    saw_start = true;
                }
                e["id"] = json!(r.id);
                e["parentId"] = json!(parent);
                events.push(e);
            }
            // The log keeps its newer half when it grows; the record still
            // knows when the agent was started.
            if !saw_start {
                events.push(json!({ "at": r.created_at, "event": "subagent.started", "id": r.id, "parentId": parent, "status": r.status, "synthetic": true }));
            }
        }
        events.sort_by_key(|e| e.get("at").and_then(Value::as_u64).unwrap_or(0));
        if events.len() > max_events {
            let drop = events.len() - max_events;
            events.drain(..drop);
        }
        json!({ "sessionKey": session_key, "nodes": nodes, "edges": edges, "events": events })
    }
}
