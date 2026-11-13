//! Per-sub-agent data: tracked files, an activity log, separate deletion of
//! each kind of data, and finding a past sub-agent to reuse.

use super::*;

/// A file a sub-agent wrote. `created` = the file did not exist before the
/// sub-agent's first write, so deleting it cannot destroy the user's work.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackedFile {
    pub path: String,
    pub created: bool,
    pub at: i64,
}

/// The kinds of data that can be deleted separately.
pub const DATA_PARTS: [&str; 4] = ["chat", "memory", "files", "logs"];
const LOG_CAP_BYTES: u64 = 256 * 1024;
const WRITE_TOOLS: [&str; 2] = ["write_file", "edit_file"];

/// Normalise the parts the user picked. `all` / `everything` means every
/// part plus the record itself.
pub fn parse_parts(raw: &Value) -> Result<(Vec<&'static str>, bool), String> {
    let list: Vec<String> = match raw {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    };
    if list.is_empty() {
        return Err("Choose what to delete: chat, memory, files, logs or all.".into());
    }
    let mut out: Vec<&'static str> = Vec::new();
    let mut everything = false;
    for p in list {
        let part = match p.trim().to_ascii_lowercase().as_str() {
            "all" | "everything" => {
                everything = true;
                continue;
            }
            "chat" | "transcript" | "session" | "history" => "chat",
            "memory" | "memories" => "memory",
            "files" | "artifacts" | "file" => "files",
            "logs" | "log" | "audit" | "queue" | "activity" => "logs",
            other => return Err(format!("Unknown data part {}. Use chat, memory, files, logs or all.", other)),
        };
        if !out.contains(&part) {
            out.push(part);
        }
    }
    if everything {
        out = DATA_PARTS.to_vec();
    }
    Ok((out, everything))
}

impl SubagentManager {
    /// Where the agent's file tools work; needed to delete tracked files.
    pub fn set_workspace(&self, path: &str) {
        *self.workspace.lock().unwrap() = Some(path.to_string());
    }

    /// Called on a sub-agent's `tool_use` event, before the tool runs.
    pub(crate) fn track_tool_use(&self, id: &str, tool: &str, args: &Value) {
        if !WRITE_TOOLS.contains(&tool) {
            return;
        }
        let Some(rel) = args.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()) else {
            return;
        };
        let ws = self.workspace.lock().unwrap().clone();
        let existed = match ws.as_deref().map(|w| crate::tool_runner::resolve_path(w, rel)) {
            Some(Ok(p)) => p.exists(),
            // Outside the workspace or unknown: never mark it ours.
            _ => true,
        };
        let rel = rel.to_string();
        let changed = self
            .update(id, |r| {
                if !r.files.iter().any(|f| f.path == rel) && r.files.len() < 500 {
                    r.files.push(TrackedFile { path: rel.clone(), created: !existed, at: now_ms() });
                }
            })
            .is_some();
        if changed {
            self.persist();
        }
    }

    fn log_path(&self, id: &str) -> PathBuf {
        self.state_dir.join("logs").join(format!("{}.jsonl", sanitize_name(id)))
    }

    /// One line per sub-agent event (queue, start, steps, tools, finish).
    pub(crate) fn append_log(&self, id: &str, event: &str, rec: &SubagentRecord, extra: &Value) {
        use std::io::Write;
        let path = self.log_path(id);
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&self.state_dir));
        if std::fs::metadata(&path).map(|m| m.len() > LOG_CAP_BYTES).unwrap_or(false) {
            // Keep the newer half.
            if let Ok(text) = std::fs::read_to_string(&path) {
                let lines: Vec<&str> = text.lines().collect();
                let keep = lines[lines.len() / 2..].join("\n");
                let _ = std::fs::write(&path, keep + "\n");
            }
        }
        let mut line = json!({
            "at": now_ms(),
            "event": event,
            "status": rec.status,
            "steps": rec.steps,
            "tokens": rec.total_tokens(),
        });
        for k in ["tool", "queuePosition", "whileQueued", "run"] {
            if let Some(v) = extra.get(k) {
                line[k] = v.clone();
            }
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", line);
        }
    }

    pub fn read_log(&self, id: &str, limit: usize) -> Vec<Value> {
        let text = std::fs::read_to_string(self.log_path(id)).unwrap_or_default();
        let all: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        let skip = all.len().saturating_sub(limit);
        all.into_iter().skip(skip).collect()
    }

    pub(crate) fn remove_log(&self, id: &str) {
        let _ = std::fs::remove_file(self.log_path(id));
    }

    /// Which records a delete request targets.
    fn delete_targets(&self, req: &Value) -> Result<Vec<String>, String> {
        let mut ids: Vec<String> = Vec::new();
        if let Some(id) = req.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            ids.push(id.to_string());
        }
        if let Some(arr) = req.get("ids").and_then(Value::as_array) {
            ids.extend(arr.iter().filter_map(|v| v.as_str().map(str::to_string)));
        }
        if let Some(scope) = req.get("scope").and_then(Value::as_str) {
            let chat = req.get("parentSessionKey").and_then(Value::as_str);
            let recs = self.list();
            let picked = recs.into_iter().filter(|r| chat.map_or(true, |c| r.parent_session_key == c));
            match scope {
                "finished" => ids.extend(picked.filter(|r| !r.is_active()).map(|r| r.id)),
                "all" => ids.extend(picked.map(|r| r.id)),
                "selected" => {}
                other => return Err(format!("Unknown scope {}. Use selected, finished or all.", other)),
            }
        }
        let mut seen = HashSet::new();
        ids.retain(|i| seen.insert(i.clone()));
        if ids.is_empty() {
            return Err("Nothing selected to delete.".into());
        }
        for id in &ids {
            if self.get(id).is_none() {
                return Err(format!("No sub-agent with id {}.", id));
            }
        }
        Ok(ids)
    }

    /// What deleting `parts` of `rec` would remove, for the confirmation.
    fn plan_for(&self, rec: &SubagentRecord, parts: &[&str], everything: bool, batch: &[String]) -> Value {
        let mut items = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        if rec.is_running() {
            warnings.push("It is running: it will be stopped first, then its data is deleted.".into());
        } else if rec.status == "queued" {
            warnings.push("It is waiting in the queue: it will be taken out of the queue.".into());
        }
        for part in parts {
            match *part {
                "chat" => {
                    let n = self.runner.load_messages(&rec.session_key).len();
                    items.push(json!({"part": "chat", "messages": n, "hasReport": rec.result.as_deref().map_or(false, |r| !r.is_empty()),
                        "label": format!("Chat: {} message{} and its report", n, if n == 1 { "" } else { "s" })}));
                }
                "memory" => {
                    if rec.memory_mode == "shared" {
                        items.push(json!({"part": "memory", "entries": 0, "skipped": true,
                            "label": "Memory: none of its own (it used the main memory, which is not touched)"}));
                    } else {
                        let n = self.memory_entries(&rec.name).len();
                        let others: Vec<String> = self
                            .list()
                            .into_iter()
                            .filter(|o| o.name == rec.name && o.id != rec.id && !batch.contains(&o.id))
                            .map(|o| o.id)
                            .collect();
                        if !others.is_empty() && n > 0 {
                            warnings.push(format!(
                                "Memory is kept per name: \"{}\" is also used by {} other sub-agent run{}, which lose it too.",
                                rec.name,
                                others.len(),
                                if others.len() == 1 { "" } else { "s" }
                            ));
                        }
                        items.push(json!({"part": "memory", "entries": n, "name": rec.name, "sharedWith": others,
                            "label": format!("Memory \"{}\": {} entr{}", rec.name, n, if n == 1 { "y" } else { "ies" })}));
                    }
                }
                "files" => {
                    let created: Vec<&TrackedFile> = rec.files.iter().filter(|f| f.created).collect();
                    let edited: Vec<String> = rec.files.iter().filter(|f| !f.created).map(|f| f.path.clone()).collect();
                    if !edited.is_empty() {
                        warnings.push(format!(
                            "{} file{} it edited existed before it ran, so {} kept.",
                            edited.len(),
                            if edited.len() == 1 { "" } else { "s" },
                            if edited.len() == 1 { "it is" } else { "they are" }
                        ));
                    }
                    items.push(json!({"part": "files", "files": created.iter().map(|f| f.path.clone()).collect::<Vec<_>>(), "kept": edited,
                        "label": format!("Files it created: {}", created.len())}));
                }
                "logs" => {
                    let lines = self.read_log(&rec.id, usize::MAX).len();
                    let asks = self.asks.lock().unwrap().iter().filter(|a| a.caller_session_key == rec.session_key || a.target_session_key == rec.session_key).count();
                    items.push(json!({"part": "logs", "entries": lines, "asks": asks,
                        "label": format!("Activity log: {} entr{}", lines + asks, if lines + asks == 1 { "y" } else { "ies" })}));
                }
                _ => {}
            }
        }
        if everything {
            items.push(json!({"part": "record", "label": "The sub-agent itself (its card and settings)"}));
        }
        json!({"id": rec.id, "name": rec.name, "status": rec.status, "items": items, "warnings": warnings})
    }

    /// `deleteData`: with dryRun, only the plan. Otherwise stops what is
    /// running and deletes; a running one is deleted the moment it stops.
    pub fn delete_data_request(self: &Arc<Self>, req: &Value) -> Result<Value, String> {
        let ids = self.delete_targets(req)?;
        let (parts, everything) = parse_parts(req.get("parts").unwrap_or(&Value::Null))?;
        let plans: Vec<Value> = ids
            .iter()
            .filter_map(|id| self.get(id))
            .map(|r| self.plan_for(&r, &parts, everything, &ids))
            .collect();
        if req.get("dryRun").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(json!({"dryRun": true, "parts": parts, "everything": everything, "plan": plans}));
        }
        let mut done = Vec::new();
        let mut deferred = Vec::new();
        for id in &ids {
            let Some(rec) = self.get(id) else { continue };
            if rec.status == "queued" {
                self.stop(id, "cancelled");
            }
            if self.get(id).map_or(false, |r| r.is_running()) {
                self.deferred_deletes.lock().unwrap().insert(id.clone(), (parts.clone(), everything));
                self.stop(id, "cancelled");
                deferred.push(id.clone());
                continue;
            }
            done.push(self.apply_delete(id, &parts, everything));
        }
        Ok(json!({"deleted": done, "stopping": deferred, "parts": parts, "everything": everything, "plan": plans}))
    }

    /// Delete now. Touches only this record's own data.
    pub(crate) fn apply_delete(&self, id: &str, parts: &[&str], everything: bool) -> Value {
        let Some(rec) = self.get(id) else { return json!({"id": id, "missing": true}) };
        let mut out = json!({"id": id, "name": rec.name});
        for part in parts {
            match *part {
                "chat" => {
                    // Guard: only ever a sub-agent session.
                    if rec.session_key.starts_with("subagent:") {
                        self.runner.clear(&rec.session_key);
                    }
                    self.update(id, |r| {
                        r.result = None;
                        r.chat_deleted = true;
                    });
                    out["chat"] = json!(true);
                }
                "memory" => {
                    out["memory"] = if rec.memory_mode == "shared" { json!(0) } else { json!(self.memory_clear(&rec.name)) };
                }
                "files" => {
                    let ws = self.workspace.lock().unwrap().clone();
                    let mut removed = Vec::new();
                    let mut failed = Vec::new();
                    if let Some(ws) = ws {
                        for f in rec.files.iter().filter(|f| f.created) {
                            match crate::tool_runner::resolve_path(&ws, &f.path) {
                                Ok(p) if p.is_file() => match std::fs::remove_file(&p) {
                                    Ok(()) => removed.push(f.path.clone()),
                                    Err(e) => failed.push(format!("{}: {}", f.path, e)),
                                },
                                Ok(_) => removed.push(f.path.clone()), // already gone
                                Err(_) => failed.push(format!("{}: outside the workspace", f.path)),
                            }
                        }
                    } else if rec.files.iter().any(|f| f.created) {
                        failed.push("The workspace isn't known, so no files were deleted.".into());
                    }
                    self.update(id, |r| r.files.retain(|f| !removed.contains(&f.path)));
                    out["files"] = json!(removed);
                    if !failed.is_empty() {
                        out["filesFailed"] = json!(failed);
                    }
                }
                "logs" => {
                    self.remove_log(id);
                    let mut asks = self.asks.lock().unwrap();
                    let before = asks.len();
                    asks.retain(|a| a.caller_session_key != rec.session_key && a.target_session_key != rec.session_key);
                    if asks.len() != before {
                        fs_write_json(&self.state_dir.join("session_asks.json"), &*asks);
                    }
                    out["logs"] = json!(true);
                }
                _ => {}
            }
        }
        if everything {
            self.records.lock().unwrap().retain(|r| r.id != id);
            out["record"] = json!(true);
        }
        self.persist();
        out
    }

    /// After a stopped run has saved its transcript, finish a delete the
    /// user asked for while it was running.
    pub(crate) fn run_deferred_delete(self: &Arc<Self>, id: &str, app: &Option<Arc<dyn NativeEventCallback>>) {
        let job = self.deferred_deletes.lock().unwrap().remove(id);
        if let Some((parts, everything)) = job {
            let out = self.apply_delete(id, &parts, everything);
            if let Some(cb) = app {
                cb.on_event("subagent.deleted".into(), json!({"id": id, "result": out}).to_string());
            }
        }
    }

    /// A past sub-agent to continue: by id, else the most recent one with
    /// that name. Only this chat's, unless `reuseAcrossChats` is on.
    pub fn find_reusable(&self, key: &str, session_key: &str) -> Option<SubagentRecord> {
        let key = key.trim();
        if key.is_empty() {
            return None;
        }
        let cross = self.settings().reuse_across_chats;
        let mine = |r: &SubagentRecord| cross || r.parent_session_key == session_key;
        if let Some(r) = self.get(key) {
            return if mine(&r) { Some(r) } else { None };
        }
        let name = sanitize_name(key);
        self.list()
            .into_iter()
            .filter(|r| r.name == name && mine(r))
            .max_by_key(|r| (r.is_active(), r.finished_at.unwrap_or(r.started_at).max(r.created_at)))
    }

    /// Records the main agent may see in list_subagents.
    pub(crate) fn filter_records(&self, input: &Value, session_key: &str) -> Vec<SubagentRecord> {
        let cross = self.settings().reuse_across_chats;
        let scope_all = input.get("scope").and_then(Value::as_str) == Some("all") && cross;
        let name = input.get("name").and_then(Value::as_str).map(sanitize_name).filter(|n| !n.is_empty());
        let query = input.get("query").and_then(Value::as_str).map(|q| q.to_lowercase()).filter(|q| !q.trim().is_empty());
        let status = input.get("status").and_then(Value::as_str).unwrap_or("all").to_string();
        let ids: Option<Vec<String>> = input.get("ids").and_then(|v| serde_json::from_value(v.clone()).ok());
        let mut recs: Vec<SubagentRecord> = self
            .list()
            .into_iter()
            .filter(|r| scope_all || r.parent_session_key == session_key)
            .filter(|r| ids.as_ref().map_or(true, |ids| ids.contains(&r.id)))
            .filter(|r| name.as_ref().map_or(true, |n| &r.name == n))
            .filter(|r| {
                query.as_ref().map_or(true, |q| {
                    r.task.to_lowercase().contains(q) || r.name.contains(q.as_str()) || r.role.as_deref().unwrap_or("").to_lowercase().contains(q)
                })
            })
            .filter(|r| match status.as_str() {
                "running" => r.is_running(),
                "queued" => r.status == "queued",
                "active" => r.is_active(),
                "finished" => !r.is_active(),
                "failed" => matches!(r.status.as_str(), "error" | "cancelled" | "budget_exceeded" | "timeout" | "max_steps"),
                _ => true,
            })
            .collect();
        recs.sort_by_key(|r| std::cmp::Reverse(r.finished_at.unwrap_or(r.started_at).max(r.created_at)));
        if let Some(n) = input.get("recent").and_then(Value::as_u64) {
            recs.truncate(n.clamp(1, 100) as usize);
        }
        recs
    }
}
