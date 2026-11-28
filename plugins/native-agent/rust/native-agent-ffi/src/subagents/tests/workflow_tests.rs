//! Tests for workflows (workflows.rs): validation, automatic hand-off between
//! steps, parallel fan-out and join, router branches, loops and failures.
//! The scripted runner answers `done: <brief>`, so each step's brief (and the
//! upstream output inside it) shows up in the next step's input.

use super::*;

fn wf(v: Value) -> Workflow {
    serde_json::from_value(v).unwrap()
}

async fn run(
    mgr: &Arc<SubagentManager>,
    env: &ParentEnv,
    w: Value,
    input: &str,
) -> (Workflow, WorkflowRun) {
    let (saved, _) = mgr.save_workflow(wf(w), &env.session_key).expect("saved");
    let r = tokio::time::timeout(
        Duration::from_secs(30),
        mgr.run_workflow(saved.clone(), input.into(), 0, env.clone()),
    )
    .await
    .expect("run ends");
    (saved, r)
}

fn prompts(script: &Arc<Script>) -> Vec<String> {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|r| r.0.clone())
        .collect()
}

#[test]
fn validation_catches_bad_graphs() {
    let mut cyc = wf(json!({"name": "c", "nodes": [
        {"id": "a", "task": "x"}, {"id": "b", "task": "y"}],
        "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]}));
    assert!(workflows::normalize_workflow(&mut cyc)
        .unwrap_err()
        .contains("cycle"));

    let mut looped = wf(json!({"name": "c", "nodes": [
        {"id": "a", "task": "x"}, {"id": "b", "task": "y"}],
        "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a", "loop": true}]}));
    workflows::normalize_workflow(&mut looped).unwrap();
    assert_eq!(looped.nodes[0].max_runs, Some(3));
    assert!(looped.nodes.iter().all(|n| n.position.is_some()));

    let mut missing = wf(json!({"name": "m", "nodes": [{"id": "a", "task": "x"}],
        "edges": [{"from": "a", "to": "zzz"}]}));
    assert!(workflows::normalize_workflow(&mut missing)
        .unwrap_err()
        .contains("zzz"));

    let mut bad_route = wf(json!({"name": "r", "nodes": [
        {"id": "r", "kind": "router", "task": "x", "routes": ["a", "b"]}, {"id": "t", "task": "y"}],
        "edges": [{"from": "r", "to": "t", "when": {"type": "route", "value": "c"}}]}));
    assert!(workflows::normalize_workflow(&mut bad_route).is_err());

    // Edges may name nodes by label.
    let mut by_label = wf(json!({"name": "l", "nodes": [
        {"label": "Research", "task": "x"}, {"label": "Write", "task": "y"}],
        "edges": [{"source": "Research", "target": "Write"}]}));
    workflows::normalize_workflow(&mut by_label).unwrap();
    assert_eq!(by_label.edges[0].from, "research");
    assert_eq!(by_label.edges[0].to, "write");
}

#[tokio::test]
async fn sequential_steps_pass_results_on() {
    let (mgr, script, _app, env, _dir) = setup();
    let (_, r) = run(
        &mgr,
        &env,
        json!({"name": "pipe", "nodes": [
        {"id": "research", "task": "research {{input}}"},
        {"id": "write", "task": "write it up"}],
        "edges": [{"from": "research", "to": "write"}]}),
        "rust",
    )
    .await;
    assert_eq!(r.status, "finished", "{:?}", r);
    assert_eq!(r.trace, vec!["research", "write"]);
    let p = prompts(&script);
    assert_eq!(p.len(), 2);
    assert!(p[0].contains("research rust"));
    // The writer got the researcher's report without any relay.
    assert!(
        p[1].contains("write it up") && p[1].contains("done: research rust"),
        "{}",
        p[1]
    );
    assert!(r.output.unwrap().contains("write it up"));
    // The run was saved.
    assert_eq!(mgr.workflow_runs()[0].id, r.id);
}

#[tokio::test]
async fn fan_out_runs_in_parallel_and_joins() {
    let (mgr, script, _app, env, _dir) = setup();
    let (_, r) = run(
        &mgr,
        &env,
        json!({"name": "fan", "nodes": [
        {"id": "plan", "kind": "transform", "template": "topic: {{input}}"},
        {"id": "a", "task": "wfsleep"},
        {"id": "b", "task": "wfsleep"},
        {"id": "join", "kind": "merge"},
        {"id": "out", "kind": "output", "template": "A={{node.a}} | B={{node.b}}"}],
        "edges": [{"from": "plan", "to": "a"}, {"from": "plan", "to": "b"},
                  {"from": "a", "to": "join"}, {"from": "b", "to": "join"},
                  {"from": "join", "to": "out"}]}),
        "x",
    )
    .await;
    assert_eq!(r.status, "finished", "{:?}", r);
    assert!(
        script.max_concurrent.load(Ordering::SeqCst) >= 2,
        "a and b ran in parallel"
    );
    assert_eq!(r.nodes["join"].status, "finished");
    let joined = r.nodes["join"].output.clone().unwrap();
    assert!(joined.contains("### From a") && joined.contains("### From b"));
    let out = r.output.unwrap();
    assert!(
        out.starts_with("A=done:") && out.contains("| B=done:"),
        "{}",
        out
    );
}

#[tokio::test]
async fn router_takes_one_branch_and_skips_the_other() {
    let (mgr, script, _app, env, _dir) = setup();
    let (_, r) = run(&mgr, &env, json!({"name": "triage", "nodes": [
        {"id": "triage", "kind": "router", "routes": ["billing", "tech"], "task": "classify\nROUTE: tech"},
        {"id": "billing", "task": "billing desk"},
        {"id": "tech", "task": "tech desk"},
        {"id": "after_billing", "task": "refund"}],
        "edges": [{"from": "triage", "to": "billing", "when": {"type": "route", "value": "billing"}},
                  {"from": "triage", "to": "tech", "when": {"type": "route", "value": "tech"}},
                  {"from": "billing", "to": "after_billing"}]}), "my wifi is down").await;
    assert_eq!(r.status, "finished", "{:?}", r);
    assert_eq!(r.nodes["triage"].route.as_deref(), Some("tech"));
    assert_eq!(r.nodes["tech"].status, "finished");
    assert_eq!(r.nodes["billing"].status, "skipped");
    assert_eq!(r.nodes["after_billing"].status, "skipped");
    assert_eq!(prompts(&script).len(), 2);
    // The ROUTE line is not passed on.
    let tech_prompt = prompts(&script)[1].clone();
    assert!(tech_prompt.contains("tech desk"));
}

#[tokio::test]
async fn loop_reruns_until_max_runs_then_exits() {
    let (mgr, script, _app, env, _dir) = setup();
    let (_, r) = run(&mgr, &env, json!({"name": "review", "nodes": [
        {"id": "writer", "task": "draft", "max_runs": 2},
        {"id": "critic", "task": "review it"},
        {"id": "publish", "kind": "output"}],
        "edges": [{"from": "writer", "to": "critic"},
                  {"from": "critic", "to": "writer", "loop": true, "when": {"type": "not_contains", "value": "APPROVED"}},
                  {"from": "critic", "to": "publish", "when": {"type": "contains", "value": "APPROVED"}}]}), "").await;
    assert_eq!(r.status, "finished", "{:?}", r);
    assert_eq!(r.nodes["writer"].runs, 2);
    assert_eq!(r.nodes["writer"].runs, 2, "{:#?}", r);
    assert_eq!(
        r.trace,
        vec!["writer", "critic", "writer", "critic", "publish"],
        "{:#?}",
        r.nodes
    );
    // The second draft saw the critic's feedback, in the same sub-agent.
    let p = prompts(&script);
    assert!(p[2].contains("(feedback)"), "{}", p[2]);
    assert_eq!(r.nodes["publish"].status, "finished");
    assert_eq!(
        mgr.list()
            .iter()
            .filter(|s| s.name.starts_with("wf-writer"))
            .count(),
        1
    );
}

#[tokio::test]
async fn failure_takes_the_error_path() {
    let (mgr, _script, _app, env, _dir) = setup();
    let (_, r) = run(
        &mgr,
        &env,
        json!({"name": "err", "nodes": [
        {"id": "risky", "task": "wffail"},
        {"id": "ok", "task": "celebrate"},
        {"id": "fix", "kind": "output", "template": "handled: {{last}}"}],
        "edges": [{"from": "risky", "to": "ok"},
                  {"from": "risky", "to": "fix", "when": {"type": "failed"}}]}),
        "",
    )
    .await;
    assert_eq!(r.nodes["risky"].status, "error", "{:?}", r);
    assert_eq!(r.nodes["ok"].status, "skipped");
    assert_eq!(r.nodes["fix"].status, "finished");
    assert_eq!(r.status, "finished");
    assert!(r.output.unwrap().starts_with("handled: "));
}

#[tokio::test]
async fn the_agent_builds_and_runs_a_workflow_through_its_tool() {
    let (mgr, _script, app, env, _dir) = setup();
    let (out, err) = run_tool(
        &mgr,
        TOOL_WORKFLOW,
        json!({
        "action": "create", "name": "Brief",
        "nodes": [{"id": "a", "task": "step one {{input}}"}, {"id": "b", "task": "step two"}],
        "edges": [{"from": "a", "to": "b"}],
        "run": true, "input": "hello"}),
        &env,
    )
    .await;
    assert!(!err, "{}", out);
    assert!(
        out.contains("Saved workflow") && out.contains(": finished."),
        "{}",
        out
    );
    assert!(out.contains("Final output:"));
    let (list, _) = run_tool(&mgr, TOOL_WORKFLOW, json!({"action": "list"}), &env).await;
    assert!(list.contains("Brief") && list.contains("2 nodes"));
    let (upd, err) = run_tool(
        &mgr,
        TOOL_WORKFLOW,
        json!({"action": "update", "id": "Brief",
        "add_nodes": [{"id": "c", "kind": "output"}], "add_edges": [{"from": "b", "to": "c"}]}),
        &env,
    )
    .await;
    assert!(
        !err && upd.contains("version 2") && upd.contains("b -> c"),
        "{}",
        upd
    );
    let events = app.0.lock().unwrap();
    assert!(events.iter().any(|(t, _)| t == "workflow.run"));
    assert!(events.iter().any(|(t, _)| t == "workflow.changed"));
}
