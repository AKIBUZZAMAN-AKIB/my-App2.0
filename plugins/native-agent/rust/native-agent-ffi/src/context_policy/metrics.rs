//! TCPE metrics: what the policies did, from the stored tasks and events.
//!
//! Per policy: tasks and how they ended, requests, tokens sent against what T7
//! would have sent, the share saved, average latency and time to first token,
//! fallbacks, retries and escalations; and per selection source (pin, rule, the
//! model's same-reply `ctx task`, auto). Read by `policy.metrics` and the
//! benchmark tests. Nothing here is estimated: a value no event recorded stays
//! `null`.

use super::store;
use super::types::{PolicyId, TaskStatus};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Default, Clone, Debug, PartialEq)]
pub struct PolicyStats {
    pub tasks: u32,
    pub completed: u32,
    pub failed: u32,
    pub fallback: u32,
    pub timed_out: u32,
    pub other: u32,
    pub requests: u32,
    pub input_tokens: i64,
    pub t7_tokens: i64,
    pub latency_ms: Vec<i64>,
    pub first_token_ms: Vec<i64>,
    pub fallbacks: u32,
    pub retries: u32,
    pub escalations: u32,
}

fn avg(v: &[i64]) -> Option<f64> {
    (!v.is_empty()).then(|| v.iter().sum::<i64>() as f64 / v.len() as f64)
}

impl PolicyStats {
    /// Share of tokens saved against T7, 0..=100, when anything was measured.
    pub fn saved_pct(&self) -> Option<f64> {
        (self.t7_tokens > 0)
            .then(|| (1.0 - self.input_tokens as f64 / self.t7_tokens as f64).max(0.0) * 100.0)
    }
    pub fn to_json(&self) -> Value {
        json!({
            "tasks": self.tasks,
            "completed": self.completed,
            "failed": self.failed,
            "fallback": self.fallback,
            "timedOut": self.timed_out,
            "other": self.other,
            "successRate": (self.tasks > 0).then(|| self.completed as f64 / self.tasks as f64),
            "requests": self.requests,
            "inputTokens": self.input_tokens,
            "t7Tokens": self.t7_tokens,
            "savedPct": self.saved_pct(),
            "avgLatencyMs": avg(&self.latency_ms),
            "avgFirstTokenMs": avg(&self.first_token_ms),
            "fallbacks": self.fallbacks,
            "retries": self.retries,
            "escalations": self.escalations,
        })
    }
}

#[derive(Default, Debug)]
pub struct Metrics {
    pub by_policy: BTreeMap<String, PolicyStats>,
    pub by_source: BTreeMap<String, u32>,
    pub total: PolicyStats,
}

impl Metrics {
    pub fn to_json(&self) -> Value {
        let mut p = Map::new();
        for (k, v) in &self.by_policy {
            p.insert(k.clone(), v.to_json());
        }
        json!({
            "byPolicy": Value::Object(p),
            "bySource": self.by_source,
            "total": self.total.to_json(),
        })
    }
}

/// Metrics over the newest `limit` tasks of a chat.
pub fn compute(conn: &Connection, session_key: &str, limit: i64) -> rusqlite::Result<Metrics> {
    let tasks = store::recent_tasks(conn, session_key, limit)?;
    let mut m = Metrics::default();
    for t in &tasks {
        let events = store::events(conn, session_key, Some(&t.task_id), 5000)?;
        let mut s = PolicyStats {
            tasks: 1,
            retries: t.retries,
            escalations: t.escalations,
            ..Default::default()
        };
        match t.status {
            TaskStatus::Completed => s.completed = 1,
            TaskStatus::Failed => s.failed = 1,
            TaskStatus::Fallback => s.fallback = 1,
            TaskStatus::TimedOut => s.timed_out = 1,
            _ => s.other = 1,
        }
        for e in &events {
            match e["kind"].as_str() {
                Some("tokens") => {
                    s.requests += 1;
                    s.input_tokens += e["inputTokens"].as_i64().unwrap_or(0);
                    s.t7_tokens += e["t7Tokens"].as_i64().unwrap_or(0);
                    if let Some(l) = e["latencyMs"].as_i64() {
                        s.latency_ms.push(l);
                    }
                    if let Some(f) = e["firstTokenMs"].as_i64() {
                        s.first_token_ms.push(f);
                    }
                }
                Some("fallback") => s.fallbacks += 1,
                _ => {}
            }
        }
        add(
            m.by_policy
                .entry(t.policy_id.as_str().to_string())
                .or_default(),
            &s,
        );
        add(&mut m.total, &s);
        *m.by_source
            .entry(t.source.as_str().to_string())
            .or_default() += 1;
    }
    Ok(m)
}

fn add(a: &mut PolicyStats, b: &PolicyStats) {
    a.tasks += b.tasks;
    a.completed += b.completed;
    a.failed += b.failed;
    a.fallback += b.fallback;
    a.timed_out += b.timed_out;
    a.other += b.other;
    a.requests += b.requests;
    a.input_tokens += b.input_tokens;
    a.t7_tokens += b.t7_tokens;
    a.latency_ms.extend_from_slice(&b.latency_ms);
    a.first_token_ms.extend_from_slice(&b.first_token_ms);
    a.fallbacks += b.fallbacks;
    a.retries += b.retries;
    a.escalations += b.escalations;
}

/// Every policy id, for a table with a row each.
pub fn policy_ids() -> Vec<&'static str> {
    [
        PolicyId::T1,
        PolicyId::T2,
        PolicyId::T3,
        PolicyId::T4,
        PolicyId::T5,
        PolicyId::T6,
        PolicyId::T7,
    ]
    .iter()
    .map(|p| p.as_str())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_policy::store::{EventRow, TaskRow};
    use crate::context_policy::types::Source;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        store::ensure_tables(&c).unwrap();
        c
    }

    fn task(c: &Connection, id: &str, p: PolicyId, src: Source, st: TaskStatus) {
        let t = TaskRow {
            task_id: id.into(),
            session_key: "s".into(),
            goal_json: json!({}),
            checklist_json: json!({}),
            policy_id: p,
            params: Map::new(),
            source: src,
            status: st,
            retries: 1,
            escalations: 0,
            started_at: 1,
            ended_at: Some(2),
        };
        store::insert_task(c, &t).unwrap();
    }

    fn ev(c: &Connection, id: &str, kind: &str, sent: i64, t7: i64, lat: Option<i64>) {
        let e = EventRow {
            task_id: Some(id.into()),
            step: 1,
            kind: kind.into(),
            policy_id: None,
            included_ids: vec![],
            excluded_ids: vec![],
            reason: None,
            input_tokens: Some(sent),
            t7_tokens: Some(t7),
            latency_ms: lat,
            first_token_ms: lat.map(|l| l / 2),
        };
        store::insert_event(c, "s", &e, 1).unwrap();
    }

    #[test]
    fn metrics_add_up_per_policy_and_source() {
        let c = db();
        task(&c, "a", PolicyId::T1, Source::Ai, TaskStatus::Completed);
        ev(&c, "a", "tokens", 100, 1000, Some(40));
        ev(&c, "a", "tokens", 200, 1000, Some(60));
        task(
            &c,
            "b",
            PolicyId::T7,
            Source::Fallback,
            TaskStatus::Fallback,
        );
        ev(&c, "b", "tokens", 1000, 1000, None);
        ev(&c, "b", "fallback", 0, 0, None);
        let m = compute(&c, "s", 50).unwrap();
        let t1 = &m.by_policy["T1"];
        assert_eq!((t1.tasks, t1.completed, t1.requests), (1, 1, 2));
        assert_eq!((t1.input_tokens, t1.t7_tokens), (300, 2000));
        assert_eq!(t1.saved_pct(), Some(85.0));
        assert_eq!(t1.to_json()["avgLatencyMs"], json!(50.0));
        assert_eq!(t1.to_json()["avgFirstTokenMs"], json!(25.0));
        let t7 = &m.by_policy["T7"];
        assert_eq!((t7.fallback, t7.fallbacks), (1, 1));
        assert_eq!(t7.to_json()["avgLatencyMs"], Value::Null);
        assert_eq!(m.by_source["ai"], 1);
        assert_eq!(m.total.tasks, 2);
        assert_eq!(m.total.retries, 2);
        assert_eq!(m.to_json()["total"]["successRate"], json!(0.5));
    }

    #[test]
    fn no_tasks_is_empty_not_an_error() {
        let m = compute(&db(), "s", 50).unwrap();
        assert!(m.by_policy.is_empty());
        assert_eq!(m.to_json()["total"]["savedPct"], Value::Null);
        assert_eq!(policy_ids().len(), 7);
    }
}
