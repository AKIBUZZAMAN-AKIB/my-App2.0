//! Advanced spawning and control (feature "subagentAdvanced").
//!
//! - Batches: `spawn_subagent` with `tasks` starts several agents at once,
//!   as a `parallel` fan-out, a `pipeline` (each step waits for the one
//!   before it and gets its report) or a `race` (first to finish wins, the
//!   rest are stopped).
//! - Dependencies: `after` makes an agent wait in the queue until the agents
//!   it names have ended; their reports are added to its brief, and it is
//!   cancelled when one of them did not finish.
//! - Fork context: `context: "fork"` gives the child the recent transcript of
//!   the parent's conversation (or, from the app, of any chat up to a given
//!   message), not only the brief.
//! - Handoff: the child's report is the parent's reply, word for word.
//! - App controls: `spawnBatch`, `moveToChat`, `bulk`, `groups`.

use super::*;

/// Put in front of a handed-off report so the parent passes it on as is.
pub(super) const HANDOFF_LEAD: &str = "HANDOFF: you handed this request to the sub-agent below. Its report is your reply to the user: send it word for word as your final answer, add nothing, and call no more tools this turn.\n\n";

/// Most agents one batch may start.
pub(super) const MAX_BATCH: usize = 12;
/// Fork context: messages copied by default, and the most allowed.
const FORK_DEFAULT_MESSAGES: u32 = 20;
const FORK_MAX_MESSAGES: u32 = 100;
/// Fork context: characters kept per message and in total.
const FORK_MESSAGE_CHARS: usize = 2_000;
const FORK_TOTAL_CHARS: usize = 24_000;
/// Dependency reports: characters kept per report.
const DEP_REPORT_CHARS: usize = 6_000;

fn batch_modes() -> [&'static str; 3] {
    ["parallel", "pipeline", "race"]
}

impl SubagentManager {
    /// True while an agent `id` depends on is still running or queued.
    pub(super) fn blocked_in(recs: &[SubagentRecord], id: &str) -> bool {
        let Some(r) = recs.iter().find(|r| r.id == id) else { return false };
        r.depends_on.iter().any(|d| recs.iter().any(|x| &x.id == d && x.is_active()))
    }

    /// Ids for the `after` references (ids or names) of a new agent. Only
    /// agents of the same chat can be waited for; a name picks the newest.
    pub(super) fn resolve_deps(&self, refs: &[String], env: &ParentEnv) -> Result<Vec<String>, String> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let root = self.root_of(&env.session_key);
        let recs = self.list(); // newest first
        let mut out: Vec<String> = Vec::new();
        for raw in refs {
            let key = raw.trim();
            if key.is_empty() {
                continue;
            }
            let wanted = sanitize_name(key);
            let found = recs
                .iter()
                .filter(|r| r.root_session_key == root || r.parent_session_key == env.session_key)
                .find(|r| r.id == key || r.name == key || r.name == wanted)
                .ok_or_else(|| format!("`after`: no sub-agent of this chat is called or has id \"{}\".", key))?;
            if !out.contains(&found.id) {
                out.push(found.id.clone());
            }
        }
        if out.len() > MAX_BATCH {
            return Err(format!("`after` may name at most {} agents.", MAX_BATCH));
        }
        Ok(out)
    }

    /// The fork context block for a new agent: `(source session, text)`, or
    /// None for a fresh context.
    pub(super) fn fork_context(&self, spec: &SpawnSpec, env: &ParentEnv) -> Result<Option<(String, String)>, String> {
        let mode = spec.context.as_deref().map(|c| c.trim().to_ascii_lowercase()).unwrap_or_default();
        let fork = match mode.as_str() {
            "" => spec.fork_session.is_some() || spec.fork_upto.is_some() || spec.fork_user_turns.is_some(),
            "fresh" => false,
            "fork" => true,
            other => return Err(format!("`context` must be \"fresh\" or \"fork\", not \"{}\".", other)),
        };
        if !fork {
            return Ok(None);
        }
        let source = spec.fork_session.clone().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| env.session_key.clone());
        let mut messages = self.runner.load_messages(&source);
        if let Some(upto) = spec.fork_upto {
            messages.truncate(upto as usize);
        }
        if let Some(n) = spec.fork_user_turns {
            // Cut before the (n+1)-th user message that carries text.
            let mut seen = 0u32;
            let cut = messages.iter().position(|m| {
                if m.role == Role::User && !m.text().trim().is_empty() {
                    seen += 1;
                    return seen > n;
                }
                false
            });
            if let Some(c) = cut {
                messages.truncate(c);
            }
        }
        let keep = spec.context_messages.unwrap_or(FORK_DEFAULT_MESSAGES).clamp(1, FORK_MAX_MESSAGES) as usize;
        let turns: Vec<(String, String)> = messages
            .iter()
            .filter_map(|m| {
                let who = match m.role {
                    Role::User => "User",
                    Role::Assistant => "Assistant",
                    _ => return None,
                };
                let text = m.text();
                let text = text.trim();
                if text.is_empty() {
                    return None;
                }
                Some((who.to_string(), truncate_chars(text, FORK_MESSAGE_CHARS)))
            })
            .collect();
        let start = turns.len().saturating_sub(keep);
        let mut body = String::new();
        // Newest first into the budget, then put back in order.
        let mut picked: Vec<String> = Vec::new();
        let mut used = 0usize;
        for (who, text) in turns[start..].iter().rev() {
            let line = format!("{}: {}\n\n", who, text);
            if used + line.len() > FORK_TOTAL_CHARS {
                break;
            }
            used += line.len();
            picked.push(line);
        }
        picked.reverse();
        for l in picked.iter() {
            body.push_str(l);
        }
        let n = picked.len();
        let block = if n == 0 {
            "\n\n## Context: the conversation you were forked from\n(It has no messages yet.)".to_string()
        } else {
            format!(
                "\n\n## Context: the conversation you were forked from\nThe last {} message{} of it, oldest first. It is background: your task is the brief above.\n\n{}",
                n,
                if n == 1 { "" } else { "s" },
                body.trim_end()
            )
        };
        Ok(Some((source, block)))
    }

    /// Save the dependency and context facts on a new record.
    pub(super) fn apply_advanced(&self, id: &str, deps: &[String], fork: Option<&(String, String)>) -> Option<SubagentRecord> {
        let rec = self.update(id, |r| {
            r.depends_on = deps.to_vec();
            r.context_mode = Some(if fork.is_some() { "fork" } else { "fresh" }.to_string());
            r.context_source = fork.map(|f| f.0.clone());
        })?;
        self.persist();
        Some(rec)
    }

    /// Why a queued agent must not start: an agent it waited for ended
    /// without finishing (or was deleted).
    pub(super) fn failed_dependency(&self, id: &str) -> Option<String> {
        let rec = self.get(id)?;
        for d in &rec.depends_on {
            match self.get(d) {
                None => return Some(format!("Cancelled: the agent it waited for ({}) was deleted.", d)),
                Some(dep) if dep.status != "finished" => {
                    return Some(format!(
                        "Cancelled: \"{}\", which it waited for, ended as {}.",
                        dep.name,
                        dep.status.replace('_', " ")
                    ))
                }
                _ => {}
            }
        }
        None
    }

    /// The reports of the agents `id` waited for, added to its brief.
    pub(super) fn dependency_reports(&self, id: &str) -> String {
        let Some(rec) = self.get(id) else { return String::new() };
        if rec.depends_on.is_empty() {
            return String::new();
        }
        let mut out = String::from("\n\n## Results from the agents you waited for");
        for d in &rec.depends_on {
            if let Some(dep) = self.get(d) {
                let report = dep.result.clone().unwrap_or_default();
                let report = if report.trim().is_empty() { "(no report)".to_string() } else { truncate_chars(report.trim(), DEP_REPORT_CHARS) };
                out.push_str(&format!("\n\n### {} ({})\n{}", dep.title.clone().unwrap_or(dep.name.clone()), dep.id, report));
            }
        }
        out
    }

    /// Start a batch: one agent per item of `tasks`. Fields outside `tasks`
    /// apply to every item; a top-level `task` is the shared goal above each
    /// item's own part. Returns (group id, mode, records in order).
    pub(super) fn spawn_batch(self: &Arc<Self>, parent_depth: u32, input: &Value, env: &ParentEnv) -> Result<(String, String, Vec<SubagentRecord>), String> {
        let items = input.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
        if items.is_empty() {
            return Err("`tasks` is empty: give one brief per sub-agent.".into());
        }
        if items.len() > MAX_BATCH {
            return Err(format!("`tasks` may hold at most {} briefs (got {}).", MAX_BATCH, items.len()));
        }
        let mode = input.get("mode").and_then(Value::as_str).map(|m| m.trim().to_ascii_lowercase()).unwrap_or_else(|| "parallel".into());
        if !batch_modes().contains(&mode.as_str()) {
            return Err(format!("`mode` must be parallel, pipeline or race, not \"{}\".", mode));
        }
        let settings = self.settings();
        let room = settings.max_queue as usize + settings.max_parallel as usize;
        if items.len() > room {
            return Err(format!("{} briefs won't fit: {} can run and {} can wait in the queue.", items.len(), settings.max_parallel, settings.max_queue));
        }
        let shared = input.get("task").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        let base_name = input.get("name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let group_id = format!("grp_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let mut base = input.clone();
        if let Some(o) = base.as_object_mut() {
            for k in ["tasks", "mode", "task", "name", "reuse", "handoff", "_toolCallId", "spawnToolCallId"] {
                o.remove(k);
            }
        }
        let mut started: Vec<SubagentRecord> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let mut merged = base.clone();
            let own = match item {
                Value::String(t) => {
                    merged["task"] = json!(t);
                    t.trim().to_string()
                }
                Value::Object(o) => {
                    for (k, v) in o {
                        merged[k] = v.clone();
                    }
                    o.get("task").and_then(Value::as_str).unwrap_or("").trim().to_string()
                }
                _ => String::new(),
            };
            if own.is_empty() {
                self.abandon(&started);
                return Err(format!("`tasks[{}]` has no brief.", i));
            }
            let task = if shared.is_empty() { own.clone() } else { format!("{}\n\n## Your part\n{}", shared, own) };
            merged["task"] = json!(task);
            if merged.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("").is_empty() {
                let stem = base_name.clone().unwrap_or_else(|| if mode == "pipeline" { "step".into() } else { "worker".into() });
                merged["name"] = json!(format!("{}-{}", stem, i + 1));
            }
            let mut spec: SpawnSpec = match serde_json::from_value(merged) {
                Ok(s) => s,
                Err(e) => {
                    self.abandon(&started);
                    return Err(format!("`tasks[{}]`: {}", i, e));
                }
            };
            spec.wait = Some(false);
            spec.reuse = None;
            spec.group = Some((group_id.clone(), mode.clone(), i as u32));
            if mode == "pipeline" {
                if let Some(prev) = started.last() {
                    let mut after = spec.after.take().unwrap_or_default();
                    after.push(prev.id.clone());
                    spec.after = Some(after);
                }
            }
            match self.spawn(parent_depth, spec, env) {
                Ok(r) => started.push(r),
                Err(e) => {
                    self.abandon(&started);
                    return Err(format!("`tasks[{}]`: {}", i, e));
                }
            }
        }
        for r in &started {
            self.append_log(&r.id, "subagent.grouped", r, &json!({ "groupId": group_id, "mode": mode, "size": started.len() }));
        }
        let recs = started.iter().map(|r| self.get(&r.id).unwrap_or_else(|| r.clone())).collect();
        Ok((group_id, mode, recs))
    }

    /// A batch that could not start in full: stop and forget what it started.
    fn abandon(self: &Arc<Self>, started: &[SubagentRecord]) {
        for r in started.iter().rev() {
            self.stop(&r.id, "cancelled");
        }
    }

    /// Wait for the first race member to finish; mark it the winner and stop
    /// the rest. None when none finished (all failed, timed out, cancelled).
    pub(super) async fn race_watch(self: Arc<Self>, ids: Vec<String>, abort: Option<Arc<Mutex<bool>>>, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            let recs: Vec<SubagentRecord> = ids.iter().filter_map(|i| self.get(i)).collect();
            if let Some(w) = recs.iter().find(|r| r.status == "finished") {
                let wid = w.id.clone();
                let won = self.update(&wid, |r| r.group_winner = true).unwrap_or_else(|| w.clone());
                self.persist();
                for r in &recs {
                    if r.id != wid && r.is_active() && self.stop(&r.id, "cancelled") {
                        self.append_log(&r.id, "subagent.race_lost", r, &json!({ "winner": wid }));
                    }
                }
                self.append_log(&wid, "subagent.race_won", &won, &json!({ "groupId": won.group_id }));
                return Some(wid);
            }
            if recs.iter().all(|r| !r.is_active()) || is_aborted(&abort) || Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn batch_timeout(&self, recs: &[SubagentRecord], sequential: bool) -> Duration {
        let each: Vec<u64> = recs.iter().map(|r| r.timeout_seconds).collect();
        let secs = if sequential { each.iter().sum::<u64>() } else { each.iter().copied().max().unwrap_or(60) * 2 };
        Duration::from_secs(secs + 30)
    }

    /// `spawn_subagent` with `tasks`.
    pub(super) async fn batch_tool(self: &Arc<Self>, parent_depth: u32, input: &Value, env: ParentEnv) -> (String, bool) {
        let wait = input.get("wait").and_then(Value::as_bool).unwrap_or(true);
        let (group, mode, recs) = match self.spawn_batch(parent_depth, input, &env) {
            Ok(x) => x,
            Err(e) => return (e, true),
        };
        let ids: Vec<String> = recs.iter().map(|r| r.id.clone()).collect();
        let roster = recs.iter().map(|r| format!("\"{}\" ({})", r.name, r.id)).collect::<Vec<_>>().join(", ");
        let lead = format!("Started {} sub-agents as a {} batch (group {}): {}.\n", recs.len(), mode, group, roster);
        if mode == "race" {
            let timeout = self.batch_timeout(&recs, false);
            if !wait {
                let me = self.clone();
                let abort = None;
                tokio::spawn(async move { me.race_watch(ids, abort, timeout).await });
                return (format!("{}They race in the background: the first to finish is kept and the others are stopped. Collect the result with list_subagents(wait=true).", lead), false);
            }
            return match self.clone().race_watch(ids.clone(), env.abort.clone(), timeout).await {
                Some(w) => {
                    let (out, err) = self.wait_and_report(std::slice::from_ref(&w), &env, None).await;
                    (format!("{}Winner (finished first; the others were stopped):\n{}", lead, out), err)
                }
                None if is_aborted(&env.abort) => {
                    for id in &ids {
                        self.stop(id, "cancelled");
                    }
                    ("Cancelled by the user; the race was stopped.".into(), true)
                }
                None => {
                    let (out, _) = self.wait_and_report(&ids, &env, Some(1)).await;
                    (format!("{}No agent in the race finished.\n{}", lead, out), true)
                }
            };
        }
        if !wait {
            return (format!("{}They run in the background. Collect their reports with list_subagents(wait=true), or use message_subagent / stop_subagent with these ids.", lead), false);
        }
        if mode == "pipeline" {
            // One step after another: wait for each in turn, then report all.
            for r in &recs {
                let t = Duration::from_secs(r.timeout_seconds + 30);
                if self.wait_for(std::slice::from_ref(&r.id), env.abort.clone(), t).await == WaitEnd::ParentCancelled {
                    for id in &ids {
                        self.stop(id, "cancelled");
                    }
                    return ("Cancelled by the user; the pipeline was stopped.".into(), true);
                }
            }
        }
        let (out, err) = self.wait_and_report(&ids, &env, None).await;
        (format!("{}{}", lead, out), err)
    }

    /// Batches of a chat (all chats when `session_key` is None).
    pub fn groups(&self, session_key: Option<&str>) -> Vec<Value> {
        let mut recs: Vec<SubagentRecord> = self
            .list()
            .into_iter()
            .filter(|r| r.group_id.is_some())
            .filter(|r| session_key.is_none_or(|k| r.root_session_key == k || r.parent_session_key == k))
            .collect();
        recs.sort_by_key(|r| (r.created_at, r.group_index.unwrap_or(0)));
        let mut order: Vec<String> = Vec::new();
        let mut by: HashMap<String, Vec<SubagentRecord>> = HashMap::new();
        for r in recs {
            let g = r.group_id.clone().unwrap_or_default();
            if !order.contains(&g) {
                order.push(g.clone());
            }
            by.entry(g).or_default().push(r);
        }
        order
            .into_iter()
            .map(|g| {
                let mut members = by.remove(&g).unwrap_or_default();
                members.sort_by_key(|r| r.group_index.unwrap_or(0));
                let count = |s: &str| members.iter().filter(|r| r.status == s).count();
                let active = members.iter().filter(|r| r.is_active()).count();
                json!({
                    "groupId": g,
                    "mode": members.first().and_then(|r| r.group_mode.clone()),
                    "size": members.len(),
                    "active": active,
                    "finished": count("finished"),
                    "winner": members.iter().find(|r| r.group_winner).map(|r| r.id.clone()),
                    "members": members.iter().map(|r| json!({
                        "id": r.id, "name": r.name, "title": r.title, "status": r.status,
                        "index": r.group_index, "winner": r.group_winner, "dependsOn": r.depends_on,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect()
    }

    /// Move an idle top-level agent (with everything below it) to another
    /// chat, so it is listed, reused and messaged from there.
    pub fn move_to_chat(&self, id: &str, target: &str) -> Result<SubagentRecord, String> {
        let rec = self.get(id).ok_or_else(|| format!("No sub-agent with id {}.", id))?;
        let target = target.trim();
        if target.is_empty() {
            return Err("Say which chat to move it to.".into());
        }
        if target.starts_with("subagent:") || self.record_by_session(target).is_some() {
            return Err("That is a sub-agent's session, not a chat. To put it under another agent, use reparent.".into());
        }
        if rec.parent_id.is_some() {
            return Err("Only an agent started by a chat's main agent can move to another chat; move the top agent of its tree.".into());
        }
        if rec.root_session_key == target {
            return Err("It already belongs to that chat.".into());
        }
        let tree = self.subtree_ids(id);
        if tree.iter().any(|i| self.get(i).is_some_and(|r| r.is_active())) {
            return Err("It or an agent below it is still running. Stop them first.".into());
        }
        let from = rec.root_session_key.clone();
        {
            let mut recs = self.records.lock().unwrap();
            for r in recs.iter_mut().filter(|r| tree.contains(&r.id)) {
                r.root_session_key = target.to_string();
                if r.id == id {
                    r.parent_session_key = target.to_string();
                }
            }
        }
        self.persist();
        let moved = self.get(id).ok_or("Sub-agent disappeared.")?;
        self.append_log(id, "subagent.moved", &moved, &json!({ "from": from, "to": target, "agents": tree.len() }));
        Ok(moved)
    }

    /// One control on many agents: stop, stopTree, pause, resume, retry, delete.
    /// `ids`, or every agent of `sessionKey` that the op applies to.
    pub fn bulk(self: &Arc<Self>, op: &str, ids: Option<Vec<String>>, session_key: Option<&str>, env: &ParentEnv) -> Result<Value, String> {
        let applies = |r: &SubagentRecord| match op {
            "stop" | "stopTree" => r.is_active(),
            "pause" => r.is_active() && !r.paused,
            "resume" => r.paused || r.status == "paused",
            "retry" | "delete" => !r.is_active(),
            _ => false,
        };
        if !["stop", "stopTree", "pause", "resume", "retry", "delete"].contains(&op) {
            return Err(format!("Unknown bulk op \"{}\" (stop, stopTree, pause, resume, retry or delete).", op));
        }
        let targets: Vec<String> = match ids {
            Some(ids) => ids,
            None => {
                let key = session_key.ok_or("Give `ids` or `sessionKey`.")?;
                self.list().into_iter().filter(|r| (r.root_session_key == key || r.parent_session_key == key) && applies(r)).map(|r| r.id).collect()
            }
        };
        if targets.len() > 200 {
            return Err("At most 200 agents at once.".into());
        }
        let mut results = Vec::new();
        let mut ok = 0;
        for id in &targets {
            let Some(r) = self.get(id) else {
                results.push(json!({ "id": id, "ok": false, "error": format!("No sub-agent with id {}.", id) }));
                continue;
            };
            let out: Result<(), String> = if !applies(&r) {
                Err(format!("Not {} now (status {}).", op, r.status))
            } else {
                match op {
                    "stop" => {
                        if self.stop(id, "cancelled") { Ok(()) } else { Err("Nothing to stop.".into()) }
                    }
                    "stopTree" => {
                        self.stop_tree(id);
                        Ok(())
                    }
                    "pause" => self.pause(id).map(|_| ()),
                    "resume" => self.resume(id, env).map(|_| ()),
                    "retry" => self.retry(id, env).map(|_| ()),
                    "delete" => self.delete(id),
                    _ => unreachable!(),
                }
            };
            match out {
                Ok(()) => {
                    ok += 1;
                    results.push(json!({ "id": id, "ok": true }));
                }
                Err(e) => results.push(json!({ "id": id, "ok": false, "error": e })),
            }
        }
        Ok(json!({ "op": op, "ok": ok, "total": targets.len(), "results": results }))
    }

    pub(super) fn advanced_app_request(self: &Arc<Self>, action: &str, req: &Value, env: &ParentEnv) -> Option<Result<Value, String>> {
        let s = |k: &str| req.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
        Some(match action {
            "spawnBatch" => self.spawn_batch(0, req, env).map(|(group, mode, recs)| {
                if mode == "race" {
                    let ids: Vec<String> = recs.iter().map(|r| r.id.clone()).collect();
                    let timeout = self.batch_timeout(&recs, false);
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        let me = self.clone();
                        handle.spawn(async move { me.race_watch(ids, None, timeout).await });
                    }
                }
                json!({ "groupId": group, "mode": mode, "subagents": recs })
            }),
            "groups" => Ok(json!({ "groups": self.groups(s("sessionKey")) })),
            "moveToChat" => {
                let id = s("id").unwrap_or("");
                let target = s("targetSessionKey").or_else(|| s("to")).unwrap_or("");
                self.move_to_chat(id, target).map(|r| json!({ "subagent": r }))
            }
            "bulk" => {
                let ids: Option<Vec<String>> = req.get("ids").and_then(|v| serde_json::from_value(v.clone()).ok());
                self.bulk(s("op").unwrap_or(""), ids, s("sessionKey"), env)
            }
            _ => return None,
        })
    }
}
