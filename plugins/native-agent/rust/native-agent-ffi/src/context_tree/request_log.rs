//! The request ledger: every model request a turn really made.
//!
//! One user message is one *turn* in the chat, but answering it can take many
//! requests to the model: one per tool step, a retry after a context overflow,
//! and the summarizer's own requests when the chat memory folds old turns.
//! The checklist's Activity tab reads this ledger to show, per turn, how many
//! requests were really sent and what they cost:
//!
//! * `full_tokens`: what the request would have carried with every item of the
//!   chat in (system prompt, tools and the whole stored transcript plus the
//!   messages of this turn), the number the checklist is measured against;
//! * `sent_tokens`: what was sent after the checklist, the memory and the
//!   context policy took their share out (the engine's own meter);
//! * `input_tokens` / `output_tokens`: what the provider reported (0 when it
//!   reported nothing, for example on an overflow error).
//!
//! The ledger is always on (it does not depend on the checklist or the context
//! policy being enabled) and best effort: a failure to write it never blocks a
//! request. Rows are kept per session and trimmed to the newest
//! [`KEEP_ROWS`].

use rusqlite::{params, Connection, Result};
use serde_json::{json, Value};

/// Newest rows kept per session.
pub const KEEP_ROWS: i64 = 4_000;
/// Turns returned by [`summary`] (newest first).
pub const SUMMARY_TURNS: usize = 60;

/// What a request was for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind {
    /// A step of the agent loop (the answer or a tool step).
    Step,
    /// The summarizer folding old turns into the chat memory.
    Summary,
}

impl RequestKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RequestKind::Step => "step",
            RequestKind::Summary => "summary",
        }
    }
}

/// One request, as the agent loop saw it.
#[derive(Debug, Clone, Default)]
pub struct RequestRow {
    /// Absolute turn number (the one the checklist shows). `None` attributes the
    /// request to the newest turn already in the ledger (background summaries).
    pub turn: Option<u32>,
    /// 1-based step inside the turn (the agent loop's iteration).
    pub step: u32,
    pub kind: &'static str,
    /// `ok`, `overflow` (the provider rejected the context and it was retried)
    /// or `error`.
    pub status: &'static str,
    pub model: String,
    pub full_tokens: u64,
    pub sent_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub latency_ms: u64,
    /// The user's prompt of the turn (clipped), stored with the first step.
    pub prompt: Option<String>,
    /// Context policy that built the step (`T1`..`T7`), when one did.
    pub policy: Option<String>,
}

pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ctx_request_log (
            session_key   TEXT NOT NULL,
            seq           INTEGER PRIMARY KEY AUTOINCREMENT,
            turn          INTEGER NOT NULL DEFAULT 0,
            step          INTEGER NOT NULL DEFAULT 0,
            kind          TEXT NOT NULL DEFAULT 'step',
            status        TEXT NOT NULL DEFAULT 'ok',
            model         TEXT NOT NULL DEFAULT '',
            full_tokens   INTEGER NOT NULL DEFAULT 0,
            sent_tokens   INTEGER NOT NULL DEFAULT 0,
            input_tokens  INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            latency_ms    INTEGER NOT NULL DEFAULT 0,
            prompt        TEXT,
            policy        TEXT,
            at_ms         INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ctx_request_log_turn
            ON ctx_request_log(session_key, turn);",
    )
}

fn clip(text: &str, max: usize) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let mut out: String = one_line.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Store one request. Returns the absolute turn it was filed under.
pub fn record(conn: &Connection, session_key: &str, row: &RequestRow, now_ms: i64) -> Result<u32> {
    ensure_table(conn)?;
    let turn = match row.turn {
        Some(t) => t,
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(turn), 0) FROM ctx_request_log WHERE session_key = ?1",
                params![session_key],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0) as u32,
    };
    conn.execute(
        "INSERT INTO ctx_request_log (session_key, turn, step, kind, status, model,
            full_tokens, sent_tokens, input_tokens, output_tokens, latency_ms, prompt, policy, at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            session_key,
            turn as i64,
            row.step as i64,
            row.kind,
            row.status,
            row.model,
            row.full_tokens as i64,
            row.sent_tokens as i64,
            row.input_tokens as i64,
            row.output_tokens as i64,
            row.latency_ms as i64,
            row.prompt.as_deref().map(|p| clip(p, 160)),
            row.policy,
            now_ms,
        ],
    )?;
    // Keep the ledger bounded.
    conn.execute(
        "DELETE FROM ctx_request_log WHERE session_key = ?1 AND seq <= (
             SELECT seq FROM ctx_request_log WHERE session_key = ?1
             ORDER BY seq DESC LIMIT 1 OFFSET ?2)",
        params![session_key, KEEP_ROWS],
    )?;
    Ok(turn)
}

/// Forget a session's ledger (the chat was reset or deleted).
pub fn clear(conn: &Connection, session_key: &str) -> Result<()> {
    ensure_table(conn)?;
    conn.execute(
        "DELETE FROM ctx_request_log WHERE session_key = ?1",
        params![session_key],
    )?;
    Ok(())
}

fn pct(saved: u64, full: u64) -> f64 {
    if full == 0 {
        0.0
    } else {
        ((saved as f64 / full as f64) * 1000.0).round() / 10.0
    }
}

#[derive(Default)]
struct Acc {
    requests: u64,
    steps: u64,
    summaries: u64,
    overflows: u64,
    full: u64,
    sent: u64,
    input: u64,
    output: u64,
    latency: u64,
    first_at: i64,
    last_at: i64,
    prompt: Option<String>,
    models: Vec<String>,
    list: Vec<Value>,
}

impl Acc {
    fn totals(&self) -> Value {
        // Savings are measured on one meter (the engine's), so they never mix
        // an estimate with the provider's count. Summarizer requests have no
        // "full" counterpart: they are reported apart and add to the cost.
        let saved = self.full.saturating_sub(self.sent);
        json!({
            "requests": self.requests,
            "steps": self.steps,
            "summaryRequests": self.summaries,
            "overflowRetries": self.overflows,
            "fullTokens": self.full,
            "sentTokens": self.sent,
            "savedTokens": saved,
            "savedPct": pct(saved, self.full),
            "inputTokens": self.input,
            "outputTokens": self.output,
            "latencyMs": self.latency,
        })
    }
}

/// The ledger of a session, ready for the panel: per-turn totals (newest
/// first, at most [`SUMMARY_TURNS`] turns, each with its requests in order)
/// and the totals of the whole chat.
pub fn summary(conn: &Connection, session_key: &str) -> Value {
    if ensure_table(conn).is_err() {
        return json!({"turns": [], "total": Value::Null});
    }
    let rows: Vec<(
        u32,
        u32,
        String,
        String,
        String,
        u64,
        u64,
        u64,
        u64,
        u64,
        Option<String>,
        Option<String>,
        i64,
    )> = (|| -> Result<_> {
        let mut stmt = conn.prepare(
            "SELECT turn, step, kind, status, model, full_tokens, sent_tokens, input_tokens,
                    output_tokens, latency_ms, prompt, policy, at_ms
             FROM ctx_request_log WHERE session_key = ?1 ORDER BY seq ASC",
        )?;
        let it = stmt.query_map(params![session_key], |r| {
            Ok((
                r.get::<_, i64>(0)? as u32,
                r.get::<_, i64>(1)? as u32,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?.max(0) as u64,
                r.get::<_, i64>(6)?.max(0) as u64,
                r.get::<_, i64>(7)?.max(0) as u64,
                r.get::<_, i64>(8)?.max(0) as u64,
                r.get::<_, i64>(9)?.max(0) as u64,
                r.get::<_, Option<String>>(10)?,
                r.get::<_, Option<String>>(11)?,
                r.get::<_, i64>(12)?,
            ))
        })?;
        it.collect()
    })()
    .unwrap_or_default();

    let mut total = Acc::default();
    let mut turns: std::collections::BTreeMap<u32, Acc> = std::collections::BTreeMap::new();
    for (turn, step, kind, status, model, full, sent, input, output, latency, prompt, policy, at) in
        rows
    {
        let is_summary = kind == "summary";
        for acc in [&mut total, turns.entry(turn).or_default()] {
            acc.requests += 1;
            if is_summary {
                acc.summaries += 1;
            } else {
                acc.steps += 1;
                acc.full += full;
                acc.sent += sent;
            }
            if status == "overflow" {
                acc.overflows += 1;
            }
            acc.input += input;
            acc.output += output;
            acc.latency += latency;
            if acc.first_at == 0 || at < acc.first_at {
                acc.first_at = at;
            }
            acc.last_at = acc.last_at.max(at);
            if !model.is_empty() && !acc.models.contains(&model) {
                acc.models.push(model.clone());
            }
        }
        let acc = turns.get_mut(&turn).expect("inserted above");
        if acc.prompt.is_none() {
            acc.prompt = prompt.clone();
        }
        let saved = if is_summary {
            0
        } else {
            full.saturating_sub(sent)
        };
        acc.list.push(json!({
            "n": acc.list.len() + 1,
            "step": step,
            "kind": kind,
            "status": status,
            "model": model,
            "fullTokens": if is_summary { Value::Null } else { json!(full) },
            "sentTokens": sent,
            "savedTokens": saved,
            "savedPct": pct(saved, full),
            "inputTokens": input,
            "outputTokens": output,
            "latencyMs": latency,
            "policy": policy,
            "at": at,
        }));
    }
    let turn_count = turns.len();
    let list: Vec<Value> = turns
        .iter()
        .rev()
        .take(SUMMARY_TURNS)
        .map(|(turn, acc)| {
            let mut v = acc.totals();
            v["turn"] = json!(turn);
            v["prompt"] = json!(acc.prompt);
            v["models"] = json!(acc.models);
            v["startedAt"] = json!(acc.first_at);
            v["endedAt"] = json!(acc.last_at);
            v["list"] = Value::Array(acc.list.clone());
            v
        })
        .collect();
    let mut t = total.totals();
    t["turns"] = json!(turn_count);
    t["requestsPerTurn"] = json!(if turn_count == 0 {
        0.0
    } else {
        ((total.requests as f64 / turn_count as f64) * 10.0).round() / 10.0
    });
    json!({ "turns": list, "total": t })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_table(&c).unwrap();
        c
    }

    fn step(turn: u32, step: u32, full: u64, sent: u64) -> RequestRow {
        RequestRow {
            turn: Some(turn),
            step,
            kind: RequestKind::Step.as_str(),
            status: "ok",
            model: "m".into(),
            full_tokens: full,
            sent_tokens: sent,
            input_tokens: sent + 5,
            output_tokens: 10,
            latency_ms: 100,
            prompt: if step == 1 {
                Some("fix   the\nbuild".into())
            } else {
                None
            },
            policy: None,
        }
    }

    #[test]
    fn one_turn_with_many_requests_is_counted_per_request() {
        let c = conn();
        record(&c, "s", &step(3, 1, 1000, 600), 10).unwrap();
        record(&c, "s", &step(3, 2, 1200, 700), 20).unwrap();
        record(&c, "s", &step(3, 3, 1400, 800), 30).unwrap();
        record(&c, "s", &step(4, 1, 500, 500), 40).unwrap();
        let s = summary(&c, "s");
        let turns = s["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 2);
        // Newest turn first.
        assert_eq!(turns[0]["turn"], 4);
        let t3 = &turns[1];
        assert_eq!(t3["requests"], 3);
        assert_eq!(t3["fullTokens"], 3600);
        assert_eq!(t3["sentTokens"], 2100);
        assert_eq!(t3["savedTokens"], 1500);
        assert_eq!(t3["savedPct"], 41.7);
        assert_eq!(t3["inputTokens"], 2115);
        assert_eq!(t3["prompt"], "fix the build");
        assert_eq!(t3["list"].as_array().unwrap().len(), 3);
        let total = &s["total"];
        assert_eq!(total["turns"], 2);
        assert_eq!(total["requests"], 4);
        assert_eq!(total["requestsPerTurn"], 2.0);
        assert_eq!(total["savedTokens"], 1500);
    }

    #[test]
    fn a_background_summary_is_filed_under_the_newest_turn_and_saves_nothing() {
        let c = conn();
        record(&c, "s", &step(7, 1, 1000, 400), 10).unwrap();
        let turn = record(
            &c,
            "s",
            &RequestRow {
                turn: None,
                kind: RequestKind::Summary.as_str(),
                status: "ok",
                input_tokens: 900,
                output_tokens: 120,
                ..Default::default()
            },
            20,
        )
        .unwrap();
        assert_eq!(turn, 7);
        let s = summary(&c, "s");
        let t = &s["turns"][0];
        assert_eq!(t["requests"], 2);
        assert_eq!(t["summaryRequests"], 1);
        assert_eq!(t["fullTokens"], 1000);
        assert_eq!(t["sentTokens"], 400);
        assert_eq!(t["inputTokens"], 1305);
    }

    #[test]
    fn sessions_are_apart_and_clear_forgets_one() {
        let c = conn();
        record(&c, "a", &step(1, 1, 10, 10), 1).unwrap();
        record(&c, "b", &step(1, 1, 10, 10), 1).unwrap();
        clear(&c, "a").unwrap();
        assert_eq!(summary(&c, "a")["total"]["requests"], 0);
        assert_eq!(summary(&c, "b")["total"]["requests"], 1);
    }
}
