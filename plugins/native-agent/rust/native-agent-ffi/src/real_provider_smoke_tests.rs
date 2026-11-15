//! Real-provider smoke test driver (ignored by default; never runs in CI).
//!
//! Runs the app's real entry point (`NativeAgentHandle::send_message` -> agent
//! loop -> llm_driver) against a real provider through the recording proxy in
//! `tools/real-provider-smoke/proxy.py`. The scenario (seed transcript,
//! workspace files, prompts with provider/model) comes from the JSON file in
//! `SMOKE_SCENARIO_FILE`; every event the app emits is written to
//! `$SMOKE_OUT/events.jsonl` and the chat's memory row to `memory.json`.
//! Judging happens afterwards in `tools/real-provider-smoke/analyze.py`, from
//! these events and the proxy's record of the real requests and responses.
//!
//! Run: SMOKE_PROXY=http://127.0.0.1:8899 SMOKE_SCENARIO_FILE=... SMOKE_OUT=...
//!      cargo test --lib real_provider_smoke -- --ignored --nocapture
//! No API key is involved: Kilo's free routes and OVHcloud's anonymous tier.

use crate::types;
use crate::{db, NativeAgentHandle, NativeEventCallback};
use std::io::Write;
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct Record(mpsc::Sender<(String, String)>);

impl NativeEventCallback for Record {
    fn on_event(&self, event_type: String, payload_json: String) {
        let _ = self.0.send((event_type, payload_json));
    }
}

fn role(r: &str) -> types::Role {
    if r == "assistant" { types::Role::Assistant } else { types::Role::User }
}

#[test]
#[ignore = "talks to a real provider; run by hand with SMOKE_PROXY and SMOKE_SCENARIO_FILE"]
fn real_provider_smoke() {
    let proxy = std::env::var("SMOKE_PROXY").expect("SMOKE_PROXY");
    let scenario: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("SMOKE_SCENARIO_FILE").expect("SMOKE_SCENARIO_FILE")).unwrap()).unwrap();
    let out = std::path::PathBuf::from(std::env::var("SMOKE_OUT").expect("SMOKE_OUT"));
    std::fs::create_dir_all(&out).unwrap();

    let root = std::env::temp_dir().join(format!("na-smoke-{}", uuid::Uuid::new_v4()));
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = types::InitConfig {
        db_path: root.join("agent.db").display().to_string(),
        workspace_path: workspace.display().to_string(),
        auth_profiles_path: root.join("auth-profiles.json").display().to_string(),
    };
    if let Some(files) = scenario["workspace_files"].as_object() {
        for (name, body) in files {
            std::fs::write(workspace.join(name), body.as_str().unwrap_or_default()).unwrap();
        }
    }
    let session = scenario["session"].as_str().unwrap_or("smoke").to_string();
    if let Some(seed) = scenario["seed"].as_array() {
        let msgs: Vec<types::Message> = seed
            .iter()
            .map(|m| types::Message { role: role(m[0].as_str().unwrap()), content: types::MessageContent::Text(m[1].as_str().unwrap().to_string()) })
            .collect();
        let conn = db::open_db(&config.db_path).unwrap();
        db::ensure_schema(&conn).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        db::save_session(&conn, &session, "main", &serde_json::to_string(&msgs).unwrap(), None, None, now, None).unwrap();
    }

    let handle = NativeAgentHandle::new(config.clone()).unwrap();
    // Every provider the scenario may touch goes through the proxy; OpenRouter
    // (the Free Router's keyed fallback) points at a dead port so nothing can
    // leave unrecorded.
    let mut runtime = serde_json::json!({ "providerBaseUrls": {
        "kilo": format!("{proxy}/kilo"),
        "ovhcloud": format!("{proxy}/ovh"),
        "openrouter": "http://127.0.0.1:9"
    } });
    // Optional extra runtime settings from the scenario (e.g. per-model streaming capability).
    if let Some(extra) = scenario["runtime"].as_object() {
        for (k, v) in extra {
            runtime[k] = v.clone();
        }
    }
    std::fs::write(crate::runtime_config::runtime_config_path(&config.workspace_path), runtime.to_string()).unwrap();
    // The app learns OVH tool capability from the catalog fetched by get_models.
    if let Some(list) = scenario["warm_models"].as_array() {
        for p in list {
            let res = handle.get_models(p.as_str().unwrap().to_string());
            let summary = match &res {
                Ok(s) => s.chars().take(4000).collect::<String>(),
                Err(e) => format!("error: {e:?}"),
            };
            std::fs::write(out.join(format!("models-{}.txt", p.as_str().unwrap())), summary).ok();
        }
    }
    let (tx, rx) = mpsc::channel();
    handle.set_event_callback(Box::new(Record(tx))).unwrap();
    let mut log = std::fs::File::create(out.join("events.jsonl")).unwrap();
    let started = Instant::now();

    for (i, p) in scenario["prompts"].as_array().unwrap().iter().enumerate() {
        writeln!(log, "{}", serde_json::json!({"t_ms": started.elapsed().as_millis() as u64, "prompt": i, "event": "smoke.prompt", "payload": p})).unwrap();
        handle
            .send_message(types::SendMessageParams {
                prompt: p["prompt"].as_str().unwrap().into(),
                session_key: session.clone(),
                model: p["model"].as_str().map(str::to_string),
                provider: Some(p["provider"].as_str().unwrap_or("auto").to_string()),
                system_prompt: String::new(),
                max_turns: Some(scenario["max_turns"].as_u64().unwrap_or(6) as u32),
                allowed_tools_json: p.get("allowed_tools").map(|v| v.to_string()),
                prior_messages_json: None,
                attachments_json: None,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(scenario["timeout_s"].as_u64().unwrap_or(900));
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let Ok((event, payload)) = rx.recv_timeout(left.max(Duration::from_millis(1))) else {
                writeln!(log, "{}", serde_json::json!({"t_ms": started.elapsed().as_millis() as u64, "prompt": i, "event": "smoke.timeout"})).unwrap();
                break;
            };
            let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::Value::String(payload.clone()));
            writeln!(log, "{}", serde_json::json!({"t_ms": started.elapsed().as_millis() as u64, "prompt": i, "event": event, "payload": parsed})).unwrap();
            if event == "agent.completed" || event == "agent.error" {
                break;
            }
        }
        // Let trailing events (memory commit, background work) land.
        std::thread::sleep(Duration::from_secs(2));
        while let Ok((event, payload)) = rx.try_recv() {
            let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::Value::String(payload.clone()));
            writeln!(log, "{}", serde_json::json!({"t_ms": started.elapsed().as_millis() as u64, "prompt": i, "event": event, "payload": parsed})).unwrap();
        }
    }

    let conn = db::open_db(&config.db_path).unwrap();
    let memory: Option<String> = conn
        .query_row("SELECT memory_json FROM turn_memory WHERE session_key = ?1", [&session], |r| r.get(0))
        .ok();
    std::fs::write(out.join("memory.json"), memory.unwrap_or_else(|| "null".into())).unwrap();
    let archived: i64 = conn.query_row("SELECT COUNT(*) FROM turn_archive WHERE session_key = ?1", [&session], |r| r.get(0)).unwrap_or(-1);
    let fts: i64 = conn.query_row("SELECT COUNT(*) FROM turn_fts WHERE session_key = ?1", [&session], |r| r.get(0)).unwrap_or(-1);
    std::fs::write(out.join("db.json"), serde_json::json!({"archived_turns": archived, "fts_rows": fts}).to_string()).unwrap();
    std::fs::remove_dir_all(&root).ok();
}
