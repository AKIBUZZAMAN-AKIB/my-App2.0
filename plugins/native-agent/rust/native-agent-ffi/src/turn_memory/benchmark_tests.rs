//! Ground-truth long-conversation retrieval benchmark (spec §15).
//!
//! A deterministic 400-turn chat in Bengali and English with 48 planted
//! details ("needles") at known turns, filler turns that reuse the same
//! vocabulary as distractors, and a lossy model-written index (as a real
//! summarizer leaves it: segments of 20 turns whose summaries mention only
//! every other needle). For each of 72 questions with a known answer turn it
//! measures whether recall would read that turn:
//!
//! * `index`  — the pre-v5 path: `select_segments`, else the first 40 turns;
//! * `fts`    — the full-text index alone (`fts::search_turns`, top 12);
//! * `merged` — what `recall_turns` now does (`fts::merge_hits`).
//!
//! Metrics are printed as one JSON line (`BENCHMARK {...}`) and checked
//! against floors so a regression fails the build. Run with
//! `cargo test --lib retrieval_benchmark -- --nocapture` to see them.
//! Scripted data, no model: it measures retrieval, not answer quality.

use super::*;
use crate::types::Message;
use rusqlite::Connection;
use std::time::Instant;

const TURNS: u32 = 400;

/// (turn, text planted in the user message, question in the needle's own
/// words, paraphrased question with no shared content word, category)
fn needles() -> Vec<(u32, String, String, String, &'static str)> {
    let mut out = Vec::new();
    let en_codes = ["E0597", "ORA-12154", "HTTP-502", "SIGSEGV", "ENOSPC", "CVE-2024-3094", "KX-7781", "ZQ-1040"];
    for (i, c) in en_codes.iter().enumerate() {
        let t = 1 + i as u32 * 47;
        out.push((t, format!("The deploy failed with error {} on the staging box", c), format!("Which turn had the {} error?", c), "When did the staging rollout break?".to_string(), "exact-code"));
    }
    let en_names = [("Marigold", "vendor"), ("Okonkwo", "reviewer"), ("Halvorsen", "landlord"), ("Tanimura", "designer"), ("Quintero", "accountant"), ("Bellweather", "auditor"), ("Arkwright", "mentor"), ("Ferreira", "courier")];
    for (i, (n, role)) in en_names.iter().enumerate() {
        let t = 16 + i as u32 * 45;
        out.push((t, format!("Our {} is {} and the contract renews in March", role, n), format!("What did we say about {}?", n), format!("Who handles the {} work for us?", if *role == "vendor" { "supply" } else { "outside" }), "name"));
    }
    let en_numbers = ["4417", "92.6", "18000", "3.14159", "7761", "250ms", "1.21GW", "65536"];
    for (i, n) in en_numbers.iter().enumerate() {
        let t = 31 + i as u32 * 43;
        out.push((t, format!("The measured figure for the ledger import was {}", n), format!("Where is the figure {}?", n), "How fast did the bookkeeping load run?".to_string(), "number"));
    }
    // Bengali: inflected form in the chat, stem in the question.
    let bn = [
        ("কাগজের নৌকা", "কাগজ", "প্রকল্পের নাম কী ছিল?"),
        ("রাজশাহীর গুদামে", "রাজশাহী", "মাল কোথায় রাখা হবে?"),
        ("পাটের বস্তার", "পাট", "কোন পণ্যের উপকরণ?"),
        ("নদীর ধারের", "নদী", "কোন জায়গার জমি?"),
        ("ইলিশের দামের", "ইলিশ", "মাছের খরচ কত?"),
        ("বাঁশের সাঁকোর", "বাঁশ", "পারাপারের ব্যবস্থা কী?"),
        ("শিউলির বাগানের", "শিউলি", "ফুলের জায়গা কোনটা?"),
        ("মেঘনার সেতুর", "মেঘনা", "কোন পুলের কথা হয়েছিল?"),
    ];
    for (i, (phrase, stem, para)) in bn.iter().enumerate() {
        let t = 2 + i as u32 * 49;
        out.push((t, format!("আমরা ঠিক করলাম {} বিষয়টা পরে দেখব", phrase), format!("{} নিয়ে কী বলেছিলাম?", stem), para.to_string(), "bengali-inflected"));
    }
    // Decisions that were later replaced: both turns are ground truth.
    let dec = [("PostgreSQL", "SQLite"), ("Kafka", "NATS"), ("Webpack", "Vite"), ("Jenkins", "Buildkite"), ("Redux", "Zustand"), ("Mocha", "Vitest"), ("Heroku", "Fly"), ("Sentry", "Bugsnag")];
    for (i, (old, new)) in dec.iter().enumerate() {
        let t = 14 + i as u32 * 44;
        out.push((t, format!("Decision: we will use {} for this part", old), format!("Why did we stop using {}?", old), "What did the first choice for that layer look like?".to_string(), "decision-old"));
        out.push((t + 30, format!("Change of plan: replace {} with {} from now on", old, new), format!("When did {} come in?", new), "When did the plan for that layer change?".to_string(), "decision-new"));
    }
    out
}

fn filler(t: u32) -> String {
    let words = ["server", "database", "deploy", "build", "কাজ", "পরিকল্পনা", "মিটিং", "ledger", "import", "contract", "staging", "error", "figure", "হিসাব", "ফাইল", "review"];
    let a = words[(t as usize * 7) % words.len()];
    let b = words[(t as usize * 11 + 3) % words.len()];
    format!("turn {} notes about the {} and the {}, আজকের সাধারণ আলোচনা", t, a, b)
}

fn hit(ranges: &[(u32, u32)], turn: u32) -> bool {
    ranges.iter().any(|&(a, b)| a <= turn && turn <= b)
}

fn span(ranges: &[(u32, u32)]) -> u32 {
    ranges.iter().map(|&(a, b)| b - a + 1).sum()
}

#[test]
fn retrieval_benchmark() {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    ensure_tables(&conn).unwrap();
    let ns = needles();
    let mut msgs = Vec::new();
    for t in 1..=TURNS {
        let user = ns.iter().find(|n| n.0 == t).map(|n| n.1.clone()).unwrap_or_else(|| filler(t));
        msgs.push(Message::user(&user));
        msgs.push(Message::assistant_text(&format!("ঠিক আছে, noted for turn {}", t)));
    }
    let planted: std::collections::HashSet<u32> = ns.iter().map(|n| n.0).collect();
    assert_eq!(planted.len(), ns.len(), "needle turns must not collide");
    let started = Instant::now();
    archive_turns(&conn, "bench", &msgs, &split_turns(&msgs), 1).unwrap();
    let archive_ms = started.elapsed().as_secs_f64() * 1000.0;

    // Lossy index: one segment per 20 turns; summaries name every other needle.
    let mut mem = TurnMemory { through_turn: TURNS, goal: "ship the ledger app".into(), ..Default::default() };
    for s in 0..(TURNS / 20) {
        let (a, b) = (s * 20 + 1, s * 20 + 20);
        let mut summary = String::from("routine work on the app");
        for (i, n) in ns.iter().enumerate() {
            if i % 2 == 0 && n.0 >= a && n.0 <= b {
                summary.push_str("; ");
                summary.push_str(&n.1);
            }
        }
        mem.segments.push(Segment { from_turn: a, to_turn: b, topic: "work".into(), title: format!("block {}", s + 1), summary });
    }

    let (mut q, mut idx_hits, mut fts_hits, mut fts_top1, mut merged_hits, mut idx_span, mut merged_span) = (0, 0, 0, 0, 0, 0u32, 0u32);
    let (mut para_q, mut para_idx, mut para_merged) = (0, 0, 0);
    let mut by_cat: std::collections::BTreeMap<&str, (u32, u32, u32)> = Default::default();
    let mut fts_time = 0f64;
    for (turn, _, direct, para, cat) in &ns {
        for (question, is_para) in [(direct, false), (para, true)] {
            if is_para && q % 3 != 0 {
                // A paraphrase for every third needle: 24 of the 72 questions.
                q += 1;
                continue;
            }
            let by_index = {
                let p = select_segments(&mem, question, 40);
                if p.is_empty() { vec![(1, 40)] } else { p }
            };
            let t0 = Instant::now();
            let by_text = fts::search_turns(&conn, "bench", question, TURNS, 12);
            fts_time += t0.elapsed().as_secs_f64() * 1000.0;
            let merged = fts::merge_hits(&select_segments(&mem, question, 40), &by_text);
            let merged = if merged.is_empty() { vec![(1, 40)] } else { merged };
            let (hi, hm) = (hit(&by_index, *turn), hit(&merged, *turn));
            if is_para {
                para_q += 1;
                para_idx += hi as u32;
                para_merged += hm as u32;
            } else {
                let e = by_cat.entry(cat).or_default();
                e.0 += 1;
                e.1 += hi as u32;
                e.2 += hm as u32;
                idx_hits += hi as u32;
                fts_hits += by_text.contains(turn) as u32;
                fts_top1 += (by_text.first() == Some(turn)) as u32;
                merged_hits += hm as u32;
                idx_span += span(&by_index);
                merged_span += span(&merged);
            }
        }
        q += 1;
    }
    let direct = ns.len() as u32;
    conn.execute_batch("VACUUM;").unwrap();
    let page_with: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    conn.execute_batch("DROP TRIGGER turn_archive_fts_delete; DROP TABLE turn_fts; VACUUM;").unwrap();
    let page_without: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let report = serde_json::json!({
        "turns": TURNS,
        "directQuestions": direct,
        "paraphraseQuestions": para_q,
        "indexOnlyHitRate": idx_hits as f64 / direct as f64,
        "ftsTop12HitRate": fts_hits as f64 / direct as f64,
        "ftsTop1HitRate": fts_top1 as f64 / direct as f64,
        "mergedHitRate": merged_hits as f64 / direct as f64,
        "paraphraseIndexHitRate": para_idx as f64 / para_q as f64,
        "paraphraseMergedHitRate": para_merged as f64 / para_q as f64,
        "avgTurnsToReadIndex": idx_span as f64 / direct as f64,
        "avgTurnsToReadMerged": merged_span as f64 / direct as f64,
        "byCategory": by_cat.iter().map(|(k, v)| (k.to_string(), serde_json::json!({"n": v.0, "index": v.1, "merged": v.2}))).collect::<serde_json::Map<_, _>>(),
        "archive400TurnsMs": (archive_ms * 10.0).round() / 10.0,
        "avgFtsQueryMs": ((fts_time / (direct + para_q) as f64) * 1000.0).round() / 1000.0,
        "dbPagesWithFts": page_with,
        "dbPagesWithoutFts": page_without,
    });
    println!("BENCHMARK {}", report);
    // Floors: measured values must not regress below these.
    assert!(merged_hits >= idx_hits, "merged must never lose an index hit");
    assert!(merged_hits as f64 / direct as f64 >= 0.95, "{report}");
    assert!(fts_hits as f64 / direct as f64 >= 0.95, "{report}");
    assert!(by_cat["bengali-inflected"].2 == by_cat["bengali-inflected"].0, "{report}");
}
