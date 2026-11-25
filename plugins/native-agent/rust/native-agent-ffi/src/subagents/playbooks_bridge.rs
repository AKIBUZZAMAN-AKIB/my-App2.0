//! Playbooks in groups, for agents and the panel (unified plan, Phase 5).
//!
//! `group_playbook` is one tool for every protocol: a member starts a run
//! (debate, vote, market, election, handoff, gossip, pipeline, review, ...),
//! makes its moves, reads the status or cancels it. Moves that say something
//! (debate turns, results, handoffs, reviews) are posted in the group, and
//! the result is posted as the run's last message; `groups::post_at` uses the
//! running playbook to decide who is woken (see `playbooks::steer`).

use super::*;
use crate::ws::envelope::Party;
use crate::ws::{groups, playbooks};
use serde_json::{json, Value};
use std::sync::Arc;

pub const TOOL_GROUP_PLAYBOOK: &str = "group_playbook";

pub(super) fn playbook_tool_definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL_GROUP_PLAYBOOK.into(),
        description: "Run a protocol in a group: start one (debate, vote, auction, election, handoff, gossip, parallel, pipeline, race, review, gather), make your move in the running one, read its status, or cancel it. While it runs only the members whose move it is are woken.".into(),
        input_schema: json!({"type": "object", "properties": {
            "group": {"type": "string", "description": "Group id or #name"},
            "op": {"type": "string", "enum": ["start", "act", "status", "cancel"]},
            "kind": {"type": "string", "description": "start: the protocol"},
            "members": {"type": "array", "items": {"type": "string"}, "description": "start: who takes part, in order (default: every agent in the group)"},
            "options": {"type": "array", "items": {"type": "string"}, "description": "vote: the choices"},
            "rule": {"type": "string", "enum": ["majority", "plurality", "unanimous", "supermajority"]},
            "task": {"type": "string", "description": "auction / handoff: the task"},
            "rounds": {"type": "integer"},
            "timeoutSeconds": {"type": "integer"},
            "action": {"type": "string", "description": "act: turn | ballot | bid | handoff | finish | spread | result | review | close"},
            "text": {"type": "string"},
            "option": {"type": "string"},
            "reason": {"type": "string"},
            "cost": {"type": "number"},
            "confidence": {"type": "number"},
            "to": {"description": "handoff: one member; spread: members"},
            "approve": {"type": "boolean"},
            "stance": {"type": "string", "enum": ["agree", "disagree", "neutral"]}
        }, "required": ["group", "op"]}),
        webview_only: false,
        approval_policy: None,
    }
}

fn pid_of(name: &str, members: &[Value]) -> Option<String> {
    let n = name.trim().trim_start_matches('@');
    let lower = n.to_lowercase();
    members
        .iter()
        .find(|m| m["pid"].as_str() == Some(n) || m["pid"].as_str() == Some(&format!("agent:{n}")) || m["name"].as_str().is_some_and(|x| x.to_lowercase() == lower))
        .and_then(|m| m["pid"].as_str().map(str::to_string))
}

impl SubagentManager {
    /// Start, act on, read or cancel a group's playbook as `me`. Used by the
    /// `group_playbook` tool of sub-agents and of the main agent, and by the
    /// panel (as the user).
    pub(crate) fn group_playbook(self: &Arc<Self>, gid: &str, me: Party, input: &Value, env: &ParentEnv) -> Result<Value, String> {
        let conn = self.ws_conn().ok_or("The message store is not open.")?;
        let room = format!("group:{gid}");
        let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let agents = self.group_agents();
        let g = groups::get(&conn, gid, &agents)?;
        let members: Vec<Value> = g["members"].as_array().cloned().unwrap_or_default().into_iter().filter(|m| m["membership"] == "joined").collect();
        match s("op").as_str() {
            "start" => {
                if !self.settings().unified_playbooks {
                    return Err("Playbooks are off (Settings → Sub-agents → Unified playbooks).".into());
                }
                let mut params = input.clone();
                if let Some(o) = params.as_object_mut() {
                    for k in ["group", "op", "kind"] {
                        o.remove(k);
                    }
                }
                let named: Vec<String> = input.get("members").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let pids: Vec<String> = if named.is_empty() {
                    members.iter().filter_map(|m| m["pid"].as_str()).filter(|p| p.starts_with("agent:") && *p != groups::HOST_PID).map(str::to_string).collect()
                } else {
                    let mut out = Vec::new();
                    for n in &named {
                        out.push(pid_of(n, &members).ok_or_else(|| format!("{n} is not a member of this group."))?);
                    }
                    out
                };
                params["members"] = json!(pids);
                if let Some(to) = input.get("to").and_then(Value::as_str) {
                    params["to"] = json!(pid_of(to, &members).unwrap_or_else(|| to.to_string()));
                }
                let pb = playbooks::start(&conn, &room, &s("kind"), &params, &me.pid)?;
                let names: Vec<String> = pids.iter().map(|p| crate::ws::principals::display_name(&conn, p)).collect();
                let what = match pb.kind.as_str() {
                    "vote" => format!("Vote: {} (options: {}; {} rule)", s("text"), crate::subagents::playbooks_bridge::join(&pb.params["options"]), pb.params["rule"].as_str().unwrap_or("majority")),
                    "auction" => format!("Market: who takes \"{}\"? Bid with cost and confidence.", pb.params["task"].as_str().unwrap_or("")),
                    k => format!("{}{}", k[..1].to_uppercase() + &k[1..], if s("text").is_empty() { String::new() } else { format!(": {}", s("text")) }),
                };
                let post = format!("[playbook {}] {what} — with {}.", pb.id, names.join(", "));
                let out = self.group_post_as(gid, me, &post, None, vec![], vec![], env, false)?;
                Ok(json!({ "playbook": pb.to_json(), "message": out["message"], "dispatch": out["dispatch"] }))
            }
            "act" => {
                let pb = playbooks::active(&conn, &room)?.ok_or("No playbook is running in this group.")?;
                let mut body = input.clone();
                if let Some(o) = body.as_object_mut() {
                    for k in ["group", "op", "action"] {
                        o.remove(k);
                    }
                }
                let o = playbooks::act(&conn, &room, &pb.id, &me.pid, &s("action"), &body)?;
                let mut text = o.post.clone().unwrap_or_default();
                if o.finished {
                    let line = playbooks::result_line(&o.playbook);
                    text = if text.is_empty() { line } else { format!("{text}\n\n{line}") };
                }
                let posted = if text.is_empty() { Value::Null } else { self.group_post_as(gid, me, &text, None, vec![], vec![], env, false)? };
                Ok(json!({ "playbook": o.playbook.to_json(), "finished": o.finished, "message": posted["message"], "dispatch": posted["dispatch"] }))
            }
            "status" => Ok(json!({
                "active": playbooks::active(&conn, &room)?.map(|p| p.to_json()),
                "recent": playbooks::list(&conn, &room)?.into_iter().take(5).map(|p| p.to_json()).collect::<Vec<_>>(),
            })),
            "cancel" => {
                let pb = playbooks::active(&conn, &room)?.ok_or("No playbook is running in this group.")?;
                playbooks::cancel(&conn, &room, &pb.id, &me.pid)?;
                Ok(json!({ "cancelled": pb.id }))
            }
            other => Err(format!("Unknown op {other}; one of start, act, status, cancel.")),
        }
    }

    /// The tool's text answer for an agent.
    pub(super) fn group_playbook_text(self: &Arc<Self>, gid: &str, me: Party, input: &Value, env: &ParentEnv) -> Result<String, String> {
        let op = input.get("op").and_then(Value::as_str).unwrap_or("").to_string();
        let out = self.group_playbook(gid, me, input, env)?;
        let pb = if op == "status" { out["active"].clone() } else { out["playbook"].clone() };
        Ok(match op.as_str() {
            "cancel" => format!("Cancelled {}.", out["cancelled"].as_str().unwrap_or("")),
            "status" if pb.is_null() => match out["recent"].as_array().and_then(|a| a.first()) {
                Some(r) => format!("No playbook running. Last: {} ({}) — {}", r["kind"].as_str().unwrap_or(""), r["state"].as_str().unwrap_or(""), r["status"].as_str().unwrap_or("")),
                None => "No playbook running in this group.".into(),
            },
            _ => {
                let next: Vec<String> = pb["next"].as_array().into_iter().flatten().filter_map(|n| n["pid"].as_str().map(str::to_string)).collect();
                let mut t = format!("{} {} ({}): {}", pb["kind"].as_str().unwrap_or(""), pb["id"].as_str().unwrap_or(""), pb["state"].as_str().unwrap_or(""), pb["status"].as_str().unwrap_or(""));
                if pb["state"] == "done" {
                    t.push_str(&format!(" Result: {}", pb["result"]));
                } else if !next.is_empty() {
                    t.push_str(&format!(" Next: {}.", next.join(", ")));
                }
                t
            }
        })
    }
}

impl SubagentManager {
    /// A batch runs as a playbook in its own room when unified playbooks
    /// are on (Phase 5): started with the batch, members in batch order,
    /// closed by the batch's deadline at the latest. Returns (room, id).
    pub(super) fn batch_playbook_start(&self, batch: &str, mode: &str, recs: &[SubagentRecord], root: &str, timeout_secs: u64) -> Option<(String, String)> {
        if !self.settings().unified_playbooks || recs.is_empty() {
            return None;
        }
        let conn = self.ws_conn()?;
        let room = playbooks::batch_room(root, batch);
        let members: Vec<String> = recs.iter().map(|r| format!("agent:{}", r.id)).collect();
        let params = json!({ "members": members, "batch": batch, "mode": mode, "maxRounds": 5, "timeoutSeconds": timeout_secs.max(60) });
        playbooks::start(&conn, &room, playbooks::batch_kind(mode), &params, groups::HOST_PID).ok().map(|pb| (room, pb.id))
    }

    /// After the batch: each finished member's report is its result (in
    /// batch order, where the protocol takes one), then the run is closed.
    pub(super) fn batch_playbook_finish(&self, pb: Option<(String, String)>, ids: &[String]) {
        let Some((room, id)) = pb else { return };
        let Some(conn) = self.ws_conn() else { return };
        for rid in ids {
            if let Some(r) = self.get(rid).filter(|r| r.status == "finished") {
                let text = r.result.clone().unwrap_or_else(|| "(no report)".into());
                let _ = playbooks::act(&conn, &room, &id, &format!("agent:{rid}"), "result", &json!({ "text": text }));
            }
        }
        if playbooks::get(&conn, &room, &id).ok().flatten().is_some_and(|p| p.state == "running") {
            let _ = playbooks::act(&conn, &room, &id, groups::HOST_PID, "close", &json!({}));
        }
    }
}

pub(crate) fn join(v: &Value) -> String {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default()
}
