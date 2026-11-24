//! Groups bridge (plan.md, Phase 3): the sub-agent side of `ws::groups`.
//!
//! - The app's group actions (`groups.*` through the subagents request).
//! - The members' tools: `group_post`, `group_read`, `group_pass`, `group_list`, `group_pin`,
//!   and `group_context` (Phase 5: toggle a shared item in or out of the group's AI context
//!   when the group lets the model decide).
//! - Acting on a post's dispatch: waking members (one run per member, a
//!   second trigger coalesces into the run already going), steering the note
//!   into a running engaged member, and counting a group run's tokens
//!   against the group's daily budget when it finishes.
//! - Re-checking memberships when an agent's sharing, visibility or
//!   existence changes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::*;
use crate::ws::envelope::Party;
use crate::ws::groups::{self, AgentInfo, PostReq};

pub const TOOL_GROUP_POST: &str = "group_post";
pub const TOOL_GROUP_READ: &str = "group_read";
pub const TOOL_GROUP_PASS: &str = "group_pass";
pub const TOOL_GROUP_LIST: &str = "group_list";
pub const TOOL_GROUP_PIN: &str = "group_pin";
pub const TOOL_GROUP_CONTEXT: &str = "group_context";
pub const GROUP_TOOL_NAMES: [&str; 6] = [TOOL_GROUP_POST, TOOL_GROUP_READ, TOOL_GROUP_PASS, TOOL_GROUP_LIST, TOOL_GROUP_PIN, TOOL_GROUP_CONTEXT];

/// A run a group started (plan.md 3.4, 3.6): its tokens count against the
/// group's day, memory it stores gets the group category, and a plain-text
/// final answer is posted back to the group as a reply to the trigger.
#[derive(Clone)]
pub(super) struct GroupRun {
    pub(super) gid: String,
    pub(super) before: u64,
    /// The message that woke the agent.
    pub(super) trigger: String,
    pub(super) started: i64,
    pub(super) env: ParentEnv,
}

/// Runs started by a group: agent id -> the run.
pub(super) fn group_runs() -> &'static Mutex<HashMap<String, GroupRun>> {
    static RUNS: OnceLock<Mutex<HashMap<String, GroupRun>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl SubagentManager {
    /// What the group code needs about every sub-agent.
    pub(crate) fn group_agents(&self) -> Vec<AgentInfo> {
        self.list()
            .iter()
            .map(|r| {
                let root = if r.root_session_key.is_empty() { self.root_of(&r.session_key) } else { r.root_session_key.clone() };
                let runs = r.runs.max(1) as i64;
                let tokens = r.total_tokens() as i64;
                AgentInfo {
                    pid: format!("agent:{}", r.id),
                    name: r.title.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or(&r.name).to_string(),
                    title: r.title.clone(),
                    status: r.status.clone(),
                    paused: r.paused,
                    shareable: r.shareable,
                    hidden: r.hidden,
                    hidden_from: r.hidden_from.clone(),
                    root,
                    avg_tokens: if tokens > 0 && r.runs > 0 { tokens / runs } else { 0 },
                }
            })
            .collect()
    }

    /// Members with a group run going (running or queued) for `gid`.
    fn pending_for(&self, gid: &str) -> Vec<String> {
        let runs = group_runs().lock().unwrap();
        runs.iter()
            .filter(|(id, run)| run.gid == gid && self.get(id).is_some_and(|r| r.is_active()))
            .map(|(id, _)| format!("agent:{id}"))
            .collect()
    }

    /// Whether `rec` is a joined member of any group (gets the group tools).
    pub(super) fn in_any_group(&self, rec: &SubagentRecord) -> bool {
        let Some(conn) = self.ws_conn() else { return false };
        groups::groups_of(&conn, &format!("agent:{}", rec.id)).is_ok_and(|g| !g.is_empty())
    }

    pub(super) fn group_prompt(&self, rec: &SubagentRecord) -> String {
        let Some(conn) = self.ws_conn() else { return String::new() };
        groups::for_agent(&conn, &format!("agent:{}", rec.id), &self.group_agents())
    }

    /// The items shared with this agent that it uses now (plan.md 4.5, 5.2).
    pub(super) fn shared_context_prompt(&self, rec: &SubagentRecord) -> String {
        let Some(conn) = self.ws_conn() else { return String::new() };
        crate::ws::context_use::agent_block(&conn, &format!("agent:{}", rec.id), 8_000)
    }

    /// After an agent's record changed or it was deleted: suspend or restore
    /// it in its groups.
    pub(crate) fn group_recheck(&self, id: &str) {
        if let Some(conn) = self.ws_conn() {
            let _ = groups::recheck_member(&conn, &format!("agent:{id}"), &self.group_agents());
        }
    }

    /// The group category of memory `id` stores right now: `(group:<id>,
    /// group name)` while a group run of that agent is going (plan.md 3.6).
    pub(crate) fn group_memory_category(&self, id: &str) -> Option<(String, String)> {
        let gid = group_runs().lock().unwrap().get(id).map(|r| r.gid.clone())?;
        let name = self
            .ws_conn()
            .and_then(|c| c.query_row("SELECT name FROM ws_groups WHERE id = ?1", rusqlite::params![gid], |r| r.get::<_, String>(0)).ok())
            .unwrap_or_default();
        Some((format!("group:{gid}"), name))
    }

    /// A group run finished: add its tokens to the group's day and, when the
    /// agent answered in plain text without group_post or group_pass, post
    /// that answer to the group as a reply to the message that woke it
    /// (plan.md 3.4: a woken agent's answer is never lost).
    pub(super) fn group_run_finished(self: &Arc<Self>, id: &str, status: &str, result: &str) {
        let Some(run) = group_runs().lock().unwrap().remove(id) else { return };
        let Some(rec) = self.get(id) else { return };
        let used = rec.total_tokens().saturating_sub(run.before) as i64;
        let Some(conn) = self.ws_conn() else { return };
        let _ = groups::add_tokens(&conn, &run.gid, used);
        let text = result.trim();
        if !matches!(status, "finished" | "completed" | "done") || text.is_empty() {
            return;
        }
        let pid = format!("agent:{id}");
        let spoke: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ws_messages WHERE conversation = ?1 AND from_pid = ?2 AND created_at >= ?3)",
                rusqlite::params![format!("group:{}", run.gid), pid, run.started],
                |r| r.get(0),
            )
            .unwrap_or(true);
        let passed: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ws_group_dispatch WHERE pid = ?1 AND decision = 'pass' AND at >= ?2)",
                rusqlite::params![pid, run.started],
                |r| r.get(0),
            )
            .unwrap_or(true);
        drop(conn);
        if spoke || passed {
            return;
        }
        let _ = self.group_post(&run.gid, Self::party_of(&rec), text, Some(run.trigger.clone()), Vec::new(), Vec::new(), &run.env);
    }

    /// Post to a group and act on the dispatch. Returns the post and what
    /// happened to each member.
    #[allow(clippy::too_many_arguments)] // the post fields mirror the group.post request one to one
    pub(crate) fn group_post(self: &Arc<Self>, gid: &str, from: Party, text: &str, reply_to: Option<String>, to: Vec<String>, attachments: Vec<Value>, env: &ParentEnv) -> Result<Value, String> {
        let conn = self.ws_conn().ok_or("The message store is not open.")?;
        let gid = groups::resolve(&conn, gid)?;
        let agents = self.group_agents();
        let comms_paused = match from.pid.strip_prefix("agent:").and_then(|id| self.get(id)) {
            Some(r) => self.effective_comms(&self.root_of(&r.session_key)).paused,
            None => false,
        };
        let req = PostReq { from, text, reply_to, to, attachments, comms_paused, pending: self.pending_for(&gid) };
        let out = groups::post(&conn, &gid, &req, &agents)?;
        let mut results = Vec::new();
        let wenv = ParentEnv { abort: None, tool_names: Vec::new(), ..env.clone() };
        let act = |pid: &str, wake: bool, coalesce: bool| -> Option<&'static str> {
            let id = pid.strip_prefix("agent:")?;
            let rec = self.get(id)?;
            let note = groups::member_note(&conn, &gid, pid, &out.posted, &out.group_name).ok()?;
            if wake && !rec.is_active() && !rec.paused {
                let before = rec.total_tokens();
                match self.rerun_existing(id, note.clone(), PendingPrior::Resume, &wenv, false) {
                    Ok(_) => {
                        group_runs().lock().unwrap().insert(
                            id.to_string(),
                            GroupRun { gid: gid.clone(), before, trigger: out.posted.id.clone(), started: crate::ws::now_ms(), env: wenv.clone() },
                        );
                        Some("started")
                    }
                    Err(_) => Some(self.deliver(&rec, note)),
                }
            } else if wake || coalesce || rec.is_running() {
                Some(self.deliver(&rec, note))
            } else {
                None
            }
        };
        for p in &out.dispatch.wake {
            if let Some(how) = act(&p.pid, true, false) {
                results.push(json!({ "pid": p.pid, "how": how }));
            }
        }
        for (pid, _) in &out.dispatch.coalesce {
            if let Some(how) = act(pid, false, true) {
                results.push(json!({ "pid": pid, "how": how }));
            }
        }
        // Engaged members that are running see the message live.
        for (pid, reason) in &out.dispatch.deliver {
            if reason == "engaged" {
                if let Some(how) = act(pid, false, false) {
                    results.push(json!({ "pid": pid, "how": how }));
                }
            }
        }
        let mut d = out.dispatch.to_json();
        d["acted"] = json!(results);
        Ok(json!({ "message": out.posted.id, "conversation": format!("group:{gid}"), "dispatch": d }))
    }

    /// `groups.*` actions of the subagents request.
    pub(super) fn groups_app_request(self: &Arc<Self>, action: &str, req: &Value, env: &ParentEnv) -> Option<Result<Value, String>> {
        let op = action.strip_prefix("groups.")?;
        let Some(conn) = self.ws_conn() else { return Some(Err("The message store is not open.".into())) };
        let agents = self.group_agents();
        let s = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let gid = || groups::resolve(&conn, &s("group"));
        let strs = |k: &str| req.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();
        let names = |p: &str| crate::ws::principals::display_name(&conn, p);
        let r: Result<Value, String> = (|| match op {
            "list" => Ok(json!({ "groups": groups::list(&conn, req.get("member").and_then(Value::as_str), &agents)? })),
            "create" => groups::create(&conn, req, &agents),
            "get" => groups::get(&conn, &gid()?, &agents),
            "read" => groups::read(&conn, &gid()?, req.get("before").and_then(Value::as_str), req.get("thread").and_then(Value::as_str), req.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize),
            "post" => self.group_post(
                &gid()?,
                Party::new("user", "You"),
                &s("text"),
                req.get("replyTo").and_then(Value::as_str).map(str::to_string),
                strs("to"),
                req.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default(),
                env,
            ),
            "preview" => {
                let g = gid()?;
                let pr = PostReq { from: Party::new("user", "You"), text: &s("text"), reply_to: req.get("replyTo").and_then(Value::as_str).map(str::to_string), to: strs("to"), attachments: vec![], comms_paused: false, pending: self.pending_for(&g) };
                groups::preview(&conn, &g, &pr, &agents)
            }
            "dispatch" => Ok(json!({ "rows": groups::dispatch_log(&conn, &s("message"))? })),
            "members.add" => groups::add_member(&conn, &gid()?, &s("pid"), req.get("role").and_then(Value::as_str), &agents),
            "members.remove" => groups::remove_member(&conn, &gid()?, &s("pid"), &agents),
            "members.role" => groups::set_member(&conn, &gid()?, &s("pid"), Some(&s("role")), None).map(|_| json!({ "ok": true })),
            "members.mute" => groups::set_member(&conn, &gid()?, &s("pid"), None, Some(req.get("until").and_then(Value::as_i64))).map(|_| json!({ "ok": true })),
            "rename" | "purpose" | "archive" | "unarchive" | "pause" | "resume" | "delete" | "restore" => {
                let g = gid()?;
                groups::set_group(&conn, &g, op, &s(if op == "rename" { "name" } else { "purpose" }))?;
                groups::get(&conn, &g, &agents)
            }
            "settings" => {
                let g = gid()?;
                groups::set_settings(&conn, &g, req.get("settings").unwrap_or(&Value::Null))?;
                groups::get(&conn, &g, &agents)
            }
            "rules.set" => groups::save_rules(&conn, &gid()?, req.get("rules").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), &names),
            "rules.validate" => {
                let g = gid()?;
                let rules: Vec<crate::ws::group_rules::Rule> = req
                    .get("rules")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|r| crate::ws::group_rules::Rule {
                                id: r["id"].as_str().unwrap_or("").to_string(),
                                scope: r["scope"].as_str().unwrap_or("group").to_string(),
                                kind: r["kind"].as_str().unwrap_or("").to_string(),
                                params: r.get("params").cloned().unwrap_or(json!({})),
                                priority: r["priority"].as_i64().unwrap_or(0),
                                enabled: r["enabled"].as_bool().unwrap_or(true),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let members = groups::get(&conn, &g, &agents)?["members"].as_array().cloned().unwrap_or_default();
                let pids: Vec<String> = members.iter().filter(|m| m["membership"] != "left").filter_map(|m| m["pid"].as_str().map(str::to_string)).collect();
                Ok(crate::ws::group_rules::validate(&rules, &pids, &names))
            }
            "rules.history" => Ok(json!({ "history": groups::rules_history(&conn, &gid()?, req.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize)? })),
            "context.list" => {
                let g = gid()?;
                Ok(json!({ "policy": groups::ai_context_policy(&conn, &g), "items": crate::ws::context_use::list(&conn, &format!("group:{g}"))? }))
            }
            "notes" => {
                let g = gid()?;
                let (ws, state) = self.ws_sources();
                let src = crate::ws::registry::Sources { workspace_dir: ws.as_deref(), state_dir: Some(state.as_path()), ..Default::default() };
                crate::ws::registry::sync(&conn, &src).map_err(|e| e.to_string())?;
                Ok(json!({ "members": groups::member_notes(&conn, &src, &g)? }))
            }
            "context.set" => {
                let g = gid()?;
                let lock = req.get("lock").and_then(Value::as_bool);
                crate::ws::context_use::set_user(&conn, &format!("group:{g}"), &s("itemId"), &s("state"), lock)
            }
            "rules.preset" => {
                let g = gid()?;
                groups::apply_preset(&conn, &g, &s("preset"))?;
                groups::get(&conn, &g, &agents)
            }
            "pin" | "unpin" => groups::pin(&conn, &gid()?, &s("message"), "user", op == "pin").map(|_| json!({ "ok": true })),
            "edit" => groups::edit_message(&conn, &s("message"), "user", Some(&s("text"))).map(|_| json!({ "ok": true })),
            "deleteMessage" => groups::edit_message(&conn, &s("message"), "user", None).map(|_| json!({ "ok": true })),
            "silence" => {
                let g = gid()?;
                Ok(json!({ "silence": groups::silence(&conn, &g, crate::ws::now_ms())? }))
            }
            "nudged" => groups::mark_nudged(&conn, &gid()?, &s("message")).map(|_| json!({ "ok": true })),
            "read_cursor" => {
                let g = gid()?;
                conn.execute(
                    "INSERT INTO ws_cursors (pid, conversation, last_read) VALUES ('user', ?1, ?2) ON CONFLICT(pid, conversation) DO UPDATE SET last_read = excluded.last_read",
                    rusqlite::params![format!("group:{g}"), s("message")],
                )
                .map_err(|e| e.to_string())?;
                Ok(json!({ "ok": true }))
            }
            other => Err(format!("Unknown group action {other}.")),
        })();
        Some(r)
    }

    pub(super) fn group_tool_definitions() -> Vec<ToolDefinition> {
        let def = |name: &str, description: &str, schema: Value| ToolDefinition { name: name.into(), description: description.into(), input_schema: schema, webview_only: false, approval_policy: None };
        vec![
            def(
                TOOL_GROUP_POST,
                "Post a message in a group you are a member of. Mention members with @name to wake them; replyTo threads under a message; to sends to some members only.",
                json!({"type": "object", "properties": {"group": {"type": "string", "description": "Group id or #name"}, "text": {"type": "string"}, "replyTo": {"type": "string"}, "to": {"type": "array", "items": {"type": "string"}}}, "required": ["group", "text"]}),
            ),
            def(
                TOOL_GROUP_READ,
                "Read a group's messages, oldest first (the full thread when a note was folded). thread reads one message's replies.",
                json!({"type": "object", "properties": {"group": {"type": "string"}, "before": {"type": "string"}, "thread": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["group"]}),
            ),
            def(
                TOOL_GROUP_PASS,
                "You were woken in a group but have nothing to add: post nothing and say why in one line.",
                json!({"type": "object", "properties": {"group": {"type": "string"}, "reason": {"type": "string"}}, "required": ["group", "reason"]}),
            ),
            def(TOOL_GROUP_LIST, "List the groups you are in, with their members and rules.", json!({"type": "object", "properties": {}})),
            def(
                TOOL_GROUP_PIN,
                "Pin a message in a group you are a member of so every member sees it on top; unpin: true takes the pin off.",
                json!({"type": "object", "properties": {"group": {"type": "string"}, "messageId": {"type": "string"}, "unpin": {"type": "boolean"}}, "required": ["group", "messageId"]}),
            ),
            def(
                TOOL_GROUP_CONTEXT,
                "Put a shared item in or out of the group's AI context. Works only when the group lets the AI decide and the user has not locked the item; say why in reason (it is logged).",
                json!({"type": "object", "properties": {"group": {"type": "string"}, "itemId": {"type": "string"}, "state": {"type": "string", "enum": ["in", "out"]}, "reason": {"type": "string"}}, "required": ["group", "itemId", "state", "reason"]}),
            ),
        ]
    }

    pub(super) fn handle_group_tool(self: &Arc<Self>, me: &SubagentRecord, tool: &str, input: &Value, env: &ParentEnv) -> (String, bool) {
        let Some(conn) = self.ws_conn() else { return ("The message store is not open.".into(), true) };
        let my_pid = format!("agent:{}", me.id);
        let agents = self.group_agents();
        let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let member_gid = |r: &str| -> Result<String, String> {
            let gid = groups::resolve(&conn, r)?;
            let mine = groups::groups_of(&conn, &my_pid)?.iter().any(|g| g["id"] == gid.as_str());
            if mine { Ok(gid) } else { Err("You are not a member of that group.".into()) }
        };
        let r: Result<String, String> = (|| match tool {
            TOOL_GROUP_LIST => {
                let gs = groups::list(&conn, Some(&my_pid), &agents)?;
                if gs.is_empty() {
                    return Ok("You are in no groups.".into());
                }
                Ok(gs
                    .iter()
                    .map(|g| {
                        let gid = g["id"].as_str().unwrap_or("");
                        let members = groups::get(&conn, gid, &agents).map(|d| d["members"].as_array().cloned().unwrap_or_default()).unwrap_or_default();
                        let names: Vec<String> = members.iter().filter(|m| m["membership"] != "left").map(|m| format!("{} ({}, {})", m["name"].as_str().unwrap_or(""), m["pid"].as_str().unwrap_or(""), m["presence"].as_str().unwrap_or(""))).collect();
                        format!("- #{} (id {gid}, {}, rules: {}): {}", g["name"].as_str().unwrap_or(""), g["state"].as_str().unwrap_or(""), g["presetLabel"].as_str().unwrap_or(""), names.join(", "))
                    })
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            TOOL_GROUP_READ => {
                let gid = member_gid(&s("group"))?;
                let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(30) as usize;
                let out = groups::read(&conn, &gid, input.get("before").and_then(Value::as_str), input.get("thread").and_then(Value::as_str), limit)?;
                let lines: Vec<String> = out["messages"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|m| {
                        let reply = m["replyTo"].as_str().map(|r| format!(" (reply to {r})")).unwrap_or_default();
                        format!("{} · {} ({}){}: {}", m["id"].as_str().unwrap_or(""), m["fromName"].as_str().unwrap_or(""), m["from"].as_str().unwrap_or(""), reply, m["text"].as_str().unwrap_or(""))
                    })
                    .collect();
                if lines.is_empty() {
                    return Ok("No messages in that group yet.".into());
                }
                Ok(format!("#{}:\n{}", out["group"]["name"].as_str().unwrap_or(""), lines.join("\n")))
            }
            TOOL_GROUP_PASS => {
                let gid = member_gid(&s("group"))?;
                groups::pass(&conn, &gid, &my_pid, &s("reason"), None)?;
                Ok("Passed. Nothing was posted.".into())
            }
            TOOL_GROUP_POST => {
                let gid = member_gid(&s("group"))?;
                let to = input.get("to").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let out = self.group_post(&gid, Self::party_of(me), &s("text"), input.get("replyTo").and_then(Value::as_str).map(str::to_string), to, vec![], env)?;
                let woken = out["dispatch"]["wake"].as_array().map(|a| a.len()).unwrap_or(0);
                Ok(format!("Posted as {} in group {gid}; {woken} member(s) woken.", out["message"].as_str().unwrap_or("")))
            }
            TOOL_GROUP_PIN => {
                let gid = member_gid(&s("group"))?;
                let mid = if s("messageId").is_empty() { s("message_id") } else { s("messageId") };
                if mid.is_empty() {
                    return Err("`messageId` is required.".into());
                }
                let on = input.get("unpin").and_then(Value::as_bool) != Some(true);
                groups::pin(&conn, &gid, &mid, &my_pid, on)?;
                Ok(if on { format!("Pinned {mid} in group {gid}.") } else { format!("Unpinned {mid} in group {gid}.") })
            }
            TOOL_GROUP_CONTEXT => {
                let gid = member_gid(&s("group"))?;
                let item = if s("itemId").is_empty() { s("item_id") } else { s("itemId") };
                let policy = groups::ai_context_policy(&conn, &gid);
                let st = crate::ws::context_use::set_model(&conn, &format!("group:{gid}"), &item, &s("state"), &my_pid, &s("reason"), &policy)?;
                Ok(format!("Item {item} is now {} in group {gid}'s context.", st["state"].as_str().unwrap_or("")))
            }
            _ => Err(format!("Unknown group tool {tool}.")),
        })();
        match r {
            Ok(t) => (t, false),
            Err(e) => (e, true),
        }
    }
}

// Phase 4 (plan.md): references and safe deletion for sub-agents.
impl SubagentManager {
    pub(super) fn ws_sources(&self) -> (Option<std::path::PathBuf>, std::path::PathBuf) {
        (self.workspace.lock().unwrap().clone().map(std::path::PathBuf::from), self.state_dir.clone())
    }

    /// Delete the sub-agent as a holder: items others reference are
    /// detached, the rest follow the delete policy, refs it holds are
    /// revoked. None when the workspace index is not available.
    pub(crate) fn ws_delete_holder(&self, id: &str) -> Option<Value> {
        let conn = self.ws_conn()?;
        let (ws, state) = self.ws_sources();
        let src = crate::ws::registry::Sources { workspace_dir: ws.as_deref(), state_dir: Some(state.as_path()), ..Default::default() };
        crate::ws::trash::delete_holder(&conn, &src, "user", &format!("agent:{id}"), &crate::ws::trash::DeleteOpts::default()).ok()
    }

    /// Names of the holders (other than the agent) that its memory entries
    /// are shared with.
    pub(crate) fn ws_memory_shared_with(&self, id: &str) -> Vec<String> {
        let Some(conn) = self.ws_conn() else { return Vec::new() };
        let mut names = std::collections::BTreeSet::new();
        let items = crate::ws::registry::query(&conn, "loc LIKE ?1 AND state = 'live'", &[&format!("fs:subagents/{id}/memory.json#%")]).unwrap_or_default();
        for it in items {
            for r in crate::ws::refs::live_shares(&conn, it["id"].as_str().unwrap_or("")).unwrap_or_default() {
                names.insert(r["holderName"].as_str().unwrap_or("").to_string());
            }
        }
        names.into_iter().filter(|n| !n.is_empty()).collect()
    }

    /// Clear the agent's memory but keep entries others still reference
    /// (they are detached to the user's library) or that sit in Trash
    /// (they come back on restore; the sweep purges them).
    /// A sub-agent id from an id or a name (the oldest of that name, as
    /// `memory_path` resolves it).
    pub(crate) fn resolve_id(&self, name: &str) -> String {
        self.get(name)
            .map(|r| r.id)
            .or_else(|| {
                let recs = self.records.lock().unwrap().clone();
                recs.into_iter().filter(|r| r.name == name).min_by_key(|r| (r.created_at, r.id.clone())).map(|r| r.id)
            })
            .unwrap_or_else(|| name.to_string())
    }

    pub(crate) fn memory_clear_unshared(&self, id: &str) -> usize {
        let id = &self.resolve_id(id);
        let keep: std::collections::HashSet<String> = match self.ws_conn() {
            Some(conn) => {
                let prefix = format!("fs:subagents/{id}/memory.json#");
                let items = crate::ws::registry::query(&conn, "loc LIKE ?1 AND state IN ('live', 'trashed')", &[&format!("{prefix}%")]).unwrap_or_default();
                let owner = format!("agent:{id}");
                items
                    .into_iter()
                    .filter(|it| it["state"] == "trashed" || it["owner"] != owner.as_str() || !crate::ws::refs::live_shares(&conn, it["id"].as_str().unwrap_or("")).unwrap_or_default().is_empty())
                    .filter_map(|it| it["loc"].as_str().and_then(|l| l.strip_prefix(&prefix)).map(str::to_string))
                    .collect()
            }
            None => Default::default(),
        };
        let mut n = 0;
        self.memory_write(id, |entries| {
            let before = entries.len();
            entries.retain(|e| keep.contains(if e.id.is_empty() { &e.key } else { &e.id }));
            n = before - entries.len();
        });
        n
    }
}

impl SubagentManager {
    /// Mount a sub-agent's memory entries into main memory (Phase 4 item 4):
    /// `items.share {holder: 'agent:main', mode: 'mount', perm: 'use'}` for
    /// each matching entry. Returns how many were shared.
    pub(crate) fn ws_share_memory_with_main(&self, name: &str, key: Option<&str>) -> Result<usize, String> {
        let conn = self.ws_conn().ok_or("The workspace index isn't available.")?;
        let (ws, state) = self.ws_sources();
        let src = crate::ws::registry::Sources { workspace_dir: ws.as_deref(), state_dir: Some(state.as_path()), ..Default::default() };
        crate::ws::registry::sync(&conn, &src).map_err(|e| e.to_string())?;
        let id = self.resolve_id(name);
        let items = crate::ws::registry::query(&conn, "kind = 'agent_memory' AND loc LIKE ?1 AND state = 'live'", &[&format!("fs:subagents/{id}/memory.json#%")]).map_err(|e| e.to_string())?;
        let mut n = 0;
        for it in items.iter().filter(|it| key.is_none_or(|k| it["meta"]["key"] == k || it["title"] == k)) {
            crate::ws::refs::share(&conn, "user", it["id"].as_str().unwrap_or(""), "agent:main", "mount", "use", "")?;
            n += 1;
        }
        if n == 0 {
            return Err(match key {
                Some(k) => format!("No memory entry {k} to share."),
                None => "There is no memory to share.".into(),
            });
        }
        Ok(n)
    }
}
