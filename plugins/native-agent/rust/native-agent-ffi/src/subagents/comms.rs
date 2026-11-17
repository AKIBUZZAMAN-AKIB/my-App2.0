//! Control of the agents of a chat as a team: the message flow between them,
//! routing rules, and the manual actions the user takes on one agent or a
//! sub-tree.
//!
//! Research notes (docs/subagents/DELEGATION_GRAPH_DESIGN.md, § Control):
//! - AutoGen GroupChat and LangGraph decide who may speak to whom with
//!   explicit edges; here that is the topology plus each agent's `canMessage`
//!   and `hidden`/`hiddenFrom` (team.rs). This module adds the chat-wide
//!   routing rules on top: `commsPaused` holds every agent-to-agent message
//!   (as a supervisor's "stop all talk"), and a per-minute send limit, chat
//!   wide with a per-agent override, so a pair of agents cannot loop forever
//!   (CrewAI's `max_rpm`, AutoGen's max turns).
//! - Every message between agents (peer messages, asks to the parent and
//!   their answers, the user's own messages and broadcasts) is already in the
//!   agents' logs; `comms` merges them into one timeline for the chat, like
//!   the OpenAI Agents SDK trace or LangSmith's run tree.
//! - Manual actions (OpenAI Agents SDK/Claude Code give the user stop and
//!   resume; LangGraph Studio adds interrupt, resume and editing state): pause
//!   and resume one agent, stop a whole sub-tree, broadcast to every agent of
//!   the chat, and move an agent under another parent while it is idle.

use super::*;
use std::collections::VecDeque;

const COMMS_EVENTS: [&str; 6] =
    ["subagent.peer_message", "subagent.ask_parent", "subagent.parent_answer", "subagent.message", "subagent.broadcast", "subagent.comms_blocked"];

impl SubagentManager {
    /// The agent and all agents below it, top first.
    pub fn subtree_ids(&self, id: &str) -> Vec<String> {
        let recs = self.records.lock().unwrap();
        let mut out = vec![id.to_string()];
        let mut i = 0;
        while i < out.len() {
            let cur = out[i].clone();
            out.extend(recs.iter().filter(|r| r.parent_id.as_deref() == Some(cur.as_str())).map(|r| r.id.clone()));
            i += 1;
            if out.len() > 500 {
                break;
            }
        }
        out
    }

    /// Whether `from` may send one more agent-to-agent message now. Counts it
    /// when it may.
    pub(super) fn check_send_rules(&self, from: &SubagentRecord) -> Result<(), String> {
        let s = self.settings();
        if s.comms_paused {
            return Err("The user has paused messages between agents. Carry on with your own task and report to your parent.".into());
        }
        let limit = from.peer_rate_limit.unwrap_or(s.peer_rate_limit_per_min);
        if limit == 0 {
            return Ok(());
        }
        let now = now_ms();
        let mut sends = self.peer_sends.lock().unwrap();
        let q: &mut VecDeque<i64> = sends.entry(from.id.clone()).or_default();
        while q.front().is_some_and(|t| now - *t > 60_000) {
            q.pop_front();
        }
        if q.len() as u32 >= limit {
            return Err(format!("You have sent {} messages in the last minute, the most allowed. Wait, or carry on without messaging.", limit));
        }
        q.push_back(now);
        Ok(())
    }

    /// One timeline of every message between the agents of a chat (and from
    /// the user to them), oldest first.
    pub fn comms(&self, session_key: &str, limit: usize) -> Vec<Value> {
        let root = self.root_of(session_key);
        let recs: Vec<SubagentRecord> = self.list().into_iter().filter(|r| self.root_of(&r.session_key) == root).collect();
        let name_of = |id: &str| recs.iter().find(|r| r.id == id).map(|r| r.title.clone().unwrap_or_else(|| r.name.clone()));
        let parent_of = |r: &SubagentRecord| -> (Option<String>, String) {
            match r.parent_id.as_deref() {
                Some(p) => (Some(p.to_string()), name_of(p).unwrap_or_else(|| p.to_string())),
                None => (None, "Main agent".to_string()),
            }
        };
        let mut out: Vec<Value> = Vec::new();
        for r in &recs {
            let me = r.title.clone().unwrap_or_else(|| r.name.clone());
            for line in self.read_log(&r.id, 400) {
                let ev = line.get("event").and_then(Value::as_str).unwrap_or("");
                let swarm_kind = ev.strip_prefix("subagent.swarm_");
                if !COMMS_EVENTS.contains(&ev) && swarm_kind.is_none() {
                    continue;
                }
                let at = line.get("at").cloned().unwrap_or(Value::Null);
                let s = |k: &str| line.get(k).and_then(Value::as_str).map(str::to_string);
                if let Some(k) = swarm_kind {
                    let to = s("to");
                    let to_name = s("toName").filter(|n| !n.is_empty()).or_else(|| to.as_deref().and_then(name_of)).unwrap_or_default();
                    let mut v = json!({
                        "at": at,
                        "kind": k,
                        "fromId": r.id,
                        "fromName": me,
                        "toId": to,
                        "toName": to_name,
                        "text": s("text").unwrap_or_default(),
                        "status": s("status").unwrap_or_default(),
                    });
                    for key in ["topic", "requestId", "auctionId", "voteId", "debateId", "rumorId", "key", "op", "round", "term", "option", "winner", "recipients", "depth", "hop"] {
                        if let Some(x) = line.get(key) {
                            v[key] = x.clone();
                        }
                    }
                    out.push(v);
                    continue;
                }
                let (kind, from_id, from_name, to_id, to_name, text, status) = match ev {
                    "subagent.peer_message" => {
                        let to = s("to").unwrap_or_default();
                        let to_name = s("toName").or_else(|| name_of(&to)).unwrap_or_else(|| to.clone());
                        ("peer", Some(r.id.clone()), me.clone(), Some(to), to_name, s("text"), s("delivery").unwrap_or_else(|| "sent".into()))
                    }
                    "subagent.ask_parent" => {
                        let (pid, pname) = parent_of(r);
                        ("ask_parent", Some(r.id.clone()), me.clone(), pid, pname, s("question"), "asked".into())
                    }
                    "subagent.parent_answer" => {
                        let (pid, pname) = parent_of(r);
                        ("parent_answer", pid, pname, Some(r.id.clone()), me.clone(), s("answer"), "answered".into())
                    }
                    "subagent.broadcast" => ("broadcast", None, "You".into(), Some(r.id.clone()), me.clone(), s("text"), s("delivery").unwrap_or_else(|| "sent".into())),
                    "subagent.comms_blocked" => {
                        let to = s("to");
                        let to_name = to.as_deref().and_then(name_of).or_else(|| s("toName")).unwrap_or_default();
                        ("blocked", Some(r.id.clone()), me.clone(), to, to_name, s("text"), s("reason").unwrap_or_else(|| "blocked".into()))
                    }
                    _ => ("user", None, "You".into(), Some(r.id.clone()), me.clone(), s("text"), "sent".into()),
                };
                out.push(json!({
                    "at": at,
                    "kind": kind,
                    "fromId": from_id,
                    "fromName": from_name,
                    "toId": to_id,
                    "toName": to_name,
                    "text": text.unwrap_or_default(),
                    "status": status,
                }));
            }
        }
        out.sort_by_key(|v| v.get("at").and_then(Value::as_i64).unwrap_or(0));
        let skip = out.len().saturating_sub(limit);
        out.into_iter().skip(skip).collect()
    }

    /// Who may message whom in a chat, for the permission matrix: one row per
    /// visible agent with the ids it may message and why the others not.
    pub fn comms_matrix(&self, session_key: &str) -> Vec<Value> {
        let root = self.root_of(session_key);
        // list() first: root_of reads the records too.
        let recs: Vec<SubagentRecord> = self.list().into_iter().filter(|r| !r.chat_deleted && self.root_of(&r.session_key) == root).collect();
        recs.iter()
            .map(|from| {
                let cells: Vec<Value> = recs
                    .iter()
                    .filter(|to| to.id != from.id)
                    .map(|to| match self.may_message(from, to) {
                        Ok(()) => json!({ "to": to.id, "allowed": true }),
                        Err(e) => json!({ "to": to.id, "allowed": false, "reason": e }),
                    })
                    .collect();
                json!({ "id": from.id, "name": from.name, "title": from.title, "cells": cells, "teamTools": self.team_tool_names(from) })
            })
            .collect()
    }

    /// Pause one agent: a run in progress stops (status `paused`), a queued
    /// run waits in the queue until it is resumed.
    pub fn pause(self: &Arc<Self>, id: &str) -> Result<SubagentRecord, String> {
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        let rec = self.update(id, |r| r.paused = true).unwrap_or(rec);
        self.persist();
        if rec.is_running() {
            self.stop(id, "paused");
        } else if rec.status == "queued" {
            self.refresh_positions();
        }
        self.append_log(id, "subagent.paused", &rec, &json!({}));
        Ok(self.get(id).unwrap_or(rec))
    }

    /// Resume a paused agent: a queued run may start again; a run that was
    /// stopped by the pause goes on from where it stopped.
    pub fn resume(self: &Arc<Self>, id: &str, env: &ParentEnv) -> Result<SubagentRecord, String> {
        let rec = self.update(id, |r| r.paused = false).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        self.persist();
        self.append_log(id, "subagent.resumed", &rec, &json!({}));
        if rec.status == "paused" {
            return self.rerun_existing(id, "Continue the task from where you stopped.".into(), PendingPrior::Resume, env, false);
        }
        self.pump();
        Ok(self.get(id).unwrap_or(rec))
    }

    /// Stop an agent and every agent below it.
    pub fn stop_tree(self: &Arc<Self>, id: &str) -> Vec<String> {
        let ids = self.subtree_ids(id);
        // Deepest first, so a stopping parent never waits on a child.
        let mut stopped = Vec::new();
        for i in ids.iter().rev() {
            if self.get(i).is_some_and(|r| r.is_active()) && self.stop(i, "cancelled") {
                stopped.push(i.clone());
            }
        }
        stopped
    }

    /// Move an idle agent (with its sub-tree) under another agent of the same
    /// chat, or directly under the main agent (`new_parent` None).
    pub fn reparent(&self, id: &str, new_parent: Option<&str>) -> Result<SubagentRecord, String> {
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        let tree = self.subtree_ids(id);
        if tree.iter().any(|i| self.get(i).is_some_and(|r| r.is_active())) {
            return Err("It or an agent below it is still running. Stop them first.".into());
        }
        let root = self.root_of(&rec.session_key);
        let (parent_id, parent_session, parent_depth) = match new_parent.map(str::trim).filter(|p| !p.is_empty()) {
            None => (None, root.clone(), 0),
            Some(p) => {
                let parent = self.get(p).ok_or_else(|| format!("No sub-agent with id {}.", p))?;
                if tree.contains(&parent.id) {
                    return Err("An agent can't move under itself or an agent below it.".into());
                }
                if self.root_of(&parent.session_key) != root {
                    return Err("The new parent belongs to another chat.".into());
                }
                (Some(parent.id.clone()), parent.session_key.clone(), parent.depth)
            }
        };
        let height = tree.iter().filter_map(|i| self.get(i)).map(|r| r.depth.saturating_sub(rec.depth)).max().unwrap_or(0);
        let max = self.settings().max_depth;
        let new_depth = parent_depth + 1;
        if new_depth + height > max {
            return Err(format!("That would put an agent at level {}; the depth limit is {}.", new_depth + height, max));
        }
        let shift = new_depth as i64 - rec.depth as i64;
        {
            let mut recs = self.records.lock().unwrap();
            for r in recs.iter_mut().filter(|r| tree.contains(&r.id)) {
                r.depth = (r.depth as i64 + shift).max(1) as u32;
                if r.id == id {
                    r.parent_id = parent_id.clone();
                    r.parent_session_key = parent_session.clone();
                }
            }
        }
        self.persist();
        let rec = self.get(id).unwrap_or(rec);
        self.append_log(id, "subagent.reparented", &rec, &json!({ "parentId": parent_id, "depth": new_depth }));
        Ok(rec)
    }

    /// A message from the user to every agent of a chat (or the ids given).
    /// Running and queued agents see it before their next step; idle ones
    /// find it in their inbox at their next run, or start now with `wake`.
    pub fn broadcast(self: &Arc<Self>, session_key: &str, text: &str, ids: Option<Vec<String>>, wake: bool, env: &ParentEnv) -> Result<Vec<Value>, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("`message` is empty.".into());
        }
        let root = self.root_of(session_key);
        let targets: Vec<SubagentRecord> = self
            .list()
            .into_iter()
            .filter(|r| !r.chat_deleted && self.root_of(&r.session_key) == root)
            .filter(|r| ids.as_ref().is_none_or(|l| l.iter().any(|i| i == &r.id)))
            .collect();
        if targets.is_empty() {
            return Err("There are no agents in this chat to message.".into());
        }
        let note = format!("[Message from the user to all agents]\n{}", truncate_chars(text, 8_000));
        let mut out = Vec::new();
        for t in targets {
            let how = if !t.is_active() && wake {
                match self.rerun_existing(&t.id, note.clone(), PendingPrior::Resume, env, false) {
                    Ok(_) => "started",
                    Err(_) => self.deliver(&t, note.clone()),
                }
            } else {
                self.deliver(&t, note.clone())
            };
            self.append_log(&t.id, "subagent.broadcast", &t, &json!({ "text": truncate_chars(text, 2_000), "delivery": how }));
            out.push(json!({ "id": t.id, "delivery": how }));
        }
        Ok(out)
    }

    /// App requests for the team controls; None when the action is not one.
    pub(super) fn comms_app_request(self: &Arc<Self>, action: &str, req: &Value, env: &ParentEnv) -> Option<Result<Value, String>> {
        let id = req.get("id").and_then(Value::as_str).unwrap_or("");
        let session = req.get("sessionKey").and_then(Value::as_str).unwrap_or(&env.session_key).to_string();
        Some(match action {
            "comms" => {
                let limit = req.get("limit").and_then(Value::as_u64).unwrap_or(300).clamp(1, 2_000) as usize;
                let s = self.settings();
                Ok(json!({
                    "messages": self.comms(&session, limit),
                    "matrix": self.comms_matrix(&session),
                    "topology": self.effective_comms(&self.root_of(&session)).topology,
                    "chatPaused": self.effective_comms(&self.root_of(&session)).paused,
                    "commsPaused": s.comms_paused,
                    "peerRateLimitPerMin": s.peer_rate_limit_per_min,
                }))
            }
            "pause" => self.pause(id).map(|r| json!({ "subagent": r })),
            "resume" => self.resume(id, env).map(|r| json!({ "subagent": r })),
            "stopTree" => Ok(json!({ "stopped": self.stop_tree(id) })),
            "reparent" => {
                let parent = req.get("parentId").and_then(Value::as_str);
                self.reparent(id, parent).map(|r| json!({ "subagent": r }))
            }
            "broadcast" => {
                let text = req.get("message").and_then(Value::as_str).unwrap_or("");
                let ids = req.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect());
                let wake = req.get("wake").and_then(Value::as_bool).unwrap_or(false);
                self.broadcast(&session, text, ids, wake, env).map(|d| json!({ "delivered": d }))
            }
            _ => return None,
        })
    }
}
