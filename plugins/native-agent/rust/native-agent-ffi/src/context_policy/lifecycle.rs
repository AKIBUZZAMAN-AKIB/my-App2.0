//! The life of one task's temp context, driven by the agent loop.
//!
//! - Turn start (`begin_turn`): an earlier task still `active` is closed as
//!   `interrupted`, and the model's stale `ctx task` pick is cleared.
//! - Before every model call (`step_view`): no task until the first real tool
//!   call of the turn (the first call always sees the full view). From then the
//!   policy is selected (pin → rule → the model's pick → auto → T7), the temp
//!   view assembled and checked; any problem sends T7. Failed tool results
//!   past `policy_max_retries`, or the model asking for something left out,
//!   switch the task to T7 for the rest of the turn.
//! - Turn end (`end_turn`): the task is closed (completed, timed out, ...), the
//!   goal stored redacted, and the pick cleared. Nothing of the temp checklist
//!   outlives the task.
//!
//! Every failure here is swallowed into T7: the agent loop never fails because
//! of a policy.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde_json::{json, Value};

use super::context_assembler::{self, AssembleInput};
use super::policy_selector::{self, AiPick, Candidate, SelectInput};
use super::request_facts::{self, FactInput};
use super::safeguards;
use super::store::{self, EventRow, TaskRow};
use super::task_goal::TaskGoal;
use super::temp_checklist::TempChecklist;
use super::types::{PolicyId, PolicyMode, Source, TaskStatus};
use crate::turn_memory::split_turns;
use crate::types::{ContentBlock, Message, MessageContent, Role};

/// What one step of the loop sends, and what the event log should say.
#[derive(Debug, Clone)]
pub struct StepView {
    pub messages: Vec<Message>,
    pub policy: PolicyId,
    pub source: Source,
    pub task_id: Option<String>,
    pub left_out: Vec<String>,
    pub reason: Option<String>,
    /// The task block, appended at the very end of the system prompt (only
    /// with a temp view; T7 sends the system prompt unchanged).
    pub system_suffix: Option<String>,
}

fn open(db_path: &str) -> Option<Connection> {
    let conn = crate::db::open_db(db_path).ok()?;
    store::ensure_tables(&conn).ok()?;
    crate::context_tree::store::ensure_tables(&conn).ok()?;
    Some(conn)
}

fn mode(conn: &Connection) -> crate::context_tree::settings::Settings {
    crate::context_tree::settings::Settings::load(conn).unwrap_or_default()
}

/// Turn start.
pub fn begin_turn(db_path: &str, session_key: &str, now_ms: i64) {
    let Some(conn) = open(db_path) else { return };
    let _ = store::mark_interrupted(&conn, Some(session_key), now_ms);
    let _ = store::clear_pick(&conn, session_key);
}

struct Newest {
    prompt: String,
    steers: Vec<String>,
    tool_names: Vec<String>,
    first_calls: Vec<String>,
    results: Vec<(String, bool)>,
    last_calls: Vec<(String, Value)>,
    /// One line per finished tool step: `"1 read_file ok R3"`.
    ledger: Vec<String>,
}

fn text_of(m: &Message) -> Option<String> {
    match &m.content {
        MessageContent::Text(t) => Some(t.clone()),
        MessageContent::Blocks(bs) => {
            let t: Vec<&str> = bs
                .iter()
                .filter_map(|b| {
                    if let ContentBlock::Text { text, .. } = b {
                        Some(text.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            (!t.is_empty()).then(|| t.join("\n"))
        }
    }
}

fn newest(view: &[Message]) -> Option<Newest> {
    let t = split_turns(view).last().cloned()?;
    let msgs = &view[t.start..t.end];
    let prompt = text_of(&msgs[0]).unwrap_or_default();
    let mut n = Newest {
        prompt,
        steers: Vec::new(),
        tool_names: Vec::new(),
        first_calls: Vec::new(),
        results: Vec::new(),
        last_calls: Vec::new(),
        ledger: Vec::new(),
    };
    let mut names: HashMap<String, String> = HashMap::new();
    let mut first_seen = false;
    for m in &msgs[1..] {
        match (&m.role, &m.content) {
            (Role::User, MessageContent::Text(t)) => n.steers.push(t.clone()),
            (Role::Assistant, MessageContent::Blocks(bs)) => {
                let calls: Vec<(String, Value)> = bs
                    .iter()
                    .filter_map(|b| {
                        if let ContentBlock::ToolUse {
                            id, name, input, ..
                        } = b
                        {
                            names.insert(id.clone(), name.clone());
                            Some((name.clone(), input.clone()))
                        } else {
                            None
                        }
                    })
                    .collect();
                let real: Vec<String> = calls
                    .iter()
                    .map(|(n, _)| n.clone())
                    .filter(|n| n != crate::context_tree::tools::CTX_TOOL)
                    .collect();
                if !first_seen && !real.is_empty() {
                    n.first_calls = real.clone();
                    first_seen = true;
                }
                n.tool_names.extend(real);
                if !calls.is_empty() {
                    n.last_calls = calls;
                }
            }
            (_, MessageContent::Blocks(bs)) => {
                for b in bs {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        is_error,
                        ..
                    } = b
                    {
                        let name = names.get(tool_use_id).cloned().unwrap_or_default();
                        if name != crate::context_tree::tools::CTX_TOOL {
                            n.ledger.push(format!(
                                "{} {} {}",
                                n.results.len() + 1,
                                name,
                                if *is_error { "error" } else { "ok" }
                            ));
                            n.results.push((name, *is_error));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Some(n)
}

fn full(
    view: &[Message],
    task_id: Option<String>,
    source: Source,
    reason: Option<String>,
) -> StepView {
    StepView {
        messages: view.to_vec(),
        policy: PolicyId::T7,
        source,
        task_id,
        left_out: Vec::new(),
        reason,
        system_suffix: None,
    }
}

pub struct StepInput<'a> {
    pub db_path: &'a str,
    pub workspace_path: &'a str,
    pub session_key: &'a str,
    pub view: &'a [Message],
    pub abs: &'a dyn Fn(u32) -> u32,
    pub result_ids: &'a HashMap<String, String>,
    pub is_background: bool,
    pub is_subagent: bool,
    pub step: u32,
    pub now_ms: i64,
}

/// The view for one model call.
pub fn step_view(inp: &StepInput<'_>) -> StepView {
    let view = inp.view;
    let Some(conn) = open(inp.db_path) else {
        return full(view, None, Source::Fallback, None);
    };
    let settings = mode(&conn);
    if settings.policy_mode == PolicyMode::Off {
        return full(view, None, Source::Fallback, None);
    }
    let Some(n) = newest(view) else {
        return full(view, None, Source::Fallback, None);
    };
    if n.tool_names.is_empty() {
        // The task starts at the first real tool call.
        return full(view, None, Source::Fallback, None);
    }
    // The task row: started at the first step that has a tool call.
    let mut task = match store::active_task(&conn, inp.session_key).ok().flatten() {
        Some(t) => t,
        None => {
            // Linked to the chat's open goal (turn memory), when there is one.
            let linked = crate::turn_memory::goals::load_state(&conn, inp.session_key)
                .current()
                .map(|g| g.goal_id.clone());
            let goal = TaskGoal::new(&n.prompt, &n.steers, linked, inp.now_ms);
            let list = TempChecklist::full(n.steers.len(), Source::Fallback, inp.now_ms);
            let row = TaskRow {
                task_id: goal.goal_id.clone(),
                session_key: inp.session_key.to_string(),
                goal_json: serde_json::to_value(&goal).unwrap_or(Value::Null),
                checklist_json: list.to_json(),
                policy_id: PolicyId::T7,
                params: Default::default(),
                source: Source::Fallback,
                status: TaskStatus::Active,
                retries: 0,
                escalations: 0,
                started_at: inp.now_ms,
                ended_at: None,
            };
            if store::insert_task(&conn, &row).is_err() {
                return full(view, None, Source::Fallback, Some("fallback:store".into()));
            }
            log(
                &conn,
                inp,
                &row.task_id,
                "task_started",
                None,
                &[],
                &[],
                None,
            );
            row
        }
    };
    let tid = task.task_id.clone();
    // Keep the goal's steer messages and focus current.
    let pick = store::get_pick(&conn, inp.session_key).ok().flatten();
    let mut new_steer = false;
    if let Ok(mut goal) = serde_json::from_value::<TaskGoal>(task.goal_json.clone()) {
        for s in &n.steers {
            if !goal.steer_messages.contains(s) {
                goal.add_steer(s);
                new_steer = true;
            }
        }
        if let Some(f) = pick.as_ref().and_then(|p| p.focus.as_deref()) {
            goal.set_focus(f);
        }
        task.goal_json = serde_json::to_value(&goal).unwrap_or(task.goal_json.clone());
    }
    task.retries = n.results.iter().filter(|(_, e)| *e).count() as u32;
    // A steer message mid-task: this one request goes in full (T7), so the
    // model reads the new instruction against everything; the next step selects
    // again.
    if new_steer {
        let _ = store::update_task(&conn, &task);
        log(
            &conn,
            inp,
            &tid,
            "steer",
            Some("T7"),
            &[],
            &[],
            Some("steer"),
        );
        return full(view, Some(tid), Source::Fallback, Some("steer".into()));
    }
    // Once escalated, T7 for the rest of the task.
    if task.escalations > 0 && task.policy_id == PolicyId::T7 {
        let _ = store::update_task(&conn, &task);
        return full(view, Some(tid), Source::Fallback, Some("escalated".into()));
    }
    let left_before: Vec<String> = task
        .checklist_json
        .get("leftOut")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let reason = if task.retries as u64 > settings.policy_max_retries {
        Some("fallback:tool_errors".to_string())
    } else {
        safeguards::escalation(&n.last_calls, &left_before)
    };
    if let Some(r) = reason {
        task.escalations += 1;
        task.policy_id = PolicyId::T7;
        task.source = Source::Fallback;
        task.params = Default::default();
        task.checklist_json =
            TempChecklist::full(n.steers.len(), Source::Fallback, inp.now_ms).to_json();
        let _ = store::update_task(&conn, &task);
        log(
            &conn,
            inp,
            &tid,
            "escalated",
            Some("T7"),
            &[],
            &[],
            Some(&r),
        );
        return full(view, Some(tid), Source::Fallback, Some(r));
    }
    // Select.
    let loaded = store::load_rules(inp.workspace_path);
    let ai = pick.as_ref().map(|p| AiPick {
        policy: p.policy.clone(),
        params: p.params.clone(),
        ids: p.ids.clone(),
    });
    let facts = request_facts::compute(&FactInput {
        request: &n.prompt,
        tool_names: &n.tool_names,
        first_calls: &n.first_calls,
        results: &n.results,
        ai_chose_t4: ai.as_ref().and_then(|a| a.policy.as_deref()) == Some("T4"),
        is_background: inp.is_background,
        is_subagent: inp.is_subagent,
    });
    let pin = store::get_pin(&conn, inp.session_key)
        .ok()
        .flatten()
        .map(|p| (p.policy_id, p.params));
    let known = crate::context_tree::dispatch::known_item(&conn, inp.session_key);
    let group_of = crate::context_tree::memory_checklist::group_lookup(&conn, inp.session_key);
    let cands: Vec<Candidate> = crate::context_tree::store::load_nodes(&conn, inp.session_key)
        .map(|v| {
            v.into_iter()
                .filter(|x| x.id.as_str().starts_with("turn/t"))
                .map(|x| Candidate {
                    id: x.id.as_str().to_string(),
                    title: x.title.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    let sel = policy_selector::select(&SelectInput {
        mode: settings.policy_mode,
        pin,
        rules: &loaded.set,
        facts: &facts,
        ai: ai.as_ref(),
        request: &n.prompt,
        candidates: &cands,
        known: &known,
        group_of: &group_of,
        recent_turns: settings.policy_recent_turns as i64,
        steer_count: n.steers.len(),
        now_ms: inp.now_ms,
    });
    let list = sel.checklist;
    let assembled = context_assembler::assemble(&AssembleInput {
        view,
        list: &list,
        abs: inp.abs,
        result_ids: inp.result_ids,
    });
    let dropped: HashSet<String> = assembled
        .left_out
        .iter()
        .filter_map(|l| l.strip_prefix("call/").map(String::from))
        .collect();
    let mut left_out = assembled.left_out.clone();
    left_out.extend(sel.removed.iter().map(|r| r.id.clone()));
    if let Err(why) = safeguards::check(view, &assembled.messages, &dropped) {
        task.policy_id = PolicyId::T7;
        task.source = Source::Fallback;
        let _ = store::update_task(&conn, &task);
        log(
            &conn,
            inp,
            &tid,
            "fallback",
            Some("T7"),
            &[],
            &[],
            Some(&format!("fallback:{why}")),
        );
        return full(
            view,
            Some(tid),
            Source::Fallback,
            Some(format!("fallback:{why}")),
        );
    }
    let mut cl = list.to_json();
    cl["leftOut"] = json!(left_out);
    let changed = task.policy_id != list.policy_id || task.source != list.source;
    task.policy_id = list.policy_id;
    task.source = list.source;
    task.params = list.params.clone();
    task.checklist_json = cl;
    let _ = store::update_task(&conn, &task);
    let reason = match (&sel.rule_id, list.source) {
        (Some(r), _) => format!("rule:{r}"),
        (None, s) => s.as_str().to_string(),
    };
    log(
        &conn,
        inp,
        &tid,
        if changed { "policy_selected" } else { "step" },
        Some(list.policy_id.as_str()),
        &list.item_ids,
        &left_out,
        Some(&reason),
    );
    let messages = assembled.messages;
    let system_suffix = (list.policy_id != PolicyId::T7).then(|| {
        let goal = serde_json::from_value::<TaskGoal>(task.goal_json.clone()).ok();
        super::render_task_block(&super::BlockView {
            goal: goal.as_ref(),
            checklist: Some(&list),
            excluded_ids: &left_out,
            ledger: &n.ledger,
        })
    });
    StepView {
        messages,
        policy: list.policy_id,
        source: list.source,
        task_id: Some(tid),
        left_out,
        reason: Some(reason),
        system_suffix,
    }
}

#[allow(clippy::too_many_arguments)]
fn log(
    conn: &Connection,
    inp: &StepInput<'_>,
    tid: &str,
    kind: &str,
    policy: Option<&str>,
    included: &[String],
    excluded: &[String],
    reason: Option<&str>,
) {
    let e = EventRow {
        task_id: Some(tid.to_string()),
        step: inp.step,
        kind: kind.to_string(),
        policy_id: policy.map(String::from),
        included_ids: included.to_vec(),
        excluded_ids: excluded.to_vec(),
        reason: reason.map(String::from),
        input_tokens: None,
        t7_tokens: None,
        latency_ms: None,
        first_token_ms: None,
    };
    let _ = store::insert_event(conn, inp.session_key, &e, inp.now_ms);
    let _ = store::trim_events(conn, inp.session_key, 2000);
}

/// Record the size of what was sent next to what T7 would have sent.
#[allow(clippy::too_many_arguments)]
pub fn record_tokens(
    db_path: &str,
    session_key: &str,
    task_id: &str,
    step: u32,
    input_tokens: i64,
    t7_tokens: i64,
    policy: PolicyId,
    now_ms: i64,
) {
    let Some(conn) = open(db_path) else { return };
    let e = EventRow {
        task_id: Some(task_id.to_string()),
        step,
        kind: "tokens".into(),
        policy_id: Some(policy.as_str().to_string()),
        included_ids: Vec::new(),
        excluded_ids: Vec::new(),
        reason: None,
        input_tokens: Some(input_tokens),
        t7_tokens: Some(t7_tokens),
        latency_ms: None,
        first_token_ms: None,
    };
    let _ = store::insert_event(&conn, session_key, &e, now_ms);
}

/// Turn end.
pub fn end_turn(db_path: &str, session_key: &str, status: TaskStatus, now_ms: i64) {
    let Some(conn) = open(db_path) else { return };
    if let Some(t) = store::active_task(&conn, session_key).ok().flatten() {
        // A turn that "completed" only because it ran out of steps failed; one
        // that needed a safety fallback is recorded as such.
        let kinds: Vec<String> = store::events(&conn, session_key, Some(&t.task_id), 2000)
            .unwrap_or_default()
            .iter()
            .filter_map(|e| e["kind"].as_str().map(String::from))
            .collect();
        let status = match status {
            TaskStatus::Completed if kinds.iter().any(|k| k == "max_turns_reached") => {
                TaskStatus::Failed
            }
            TaskStatus::Completed if kinds.iter().any(|k| k == "fallback") => TaskStatus::Fallback,
            s => s,
        };
        let redacted = serde_json::from_value::<TaskGoal>(t.goal_json.clone())
            .map(|g| g.redacted())
            .unwrap_or(Value::Null);
        let _ = store::finish_task(&conn, &t.task_id, status, &redacted, now_ms);
        let e = EventRow {
            task_id: Some(t.task_id.clone()),
            step: 0,
            kind: "task_ended".into(),
            policy_id: Some(t.policy_id.as_str().to_string()),
            included_ids: Vec::new(),
            excluded_ids: Vec::new(),
            reason: Some(status.as_str().to_string()),
            input_tokens: None,
            t7_tokens: None,
            latency_ms: None,
            first_token_ms: None,
        };
        let _ = store::insert_event(&conn, session_key, &e, now_ms);
    }
    let _ = store::clear_pick(&conn, session_key);
}

/// Record a loop event (`max_turns_reached`, `safeguard`) on the running task.
pub fn note_event(db_path: &str, session_key: &str, kind: &str, reason: &str, now_ms: i64) {
    let Some(conn) = open(db_path) else { return };
    let Some(t) = store::active_task(&conn, session_key).ok().flatten() else {
        return;
    };
    let e = EventRow {
        task_id: Some(t.task_id.clone()),
        step: 0,
        kind: kind.to_string(),
        policy_id: Some(t.policy_id.as_str().to_string()),
        included_ids: Vec::new(),
        excluded_ids: Vec::new(),
        reason: Some(reason.to_string()),
        input_tokens: None,
        t7_tokens: None,
        latency_ms: None,
        first_token_ms: None,
    };
    let _ = store::insert_event(&conn, session_key, &e, now_ms);
}

/// The brief of the parent's running task for a sub-agent (`ParentEnv`):
/// the user's request, the goal, constraints, the items the parent keeps and
/// the newest results. `None` when no task is running.
pub fn subagent_brief(db_path: &str, session_key: &str, view: &[Message]) -> Option<String> {
    let conn = open(db_path)?;
    let t = store::active_task(&conn, session_key).ok().flatten()?;
    let goal: TaskGoal = serde_json::from_value(t.goal_json.clone()).ok()?;
    let items: Vec<String> = t
        .checklist_json
        .get("items")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Some(super::subagent_brief::render(
        &goal,
        t.policy_id,
        &items,
        view,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_policy::types::PolicyMode;

    fn user(t: &str) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Text(t.into()),
        }
    }
    fn asst(t: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Text(t.into()),
        }
    }
    fn call(id: &str, name: &str, input: Value) -> Message {
        Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
                id: id.into(),
                name: name.into(),
                input,
                provider_metadata: None,
            }]),
        }
    }
    fn res(id: &str, err: bool) -> Message {
        Message {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: "ok".into(),
                is_error: err,
            }]),
        }
    }

    fn setup(name: &str, m: PolicyMode) -> (String, String) {
        let dir = std::env::temp_dir().join(format!("tcpe-life-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("ws")).unwrap();
        let db = dir.join("s.db").to_string_lossy().to_string();
        let conn = open(&db).unwrap();
        crate::context_tree::settings::Settings::save(&conn, &json!({"policy_mode": m.as_str()}))
            .unwrap();
        (db, dir.join("ws").to_string_lossy().to_string())
    }

    fn step(db: &str, ws: &str, view: &[Message], step: u32) -> StepView {
        let ids = HashMap::new();
        step_view(&StepInput {
            db_path: db,
            workspace_path: ws,
            session_key: "s",
            view,
            abs: &|n| n,
            result_ids: &ids,
            is_background: false,
            is_subagent: false,
            step,
            now_ms: 10 + step as i64,
        })
    }

    #[test]
    fn off_is_t7_and_the_task_starts_at_the_first_tool_call() {
        let (db, ws) = setup("off", PolicyMode::Off);
        let v = vec![
            user("a"),
            asst("b"),
            user("turn the torch on"),
            call("c1", "device__torch_on", json!({})),
            res("c1", false),
        ];
        let s = step(&db, &ws, &v, 1);
        assert_eq!(
            (s.policy, s.messages.len(), s.task_id.is_none()),
            (PolicyId::T7, v.len(), true)
        );
        let (db, ws) = setup("auto", PolicyMode::Auto);
        let before = vec![user("a"), asst("b"), user("turn the torch on")];
        assert!(
            step(&db, &ws, &before, 0).task_id.is_none(),
            "no task before the first tool call"
        );
        begin_turn(&db, "s", 1);
        let conn = open(&db).unwrap();
        store::set_pick(
            &conn,
            "s",
            &store::AiPickRow {
                policy: Some("T1".into()),
                params: None,
                ids: vec![],
                focus: Some("torch on".into()),
                at: 1,
            },
        )
        .unwrap();
        let s = step(&db, &ws, &v, 1);
        assert_eq!(s.policy, PolicyId::T1, "the model's pick");
        assert_eq!(s.source, Source::Ai);
        assert!(s.left_out.contains(&"turn/t1".to_string()));
        let block = s
            .system_suffix
            .as_deref()
            .expect("a temp view carries the task block");
        assert!(block.starts_with(crate::context_policy::TASK_BLOCK_MARKER));
        assert!(block.contains("T1"));
        assert!(
            !s.messages.iter().any(|m| m.role == Role::Context),
            "the block goes in the system prompt, not the transcript"
        );
        let t = store::active_task(&conn, "s").unwrap().unwrap();
        assert_eq!(t.policy_id, PolicyId::T1);
        end_turn(&db, "s", TaskStatus::Completed, 99);
        assert!(store::active_task(&conn, "s").unwrap().is_none());
        assert!(
            store::get_pick(&conn, "s").unwrap().is_none(),
            "nothing outlives the task"
        );
        let done = store::get_task(&conn, &t.task_id).unwrap().unwrap();
        assert_eq!(done.status, TaskStatus::Completed);
    }

    #[test]
    fn errors_past_the_limit_and_t7_requests_escalate_for_the_rest_of_the_task() {
        let (db, ws) = setup("esc", PolicyMode::Auto);
        let conn = open(&db).unwrap();
        store::set_pick(
            &conn,
            "s",
            &store::AiPickRow {
                policy: Some("T1".into()),
                params: None,
                ids: vec![],
                focus: None,
                at: 1,
            },
        )
        .unwrap();
        let mut v = vec![
            user("a"),
            asst("b"),
            user("read it"),
            call("c1", "read_file", json!({"p": 1})),
            res("c1", true),
        ];
        assert_eq!(step(&db, &ws, &v, 1).policy, PolicyId::T1);
        v.extend([
            call("c2", "read_file", json!({"p": 2})),
            res("c2", true),
            call("c3", "read_file", json!({"p": 3})),
            res("c3", true),
        ]);
        let s = step(&db, &ws, &v, 2);
        assert_eq!(
            (s.policy, s.reason.as_deref()),
            (PolicyId::T7, Some("fallback:tool_errors"))
        );
        v.extend([call("c4", "read_file", json!({"p": 4})), res("c4", false)]);
        assert_eq!(step(&db, &ws, &v, 3).policy, PolicyId::T7, "stays T7");
        end_turn(&db, "s", TaskStatus::Completed, 50);
        // A new turn: the model asks for T7 itself.
        begin_turn(&db, "s", 60);
        store::set_pick(
            &conn,
            "s",
            &store::AiPickRow {
                policy: Some("T1".into()),
                params: None,
                ids: vec![],
                focus: None,
                at: 61,
            },
        )
        .unwrap();
        let mut w = vec![
            user("a"),
            asst("b"),
            user("go"),
            call("d1", "read_file", json!({})),
            res("d1", false),
        ];
        assert_eq!(step(&db, &ws, &w, 1).policy, PolicyId::T1);
        w.extend([
            call("d2", "ctx", json!({"action": "task", "id": "T7"})),
            res("d2", false),
        ]);
        let s = step(&db, &ws, &w, 2);
        assert_eq!(
            (s.policy, s.reason.as_deref()),
            (PolicyId::T7, Some("model_asked_t7"))
        );
    }

    #[test]
    fn a_task_left_active_is_interrupted_at_the_next_turn() {
        let (db, ws) = setup("int", PolicyMode::Manual);
        let v = vec![
            user("go"),
            call("c1", "read_file", json!({})),
            res("c1", false),
        ];
        let s = step(&db, &ws, &v, 1);
        let tid = s.task_id.unwrap();
        begin_turn(&db, "s", 500);
        let conn = open(&db).unwrap();
        assert_eq!(
            store::get_task(&conn, &tid).unwrap().unwrap().status,
            TaskStatus::Interrupted
        );
        assert!(subagent_brief(&db, "s", &[]).is_none());
    }
}
