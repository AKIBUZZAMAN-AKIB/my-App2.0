//! Cross-session messaging: the agent (or the user) sends one message to
//! ANOTHER saved chat. That chat answers in its own context, from its own
//! saved history, and its reply is saved there like any other turn. The
//! caller gets back only the final reply text, never the target's history.
//!
//! - The `ask_session` tool always needs the user's approval (the platform
//!   approval card names the target chat and shows the message). Tool rules
//!   and "never" permissions apply as for any tool.
//! - Only the main agent (depth 0, foreground) gets the tools. The target's
//!   turn has no session or sub-agent tools, so asks can't chain or loop.
//! - One ask per target at a time; a chat that is answering can't ask.
//! - Its own token budget and time limit; the caller's Stop cancels it.

use super::*;

pub const TOOL_LIST_SESSIONS: &str = "list_sessions";
pub const TOOL_ASK_SESSION: &str = "ask_session";
pub const SESSION_TOOL_NAMES: &[&str] = &[TOOL_LIST_SESSIONS, TOOL_ASK_SESSION];

pub fn is_session_tool(name: &str) -> bool {
    SESSION_TOOL_NAMES.contains(&name)
}

/// One saved main chat the agent may ask.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatInfo {
    pub session_key: String,
    pub title: String,
    pub updated_at: i64,
    pub message_count: usize,
}

/// A finished ask, kept (without any history) for the app's audit list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRecord {
    pub id: String,
    pub caller_session_key: String,
    pub target_session_key: String,
    pub target_title: String,
    pub message: String,
    pub reply: String,
    pub status: String,
    pub tokens: u64,
    pub origin: String,
    pub started_at: i64,
    pub finished_at: i64,
}

struct InFlight<'a> {
    mgr: &'a SubagentManager,
    target: String,
}
impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.mgr.asks_in_flight.lock().unwrap().remove(&self.target);
    }
}

struct AskEvents {
    app: Option<Arc<dyn NativeEventCallback>>,
    ask_id: String,
    caller: String,
    target: String,
    title: String,
    tokens: Arc<std::sync::atomic::AtomicU64>,
    budget: u64,
    abort: Arc<Mutex<bool>>,
    reason: Arc<StdMutex<Option<String>>>,
}

impl AskEvents {
    fn send(&self, kind: &str, extra: Value) {
        let Some(app) = &self.app else { return };
        let mut p = json!({
            "askId": self.ask_id,
            "callerSessionKey": self.caller,
            "targetSessionKey": self.target,
            "targetTitle": self.title,
            "sessionKey": self.caller,
        });
        if let (Some(o), Some(m)) = (p.as_object_mut(), extra.as_object()) {
            for (k, v) in m {
                o.insert(k.clone(), v.clone());
            }
        }
        app.on_event(kind.into(), p.to_string());
    }
}

impl NativeEventCallback for AskEvents {
    fn on_event(&self, event_type: String, payload_json: String) {
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
        match event_type.as_str() {
            "context.usage" => {
                let n = payload.get("inputTokens").and_then(Value::as_u64).unwrap_or(0)
                    + payload.get("outputTokens").and_then(Value::as_u64).unwrap_or(0);
                let total = self.tokens.fetch_add(n, std::sync::atomic::Ordering::SeqCst) + n;
                self.send("session.step", json!({ "tokens": total, "budget": self.budget }));
                if total >= self.budget {
                    self.reason.lock().unwrap().get_or_insert_with(|| "budget_exceeded".into());
                    set_abort(&self.abort);
                }
            }
            "tool_use" => {
                self.send("session.step", json!({ "tool": payload.get("toolName") }));
            }
            "approval_request" | "mcp_tool_call" => {
                // Shown in the caller's chat, tagged with the chat that asks.
                let mut p = payload.clone();
                if let Some(o) = p.as_object_mut() {
                    o.insert("askedSession".into(), json!({ "sessionKey": self.target, "title": self.title, "askId": self.ask_id }));
                    o.insert("sessionKey".into(), json!(self.caller));
                }
                if let Some(app) = &self.app {
                    app.on_event(event_type, p.to_string());
                }
            }
            "max_turns_reached" => {
                self.reason.lock().unwrap().get_or_insert_with(|| "max_steps".into());
            }
            t if t.starts_with("webllm") => {
                if let Some(app) = &self.app {
                    app.on_event(event_type, payload_json);
                }
            }
            _ => {}
        }
    }
}

impl SubagentManager {
    pub fn session_titles(&self) -> HashMap<String, String> {
        self.titles.lock().unwrap().clone()
    }

    /// The app tells the engine the titles it shows (they live in the app).
    pub fn set_session_titles(&self, titles: &Value) -> usize {
        let Some(map) = titles.as_object() else { return 0 };
        let mut t = self.titles.lock().unwrap();
        for (k, v) in map {
            match v.as_str().map(str::trim) {
                Some(s) if !s.is_empty() => {
                    t.insert(truncate_chars(k, 200), truncate_chars(s, 80));
                }
                _ => {
                    t.remove(k);
                }
            }
        }
        while t.len() > 500 {
            let k = t.keys().next().cloned().unwrap();
            t.remove(&k);
        }
        fs_write_json(&self.state_dir.join("session_titles.json"), &*t);
        t.len()
    }

    /// Saved main chats, newest first, with titles. Never their contents.
    pub fn list_chats(&self, exclude: Option<&str>) -> Vec<ChatInfo> {
        let titles = self.session_titles();
        let mut chats = self.runner.list_chats();
        for c in chats.iter_mut() {
            if let Some(t) = titles.get(&c.session_key) {
                c.title = t.clone();
            }
            if c.title.trim().is_empty() {
                c.title = "Untitled chat".into();
            }
        }
        chats.retain(|c| Some(c.session_key.as_str()) != exclude && !c.session_key.starts_with("subagent:"));
        chats.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        chats.truncate(50);
        chats
    }

    pub fn ask_history(&self) -> Vec<AskRecord> {
        self.asks.lock().unwrap().clone()
    }

    fn keep_ask(&self, rec: AskRecord) {
        let mut a = self.asks.lock().unwrap();
        a.push(rec);
        let n = a.len();
        if n > 100 {
            a.drain(0..n - 100);
        }
        fs_write_json(&self.state_dir.join("session_asks.json"), &*a);
    }

    /// Send `message` to chat `target` and return only its reply.
    /// `origin` is "agent" (the ask_session tool) or "user" (from the app).
    pub async fn ask_session(
        self: &Arc<Self>,
        target: &str,
        message: &str,
        max_chars: Option<usize>,
        env: &ParentEnv,
        origin: &str,
    ) -> Result<(ChatInfo, String, u64), String> {
        let settings = self.settings();
        if !settings.sessions_enabled {
            return Err("Asking other chats is turned off in settings.".into());
        }
        let target = target.trim();
        let message = message.trim();
        if message.is_empty() {
            return Err("`message` is empty.".into());
        }
        if message.chars().count() > 8_000 {
            return Err("`message` is too long (max 8000 characters). Send a shorter question.".into());
        }
        if target == env.session_key {
            return Err("That is this chat. Pick another chat from list_sessions.".into());
        }
        let chat = self
            .list_chats(None)
            .into_iter()
            .find(|c| c.session_key == target)
            .ok_or_else(|| format!("No saved chat with key '{}'. Call list_sessions to see the chats you can ask.", target))?;
        // Loop / re-entry protection.
        {
            let mut busy = self.asks_in_flight.lock().unwrap();
            if busy.contains_key(target) {
                return Err(format!("Chat \"{}\" is already answering another question. Try again when it is done.", chat.title));
            }
            if busy.contains_key(&env.session_key) {
                return Err("This chat is answering another chat right now, so it can't ask a third one.".into());
            }
            if busy.len() >= 3 {
                return Err("Three chats are already being asked. Wait for one to answer.".into());
            }
            busy.insert(target.to_string(), env.session_key.clone());
        }
        let _in_flight = InFlight { mgr: self, target: target.to_string() };

        let ask_id = format!("ask_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        let caller_title = self.session_titles().get(&env.session_key).cloned().unwrap_or_else(|| "another chat".into());
        let started_at = now_ms();
        let max_chars = max_chars.unwrap_or(settings.session_reply_max_chars as usize).clamp(200, settings.session_reply_max_chars.max(200) as usize);
        // The note the target chat sees (and keeps in its history).
        let prompt = format!(
            "[Message from your other chat \"{}\" (sent by the {} with the user's permission). Answer it from this chat's own context. Only your final reply goes back to that chat.]\n\n{}",
            caller_title,
            if origin == "user" { "user" } else { "assistant" },
            message
        );
        let abort = Arc::new(Mutex::new(false));
        let reason: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let tokens = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let events = Arc::new(AskEvents {
            app: env.callback.clone(),
            ask_id: ask_id.clone(),
            caller: env.session_key.clone(),
            target: target.to_string(),
            title: chat.title.clone(),
            tokens: tokens.clone(),
            budget: settings.session_token_budget,
            abort: abort.clone(),
            reason: reason.clone(),
        });
        events.send("session.asked", json!({ "message": truncate_chars(message, 2_000), "origin": origin, "callerTitle": caller_title }));

        // The target's tools: what the caller may use, minus sub-agent,
        // session and ui__ tools (no chains, no UI in a chat nobody sees).
        let tools: Vec<String> = env
            .tool_names
            .iter()
            .filter(|t| !t.starts_with("ui__") && !is_subagent_tool(t) && !is_session_tool(t))
            .cloned()
            .collect();
        let tools_json = serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into());
        let prior = self.runner.load_messages(target);
        let prior_len = prior.len();
        let params = SendMessageParams {
            prompt: prompt.clone(),
            session_key: target.to_string(),
            model: env.model.clone(),
            provider: env.provider.clone(),
            system_prompt: env.system_prompt.clone(),
            max_turns: Some(10),
            allowed_tools_json: Some(tools_json.clone()),
            prior_messages_json: None,
            attachments_json: None,
        };
        let timeout_ms = settings.session_timeout_seconds * 1000;
        let (_steer_tx, steer_rx) = mpsc::unbounded_channel();
        let req = RunRequest {
            id: ask_id.clone(),
            params,
            prior_messages: prior,
            callback: events.clone(),
            abort: abort.clone(),
            steer_rx: Arc::new(Mutex::new(Some(steer_rx))),
            // The target uses the main memory, like any chat.
            memory: env.memory.clone(),
            timeout_ms,
            // Depth past every limit: no sub-agent or session tools.
            child: SubagentCtx { manager: self.clone(), depth: u32::MAX / 2 },
        };
        let caller_abort = env.abort.clone();
        let watch_abort = abort.clone();
        let (done_tx, mut done_rx) = watch::channel(false);
        tokio::spawn(async move {
            let Some(parent) = caller_abort else { return };
            loop {
                if *parent.lock().await {
                    set_abort(&watch_abort);
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                    _ = done_rx.changed() => return,
                }
            }
        });
        let outcome = tokio::time::timeout(Duration::from_millis(timeout_ms + 5_000), self.runner.run(req)).await;
        let _ = done_tx.send(true);
        let used = tokens.load(std::sync::atomic::Ordering::SeqCst);
        let stop = reason.lock().unwrap().clone();
        let result = match outcome {
            Ok(Ok(done)) => {
                // Saved in the target chat like any turn (its own history).
                self.runner.save_chat(target, &done, started_at);
                let new = if done.messages.len() > prior_len { &done.messages[prior_len..] } else { &done.messages[..] };
                let reply = last_assistant_text(new).unwrap_or_default();
                if reply.trim().is_empty() {
                    Err(format!("Chat \"{}\" finished without a text reply.", chat.title))
                } else {
                    let mut r = truncate_chars(reply.trim(), max_chars);
                    if let Some(s) = stop.as_deref() {
                        r.push_str(&format!("\n\n(It stopped early: {}.)", s.replace('_', " ")));
                    }
                    Ok(r)
                }
            }
            Ok(Err(NativeAgentError::Cancelled)) => Err(match stop.as_deref() {
                Some("budget_exceeded") => format!("Chat \"{}\" used up its token budget ({}) before it answered.", chat.title, settings.session_token_budget),
                _ => format!("The question to chat \"{}\" was cancelled.", chat.title),
            }),
            Ok(Err(e)) => Err(format!("Chat \"{}\" couldn't answer: {}", chat.title, e)),
            Err(_) => Err(format!("Chat \"{}\" didn't answer within {} seconds.", chat.title, settings.session_timeout_seconds)),
        };
        let (status, reply) = match &result {
            Ok(r) => ("answered", r.clone()),
            Err(e) => (if e.contains("cancelled") { "cancelled" } else { "error" }, e.clone()),
        };
        events.send(
            "session.answered",
            json!({ "status": status, "reply": truncate_chars(&reply, max_chars), "tokens": used, "origin": origin }),
        );
        self.keep_ask(AskRecord {
            id: ask_id,
            caller_session_key: env.session_key.clone(),
            target_session_key: target.to_string(),
            target_title: chat.title.clone(),
            message: truncate_chars(message, 2_000),
            reply: truncate_chars(&reply, 2_000),
            status: status.into(),
            tokens: used,
            origin: origin.into(),
            started_at,
            finished_at: now_ms(),
        });
        result.map(|r| (chat, r, used))
    }

    /// The user sends a message to another chat from the app (no approval:
    /// the user is the one asking). Cancel with `cancelAsk`.
    pub async fn user_ask(self: &Arc<Self>, req: &Value, mut env: ParentEnv) -> Result<Value, String> {
        let target = req.get("targetSessionKey").and_then(Value::as_str).unwrap_or("").to_string();
        let message = req.get("message").and_then(Value::as_str).unwrap_or("");
        let max_chars = req.get("maxChars").and_then(Value::as_u64).map(|n| n as usize);
        let flag = Arc::new(Mutex::new(false));
        env.abort = Some(flag.clone());
        self.user_ask_aborts.lock().unwrap().insert(target.clone(), flag);
        let out = self.ask_session(&target, message, max_chars, &env, "user").await;
        self.user_ask_aborts.lock().unwrap().remove(&target);
        let (chat, reply, tokens) = out?;
        Ok(json!({ "reply": reply, "tokens": tokens, "chat": chat }))
    }

    pub async fn handle_session_tool(self: &Arc<Self>, name: &str, input: &Value, env: ParentEnv) -> (String, bool) {
        match name {
            TOOL_LIST_SESSIONS => {
                let chats = self.list_chats(Some(&env.session_key));
                if chats.is_empty() {
                    return ("There are no other saved chats.".into(), false);
                }
                let items: Vec<Value> = chats
                    .iter()
                    .map(|c| json!({ "session_key": c.session_key, "title": c.title, "updated_at": c.updated_at, "messages": c.message_count }))
                    .collect();
                (serde_json::to_string_pretty(&json!({ "chats": items })).unwrap_or_default(), false)
            }
            TOOL_ASK_SESSION => {
                let target = input.get("session_key").or_else(|| input.get("sessionKey")).and_then(Value::as_str).unwrap_or("");
                let message = input.get("message").and_then(Value::as_str).unwrap_or("");
                let max_chars = input.get("max_chars").and_then(Value::as_u64).map(|n| n as usize);
                match self.ask_session(target, message, max_chars, &env, "agent").await {
                    Ok((chat, reply, _)) => (format!("Reply from chat \"{}\":\n\n{}", chat.title, reply), false),
                    Err(e) => (e, true),
                }
            }
            _ => (format!("Unknown session tool '{}'.", name), true),
        }
    }

    pub fn session_tool_definitions() -> Vec<ToolDefinition> {
        vec![
            ToolDefinition {
                name: TOOL_LIST_SESSIONS.into(),
                description: "List the user's other saved chats (title, key, last update). Use it to find the chat to ask with ask_session. It never shows what the chats contain.".into(),
                input_schema: json!({ "type": "object", "properties": {} }),
                approval_policy: None,
                webview_only: false,
            },
            ToolDefinition {
                name: TOOL_ASK_SESSION.into(),
                description: "Send one message to ANOTHER of the user's chats and get back only its reply. That chat answers from its own conversation and memory; you never see its history, only the reply. Use it when an earlier chat holds context you need (a plan, a decision, code it wrote). Always needs the user's approval. Ask one specific question.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "session_key": {"type": "string", "description": "The chat's key from list_sessions."},
                        "message": {"type": "string", "description": "The question or request for that chat. Be specific; it only sees this message."},
                        "max_chars": {"type": "integer", "description": "Longest reply to return (200 to the limit in settings)."}
                    },
                    "required": ["session_key", "message"]
                }),
                approval_policy: None,
                webview_only: false,
            },
        ]
    }

    pub fn session_prompt_section() -> &'static str {
        "\n\n## Other chats\nThe user has other saved chats with their own history. If one of them holds context you need, call list_sessions, then ask_session with one specific question. The user approves each message, and you only get that chat's reply back, not its history. Don't ask a chat for things you can do yourself."
    }
}
