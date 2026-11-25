//! The main agent in groups (unified plan, Phase 4).
//!
//! The main agent of a chat (depth 0) gets its own group tools:
//! `group_create` (home = its own chat), `group_post`, `group_read`,
//! `list_groups` and `group_members`. It sits in its chat's groups as
//! `host`: not counted in `MIN_AGENTS`, never woken by `decide()`. What
//! happens in a group reaches it as a short digest in its own chat
//! (`ws::digest`), behind the `mainDigest` setting.

use super::{ParentEnv, SubagentManager};
use crate::types::ToolDefinition;
use crate::ws::envelope::Party;
use crate::ws::{digest, groups};
use serde_json::{json, Value};
use std::sync::Arc;

pub const TOOL_MAIN_GROUP_CREATE: &str = "group_create";
pub const TOOL_MAIN_GROUP_POST: &str = "group_post";
pub const TOOL_MAIN_GROUP_READ: &str = "group_read";
pub const TOOL_MAIN_LIST_GROUPS: &str = "list_groups";
pub const TOOL_MAIN_GROUP_MEMBERS: &str = "group_members";
pub const TOOL_MAIN_GROUP_PLAYBOOK: &str = super::playbooks_bridge::TOOL_GROUP_PLAYBOOK;
pub const MAIN_GROUP_TOOL_NAMES: &[&str] = &[TOOL_MAIN_GROUP_CREATE, TOOL_MAIN_GROUP_POST, TOOL_MAIN_GROUP_READ, TOOL_MAIN_LIST_GROUPS, TOOL_MAIN_GROUP_MEMBERS, TOOL_MAIN_GROUP_PLAYBOOK];

pub fn is_main_group_tool(name: &str) -> bool {
    MAIN_GROUP_TOOL_NAMES.contains(&name)
}

impl SubagentManager {
    pub fn main_group_tool_definitions() -> Vec<ToolDefinition> {
        // group_create asks the user every time (it can raise costs); the
        // others answer from or into the user's own groups.
        let def = |name: &str, description: &str, schema: Value, policy: Option<&str>| ToolDefinition {
            name: name.into(),
            description: description.into(),
            input_schema: schema,
            webview_only: false,
            approval_policy: policy.map(str::to_string),
        };
        vec![
            def(
                TOOL_MAIN_GROUP_CREATE,
                &format!(
                    "Create a group: a lasting room of this chat where at least {} agents (sub-agents of this chat, or shareable agents of other chats) talk with the user under rules. Only when the user asks for a group. You join as host. The user approves it.",
                    groups::MIN_AGENTS
                ),
                json!({"type": "object", "properties": {
                    "name": {"type": "string"},
                    "purpose": {"type": "string"},
                    "members": {"type": "array", "items": {"type": "string"}, "description": "Agent names or ids"},
                    "preset": {"type": "string", "enum": ["social", "everyone", "round_table", "wait_turn", "moderated"]}
                }, "required": ["name", "members"]}),
                Some("always_ask"),
            ),
            def(
                TOOL_MAIN_GROUP_POST,
                "Post a message in one of this chat's groups, as its host. Mention members with @name to wake them.",
                json!({"type": "object", "properties": {"group": {"type": "string", "description": "Group id or #name"}, "text": {"type": "string"}, "replyTo": {"type": "string"}}, "required": ["group", "text"]}),
                None,
            ),
            def(
                TOOL_MAIN_GROUP_READ,
                "Read one of this chat's groups, oldest first (the whole thread behind a digest).",
                json!({"type": "object", "properties": {"group": {"type": "string"}, "before": {"type": "string"}, "thread": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["group"]}),
                None,
            ),
            def(TOOL_MAIN_LIST_GROUPS, "List this chat's groups with their members and rules.", json!({"type": "object", "properties": {}}), None),
            def(
                TOOL_MAIN_GROUP_MEMBERS,
                "Add an agent to, or remove one from, one of this chat's groups.",
                json!({"type": "object", "properties": {"group": {"type": "string"}, "add": {"type": "string", "description": "Agent name or id to add"}, "remove": {"type": "string", "description": "Agent name or id to remove"}}, "required": ["group"]}),
                None,
            ),
            super::playbooks_bridge::playbook_tool_definition(),
        ]
    }

    /// The main agent's prompt paragraph for chat `session_key`: its groups,
    /// then the digests it has not seen. Empty without a message store.
    pub fn main_group_prompt(&self, session_key: &str) -> String {
        let Some(conn) = self.ws_conn() else { return String::new() };
        let root = self.root_of(session_key);
        let mut out = groups::for_main(&conn, &root, &self.group_agents());
        if self.settings().main_digest {
            let seen = digest::take_unseen(&conn, &root, session_key, true).unwrap_or_default();
            if !seen.is_empty() {
                out.push_str("\nSince your last turn in your groups:\n");
                out.push_str(&seen.iter().map(|d| format!("- {d}")).collect::<Vec<_>>().join("\n"));
            }
        }
        out
    }

    /// After a post in a group: write the home chat's digest when due.
    pub(crate) fn digest_tick(&self, gid: &str) {
        if !self.settings().main_digest {
            return;
        }
        if let Some(conn) = self.ws_conn() {
            let _ = digest::tick(&conn, gid, crate::ws::now_ms(), false);
        }
    }

    /// The agent a name or id means for the chat `root`: this chat's agents
    /// first, then shareable agents of other chats. An agent of another chat
    /// that is not shareable is refused by name.
    fn agent_pid(&self, root: &str, name: &str) -> Result<String, String> {
        let n = name.trim().trim_start_matches('@');
        if n.is_empty() {
            return Err("Name an agent.".into());
        }
        let n = n.strip_prefix("agent:").unwrap_or(n);
        let lower = n.to_lowercase();
        let all = self.group_agents();
        let is = |a: &groups::AgentInfo| a.pid == format!("agent:{n}") || a.name.to_lowercase() == lower || a.title.as_deref().is_some_and(|t| t.to_lowercase() == lower);
        let pick = |hits: Vec<&groups::AgentInfo>| -> Option<Result<String, String>> {
            match hits.len() {
                0 => None,
                1 => Some(Ok(hits[0].pid.clone())),
                _ => Some(Err(format!("Several agents are called {n}; use an id: {}.", hits.iter().map(|a| a.pid.clone()).collect::<Vec<_>>().join(", ")))),
            }
        };
        if let Some(r) = pick(all.iter().filter(|a| a.root == root && is(a)).collect()) {
            return r;
        }
        if let Some(r) = pick(all.iter().filter(|a| a.root != root && a.shareable && is(a)).collect()) {
            return r;
        }
        let id = self.resolve_id(n);
        if self.get(&id).is_some() || all.iter().any(|a| is(a)) {
            return Err(format!("{n} belongs to another chat and is not shareable; spawn one here or pick a shareable agent."));
        }
        Err(format!("No agent called {n}."))
    }

    /// "this chat has 2 (Writer, Critic)" for the group_create error.
    fn chat_agents_line(&self, root: &str) -> String {
        let mine: Vec<String> = self.group_agents().into_iter().filter(|a| a.root == root && a.status != "deleted").map(|a| a.name).collect();
        if mine.is_empty() {
            "this chat has none".into()
        } else {
            format!("this chat has {} ({})", mine.len(), mine.join(", "))
        }
    }

    /// Run a main-agent group tool for the chat of `env`.
    pub fn handle_main_group_tool(self: &Arc<Self>, tool: &str, input: &Value, env: &ParentEnv) -> (String, bool) {
        let Some(conn) = self.ws_conn() else { return ("The message store is not open.".into(), true) };
        let root = self.root_of(&env.session_key);
        let agents = self.group_agents();
        let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let my_gid = |r: &str| -> Result<String, String> {
            let gid = groups::resolve(&conn, r)?;
            let g = groups::get(&conn, &gid, &agents)?;
            if g["group"]["homeRoot"].as_str() == Some(root.as_str()) {
                Ok(gid)
            } else {
                Err("That group belongs to another chat.".into())
            }
        };
        let r: Result<String, String> = (|| match tool {
            TOOL_MAIN_GROUP_CREATE => {
                let names: Vec<String> = input.get("members").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let mut pids = Vec::new();
                for n in &names {
                    let p = self.agent_pid(&root, n)?;
                    if p != groups::HOST_PID && !pids.contains(&p) {
                        pids.push(p);
                    }
                }
                if pids.len() < groups::MIN_AGENTS {
                    return Err(format!(
                        "need {} agents besides you; you named {} and {} — spawn one or pick a shareable one.",
                        groups::MIN_AGENTS,
                        pids.len(),
                        self.chat_agents_line(&root)
                    ));
                }
                let mut req = json!({ "name": s("name"), "purpose": s("purpose"), "members": pids, "homeRoot": root, "host": true });
                if !s("preset").is_empty() {
                    req["preset"] = json!(s("preset"));
                }
                let g = groups::create(&conn, &req, &agents)?;
                let gid = g["group"]["id"].as_str().unwrap_or("").to_string();
                let name = g["group"]["name"].as_str().unwrap_or("").to_string();
                Ok(format!("Created #{name} (id {gid}) with {} agents; you are its host.", pids.len()))
            }
            TOOL_MAIN_LIST_GROUPS => {
                let ids = groups::of_home(&conn, &root)?;
                if ids.is_empty() {
                    return Ok("This chat has no groups.".into());
                }
                let mut lines = Vec::new();
                for gid in ids {
                    let d = groups::get(&conn, &gid, &agents)?;
                    let g = d["group"].clone();
                    let members: Vec<String> = d["members"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .filter(|m| m["membership"] != "left" && m["pid"] != "user")
                        .map(|m| format!("{} ({}, {})", m["name"].as_str().unwrap_or(""), m["pid"].as_str().unwrap_or(""), m["presence"].as_str().unwrap_or("")))
                        .collect();
                    lines.push(format!("- #{} (id {gid}, {}, rules: {}): {}", g["name"].as_str().unwrap_or(""), g["state"].as_str().unwrap_or(""), g["preset"].as_str().unwrap_or(""), members.join(", ")));
                }
                Ok(lines.join("\n"))
            }
            TOOL_MAIN_GROUP_READ => {
                let gid = my_gid(&s("group"))?;
                let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(30) as usize;
                let out = groups::read(&conn, &gid, input.get("before").and_then(Value::as_str), input.get("thread").and_then(Value::as_str), limit)?;
                let lines: Vec<String> = out["messages"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|m| format!("{} · {} ({}): {}", m["id"].as_str().unwrap_or(""), m["fromName"].as_str().unwrap_or(""), m["from"].as_str().unwrap_or(""), m["text"].as_str().unwrap_or("")))
                    .collect();
                if lines.is_empty() {
                    return Ok("No messages in that group yet.".into());
                }
                Ok(format!("#{}:\n{}", out["group"]["name"].as_str().unwrap_or(""), lines.join("\n")))
            }
            TOOL_MAIN_GROUP_POST => {
                let gid = my_gid(&s("group"))?;
                groups::ensure_host(&conn, &gid, &root)?;
                let out = self.group_post_as(&gid, Party::new(groups::HOST_PID, "Main agent"), &s("text"), input.get("replyTo").and_then(Value::as_str).map(str::to_string), vec![], vec![], env, false)?;
                let woken = out["dispatch"]["wake"].as_array().map(|a| a.len()).unwrap_or(0);
                Ok(format!("Posted as {} in group {gid}; {woken} member(s) woken.", out["message"].as_str().unwrap_or("")))
            }
            TOOL_MAIN_GROUP_PLAYBOOK => {
                let gid = my_gid(&s("group"))?;
                groups::ensure_host(&conn, &gid, &root)?;
                self.group_playbook_text(&gid, Party::new(groups::HOST_PID, "Main agent"), input, env)
            }
            TOOL_MAIN_GROUP_MEMBERS => {
                let gid = my_gid(&s("group"))?;
                let mut done = Vec::new();
                if !s("add").is_empty() {
                    let pid = self.agent_pid(&root, &s("add"))?;
                    groups::add_member(&conn, &gid, &pid, None, &agents)?;
                    done.push(format!("added {}", s("add")));
                }
                if !s("remove").is_empty() {
                    let pid = self.agent_pid(&root, &s("remove"))?;
                    groups::remove_member(&conn, &gid, &pid, &agents)?;
                    done.push(format!("removed {}", s("remove")));
                }
                if done.is_empty() {
                    return Err("Say whom to add or remove.".into());
                }
                Ok(format!("Group {gid}: {}.", done.join(", ")))
            }
            _ => Err(format!("Unknown group tool {tool}.")),
        })();
        match r {
            Ok(t) => (t, false),
            Err(e) => (e, true),
        }
    }
}
