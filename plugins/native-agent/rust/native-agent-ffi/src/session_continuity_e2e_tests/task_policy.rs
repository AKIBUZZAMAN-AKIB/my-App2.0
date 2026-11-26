//! Task Context Policy Engine (TCPE), end to end through
//! `NativeAgentHandle::send_message` against the mock provider: what the
//! provider actually receives with the policy off and in auto mode.

use super::*;

const KEY: &str = "chat-tcpe-e2e";

fn tcpe_responder(body: &serde_json::Value) -> (Option<(String, String)>, String) {
    let text = body["messages"].to_string();
    if text.contains("long-term memory of a chat") || text.contains("You are a recall sub-agent") {
        return (None, "{\"segments\":[]}".into());
    }
    let msgs = body["messages"].as_array().cloned().unwrap_or_default();
    let i = msgs.iter().rposition(|m| m["role"] == "user").unwrap_or(0);
    let user = msgs[i]["content"].as_str().unwrap_or_default().to_string();
    let tool_after = msgs[i..].iter().any(|m| m["role"] == "tool");
    if user.starts_with("TCPE read") && !tool_after {
        // One real call plus the model's own policy pick, in the same reply.
        return (
            Some((
                "__multi__".into(),
                serde_json::json!([
                    ["read_file", "{\"path\":\"notes.txt\"}"],
                    [
                        "ctx",
                        "{\"action\":\"task\",\"id\":\"T1\",\"focus\":\"summarize notes.txt\"}"
                    ]
                ])
                .to_string(),
            )),
            String::new(),
        );
    }
    (None, format!("ANSWER for {user}"))
}

fn main_bodies(requests: &std_mpsc::Receiver<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Ok(b) = requests.recv_timeout(Duration::from_millis(300)) {
        let t = b["messages"].to_string();
        if !t.contains("long-term memory of a chat") && !t.contains("You are a recall sub-agent") {
            out.push(b);
        }
    }
    out
}

/// The transcript of a request, without the system prompt.
fn transcript(body: &serde_json::Value) -> String {
    serde_json::Value::Array(body["messages"].as_array().unwrap()[1..].to_vec()).to_string()
}

fn system_of(body: &serde_json::Value) -> String {
    body["messages"][0]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn finish(events: &std_mpsc::Receiver<(String, String)>) {
    loop {
        let (event, payload) = events
            .recv_timeout(Duration::from_secs(30))
            .expect("turn must finish");
        match event.as_str() {
            "agent.completed" => return,
            "agent.error" => panic!("turn failed: {payload}"),
            _ => {}
        }
    }
}

fn history() -> Vec<types::Message> {
    let mut v = Vec::new();
    for n in 1..=4 {
        v.push(turn(
            types::Role::User,
            &format!("older question {n} OLDER-{n}"),
        ));
        v.push(turn(types::Role::Assistant, &format!("older answer {n}")));
    }
    v
}

fn set_mode(config: &types::InitConfig, mode: &str) {
    let conn = db::open_db(&config.db_path).unwrap();
    db::ensure_schema(&conn).unwrap();
    crate::context_tree::store::ensure_tables(&conn).unwrap();
    crate::context_tree::settings::Settings::save(&conn, &serde_json::json!({"policy_mode": mode}))
        .unwrap();
}

fn run(mode: &str) -> (types::InitConfig, Vec<Vec<serde_json::Value>>) {
    let config = sandbox(&format!("tcpe-{mode}"));
    std::fs::write(
        std::path::Path::new(&config.workspace_path).join("notes.txt"),
        "NOTES-BODY line\n".repeat(20),
    )
    .unwrap();
    seed_session(&config, KEY, &history());
    set_mode(&config, mode);
    let (base, requests) = spawn_mock_provider_with(MockProviderScript {
        response_model: None,
        first_response_tool_call: None,
        responder: Some(tcpe_responder),
    });
    let (handle, events) = launch(config.clone(), &base);
    let mut turns = Vec::new();
    for prompt in [
        "TCPE read notes.txt and summarize it",
        "Plain follow-up question",
    ] {
        ask(&handle, KEY, prompt);
        finish(&events);
        turns.push(main_bodies(&requests));
    }
    (config, turns)
}

#[test]
fn off_mode_sends_every_request_unchanged_and_records_no_task() {
    let (config, turns) = run("off");
    assert_eq!(
        turns[0].len(),
        2,
        "one tool step, one answer: no extra request"
    );
    for b in turns.iter().flatten() {
        assert!(!system_of(b).contains(crate::context_policy::TASK_BLOCK_MARKER));
    }
    let follow = transcript(&turns[0][1]);
    assert!(follow.contains("OLDER-1"), "T7 keeps every older turn");
    let conn = db::open_db(&config.db_path).unwrap();
    crate::context_policy::store::ensure_tables(&conn).unwrap();
    assert!(crate::context_policy::store::recent_tasks(&conn, KEY, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn auto_mode_shortens_only_the_task_step_and_keeps_prefix_tools_and_results() {
    let (config, turns) = run("auto");
    let t1 = &turns[0];
    assert_eq!(t1.len(), 2, "the policy adds no request");
    // The first request of a turn has no task yet: full, unchanged.
    let first_sys = system_of(&t1[0]);
    assert!(!first_sys.contains(crate::context_policy::TASK_BLOCK_MARKER));
    assert!(transcript(&t1[0]).contains("OLDER-1"));
    // The follow-up runs the model's T1 pick.
    let second_sys = system_of(&t1[1]);
    // The rules before the (live) context-window checklist are byte-identical,
    // and the task block is the very last part of the system prompt.
    let tree = "[native-agent-context-tree-v1]";
    let prefix = |s: &str| s[..s.find(tree).expect("context rules part")].to_string();
    assert_eq!(
        prefix(&first_sys),
        prefix(&second_sys),
        "the system prompt is only appended to"
    );
    let at = second_sys
        .find(crate::context_policy::TASK_BLOCK_MARKER)
        .expect("the task block is sent");
    assert!(at > second_sys.find(tree).unwrap(), "the block comes last");
    assert!(second_sys.contains("T1"));
    assert_eq!(t1[0]["tools"], t1[1]["tools"], "tool schemas never change");
    let follow = transcript(&t1[1]);
    assert!(
        !follow.contains("OLDER-1"),
        "older turns are left out under T1"
    );
    assert!(
        follow.contains("TCPE read notes.txt"),
        "the request stays whole"
    );
    assert!(
        follow.contains("NOTES-BODY"),
        "the running task's results stay"
    );
    assert!(
        t1[1]["messages"].as_array().unwrap().len()
            < t1[0]["messages"].as_array().unwrap().len() + 2,
        "the step view is smaller than the full one"
    );
    // The next turn starts in full again.
    for b in &turns[1] {
        assert!(!system_of(b).contains(crate::context_policy::TASK_BLOCK_MARKER));
        assert!(transcript(b).contains("OLDER-1"));
    }
    let conn = db::open_db(&config.db_path).unwrap();
    let tasks = crate::context_policy::store::recent_tasks(&conn, KEY, 10).unwrap();
    assert_eq!(tasks.len(), 1, "one task: the turn with a tool call");
    assert_eq!(
        tasks[0].status,
        crate::context_policy::TaskStatus::Completed
    );
    assert!(crate::context_policy::store::active_task(&conn, KEY)
        .unwrap()
        .is_none());
}
