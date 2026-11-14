//! Team features for sub-agents: topologies, asking the parent, messaging
//! peers, per-agent visibility and reusable templates.
//!
//! Design notes (docs/multi-agent-design.md has the full research):
//! - Topology decides who may talk to whom, like AutoGen's allowed speaker
//!   transitions or LangGraph's edges, but enforced in code at dispatch time:
//!   `tree` (parent <-> child, nesting up to max depth), `star` (only the main
//!   agent delegates; no nesting, no peers), `mesh` (any visible sub-agent of
//!   the same chat), `ring` (each sub-agent may message the next sibling).
//! - A sub-agent never sees the parent's conversation. `ask_parent` runs an
//!   isolated consult of the parent: the parent's own instructions and recent
//!   transcript answer the question, so a parent that is blocked waiting for
//!   the child cannot deadlock it (OpenAI "agents as tools", not a handoff).
//! - Peer messages go into the recipient's steer queue when it is running, or
//!   its inbox when it is not (MetaGPT-style message pool, scoped per chat).
//! - Per agent: `hidden` (no peer sees it), `hiddenFrom` (these ids/names do
//!   not), `canMessage` (explicit allow-list that overrides the topology),
//!   `shareable` (other chats may reuse it), and its own tool list.

use super::*;

pub const TOOL_ASK_PARENT: &str = "ask_parent";
pub const TOOL_MESSAGE_PEER: &str = "message_peer";
pub const TOOL_LIST_PEERS: &str = "list_peers";
pub const TEAM_TOOL_NAMES: [&str; 3] = [TOOL_ASK_PARENT, TOOL_MESSAGE_PEER, TOOL_LIST_PEERS];
pub const TOPOLOGIES: [&str; 4] = ["tree", "star", "mesh", "ring"];
const INBOX_CAP: usize = 20;
const TEMPLATE_CAP: usize = 200;
const PARENT_CONTEXT_CHARS: usize = 60_000;

pub fn is_team_tool(name: &str) -> bool {
    TEAM_TOOL_NAMES.contains(&name)
}

pub fn normalize_topology(t: &str) -> String {
    let t = t.trim().to_lowercase();
    let t = match t.as_str() {
        "bush" | "hierarchy" | "hierarchical" => "tree",
        "network" | "swarm" | "all" => "mesh",
        "hub" | "supervisor" => "star",
        other => other,
    };
    if TOPOLOGIES.contains(&t) { t.to_string() } else { "tree".to_string() }
}

fn matches_ref(rec: &SubagentRecord, r: &str) -> bool {
    let r = r.trim();
    !r.is_empty() && (rec.id == r || rec.name.eq_ignore_ascii_case(r))
}

/// A reusable sub-agent definition (item 7). `extends` names the template it
/// was derived from; `createdFrom` the sub-agent it was saved from.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SubagentTemplate {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub role: Option<String>,
    pub system_prompt: Option<String>,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub max_steps: Option<u32>,
    pub token_budget: Option<u64>,
    pub memory: Option<String>,
    pub extends: Option<String>,
    pub created_from: Option<String>,
    pub hidden: bool,
    pub shareable: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub uses: u32,
}

impl SubagentManager {
    fn templates_path(&self) -> PathBuf {
        self.state_dir.join("templates.json")
    }

    pub fn templates(&self) -> Vec<SubagentTemplate> {
        fs_read_json::<Vec<SubagentTemplate>>(&self.templates_path()).unwrap_or_default()
    }

    fn write_templates(&self, list: &[SubagentTemplate]) {
        fs_write_json(&self.templates_path(), &list);
    }

    /// Save (create or update) a template. With `fromId`, the template is
    /// built from that sub-agent's definition and remembers it as its origin.
    pub fn save_template(&self, req: &Value) -> Result<SubagentTemplate, String> {
        let mut t: SubagentTemplate = match req.get("template") {
            Some(v) => serde_json::from_value(v.clone()).map_err(|e| format!("Invalid template: {}", e))?,
            None => SubagentTemplate::default(),
        };
        if let Some(from) = req.get("fromId").and_then(Value::as_str) {
            let rec = self.get(from).ok_or_else(|| format!("No sub-agent with id {}.", from))?;
            let fill = |o: &mut Option<String>, v: Option<String>| {
                if o.as_deref().map_or(true, |s| s.trim().is_empty()) {
                    *o = v;
                }
            };
            if t.name.trim().is_empty() {
                t.name = rec.name.clone();
            }
            fill(&mut t.title, rec.title.clone());
            fill(&mut t.description, rec.description.clone().or_else(|| Some(truncate_chars(&rec.task, 300))));
            fill(&mut t.role, rec.role.clone());
            fill(&mut t.system_prompt, rec.system_prompt.clone());
            fill(&mut t.model, rec.model.clone());
            fill(&mut t.provider, rec.provider.clone());
            fill(&mut t.extends, rec.template.clone());
            t.tools = t.tools.or_else(|| Some(rec.tools.clone()));
            t.max_steps = t.max_steps.or(Some(rec.max_steps));
            t.token_budget = t.token_budget.or(Some(rec.token_budget));
            t.memory = t.memory.or_else(|| Some(rec.memory_mode.clone()));
            t.created_from = Some(rec.id.clone());
            t.shareable = t.shareable || rec.shareable;
        }
        t.name = sanitize_name(&t.name);
        if t.name.is_empty() {
            return Err("A template needs a name.".into());
        }
        if t.extends.as_deref() == Some(t.name.as_str()) {
            t.extends = None;
        }
        let now = now_ms();
        let mut list = self.templates();
        match list.iter_mut().find(|x| x.name == t.name) {
            Some(existing) => {
                t.created_at = existing.created_at;
                t.uses = existing.uses;
                t.updated_at = now;
                *existing = t.clone();
            }
            None => {
                if list.len() >= TEMPLATE_CAP {
                    return Err(format!("At most {} templates. Delete one first.", TEMPLATE_CAP));
                }
                t.created_at = now;
                t.updated_at = now;
                list.push(t.clone());
            }
        }
        self.write_templates(&list);
        Ok(t)
    }

    pub fn delete_template(&self, name: &str) -> bool {
        let mut list = self.templates();
        let before = list.len();
        list.retain(|t| t.name != name);
        let removed = list.len() != before;
        if removed {
            self.write_templates(&list);
        }
        removed
    }

    /// A template with its `extends` chain resolved (child fields win).
    pub fn resolve_template(&self, name: &str) -> Option<SubagentTemplate> {
        let list = self.templates();
        let mut chain = Vec::new();
        let mut cur = list.iter().find(|t| t.name == name || t.name == sanitize_name(name))?.clone();
        loop {
            let next = cur.extends.clone();
            chain.push(cur);
            match next.and_then(|n| list.iter().find(|t| t.name == n).cloned()) {
                Some(p) if chain.len() < 6 && !chain.iter().any(|c| c.name == p.name) => cur = p,
                _ => break,
            }
        }
        let mut out = chain.pop()?;
        while let Some(child) = chain.pop() {
            macro_rules! over {
                ($f:ident) => {
                    if child.$f.is_some() {
                        out.$f = child.$f.clone();
                    }
                };
            }
            over!(title);
            over!(description);
            over!(role);
            over!(model);
            over!(provider);
            over!(tools);
            over!(max_steps);
            over!(token_budget);
            over!(memory);
            out.system_prompt = match (out.system_prompt.take(), child.system_prompt.clone()) {
                (Some(a), Some(b)) => Some(format!("{}\n\n{}", a, b)),
                (a, b) => b.or(a),
            };
            out.extends = Some(out.name.clone());
            out.name = child.name.clone();
            out.hidden = child.hidden;
            out.shareable = child.shareable;
        }
        Some(out)
    }

    /// Fill a spawn spec from its template: fields the caller gave win.
    pub(super) fn apply_template(&self, spec: &mut SpawnSpec) -> Result<(), String> {
        let Some(name) = spec.template.clone().filter(|s| !s.trim().is_empty()) else { return Ok(()) };
        let t = self.resolve_template(&name).ok_or_else(|| {
            let names: Vec<String> = self.templates().into_iter().map(|t| t.name).collect();
            format!("No sub-agent template named {}. Templates: {}.", name, if names.is_empty() { "none".into() } else { names.join(", ") })
        })?;
        spec.template = Some(t.name.clone());
        spec.name = spec.name.take().or_else(|| Some(t.name.clone()));
        spec.title = spec.title.take().or(t.title.clone());
        spec.description = spec.description.take().or(t.description.clone());
        spec.role = spec.role.take().or(t.role.clone());
        spec.system_prompt = match (t.system_prompt.clone(), spec.system_prompt.take()) {
            (Some(a), Some(b)) => Some(format!("{}\n\n{}", a, b)),
            (a, b) => b.or(a),
        };
        spec.tools = spec.tools.take().or(t.tools.clone());
        spec.model = spec.model.take().or(t.model.clone());
        spec.provider = spec.provider.take().or(t.provider.clone());
        spec.max_steps = spec.max_steps.or(t.max_steps);
        spec.token_budget = spec.token_budget.or(t.token_budget);
        spec.memory = spec.memory.take().or(t.memory.clone());
        if t.hidden && spec.hidden.is_none() {
            spec.hidden = Some(true);
        }
        if t.shareable && spec.shareable.is_none() {
            spec.shareable = Some(true);
        }
        let mut list = self.templates();
        if let Some(x) = list.iter_mut().find(|x| x.name == t.name) {
            x.uses += 1;
            self.write_templates(&list);
        }
        Ok(())
    }

    pub(super) fn templates_prompt(&self) -> String {
        let list = self.templates();
        if list.is_empty() {
            return String::new();
        }
        let mut s = String::from("\n- Saved sub-agent templates (spawn_subagent with `template`; your other arguments override it):");
        for t in list.iter().take(12) {
            let what = t.description.as_deref().or(t.title.as_deref()).unwrap_or("");
            s.push_str(&format!("\n  - {}: {}", t.name, truncate_chars(what, 160)));
        }
        s
    }

    // ── Visibility and topology ──────────────────────────────────────────────────

    pub(super) fn record_by_session(&self, session_key: &str) -> Option<SubagentRecord> {
        self.records.lock().unwrap().iter().find(|r| r.session_key == session_key).cloned()
    }

    /// The chat a sub-agent ultimately belongs to.
    pub fn root_of(&self, session_key: &str) -> String {
        let mut key = session_key.to_string();
        for _ in 0..16 {
            match self.record_by_session(&key) {
                Some(r) if !r.root_session_key.is_empty() => return r.root_session_key,
                Some(r) => key = r.parent_session_key,
                None => return key,
            }
        }
        key
    }

    fn hidden_from(target: &SubagentRecord, viewer: &SubagentRecord) -> bool {
        target.hidden || target.hidden_from.iter().any(|h| matches_ref(viewer, h))
    }

    /// Whether `from` may send a message to `to` under the settings.
    pub fn may_message(&self, from: &SubagentRecord, to: &SubagentRecord) -> Result<(), String> {
        if from.id == to.id {
            return Err("That is you.".into());
        }
        if self.root_of(&from.session_key) != self.root_of(&to.session_key) {
            return Err(format!("{} belongs to another chat.", to.name));
        }
        if Self::hidden_from(to, from) {
            return Err(format!("No visible sub-agent named {}.", to.name));
        }
        if let Some(allow) = &from.can_message {
            return if allow.iter().any(|a| matches_ref(to, a)) {
                Ok(())
            } else {
                Err(format!("You may only message: {}.", if allow.is_empty() { "nobody".into() } else { allow.join(", ") }))
            };
        }
        match normalize_topology(&self.settings().topology).as_str() {
            "mesh" => Ok(()),
            "ring" => {
                let next = self.ring_next(from);
                if next.as_ref().map(|n| n.id == to.id).unwrap_or(false) {
                    Ok(())
                } else {
                    Err(format!(
                        "In the ring topology you may only message the next sub-agent{}.",
                        next.map(|n| format!(" ({})", n.name)).unwrap_or_default()
                    ))
                }
            }
            t => Err(format!("Sub-agents can't message each other in the {} topology. Report to your parent instead.", t)),
        }
    }

    /// Next visible sibling in creation order, wrapping around.
    fn ring_next(&self, me: &SubagentRecord) -> Option<SubagentRecord> {
        let recs = self.records.lock().unwrap();
        let sibs: Vec<&SubagentRecord> = recs.iter().filter(|r| r.parent_session_key == me.parent_session_key && !r.chat_deleted).collect();
        let i = sibs.iter().position(|r| r.id == me.id)?;
        (1..sibs.len()).map(|k| sibs[(i + k) % sibs.len()]).find(|r| !Self::hidden_from(r, me)).cloned()
    }

    /// Sub-agents `me` can see (same chat, not hidden from it), with whether
    /// it may message each.
    pub fn peers_of(&self, me: &SubagentRecord) -> Vec<(SubagentRecord, bool)> {
        let root = self.root_of(&me.session_key);
        let all: Vec<SubagentRecord> = self.records.lock().unwrap().iter().filter(|r| r.id != me.id && !r.chat_deleted).cloned().collect();
        all.into_iter()
            .filter(|r| self.root_of(&r.session_key) == root && !Self::hidden_from(r, me))
            .map(|r| {
                let ok = self.may_message(me, &r).is_ok();
                (r, ok)
            })
            .collect()
    }

    /// Team tools a sub-agent gets on top of its own tools.
    pub fn team_tool_names(&self, rec: &SubagentRecord) -> Vec<String> {
        let s = self.settings();
        let mut out = Vec::new();
        if rec.depth == 0 {
            return out;
        }
        if s.allow_ask_parent {
            out.push(TOOL_ASK_PARENT.to_string());
        }
        let peers = rec.can_message.as_ref().map_or(false, |a| !a.is_empty()) || matches!(normalize_topology(&s.topology).as_str(), "mesh" | "ring");
        if peers {
            out.push(TOOL_MESSAGE_PEER.to_string());
            out.push(TOOL_LIST_PEERS.to_string());
        }
        out
    }

    pub fn team_tools_for_session(&self, session_key: &str) -> Option<Vec<String>> {
        self.record_by_session(session_key).map(|r| self.team_tool_names(&r))
    }

    pub fn team_tool_definitions() -> Vec<ToolDefinition> {
        let def = |name: &str, description: &str, schema: Value| ToolDefinition {
            name: name.into(),
            description: description.into(),
            input_schema: schema,
            webview_only: false,
            approval_policy: None,
        };
        vec![
            def(
                TOOL_ASK_PARENT,
                "Ask the agent that delegated your task a question (missing detail, a choice, what it meant). It answers from its own instructions and conversation; you get the answer back. Use it instead of guessing when the answer changes your work. Keep questions short and specific.",
                json!({"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]}),
            ),
            def(
                TOOL_MESSAGE_PEER,
                "Send a message to another sub-agent of this chat (by id or name from list_peers): share a finding, hand over a piece of work, or ask it something. A running peer sees it before its next step; an idle one gets it when it runs next. Replies arrive as messages to you.",
                json!({"type": "object", "properties": {"to": {"type": "string", "description": "Peer id or name."}, "message": {"type": "string"}}, "required": ["to", "message"]}),
            ),
            def(
                TOOL_LIST_PEERS,
                "List the other sub-agents of this chat that you can see: id, name, title, status, and whether you may message it.",
                json!({"type": "object", "properties": {}}),
            ),
        ]
    }

    pub(super) fn team_prompt(&self, rec: &SubagentRecord) -> String {
        let tools = self.team_tool_names(rec);
        let mut s = String::new();
        if tools.iter().any(|t| t == TOOL_ASK_PARENT) {
            s.push_str("\n- If a missing detail would change your work, call ask_parent with a short question instead of guessing.");
        }
        if tools.iter().any(|t| t == TOOL_MESSAGE_PEER) {
            s.push_str(&format!(
                "\n- Topology: {}. You can coordinate with other sub-agents: list_peers shows who you may message, message_peer sends. Messages from peers arrive as notes starting with [Message from sub-agent ...].",
                normalize_topology(&self.settings().topology)
            ));
        }
        if rec.depth > 0 && self.offers_tools_at(rec.depth) {
            s.push_str(&format!(
                "\n- You may delegate parts of your task to your own sub-agents with spawn_subagent (you are at depth {} of {}).",
                rec.depth,
                self.settings().max_depth
            ));
        }
        if s.is_empty() { s } else { format!("\n\n## Working with other agents{}", s) }
    }

    // ── Inbox ─────────────────────────────────────────────────────────────────────

    /// Deliver a note to a sub-agent: steer when running or queued, inbox
    /// otherwise. Returns how it was delivered.
    pub(super) fn deliver(&self, to: &SubagentRecord, note: String) -> &'static str {
        if to.is_running() {
            if let Some(l) = self.live.lock().unwrap().get(&to.id) {
                if l.steer_tx.send(note.clone()).is_ok() {
                    return "live";
                }
            }
        }
        if to.status == "queued" {
            if let Some(p) = self.pending.lock().unwrap().get_mut(&to.id) {
                p.steers.push(note);
                return "queued";
            }
        }
        self.update(&to.id, |r| {
            r.inbox.push(note);
            if r.inbox.len() > INBOX_CAP {
                r.inbox.remove(0);
            }
        });
        self.persist();
        "inbox"
    }

    /// Notes waiting in a sub-agent's inbox, cleared.
    pub(super) fn take_inbox(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        self.update(id, |r| out = std::mem::take(&mut r.inbox));
        out
    }

    // ── Tool handling ───────────────────────────────────────────────────────────────

    pub async fn handle_team_tool(self: &Arc<Self>, tool: &str, input: &Value, env: ParentEnv) -> (String, bool) {
        let Some(me) = self.record_by_session(&env.session_key) else {
            return ("Only sub-agents can use this tool.".into(), true);
        };
        if !self.team_tool_names(&me).iter().any(|t| t == tool) {
            return (format!("{} is turned off for this sub-agent.", tool), true);
        }
        match tool {
            TOOL_LIST_PEERS => {
                let peers = self.peers_of(&me);
                if peers.is_empty() {
                    return ("No other sub-agents are visible to you.".into(), false);
                }
                let lines: Vec<String> = peers
                    .iter()
                    .map(|(r, ok)| {
                        format!(
                            "- {} (id {}){} — {}{}{}",
                            r.name,
                            r.id,
                            r.title.as_deref().map(|t| format!(", {}", t)).unwrap_or_default(),
                            r.status,
                            r.description.as_deref().map(|d| format!("; {}", truncate_chars(d, 160))).unwrap_or_default(),
                            if *ok { "; you may message it" } else { "" }
                        )
                    })
                    .collect();
                (lines.join("\n"), false)
            }
            TOOL_MESSAGE_PEER => {
                let to_ref = input.get("to").and_then(Value::as_str).unwrap_or("");
                let text = input.get("message").and_then(Value::as_str).unwrap_or("").trim();
                if text.is_empty() {
                    return ("`message` is empty.".into(), true);
                }
                let target = self.peers_of(&me).into_iter().map(|p| p.0).find(|r| matches_ref(r, to_ref));
                let Some(target) = target else {
                    return (format!("No visible sub-agent {}. Call list_peers.", to_ref), true);
                };
                if let Err(e) = self.may_message(&me, &target) {
                    return (e, true);
                }
                let note = format!("[Message from sub-agent \"{}\" (id {}). Reply with message_peer if you can.]\n{}", me.name, me.id, truncate_chars(text, 8_000));
                let how = self.deliver(&target, note);
                self.emit(&env.callback, "subagent.peer_message", &me, json!({ "to": target.id, "toName": target.name, "text": truncate_chars(text, 2_000), "delivery": how }));
                let msg = match how {
                    "live" => format!("Delivered to {}; it sees it before its next step.", target.name),
                    "queued" => format!("{} is queued; it gets the message when it starts.", target.name),
                    _ => format!("{} is not running; the message waits in its inbox for its next run.", target.name),
                };
                (msg, false)
            }
            TOOL_ASK_PARENT => {
                let q = input.get("question").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if q.is_empty() {
                    return ("`question` is empty.".into(), true);
                }
                self.emit(&env.callback, "subagent.ask_parent", &me, json!({ "question": truncate_chars(&q, 2_000) }));
                match self.consult_parent(&me, &q, &env).await {
                    Ok(answer) => {
                        self.emit(&env.callback, "subagent.parent_answer", &me, json!({ "question": truncate_chars(&q, 500), "answer": truncate_chars(&answer, 4_000) }));
                        (format!("Your parent answers: {}", answer.trim()), false)
                    }
                    Err(e) => (format!("Could not reach your parent: {}. Make a reasonable assumption and say so in your report.", e), true),
                }
            }
            _ => (format!("Unknown tool {}", tool), true),
        }
    }

    /// An isolated, tool-less consult of the parent: its own instructions and
    /// the tail of its transcript answer the child's question.
    async fn consult_parent(self: &Arc<Self>, me: &SubagentRecord, question: &str, env: &ParentEnv) -> Result<String, String> {
        let parent_key = me.parent_session_key.clone();
        let parent_rec = self.record_by_session(&parent_key);
        let mut prior = self.runner.load_messages(&parent_key);
        // Keep the tail that fits; never start inside a tool exchange.
        let mut chars = 0usize;
        let mut start = prior.len();
        while start > 0 {
            let c = prior[start - 1].text().chars().count();
            if chars + c > PARENT_CONTEXT_CHARS && start < prior.len() {
                break;
            }
            chars += c;
            start -= 1;
        }
        while start < prior.len() && !prior[start].is_user_prompt() {
            start += 1;
        }
        prior.drain(..start);
        let who = match &parent_rec {
            Some(p) => format!("the sub-agent \"{}\" whose task is:\n{}", p.name, truncate_chars(&p.task, 4_000)),
            None => "the main agent of this chat".to_string(),
        };
        let base = super::base_prompt(&env.system_prompt);
        let system = format!(
            "You are answering for {}. Your sub-agent \"{}\" (task: {}) asks you a question while it works. Answer it briefly and concretely from your instructions and the conversation so far. If you do not know, say so and suggest a sensible default. Do not call tools.\n\n---\n\n{}",
            who,
            me.name,
            truncate_chars(&me.task, 1_000),
            base
        );
        let id = format!("askp_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        let params = SendMessageParams {
            prompt: format!("[Question from your sub-agent \"{}\"]\n{}", me.name, question),
            session_key: format!("ask-parent:{}", id),
            model: me.model.clone().or_else(|| env.model.clone()),
            provider: me.provider.clone().or_else(|| env.provider.clone()),
            system_prompt: system,
            max_turns: Some(1),
            allowed_tools_json: Some("[]".into()),
            prior_messages_json: None,
            attachments_json: None,
        };
        let (_tx, rx) = mpsc::unbounded_channel();
        let req = RunRequest {
            id: id.clone(),
            params,
            prior_messages: prior,
            callback: Arc::new(ConsultEvents { app: env.callback.clone() }),
            abort: Arc::new(Mutex::new(false)),
            steer_rx: Arc::new(Mutex::new(Some(rx))),
            memory: None,
            timeout_ms: 120_000,
            child: SubagentCtx { manager: self.clone(), depth: u32::MAX / 2 },
        };
        let done = self.runner.run(req).await.map_err(|e| e.to_string())?;
        self.runner.clear(&format!("ask-parent:{}", id));
        let tokens = done.usage.as_ref().map(|u| u.input_tokens + u.output_tokens).unwrap_or(0);
        if tokens > 0 {
            self.update(&me.id, |r| r.input_tokens += tokens as u64);
        }
        last_assistant_text(&done.messages).ok_or_else(|| "no answer".to_string())
    }

    /// App requests for templates and per-agent settings.
    pub(super) fn team_app_request(self: &Arc<Self>, action: &str, req: &Value) -> Option<Result<Value, String>> {
        Some(match action {
            "templates" => Ok(json!({ "templates": self.templates() })),
            "saveTemplate" => self.save_template(req).map(|t| json!({ "template": t })),
            "deleteTemplate" => Ok(json!({ "deleted": self.delete_template(req.get("name").and_then(Value::as_str).unwrap_or("")) })),
            "configure" => {
                let id = req.get("id").and_then(Value::as_str).unwrap_or("");
                let strings = |v: &Value| -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect()).unwrap_or_default() };
                let rec = self.update(id, |r| {
                    if let Some(v) = req.get("hidden").and_then(Value::as_bool) {
                        r.hidden = v;
                    }
                    if let Some(v) = req.get("hiddenFrom") {
                        r.hidden_from = strings(v);
                    }
                    if let Some(v) = req.get("shareable").and_then(Value::as_bool) {
                        r.shareable = v;
                    }
                    match req.get("canMessage") {
                        Some(Value::Null) => r.can_message = None,
                        Some(v) if v.is_array() => r.can_message = Some(strings(v)),
                        _ => {}
                    }
                    if let Some(v) = req.get("title").and_then(Value::as_str) {
                        r.title = Some(truncate_chars(v.trim(), 120)).filter(|s| !s.is_empty());
                    }
                    if let Some(v) = req.get("description").and_then(Value::as_str) {
                        r.description = Some(truncate_chars(v.trim(), 1_000)).filter(|s| !s.is_empty());
                    }
                    if let Some(v) = req.get("tools") {
                        if v.is_array() {
                            r.tools = strings(v).into_iter().filter(|t| !t.starts_with("ui__") && !is_subagent_tool(t)).collect();
                        }
                    }
                });
                match rec {
                    Some(r) => {
                        self.persist();
                        Ok(json!({ "subagent": r }))
                    }
                    None => Err(format!("No sub-agent with id {}.", id)),
                }
            }
            "lineage" => {
                let id = req.get("id").and_then(Value::as_str).unwrap_or("");
                let mut chain = Vec::new();
                let mut cur = self.get(id);
                while let Some(r) = cur {
                    if chain.len() > 16 {
                        break;
                    }
                    let next = r.parent_id.as_deref().and_then(|p| self.get(p));
                    chain.push(json!({ "id": r.id, "name": r.name, "title": r.title, "depth": r.depth, "template": r.template }));
                    cur = next;
                }
                Ok(json!({ "lineage": chain, "root": self.get(id).map(|r| self.root_of(&r.session_key)) }))
            }
            _ => return None,
        })
    }
}

/// Callback for a parent consult: forwards only WebLLM requests (an on-device
/// model needs the app to run it); nothing else reaches the chat.
struct ConsultEvents {
    app: Option<Arc<dyn NativeEventCallback>>,
}

impl NativeEventCallback for ConsultEvents {
    fn on_event(&self, event_type: String, payload_json: String) {
        if event_type.starts_with("webllm") {
            if let Some(app) = &self.app {
                app.on_event(event_type, payload_json);
            }
        }
    }
}
