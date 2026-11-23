//! The memory checklist: groups, versions, #tags (last mention wins,
//! inactive, removed), picks that override relevance, reasons and colours,
//! files as their own versioned group, and duplicate tool results.

use super::*;
use crate::turn_memory::goals::{self, Proposal};
use crate::turn_memory::items::MemoryItem;
use crate::turn_memory::select::{select_with, Input};
use crate::turn_memory::{store, Decision, Decisions, Segment, TurnMemory};
use crate::types::{ContentBlock, Message};
use rusqlite::Connection;

const K: &str = "chat";

fn words(s: &str) -> usize {
    s.split_whitespace().count()
}

fn dec(id: &str, text: &str, turn: u32) -> Decision {
    Decision { id: id.into(), text: text.into(), turn, ..Default::default() }
}

fn item(id: &str, kind: &str, text: &str, status: &str, turn: u32) -> MemoryItem {
    serde_json::from_value(json!({"id": id, "kind": kind, "text": text, "status": status, "sourceTurns": [turn], "updatedTurn": turn})).unwrap()
}

fn seg(from: u32, to: u32, topic: &str, title: &str) -> Segment {
    Segment { from_turn: from, to_turn: to, topic: topic.into(), title: title.into(), summary: format!("{title} work"), ..Default::default() }
}

fn conn() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    store::ensure_tables(&c).unwrap();
    ensure_tables(&c).unwrap();
    c
}

/// The memory saved in the chat's database, as the panel and `ctx set` see it.
fn save(c: &Connection, m: &TurnMemory) {
    let cur = store::load_memory(c, K).version;
    store::save_version(c, K, cur, m, "fold", &json!({}), None, 1).unwrap();
}

fn goal_state(c: &Connection) -> GoalState {
    let pr = |op: &str, title: &str, turn: u32| Proposal {
        op: op.into(),
        target: None,
        title: title.into(),
        description: String::new(),
        turn,
        origin: goals::ORIGIN_USER.into(),
        evidence: "x".into(),
    };
    let steps = [pr("create", "Billing page", 1), pr("complete", "", 6), pr("create", "Mobile release", 7)];
    let (_, st) = goals::apply(c, K, &steps, 1000).unwrap();
    st
}

fn memory() -> TurnMemory {
    TurnMemory {
        version: 4,
        through_turn: 20,
        segments: vec![seg(1, 3, "billing", "Stripe billing"), seg(4, 6, "billing", "Invoices"), seg(7, 10, "release", "Signing"), seg(11, 15, "release", "Store listing"), seg(16, 20, "release", "Upload")],
        decisions: Decisions {
            current: vec![dec("D6", "Release version code is 200", 12), dec("D8", "Indent with tabs", 1)],
            superseded: vec![Decision {
                id: "D2".into(),
                text: "Release version code is 150".into(),
                turn: 9,
                superseded_by: Some("D6".into()),
                superseded_at: Some(12),
                ..Default::default()
            }],
        },
        items: vec![
            item("O1", "openItem", "Upload screenshots", "current", 14),
            item("O2", "openItem", "Create the signing key", "done", 8),
            item("F1", "fact", "Staging host is kakatua-17.lan", "current", 3),
            item("P1", "preference", "Answers in Bangla", "current", 1),
            item("L1", "file", "docs/plan.md holds the release plan", "current", 9),
        ],
        ..Default::default()
    }
}

fn group_of<'a>(recs: &'a [Record], rid: &str) -> &'a str {
    recs.iter().find(|r| r.rid == rid).map(|r| r.group).unwrap_or("?")
}

#[test]
fn every_record_is_filed_under_its_own_group() {
    let c = conn();
    let st = goal_state(&c);
    let files = vec![FileRead { path: "src/main.rs".into(), hash: "aa".into(), turn: 3, call_index: 1, chars: 500, tool_use_id: String::new() }];
    let recs = records(&memory(), &st, &[json!({"version": 4, "kind": "fold", "throughTurn": 20})], &files);
    assert_eq!(group_of(&recs, "D6"), "mem.decisions");
    assert_eq!(group_of(&recs, "D2"), "mem.decisions.closed");
    assert_eq!(group_of(&recs, "O1"), "mem.tasks");
    assert_eq!(group_of(&recs, "O2"), "mem.tasks.closed");
    assert_eq!(group_of(&recs, "F1"), "mem.facts");
    assert_eq!(group_of(&recs, "P1"), "mem.prefs");
    assert_eq!(group_of(&recs, "L1"), "mem.files");
    assert_eq!(group_of(&recs, "file:src/main.rs"), "mem.files");
    assert_eq!(group_of(&recs, "V4"), "mem.versions");
    assert_eq!(group_of(&recs, "S16-20"), "mem.ranges");
    assert_eq!(group_of(&recs, "S1-3"), "mem.ranges.old");
    assert_eq!(group_of(&recs, "T-billing"), "mem.topics");
    assert!(recs.iter().any(|r| r.group == "mem.goals.closed"), "the completed goal");
    assert!(recs.iter().any(|r| r.group == "mem.goals"), "the active goal");
    assert!(recs.iter().filter(|r| r.group == "mem.goal_history").count() >= 3);
    // A topic row carries the titles its ranges were given.
    let t = recs.iter().find(|r| r.rid == "T-billing").unwrap();
    assert!(t.line.contains("Stripe billing") && t.line.contains("Invoices"), "{}", t.line);
    // Files answer to their name.
    assert_eq!(resolve(&recs, "#main.rs").as_deref(), Some("file:src/main.rs"));
    assert_eq!(resolve(&recs, "plan.md").as_deref(), Some("L1"));
    assert_eq!(resolve(&recs, "mem/d6").as_deref(), Some("D6"));
    assert!(GROUPS.iter().all(|(_, _, p)| p.map(|p| GROUPS.iter().any(|g| g.0 == p)).unwrap_or(true)));
}

#[test]
fn versions_are_kept_and_never_overwritten() {
    let c = conn();
    let st = goal_state(&c);
    let mut m = memory();
    let recs = records(&m, &st, &[], &[]);
    let n1 = sync_versions(&c, K, &recs, 4, 1).unwrap();
    assert_eq!(n1, recs.len());
    assert_eq!(sync_versions(&c, K, &recs, 4, 2).unwrap(), 0, "nothing changed, nothing written");
    m.decisions.current[1].text = "Indent with four spaces".into();
    let recs = records(&m, &st, &[], &[]);
    assert_eq!(sync_versions(&c, K, &recs, 5, 3).unwrap(), 1);
    let vs = load_versions(&c, K, "D8");
    assert_eq!(vs.len(), 2);
    assert!(vs[0].line.contains("tabs") && vs[1].line.contains("four spaces"));
    assert_eq!(vs[1].memory_version, 5);
}

fn convo(texts: &[(&str, &str)]) -> Vec<Message> {
    texts.iter().map(|(r, t)| if *r == "u" { Message::user(t) } else { Message::assistant_text(t) }).collect()
}

#[test]
fn the_last_mention_of_a_tag_wins_and_counts_once() {
    let c = conn();
    let st = goal_state(&c);
    let m = memory();
    let recs = records(&m, &st, &[], &[]);
    sync_versions(&c, K, &recs, 4, 1).unwrap();
    let msgs = convo(&[("u", "look at #D8 and #F1"), ("a", "ok"), ("u", "again #D8, and #nothing-here, a C# word"), ("a", "done"), ("u", "one more #d8.")]);
    let turn_of = |i: usize| Some((i / 2 + 1) as u32);
    let ms = scan_mentions(&msgs, &turn_of, &recs);
    assert_eq!(ms.iter().filter(|m| m.rid == "D8").count(), 3);
    assert!(ms.iter().all(|m| m.rid == "D8" || m.rid == "F1"), "unknown tags and C# are ignored: {ms:?}");
    record_mentions(&c, K, &ms, 5).unwrap();
    let tags = load_tags(&c, K);
    let d8 = tags.iter().find(|t| t.tag == "d8").unwrap();
    assert_eq!((d8.mentions, d8.first_turn, d8.last_turn), (3, 1, 3));
    let picks = build_picks(&c, K, &recs);
    // One include per tag, however often it was named.
    assert_eq!(picks.include.iter().filter(|(id, _)| id == "D8").count(), 1);
    assert!(picks.include.contains(&("F1".to_string(), "mentioned")));
}

#[test]
fn inactive_and_removed_tags_stop_pulling_their_record() {
    let c = conn();
    let st = goal_state(&c);
    save(&c, &memory());
    let recs = records(&memory(), &st, &[], &[]);
    let msgs = convo(&[("u", "use #F1 and #P1")]);
    let ms = scan_mentions(&msgs, &|_| Some(2), &recs);
    record_mentions(&c, K, &ms, 1).unwrap();
    let r = apply_ops(&c, K, &[json!({"id": "#F1", "action": "inactive"}), json!({"id": "mem/P1", "action": "remove"})], "user", 2);
    assert_eq!(r["ok"], true, "{r}");
    // The same transcript scanned again: the inactive tag keeps its state,
    // the removed one stays removed.
    record_mentions(&c, K, &ms, 3).unwrap();
    let picks = build_picks(&c, K, &recs);
    assert!(picks.include.is_empty(), "{picks:?}");
    assert!(picks.inactive.contains("F1"));
    assert!(!picks.inactive.contains("P1"));
    // A newer mention brings the removed tag back.
    let later = scan_mentions(&convo(&[("u", "now #P1 again")]), &|_| Some(5), &recs);
    record_mentions(&c, K, &later, 4).unwrap();
    let p1 = load_tags(&c, K).into_iter().find(|t| t.tag == "p1").unwrap();
    assert_eq!((p1.state.as_str(), p1.last_turn), ("active", 5));
    let picks = build_picks(&c, K, &recs);
    assert!(picks.include.iter().any(|(id, _)| id == "P1"));
    // Making F1 active again sends it.
    apply_ops(&c, K, &[json!({"id": "F1", "action": "active"})], "user", 6);
    assert!(build_picks(&c, K, &recs).include.iter().any(|(id, _)| id == "F1"));
}

fn run(_c: &Connection, m: &TurnMemory, st: &GoalState, query: &str, picks: &Picks, max: usize) -> Selection {
    select_with(&Input { mem: m, goals: st, query, previous: "", fts_turns: &[], max_tokens: max }, picks, &words)
}

#[test]
fn picks_override_relevance_and_every_record_gets_a_reason() {
    let c = conn();
    let st = goal_state(&c);
    let m = memory();
    save(&c, &m);
    let recs = records(&m, &st, &[], &[]);
    sync_versions(&c, K, &recs, 4, 1).unwrap();
    // Without picks the old decision D2 stays out of an unrelated request.
    let plain = run(&c, &m, &st, "what is the weather", &Picks::default(), 2000);
    assert!(!plain.text.contains("version code is 150"));
    // Checked in: D2 comes in; taken out: the preference P1 goes even though
    // it is essential.
    apply_ops(&c, K, &[json!({"id": "mem/D2", "action": "include"}), json!({"id": "mem/P1", "action": "exclude"})], "user", 2);
    let picks = build_picks(&c, K, &recs);
    let s = run(&c, &m, &st, "what is the weather", &picks, 2000);
    assert!(s.text.contains("version code is 150"), "{}", s.text);
    assert!(!s.text.contains("Answers in Bangla"), "{}", s.text);
    let reason = |id: &str| s.reasons.iter().find(|(r, _)| r == id).map(|(_, w)| w.clone()).unwrap_or_default();
    assert_eq!(reason("D2"), "user_pick");
    assert_eq!(reason("P1"), "excluded");
    assert_eq!(colour(&reason("P1")), "left_out");
    assert_eq!(colour(&reason("S1-3")), "show_more");
    // The active goal cannot be taken out.
    let active = st.current().unwrap().goal_id.clone();
    apply_ops(&c, K, &[json!({"id": format!("mem/{active}"), "action": "exclude"})], "user", 3);
    let s = run(&c, &m, &st, "hi", &build_picks(&c, K, &recs), 2000);
    assert!(s.goal_ids.contains(&active));
    save_status(&c, K, &s, &build_picks(&c, K, &recs), &recs, 4).unwrap();
    let snap = snapshot(&c, K);
    assert_eq!(snap["alwaysOn"], true);
    assert!(snap["counts"]["leftOut"].as_u64().unwrap() >= 1, "{}", snap["counts"]);
    assert!(snap["counts"]["showMore"].as_u64().unwrap() >= 1);
}

#[test]
fn all_versions_and_a_version_tag_send_earlier_wordings() {
    let c = conn();
    let st = goal_state(&c);
    let mut m = memory();
    sync_versions(&c, K, &records(&m, &st, &[], &[]), 4, 1).unwrap();
    m.decisions.current[1].text = "Indent with four spaces".into();
    save(&c, &m);
    let recs = records(&m, &st, &[], &[]);
    sync_versions(&c, K, &recs, 5, 2).unwrap();
    // "#D8@v1" in the chat sends the first wording.
    let ms = scan_mentions(&convo(&[("u", "go back to #D8@v1 please")]), &|_| Some(21), &recs);
    assert_eq!(ms[0].version, Some(1));
    record_mentions(&c, K, &ms, 3).unwrap();
    let picks = build_picks(&c, K, &recs);
    assert!(picks.extra.iter().any(|(k, l)| k == "D8@v1" && l.contains("tabs")), "{picks:?}");
    let s = run(&c, &m, &st, "hello", &picks, 2000);
    assert!(s.text.contains("Indent with tabs") && s.text.contains("Earlier versions chosen"), "{}", s.text);
    // all_versions on D6 brings D2, the decision it replaced.
    apply_ops(&c, K, &[json!({"id": "D6", "action": "all_versions"})], "model", 4);
    let picks = build_picks(&c, K, &recs);
    let s = run(&c, &m, &st, "hello", &picks, 2000);
    assert!(s.text.contains("version code is 150"), "{}", s.text);
    assert_eq!(s.reasons.iter().find(|(r, _)| r == "D2").map(|x| x.1.as_str()), Some("versions"));
}

fn read(id: &str, path: &str) -> Message {
    Message::assistant_blocks(vec![ContentBlock::ToolUse { id: id.into(), name: "read_file".into(), input: json!({"path": path}), provider_metadata: None }])
}

#[test]
fn the_same_file_content_is_sent_once_and_a_change_is_a_new_version() {
    let body = "fn main() { println!(\"hello\"); }\n".repeat(10);
    let changed = format!("{body}// changed\n");
    let msgs = vec![
        Message::user("read it"),
        read("a", "src/main.rs"),
        Message::tool_result("a", &body, false),
        Message::user("read it again"),
        read("b", "src/main.rs"),
        Message::tool_result("b", &body, false),
        Message::user("and after the edit"),
        read("c", "src/main.rs"),
        Message::tool_result("c", &changed, false),
    ];
    let turn_of = |i: usize| Some((i / 3 + 1) as u32);
    let (drop, reads) = duplicate_calls_abs(&msgs, &turn_of);
    assert_eq!(drop.into_iter().collect::<Vec<_>>(), vec![(1, 1)], "only the earlier identical read goes");
    assert_eq!(reads.len(), 3);
    let c = conn();
    save_files(&c, K, &reads).unwrap();
    let st = goal_state(&c);
    let recs = records(&memory(), &st, &[], &load_files(&c, K));
    let f = recs.iter().find(|r| r.rid == "file:src/main.rs").unwrap();
    assert!(f.status.contains("3 read(s), 2 distinct content(s)"), "{}", f.status);
    assert!(!f.line.contains("turn"), "the line names the content only: {}", f.line);
    // Short results are never treated as duplicates.
    let short = vec![read("x", "a.txt"), Message::tool_result("x", "ok", false), read("y", "a.txt"), Message::tool_result("y", "ok", false)];
    assert!(duplicate_calls_abs(&short, &|_| Some(1)).0.is_empty());
}

#[test]
fn unknown_ids_and_actions_are_refused_and_reset_clears_everything() {
    let c = conn();
    let _ = goal_state(&c);
    save(&c, &memory());
    let r = apply_ops(&c, K, &[json!({"id": "mem/D99", "action": "include"})], "model", 1);
    assert_eq!(r["ok"], false);
    let r = apply_ops(&c, K, &[json!({"id": "mem/F1", "action": "explode"})], "model", 1);
    assert_eq!(r["ok"], false);
    let (v, err) = view(&c, K, &json!({}));
    assert!(!err && v.contains("Decisions in force"), "{v}");
    let (v, err) = view(&c, K, &json!({"id": "#D6"}));
    assert!(!err && v.contains("Replaced earlier records: D2"), "{v}");
    apply_ops(&c, K, &[json!({"id": "mem/F1", "action": "exclude"})], "model", 2);
    assert!(!load_picks(&c, K).is_empty());
    reset_session(&c, K).unwrap();
    assert!(load_picks(&c, K).is_empty());
}

// ───────────── added: context at the last #tag, file versions, migration ─────────────

#[test]
fn a_tag_in_the_view_gets_its_context_once_at_its_last_mention_and_leaves_the_block() {
    let c = conn();
    let st = goal_state(&c);
    let m = memory();
    let recs = records(&m, &st, &[], &[]);
    sync_versions(&c, K, &recs, 4, 1).unwrap();
    let mut msgs = convo(&[("u", "look at #D8"), ("a", "ok"), ("u", "again #D8 please"), ("a", "done"), ("u", "one more #d8.")]);
    let turn_of = |i: usize| Some((i / 2 + 1) as u32);
    record_mentions(&c, K, &scan_mentions(&msgs, &turn_of, &recs), 5).unwrap();
    let anchors = anchors(&c, K, &recs, st.current().map(|g| g.goal_id.as_str()), &|_| true);
    assert_eq!(anchors.len(), 1, "one anchor per record: {anchors:?}");
    assert_eq!((anchors[0].rid.as_str(), anchors[0].turn), ("D8", 3));
    assert!(anchors[0].text.contains("Indent with tabs"), "{}", anchors[0].text);
    let picks = build_picks_with(&c, K, &recs, &anchors);
    assert!(picks.inline.contains("D8") && !picks.include.iter().any(|(id, _)| id == "D8"));
    let s = run(&c, &m, &st, "indent tabs", &picks, 2000);
    assert!(!s.text.contains("Indent with tabs"), "an anchored record is not repeated in the block: {}", s.text);
    assert_eq!(s.reasons.iter().find(|(r, _)| r == "D8").map(|x| x.1.as_str()), Some("inline"));
    assert_eq!(colour("inline"), "sent");
    assert_eq!(place_anchors(&mut msgs, &turn_of, &anchors), 1);
    let with: Vec<usize> = msgs.iter().enumerate().filter(|(_, m)| m.text().contains("[Context for #d8")).map(|(i, _)| i).collect();
    assert_eq!(with, vec![4], "only the last mention carries the context");
}

#[test]
fn a_tag_whose_last_mention_was_summarized_goes_through_the_block() {
    let c = conn();
    let st = goal_state(&c);
    let m = memory();
    let recs = records(&m, &st, &[], &[]);
    sync_versions(&c, K, &recs, 4, 1).unwrap();
    let msgs = convo(&[("u", "keep #F1 in mind"), ("a", "ok")]);
    record_mentions(&c, K, &scan_mentions(&msgs, &|_| Some(2), &recs), 5).unwrap();
    // Turn 2 is summarized (through turn 20): no anchor, the block sends it.
    let a = anchors(&c, K, &recs, None, &|t| t > 20);
    assert!(a.is_empty());
    let picks = build_picks_with(&c, K, &recs, &a);
    assert!(picks.include.contains(&("F1".to_string(), "mentioned")));
}

#[test]
fn inactive_removed_and_hand_picked_records_get_no_anchor() {
    let c = conn();
    let st = goal_state(&c);
    save(&c, &memory());
    let recs = current_records(&c, K);
    sync_versions(&c, K, &recs, 4, 1).unwrap();
    let msgs = convo(&[("u", "#D8 #F1 #P1 #O1"), ("a", "ok")]);
    record_mentions(&c, K, &scan_mentions(&msgs, &|_| Some(21), &recs), 5).unwrap();
    apply_ops(&c, K, &[json!({"id": "#D8", "action": "inactive"}), json!({"id": "#F1", "action": "remove"}), json!({"id": "mem/P1", "action": "include"})], "user", 6);
    let a = anchors(&c, K, &recs, st.current().map(|g| g.goal_id.as_str()), &|_| true);
    let rids: Vec<&str> = a.iter().map(|x| x.rid.as_str()).collect();
    assert_eq!(rids, vec!["O1"], "{a:?}");
}

#[test]
fn reading_a_file_again_is_not_a_version_and_every_version_stays_readable() {
    let c = conn();
    let st = goal_state(&c);
    let body = "line one of the plan\n".repeat(20);
    let changed = format!("{body}a new line\n");
    for (id, content, turn) in [("a", body.as_str(), 1u32), ("b", body.as_str(), 2), ("c", changed.as_str(), 3)] {
        store::store_result(&c, K, id, "read_file", Some("docs/plan.md"), content, false, Some(turn), 1).unwrap();
    }
    let reads = |upto: usize| -> Vec<FileRead> {
        [("a", &body, 1u32), ("b", &body, 2), ("c", &changed, 3)]
            .iter()
            .take(upto)
            .map(|(id, content, turn)| FileRead { path: "docs/plan.md".into(), hash: hash(content), turn: *turn, call_index: 1, chars: content.chars().count(), tool_use_id: id.to_string() })
            .collect()
    };
    for upto in 1..=3 {
        save_files(&c, K, &reads(upto)).unwrap();
        let recs = records(&TurnMemory::default(), &st, &[], &load_files(&c, K));
        sync_versions(&c, K, &recs, 0, upto as i64).unwrap();
    }
    let vs = load_versions(&c, K, "file:docs/plan.md");
    assert_eq!(vs.len(), 2, "two reads of the same content are one version: {vs:?}");
    let (v, _, turn, content) = file_version(&c, K, "file:docs/plan.md", Some(1)).unwrap();
    assert_eq!((v, turn), (1, Some(2)), "v1 is the newest read with that content");
    assert_eq!(content.as_deref(), Some(body.as_str()));
    // A version tag on the old content, the read no longer in the view: the
    // content itself goes to the tag; in the view: only a pointer.
    let recs = records(&TurnMemory::default(), &st, &[], &load_files(&c, K));
    let msgs = convo(&[("u", "compare with #plan.md@v1")]);
    record_mentions(&c, K, &scan_mentions(&msgs, &|_| Some(4), &recs), 5).unwrap();
    let out = anchors(&c, K, &recs, None, &|t| t >= 4);
    assert!(out[0].text.contains("line one of the plan") && !out[0].text.contains("a new line"), "{}", out[0].text);
    let shown = anchors(&c, K, &recs, None, &|_| true);
    assert!(shown[0].text.contains("file read of turn 2") && !shown[0].text.contains("line one"), "{}", shown[0].text);
    // ctx memory reads a version's content.
    let (txt, err) = view(&c, K, &json!({"id": "#plan.md@v1"}));
    assert!(!err && txt.contains("line one of the plan"), "{txt}");
}

#[test]
fn tables_from_the_first_build_get_the_tool_use_id_column() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE ctx_mem_files (session_key TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, turn INTEGER NOT NULL, call_index INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_key, path, turn, call_index)); INSERT INTO ctx_mem_files VALUES ('chat', 'a.txt', 'ff', 1, 1, 10);").unwrap();
    ensure_tables(&c).unwrap();
    ensure_tables(&c).unwrap();
    let f = load_files(&c, K);
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].tool_use_id, "");
}

#[test]
fn an_anchor_goes_to_a_whole_tag_never_to_a_longer_one() {
    let a = Anchor { rid: "D1".into(), tag: "d1".into(), version: None, turn: 1, text: "[Context for #d1]".into(), names: vec!["d1".into()] };
    let mut msgs = convo(&[("u", "see #D1, then"), ("a", "and #d12 too")]);
    let turn_of = |_: usize| Some(1u32);
    assert_eq!(anchor_slot(&msgs, &turn_of, &a), Some(0), "#d12 is not a mention of #d1");
    assert_eq!(place_anchors(&mut msgs, &turn_of, &[a.clone()]), 1);
    assert!(msgs[0].text().contains("[Context for #d1]") && !msgs[1].text().contains("[Context"));
    // A tag with no message to go to has no slot (the record then stays in the block).
    let none = convo(&[("u", "only #d12 here")]);
    assert_eq!(anchor_slot(&none, &turn_of, &a), None);
    let by_id = convo(&[("u", "the #mem/D1 row")]);
    assert_eq!(anchor_slot(&by_id, &turn_of, &a), Some(0));
}

// ───────────────────────────── long-term memory (every chat) ─────────────────────────────

#[test]
fn the_long_term_memory_is_a_versioned_group_of_the_tree() {
    let c = conn();
    let keys = parse_long_term_keys(r#"["user_name", "Diet Pref"]"#);
    assert_eq!(keys.as_deref(), Some(&["user_name".to_string(), "Diet Pref".to_string()][..]));
    assert_eq!(parse_long_term_keys(r#"{"error": "down"}"#), None, "a failed list removes nothing");
    let fetch = |k: &str| parse_long_term_text(&format!(r#"[{{"key": "{k}", "text": "value of {k}", "score": 1.0}}]"#), k);
    assert_eq!(sync_long_term(&c, keys.as_deref(), &fetch, 1), 2);
    let recs = long_term_records(&c);
    assert_eq!(recs.len(), 2);
    assert!(recs.iter().all(|r| r.group == LONG_TERM_GROUP && !r.native));
    let diet = recs.iter().find(|r| r.title == "Diet Pref").unwrap();
    assert_eq!(diet.tag, "lt:diet-pref");
    assert_eq!(diet.rid, "lt:Diet Pref");
    // It is a group of the same tree the panel and `ctx memory` read.
    let snap = snapshot(&c, K);
    let g = snap["groups"].as_array().unwrap().iter().find(|g| g["id"] == LONG_TERM_GROUP).expect("long-term group");
    assert_eq!(g["items"].as_array().unwrap().len(), 2, "{g}");
    // A #tag in the chat finds it; the last mention decides.
    let msgs = convo(&[("u", "remember #lt:diet-pref please"), ("a", "ok"), ("u", "and #lt:diet-pref again")]);
    let ms = scan_mentions(&msgs, &|i| Some((i / 2 + 1) as u32), &recs);
    assert_eq!(ms.iter().filter(|m| m.rid == "lt:Diet Pref").count(), 2);
    record_mentions(&c, K, &ms, 2).unwrap();
    let picks = build_picks(&c, K, &recs);
    // Not a selector record: it rides once as an extra line.
    assert_eq!(picks.extra.iter().filter(|(id, _)| id == "lt:Diet Pref").count(), 1, "{picks:?}");
    // Its wording is versioned: a change keeps v1 readable.
    sync_versions(&c, K, &recs, 1, 3).unwrap();
    long_term_put(&c, "Diet Pref", "vegetarian now", 4).unwrap();
    sync_versions(&c, K, &long_term_records(&c), 2, 5).unwrap();
    let vs = load_versions(&c, K, "lt:Diet Pref");
    assert!(vs.len() >= 2, "{} versions", vs.len());
    // The provider no longer lists a key: it leaves the live group.
    let only = vec!["user_name".to_string()];
    sync_long_term(&c, Some(&only), &fetch, 6);
    assert_eq!(long_term_records(&c).len(), 1);
}

#[test]
fn ctx_remember_and_forget_write_the_long_term_group_without_a_memory_tool() {
    let c = conn();
    let (text, err) = long_term_apply(&c, None, "remember", &json!({"key": "editor", "text": "uses VS Code"}));
    assert!(!err, "{text}");
    assert!(text.contains("#lt:editor"), "{text}");
    assert_eq!(long_term_entries(&c).len(), 1);
    let (text, err) = long_term_apply(&c, None, "forget", &json!({"key": "#lt:editor"}));
    assert!(!err, "{text}");
    assert!(long_term_entries(&c).is_empty());
    let (_, err) = long_term_apply(&c, None, "remember", &json!({"key": "x"}));
    assert!(err, "remember needs text");
    // A chat reset does not touch it: it belongs to every chat.
    long_term_put(&c, "city", "Rajshahi", 1).unwrap();
    reset_session(&c, K).unwrap();
    assert_eq!(long_term_entries(&c).len(), 1);
}

#[test]
fn a_long_term_entry_keeps_one_version_history_for_every_chat() {
    let c = conn();
    long_term_put(&c, "city", "Dhaka", 1).unwrap();
    sync_versions(&c, "chat-a", &long_term_records(&c), 1, 2).unwrap();
    long_term_put(&c, "city", "Rajshahi", 3).unwrap();
    sync_versions(&c, "chat-b", &long_term_records(&c), 1, 4).unwrap();
    // Both chats read the same two versions: v1 Dhaka, v2 Rajshahi.
    for chat in ["chat-a", "chat-b", "chat-c"] {
        let vs = load_versions(&c, chat, "lt:city");
        assert_eq!(vs.len(), 2, "{chat}: {vs:?}");
        assert!(vs[0].line.contains("Dhaka") && vs[1].line.contains("Rajshahi"), "{chat}: {vs:?}");
    }
    // A second chat seeing the same wording writes no duplicate version.
    assert_eq!(sync_versions(&c, "chat-a", &long_term_records(&c), 2, 5).unwrap(), 0);
    // A chat reset keeps the shared history.
    reset_session(&c, "chat-a").unwrap();
    assert_eq!(load_versions(&c, "chat-b", "lt:city").len(), 2);
    // Chat records still keep their versions per chat.
    assert_eq!(version_scope("chat-a", "D6"), "chat-a");
    assert_eq!(version_scope("chat-a", "lt:city"), GLOBAL_VERSIONS_KEY);
}

#[test]
fn a_full_long_term_list_may_be_cut_short_so_it_forgets_nothing() {
    let c = conn();
    let fetch = |k: &str| Some(format!("value of {k}"));
    long_term_put(&c, "oldest", "kept by the provider past the list cap", 1).unwrap();
    // A list as long as the cap may be cut short: the missing key stays.
    let full: Vec<String> = (0..LONG_TERM_MAX).map(|n| format!("k{n}")).collect();
    sync_long_term(&c, Some(&full), &fetch, 2);
    let removed: i64 = c.query_row("SELECT removed FROM ctx_mem_longterm WHERE key = 'oldest'", [], |r| r.get(0)).unwrap();
    assert_eq!(removed, 0, "a cut-short list must not forget an entry");
    // A shorter list is the whole list: a missing key is forgotten.
    let c = conn();
    long_term_put(&c, "oldest", "gone from the provider", 1).unwrap();
    let short = vec!["k1".to_string()];
    sync_long_term(&c, Some(&short), &fetch, 3);
    let removed: i64 = c.query_row("SELECT removed FROM ctx_mem_longterm WHERE key = 'oldest'", [], |r| r.get(0)).unwrap();
    assert_eq!(removed, 1);
}

#[test]
fn a_group_op_without_the_mem_prefix_is_routed_to_the_memory() {
    assert!(is_memory_id("group:mem.longterm"));
    assert!(is_memory_id("memgrp/mem.files"));
    assert!(is_memory_id("mem/group:mem.decisions"));
    assert!(!is_memory_id("turn/t1"));
}

#[test]
fn the_memory_is_always_on_even_when_an_old_settings_file_says_off() {
    let s: crate::turn_memory::MemorySettings = serde_json::from_value(json!({"enabled": false})).unwrap();
    assert!(s.clamped().enabled);
}

#[test]
fn a_whole_group_is_checked_in_or_out_with_one_op() {
    let c = conn();
    long_term_put(&c, "a", "first", 1).unwrap();
    long_term_put(&c, "b", "second", 2).unwrap();
    let r = apply_ops(&c, K, &[json!({"id": "group:mem.longterm", "action": "exclude"})], "user", 3);
    assert_eq!(r["ok"], true, "{r}");
    let picks = load_picks(&c, K);
    assert_eq!(picks.values().filter(|p| p.pick == "out").count(), 2, "{r}");
    let r = apply_ops(&c, K, &[json!({"id": "memgrp/mem.longterm", "action": "auto"})], "user", 4);
    assert_eq!(r["ok"], true, "{r}");
    assert!(load_picks(&c, K).values().all(|p| p.pick != "out"));
}
