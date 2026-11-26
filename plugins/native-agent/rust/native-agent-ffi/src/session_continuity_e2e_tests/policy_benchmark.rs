//! TCPE benchmark (mock provider, deterministic): the same task with history,
//! run once per policy T1–T7 (pinned), through the real entry point. For each
//! policy it measures what the provider received and checks the plan's
//! guarantees against T7:
//! - the same number of requests (no extra request, no extra latency step);
//! - the tool schemas and the rules part of the system prompt unchanged;
//! - the user's request and the running task's tool results always sent
//!   (no omission of what the answer needs);
//! - the follow-up request never larger than T7's, and the shortening
//!   policies (T1, T2, T6) strictly smaller;
//! - tokens, latency and time to first token recorded for every request, and
//!   `policy.metrics` adding them up.
//! The report prints with `--nocapture`.

use super::*;

const KEY: &str = "chat-tcpe-bench";

fn bench_responder(body: &serde_json::Value) -> (Option<(String, String)>, String) {
    let text = body["messages"].to_string();
    if text.contains("long-term memory of a chat") || text.contains("You are a recall sub-agent") {
        return (None, "{\"segments\":[]}".into());
    }
    let msgs = body["messages"].as_array().cloned().unwrap_or_default();
    let i = msgs.iter().rposition(|m| m["role"] == "user").unwrap_or(0);
    let user = msgs[i]["content"].as_str().unwrap_or_default().to_string();
    let tool_after = msgs[i..].iter().any(|m| m["role"] == "tool");
    if user.starts_with("BENCH") && !tool_after {
        return (
            Some(("read_file".into(), "{\"path\":\"report.txt\"}".into())),
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

fn transcript(body: &serde_json::Value) -> String {
    serde_json::Value::Array(body["messages"].as_array().unwrap()[1..].to_vec()).to_string()
}

fn rules_part(body: &serde_json::Value) -> String {
    let s = body["messages"][0]["content"].as_str().unwrap_or_default();
    s[..s.find("[native-agent-context-tree-v1]").unwrap_or(s.len())].to_string()
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

struct Run {
    policy: &'static str,
    requests: usize,
    follow_bytes: usize,
    first: serde_json::Value,
    follow: serde_json::Value,
    metrics: serde_json::Value,
}

fn run(policy: &'static str) -> Run {
    let config = sandbox(&format!("tcpe-bench-{policy}"));
    std::fs::write(
        std::path::Path::new(&config.workspace_path).join("report.txt"),
        "REPORT-BODY quarterly numbers\n".repeat(30),
    )
    .unwrap();
    let mut seed = Vec::new();
    for n in 1..=8 {
        seed.push(turn(
            types::Role::User,
            &format!("older question {n} OLDER-{n} {}", "context ".repeat(60)),
        ));
        seed.push(turn(
            types::Role::Assistant,
            &format!("older answer {n} {}", "detail ".repeat(60)),
        ));
    }
    seed_session(&config, KEY, &seed);
    {
        let conn = db::open_db(&config.db_path).unwrap();
        db::ensure_schema(&conn).unwrap();
        crate::context_tree::store::ensure_tables(&conn).unwrap();
        crate::context_tree::settings::Settings::save(
            &conn,
            &serde_json::json!({"policy_mode": "manual"}),
        )
        .unwrap();
        crate::context_policy::store::ensure_tables(&conn).unwrap();
        crate::context_policy::store::set_pin(
            &conn,
            KEY,
            crate::context_policy::PolicyId::parse(policy).unwrap(),
            &serde_json::Map::new(),
            1,
        )
        .unwrap();
    }
    let (base, requests) = spawn_mock_provider_with(MockProviderScript {
        response_model: None,
        first_response_tool_call: None,
        responder: Some(bench_responder),
    });
    let (handle, events) = launch(config.clone(), &base);
    ask(
        &handle,
        KEY,
        "BENCH read report.txt and sum the quarterly numbers",
    );
    finish(&events);
    let bodies = main_bodies(&requests);
    assert!(bodies.len() >= 2, "{policy}: a tool step and an answer");
    let conn = db::open_db(&config.db_path).unwrap();
    let metrics = crate::context_policy::metrics::compute(&conn, KEY, 50)
        .unwrap()
        .to_json();
    Run {
        policy,
        requests: bodies.len(),
        follow_bytes: transcript(&bodies[1]).len(),
        first: bodies[0].clone(),
        follow: bodies[1].clone(),
        metrics,
    }
}

#[test]
fn every_policy_keeps_the_task_and_never_sends_more_than_t7() {
    let runs: Vec<Run> = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"]
        .into_iter()
        .map(run)
        .collect();
    let t7 = runs.iter().find(|r| r.policy == "T7").unwrap();
    eprintln!("policy  requests  follow-up bytes  vs T7   savedPct(metrics)  status");
    for r in &runs {
        let m = &r.metrics["byPolicy"][r.policy];
        eprintln!(
            "{:<6}  {:>8}  {:>15}  {:>5.0}%  {:>17}  {}",
            r.policy,
            r.requests,
            r.follow_bytes,
            100.0 * r.follow_bytes as f64 / t7.follow_bytes as f64,
            m["savedPct"],
            if m["completed"] == 1 {
                "completed"
            } else {
                "NOT completed"
            }
        );
        assert_eq!(r.requests, t7.requests, "{}: no extra request", r.policy);
        assert_eq!(
            r.first["tools"], r.follow["tools"],
            "{}: tools unchanged",
            r.policy
        );
        assert_eq!(
            r.follow["tools"], t7.follow["tools"],
            "{}: tools as T7",
            r.policy
        );
        assert_eq!(
            rules_part(&r.follow),
            rules_part(&t7.follow),
            "{}: rules unchanged",
            r.policy
        );
        let f = transcript(&r.follow);
        assert!(
            f.contains("BENCH read report.txt"),
            "{}: the request is sent",
            r.policy
        );
        assert!(
            f.contains("REPORT-BODY"),
            "{}: the task's result is sent",
            r.policy
        );
        assert!(
            r.follow_bytes <= t7.follow_bytes,
            "{}: never larger than T7 ({} > {})",
            r.policy,
            r.follow_bytes,
            t7.follow_bytes
        );
        assert_eq!(m["tasks"], 1, "{}: one task recorded", r.policy);
        assert_eq!(m["completed"], 1, "{}: the task completed", r.policy);
        assert!(
            m["requests"].as_u64().unwrap() >= 1,
            "{}: tokens recorded",
            r.policy
        );
        assert!(
            m["avgLatencyMs"].is_number(),
            "{}: latency recorded",
            r.policy
        );
    }
    for p in ["T1", "T2", "T6"] {
        let r = runs.iter().find(|r| r.policy == p).unwrap();
        assert!(
            r.follow_bytes < t7.follow_bytes,
            "{p} leaves older turns out: {} vs {}",
            r.follow_bytes,
            t7.follow_bytes
        );
        assert!(
            !transcript(&r.follow).contains("OLDER-1"),
            "{p}: oldest turn left out"
        );
        assert!(
            r.metrics["byPolicy"][p]["savedPct"].as_f64().unwrap() > 0.0,
            "{p}: metrics show a saving"
        );
    }
    assert!(
        transcript(&t7.follow).contains("OLDER-1"),
        "T7 sends everything"
    );
}
