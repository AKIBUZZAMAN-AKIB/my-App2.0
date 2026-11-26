//! Supersession across temporary ids, batches and portions: the defect the
//! real-provider runs showed (server port 8742 → 9150 left with no
//! superseded decision) and the code-side rules that fix it.

use super::*;
use serde_json::json;
use std::sync::Mutex;

fn base7() -> TurnMemory {
    TurnMemory {
        through_turn: 7,
        segments: vec![Segment {
            from_turn: 1,
            to_turn: 7,
            topic: "t".into(),
            title: "t".into(),
            summary: "s".into(),
            created_at: 0,
            ..Default::default()
        }],
        ..Default::default()
    }
}

/// Applies a summarizer answer for turns 8-12 (segments filled in).
fn apply(
    base: &TurnMemory,
    mut v: serde_json::Value,
) -> Result<(TurnMemory, Vec<String>, Vec<String>), Vec<String>> {
    let from = base.through_turn + 1;
    let to = from + 4;
    v["segments"] = json!([{"fromTurn": from, "toTurn": to, "topic": "server", "title": "setup", "summary": "s"}]);
    let up = parse_update(&v.to_string()).unwrap();
    let (mut dropped, mut auto) = (Vec::new(), Vec::new());
    let m = apply_update_full(base, &up, from, to, 1, &mut dropped, &mut auto)?;
    Ok((m, dropped, auto))
}

fn cur_texts(m: &TurnMemory) -> Vec<&str> {
    m.decisions
        .current
        .iter()
        .map(|d| d.text.as_str())
        .collect()
}

fn sup_of<'a>(m: &'a TurnMemory, text: &str) -> &'a Decision {
    m.decisions
        .superseded
        .iter()
        .find(|d| d.text == text)
        .unwrap_or_else(|| panic!("{text} not superseded: {:?}", m.decisions))
}

#[test]
fn the_raw_kilo_answer_shape_is_confirmed_as_the_root_cause() {
    // What kilo-auto/free (nemotron) answered for the Bengali run, decisions
    // part verbatim in structure: the old port never appears under current,
    // only as a superseded "N5" with no text.
    let (m, dropped, auto) = apply(
        &base7(),
        json!({"decisions": {"current": [{"id": "N6", "text": "সার্ভার পোর্ট 9150", "turn": 10}], "superseded": [{"id": "N5", "supersededBy": "N6", "turn": 10, "reason": "পোর্ট পরিবর্তন"}]}}),
    )
    .unwrap();
    assert_eq!(cur_texts(&m), ["সার্ভার পোর্ট 9150"]);
    assert!(
        m.decisions.superseded.is_empty(),
        "nothing to link: the old decision was never written"
    );
    assert!(
        dropped.iter().any(|d| d.contains("N5")),
        "a truly unknown id is still dropped and logged"
    );
    assert!(auto.is_empty());
}

#[test]
fn same_batch_change_is_linked_when_both_decisions_are_listed_english() {
    let (m, dropped, auto) = apply(
        &base7(),
        json!({"decisions": {
            "current": [{"id": "N1", "key": "server port", "text": "Server port 8080", "turn": 8}, {"id": "N2", "key": "server port", "text": "Server port 9150", "turn": 10}],
            "superseded": [{"id": "N1", "supersededBy": "N2", "turn": 10, "reason": "8080 is taken"}]}}),
    )
    .unwrap();
    assert_eq!(cur_texts(&m), ["Server port 9150"]);
    let old = sup_of(&m, "Server port 8080");
    assert_eq!(
        (
            old.id.as_str(),
            old.superseded_by.as_deref(),
            old.superseded_at,
            old.turn
        ),
        ("D1", Some("D2"), Some(10), 8)
    );
    assert_eq!(old.reason.as_deref(), Some("8080 is taken"));
    assert!(
        dropped.is_empty() && auto.is_empty(),
        "{dropped:?} {auto:?}"
    );
    assert_eq!(m.decisions.current[0].key, "server port");
}

#[test]
fn same_batch_change_defined_inline_in_superseded_bengali() {
    // The shape free models drift to: the old decision only under
    // superseded, but now with its text and the turn it was made in.
    let (m, dropped, _) = apply(
        &base7(),
        json!({"decisions": {
            "current": [{"id": "N6", "text": "সার্ভার পোর্ট 9150", "turn": 10}],
            "superseded": [{"id": "N5", "text": "সার্ভার পোর্ট 8742", "madeInTurn": 9, "supersededBy": "N6", "turn": 10, "reason": "পোর্ট বদলানো হয়েছে"}]}}),
    )
    .unwrap();
    assert_eq!(cur_texts(&m), ["সার্ভার পোর্ট 9150"]);
    let old = sup_of(&m, "সার্ভার পোর্ট 8742");
    assert_eq!(
        (old.turn, old.superseded_by.as_deref(), old.superseded_at),
        (9, Some(m.decisions.current[0].id.as_str()), Some(10))
    );
    assert!(dropped.is_empty(), "{dropped:?}");
    // Without a valid madeInTurn it is not invented: dropped, logged.
    let (m2, dropped2, _) = apply(
        &base7(),
        json!({"decisions": {"current": [{"id": "N6", "text": "port 9150", "turn": 10}], "superseded": [{"id": "N5", "text": "port 8742", "supersededBy": "N6", "turn": 10}]}}),
    )
    .unwrap();
    assert!(m2.decisions.superseded.is_empty());
    assert!(dropped2.iter().any(|d| d.contains("madeInTurn")));
}

#[test]
fn a_textless_label_is_recovered_from_the_items_of_the_same_answer() {
    // OVHcloud Llama-3.3-70B, smoke4 #4, decisions and items in the same
    // structure: the old decision is only the label "N7" (no text), but the
    // items carry the old value under the same key, superseded via "T1".
    let ovh = json!({
        "decisions": {"current": [{"id": "N4", "key": "database", "text": "SQLite", "turn": 9}, {"id": "N5", "key": "server port", "text": "9150", "turn": 11}],
                      "superseded": [{"id": "N7", "supersededBy": "N5", "turn": 11, "reason": "8742 পোর্ট অন্য সার্ভিস নিয়েছে"}]},
        "items": {"add": [{"kind": "fact", "id": "T1", "key": "server port", "text": "8742", "turn": 10},
                          {"kind": "fact", "key": "server port", "text": "9150", "turn": 11, "supersedes": "T1", "reason": "taken"}]}
    });
    let (m, dropped, auto) = apply(&base7(), ovh).unwrap();
    assert_eq!(cur_texts(&m), ["SQLite", "9150"]);
    let old = sup_of(&m, "8742");
    assert_eq!(
        (
            old.turn,
            old.superseded_by.as_deref(),
            old.superseded_at,
            old.key.as_str()
        ),
        (10, Some("D2"), Some(11), "server port")
    );
    assert!(old.reason.as_deref().unwrap().starts_with("8742"));
    assert!(dropped.is_empty(), "recovered, so not dropped: {dropped:?}");
    assert!(
        auto.iter()
            .any(|a| a.contains("recovered") && a.contains("N7")),
        "{auto:?}"
    );
    assert!(m
        .items
        .iter()
        .any(|i| i.text == "8742" && i.status == "superseded"));
    // Not recovered when the replacement has no key, or two items fit.
    let nokey = json!({
        "decisions": {"current": [{"id": "N5", "text": "port 9150", "turn": 11}], "superseded": [{"id": "N7", "supersededBy": "N5", "turn": 11}]},
        "items": {"add": [{"kind": "fact", "id": "T1", "key": "server port", "text": "8742", "turn": 10}, {"kind": "fact", "key": "server port", "text": "9150", "turn": 11, "supersedes": "T1"}]}
    });
    let (m2, dropped2, _) = apply(&base7(), nokey).unwrap();
    assert!(m2.decisions.superseded.is_empty() && dropped2.iter().any(|d| d.contains("N7")));
    let two = json!({
        "decisions": {"current": [{"id": "N5", "key": "server port", "text": "9150", "turn": 12}], "superseded": [{"id": "N7", "supersededBy": "N5", "turn": 12}]},
        "items": {"add": [{"kind": "fact", "id": "T1", "key": "server port", "text": "8080", "turn": 9}, {"kind": "fact", "id": "T2", "key": "server port", "text": "8742", "turn": 10, "supersedes": "T1"},
                          {"kind": "fact", "key": "server port", "text": "9150", "turn": 12, "supersedes": "T2"}]}
    });
    let (m3, dropped3, _) = apply(&base7(), two).unwrap();
    assert!(
        m3.decisions.superseded.is_empty(),
        "ambiguous: two old values fit"
    );
    assert!(dropped3.iter().any(|d| d.contains("N7")));
}

#[test]
fn an_inline_definition_without_made_in_turn_takes_the_turn_of_its_item() {
    // OVHcloud Llama-3.3-70B, smoke4 English run, same structure: the old
    // decision is defined inline with text and key but no madeInTurn.
    let v = json!({
        "decisions": {"current": [{"id": "N4", "key": "server port", "text": "9150", "turn": 6}],
                      "superseded": [{"id": "N6", "key": "server port", "text": "8742", "supersededBy": "N4", "turn": 6, "reason": "another service took 8742"}]},
        "items": {"add": [{"kind": "fact", "id": "T1", "key": "server port", "text": "8742", "turn": 5}, {"kind": "fact", "key": "server port", "text": "9150", "turn": 6, "supersedes": "T1"}]}
    });
    let up = parse_update(&v.to_string()).unwrap();
    let mut dropped = Vec::new();
    let base = TurnMemory::default();
    let mut v2 = v.clone();
    v2["segments"] = json!([{"fromTurn": 1, "toTurn": 7, "summary": "s"}]);
    let up2 = parse_update(&v2.to_string()).unwrap();
    let m = apply_update_full(&base, &up2, 1, 7, 1, &mut dropped, &mut Vec::new()).unwrap();
    assert_eq!(cur_texts(&m), ["9150"]);
    let old = sup_of(&m, "8742");
    assert_eq!(
        (old.turn, old.superseded_by.as_deref(), old.superseded_at),
        (5, Some("D1"), Some(6))
    );
    assert!(dropped.is_empty(), "{dropped:?}");
    // Without a matching item it is still dropped (no turn is invented).
    let mut v3 = v2.clone();
    v3["items"] = json!({"add": []});
    let m3 = apply_update_full(
        &base,
        &parse_update(&v3.to_string()).unwrap(),
        1,
        7,
        1,
        &mut dropped,
        &mut Vec::new(),
    )
    .unwrap();
    assert!(m3.decisions.superseded.is_empty());
    assert!(dropped.iter().any(|d| d.contains("madeInTurn 0")));
    let _ = up;
}

#[test]
fn both_values_listed_as_current_without_a_link_the_later_turn_wins_bengali() {
    // What OVHcloud-style answers do when they list both and forget the link.
    let (m, _, auto) = apply(
        &base7(),
        json!({"decisions": {"current": [
            {"id": "N1", "text": "সার্ভার পোর্ট 8742", "turn": 9},
            {"id": "N2", "text": "সার্ভার পোর্ট 9150", "turn": 11},
            {"id": "N3", "text": "ডেডলাইন ২০ ডিসেম্বর", "turn": 12}]}}),
    )
    .unwrap();
    assert_eq!(cur_texts(&m), ["সার্ভার পোর্ট 9150", "ডেডলাইন ২০ ডিসেম্বর"]);
    let old = sup_of(&m, "সার্ভার পোর্ট 8742");
    assert_eq!(
        (old.superseded_by.as_deref(), old.superseded_at),
        (Some("D2"), Some(11))
    );
    assert!(old.reason.as_deref().unwrap().contains("automatically"));
    assert_eq!(auto.len(), 1, "{auto:?}");
}

#[test]
fn explicit_keys_link_decisions_whose_texts_differ() {
    let (m, _, auto) = apply(
        &base7(),
        json!({"decisions": {"current": [
            {"id": "N1", "key": "database", "text": "Use PostgreSQL", "turn": 8},
            {"id": "N2", "key": "Database", "text": "Switch to SQLite, single file", "turn": 12}]}}),
    )
    .unwrap();
    assert_eq!(cur_texts(&m), ["Switch to SQLite, single file"]);
    assert_eq!(
        sup_of(&m, "Use PostgreSQL").superseded_by.as_deref(),
        Some("D2")
    );
    assert_eq!(auto.len(), 1);
}

#[test]
fn unrelated_decisions_that_share_words_are_never_merged() {
    let (m, dropped, auto) = apply(
        &base7(),
        json!({"decisions": {"current": [
            {"id": "N1", "text": "API port 8080", "turn": 8},
            {"id": "N2", "text": "admin port 9090", "turn": 9},
            {"id": "N3", "key": "api timeout", "text": "timeout 30", "turn": 10},
            {"id": "N4", "key": "db timeout", "text": "timeout 5", "turn": 11},
            {"id": "N5", "text": "Phase 1", "turn": 11},
            {"id": "N6", "text": "Phase 2", "turn": 12},
            {"id": "N7", "text": "deadline 20 December", "turn": 12},
            {"id": "N8", "text": "use SQLite for the cache", "turn": 9},
            {"id": "N9", "text": "use SQLite for the app database", "turn": 12}]}}),
    )
    .unwrap();
    assert_eq!(m.decisions.current.len(), 9);
    assert!(
        m.decisions.superseded.is_empty() && dropped.is_empty() && auto.is_empty(),
        "{auto:?}"
    );
}

#[test]
fn a_tie_on_the_turn_changes_nothing_and_is_logged() {
    let (m, _, auto) = apply(
        &base7(),
        json!({"decisions": {"current": [{"id": "N1", "text": "server port 8080", "turn": 9}, {"id": "N2", "text": "server port 9150", "turn": 9}]}}),
    )
    .unwrap();
    assert_eq!(m.decisions.current.len(), 2);
    assert!(auto.iter().any(|a| a.contains("same turn")));
}

#[test]
fn cross_batch_change_supersedes_the_stored_decision() {
    let (m1, _, _) = apply(&base7(), json!({"decisions": {"current": [{"id": "N1", "key": "server port", "text": "server port 8742", "turn": 9}]}})).unwrap();
    assert_eq!(m1.decisions.current[0].id, "D1");
    // The context the next summary sees carries the key.
    assert!(summary_context(&m1).contains("\"key\": \"server port\""));
    // Explicit link from a later batch.
    let (m2, _, auto) = apply(
        &m1,
        json!({"decisions": {"current": [{"id": "N1", "key": "server port", "text": "server port 9150", "turn": 14}], "superseded": [{"id": "D1", "supersededBy": "N1", "turn": 14, "reason": "moved"}]}}),
    )
    .unwrap();
    assert_eq!(
        sup_of(&m2, "server port 8742").superseded_by.as_deref(),
        Some("D2")
    );
    assert!(auto.is_empty());
    // No link, D1 re-listed as current: the slot rule links it.
    let (m3, _, auto3) = apply(&m1, json!({"decisions": {"current": [{"id": "D1"}, {"id": "N1", "key": "server port", "text": "server port 9150", "turn": 14}]}})).unwrap();
    assert_eq!(cur_texts(&m3), ["server port 9150"]);
    let old = sup_of(&m3, "server port 8742");
    assert_eq!(
        (old.superseded_by.as_deref(), old.superseded_at),
        (Some("D2"), Some(14))
    );
    assert_eq!(auto3.len(), 1);
    validate_transition(&m1, &m3, &[]).unwrap();
    // The next version keeps the link; the old decision cannot come back.
    let err = apply(
        &m3,
        json!({"decisions": {"current": [{"id": "D1"}, {"id": "D2"}]}}),
    )
    .unwrap_err();
    assert!(
        err.iter().any(|e| e.contains("already superseded")),
        "{err:?}"
    );
}

#[test]
fn the_model_may_name_the_replacement_by_its_exact_text() {
    let (m, dropped, _) = apply(
        &base7(),
        json!({"decisions": {
            "current": [{"id": "N1", "text": "Use PostgreSQL", "turn": 8}, {"id": "N2", "text": "Use SQLite", "turn": 11}],
            "superseded": [{"id": "N1", "supersededBy": "use sqlite", "turn": 11}]}}),
    )
    .unwrap();
    assert_eq!(
        sup_of(&m, "Use PostgreSQL").superseded_by.as_deref(),
        Some("D2")
    );
    assert!(dropped.is_empty());
}

#[test]
fn strict_invariants_still_reject() {
    let (m1, _, _) = apply(
        &base7(),
        json!({"decisions": {"current": [{"id": "N1", "text": "server port 8742", "turn": 9}]}}),
    )
    .unwrap();
    // A stored current decision that goes missing.
    let err = apply(
        &m1,
        json!({"decisions": {"current": [{"id": "N1", "text": "other", "turn": 13}]}}),
    )
    .unwrap_err();
    assert!(
        err.iter()
            .any(|e| e.contains("D1") && e.contains("missing")),
        "{err:?}"
    );
    // A new decision from outside the new turns.
    let err = apply(&m1, json!({"decisions": {"current": [{"id": "D1"}, {"id": "N1", "text": "server port 9150", "turn": 3}]}})).unwrap_err();
    assert!(err.iter().any(|e| e.contains("source turn 3")), "{err:?}");
    // An invented D-number.
    let err = apply(
        &m1,
        json!({"decisions": {"current": [{"id": "D1"}, {"id": "D7", "text": "x", "turn": 13}]}}),
    )
    .unwrap_err();
    assert!(
        err.iter().any(|e| e.contains("unknown decision ID D7")),
        "{err:?}"
    );
    // Stable ids keep counting; an inline definition takes the next one.
    let (m2, _, _) = apply(
        &m1,
        json!({"decisions": {"current": [{"id": "D1"}, {"id": "N2", "text": "use rust", "turn": 14}], "superseded": [{"id": "N1", "text": "use go", "madeInTurn": 13, "supersededBy": "N2", "turn": 14}]}}),
    )
    .unwrap();
    let ids: Vec<&str> = m2.all_decisions().map(|d| d.id.as_str()).collect();
    assert!(
        ids.contains(&"D2") && ids.contains(&"D3") && m2.next_decision == 3,
        "{ids:?}"
    );
}

// ── Items ──

#[test]
fn items_resolve_temporary_labels_in_the_same_answer() {
    let (m, dropped, _) = apply(
        &base7(),
        json!({"items": {"add": [
            {"kind": "fact", "key": "staging host", "text": "staging host b.lan", "turn": 11, "supersedes": "T1", "reason": "renamed"},
            {"kind": "fact", "id": "T1", "key": "staging host", "text": "staging host a.lan", "turn": 9}]}}),
    )
    .unwrap();
    let a = m
        .items
        .iter()
        .find(|i| i.text == "staging host a.lan")
        .unwrap();
    let b = m
        .items
        .iter()
        .find(|i| i.text == "staging host b.lan")
        .unwrap();
    assert_eq!(
        (a.status.as_str(), a.superseded_by.as_deref()),
        ("superseded", Some(b.id.as_str())),
        "a forward reference resolves too"
    );
    assert_eq!(a.reason, "renamed");
    assert!(dropped.is_empty(), "{dropped:?}");
}

#[test]
fn item_label_that_is_a_stored_id_keeps_meaning_the_stored_item() {
    let (m1, _, _) = apply(
        &base7(),
        json!({"items": {"add": [{"kind": "fact", "text": "region eu-west", "turn": 9}]}}),
    )
    .unwrap();
    let stored = m1.items[0].id.clone();
    let (m2, _, _) = apply(
        &m1,
        json!({"items": {"add": [{"kind": "fact", "id": stored, "text": "cache redis", "turn": 13}, {"kind": "fact", "text": "region us-east", "turn": 14, "supersedes": stored, "reason": "moved"}]}}),
    )
    .unwrap();
    let old = m2.items.iter().find(|i| i.id == stored).unwrap();
    assert_eq!(old.text, "region eu-west");
    assert_eq!(old.status, "superseded");
    assert!(m2
        .items
        .iter()
        .any(|i| i.text == "cache redis" && i.is_current()));
}

#[test]
fn facts_about_the_same_slot_link_automatically_across_batches() {
    let (m1, _, _) = apply(&base7(), json!({"items": {"add": [{"kind": "fact", "text": "সার্ভার পোর্ট 8742", "turn": 9}, {"kind": "file", "text": "config v1", "turn": 9}]}})).unwrap();
    let (m2, dropped, auto) = apply(
        &m1,
        json!({"items": {"add": [{"kind": "fact", "text": "সার্ভার পোর্ট 9150", "turn": 14, "supersedes": "N8"}, {"kind": "file", "text": "config v2", "turn": 14}]}}),
    )
    .unwrap();
    assert!(
        dropped.iter().any(|d| d.contains("N8")),
        "unknown ref still dropped"
    );
    let old = m2.items.iter().find(|i| i.text.ends_with("8742")).unwrap();
    let new = m2.items.iter().find(|i| i.text.ends_with("9150")).unwrap();
    assert_eq!(
        (old.status.as_str(), old.superseded_by.as_deref()),
        ("superseded", Some(new.id.as_str()))
    );
    assert!(
        m2.items
            .iter()
            .filter(|i| i.text.starts_with("config"))
            .all(|i| i.is_current()),
        "files never take part"
    );
    assert_eq!(auto.len(), 1, "{auto:?}");
    validate_transition(&m1, &m2, &[]).unwrap();
}

// ── Portions (parallel sub-agents) ──

struct Script<F: Fn(&str, &str) -> String> {
    f: F,
    calls: Mutex<Vec<String>>,
}

impl<F: Fn(&str, &str) -> String> TextModel for Script<F> {
    async fn complete(&self, system: &str, user: String, _max: u32) -> Result<String, String> {
        self.calls
            .lock()
            .unwrap()
            .push(system.chars().take(40).collect());
        Ok((self.f)(system, &user))
    }
}

fn cnt(s: &str) -> usize {
    s.len() / 4 + 1
}

#[tokio::test]
async fn old_and_new_value_in_different_portions_end_up_linked() {
    let pad = "lorem ipsum dolor sit amet ".repeat(220);
    let turns: Vec<(u32, Vec<Message>)> = (1..=6)
        .map(|n| {
            let say = match n {
                2 => "সার্ভার পোর্ট 8742 হবে।".to_string(),
                5 => "পোর্ট বদলে 9150 করো।".to_string(),
                _ => format!("note {n}"),
            };
            (
                n,
                vec![
                    Message::user(&format!("{say} {pad}")),
                    Message::assistant_text("ঠিক আছে"),
                ],
            )
        })
        .collect();
    // The merge model lists both values as current and forgets the link,
    // the way the portion notes each saw only one of them.
    let model = Script {
        calls: Mutex::new(Vec::new()),
        f: |sys: &str, user: &str| {
            if sys.starts_with("You are one of several summarizer") {
                let from: u32 = user
                    .split("### Turn ")
                    .nth(1)
                    .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
                return json!({"segments": [{"fromTurn": from, "toTurn": from, "summary": "part"}]}).to_string();
            }
            assert!(sys.starts_with("You merge"), "{sys}");
            json!({
                "segments": [{"fromTurn": 1, "toTurn": 6, "topic": "server", "title": "সার্ভার", "summary": "পোর্ট 8742 থেকে 9150"}],
                "decisions": {"current": [{"id": "N1", "text": "সার্ভার পোর্ট 8742", "turn": 2}, {"id": "N2", "text": "সার্ভার পোর্ট 9150", "turn": 5}]}
            })
            .to_string()
        },
    };
    let ids = HashMap::new();
    let job = SummarizeJob {
        turns: &turns,
        from: 1,
        to: 6,
        input_limit: 2_000,
        max_output: 1_024,
        result_ids: &ids,
        now_ms: 1,
        parts: None,
    };
    let out = summarize_range(&model, &TurnMemory::default(), &job, &cnt)
        .await
        .unwrap();
    assert!(out.portions > 1, "split into portions ({})", out.portions);
    assert_eq!(cur_texts(&out.memory), ["সার্ভার পোর্ট 9150"]);
    assert_eq!(
        sup_of(&out.memory, "সার্ভার পোর্ট 8742")
            .superseded_by
            .as_deref(),
        Some("D2")
    );
    assert_eq!(out.auto_superseded.len(), 1, "{:?}", out.auto_superseded);
    // A save conflict re-applies the same answer: the same result, deterministically.
    let again = apply_update(&TurnMemory::default(), &out.update, 1, 6, 1).unwrap();
    assert_eq!(again.decisions, out.memory.decisions);
}

#[test]
fn prompts_ask_for_keys_and_for_both_sides_of_a_same_batch_change() {
    let s = summarizer_system();
    assert!(s.contains("\"key\"") && s.contains("made AND changed within the new turns"));
    assert!(merge_system().contains("made AND changed within the new turns"));
    assert!(PORTION_SYSTEM.contains("\"key\""));
}
