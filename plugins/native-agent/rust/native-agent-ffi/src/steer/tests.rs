use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn envelope_round_trips_and_plain_text_gets_an_id() {
    let mut env = SteerEnvelope::new("use yarn, not npm");
    env.target = Some("sa_1".into());
    env.mode = Some("update".into());
    let back = SteerEnvelope::decode(&env.encode());
    assert_eq!(back, env);
    let plain = SteerEnvelope::decode("{not json but braces");
    assert_eq!(plain.text, "{not json but braces");
    assert!(plain.id.starts_with("st-"));
    // JSON without the wire key is user text, kept verbatim.
    let raw = r#"{"text":"hi"}"#;
    assert_eq!(SteerEnvelope::decode(raw).text, raw);
}

#[test]
fn steer_message_keeps_the_verbatim_text_and_is_recognised() {
    let env = SteerEnvelope::new("line one\n\nline two");
    let m = steer_message(&env, Some("intent: Amend"));
    let (id, text, patch) = steer_of(&m).unwrap();
    assert_eq!(id, env.id);
    assert_eq!(text, "line one\n\nline two");
    assert!(!patch);
    assert!(m.is_user_prompt());
    let pm = patch_message(&env.id, "goal now: x");
    let (pid, ptext, is_patch) = steer_of(&pm).unwrap();
    assert_eq!((pid.as_str(), ptext.as_str(), is_patch), (env.id.as_str(), "goal now: x", true));
    assert!(steer_of(&Message::user("[steer is a word]")).is_none());
}

#[test]
fn fast_path_handles_stop_and_tiny_info_only() {
    let base = PatchBase::default();
    assert_eq!(fast_path(&SteerEnvelope::new("stop!"), &base).unwrap().intent, SteerIntent::Cancel);
    assert_eq!(fast_path(&SteerEnvelope::new("থামো"), &base).unwrap().intent, SteerIntent::Cancel);
    assert_eq!(fast_path(&SteerEnvelope::new("port is 8080"), &base).unwrap().intent, SteerIntent::AddInfo);
    assert!(fast_path(&SteerEnvelope::new("how far along are you?"), &base).is_none());
    let mut upd = SteerEnvelope::new("use yarn");
    upd.mode = Some("update".into());
    assert!(fast_path(&upd, &base).is_none());
    assert!(fast_path(&SteerEnvelope::new("stop using npm and switch the whole build to yarn workspaces"), &base).is_none());
}

#[test]
fn parse_patch_reads_the_interpreter_json() {
    let ids = vec!["st-a".to_string()];
    let p = parse_patch(
        r#"Sure: {"intent":"Redirect","goal_edit":"build with yarn","plan_edit":null,"checklist":["swap lockfile"],"target_agent":null,"agent_note":"drop npm","ctx_ops":[]}"#,
        &ids,
        &PatchBase::default(),
    )
    .unwrap();
    assert_eq!(p.intent, SteerIntent::Redirect);
    assert_eq!(p.goal_edit.as_deref(), Some("build with yarn"));
    assert_eq!(p.checklist_ops.len(), 1);
    assert!(p.note().contains("goal now: build with yarn"));
    assert!(parse_patch("no json", &ids, &PatchBase::default()).is_none());
}

#[test]
fn steer_is_never_lost_without_a_patch() {
    // Interpreter absent / slow: the verbatim text still goes in once the grace
    // window passes, and a forced point (SP3) delivers at once.
    let hub = SteerHub::new();
    hub.set_grace_ms(60_000);
    let env = SteerEnvelope::new("also cover the edge case of empty input please");
    hub.enqueue(vec![env.clone()]);
    let d = hub.take_deliverable(&SafePoint::BetweenTools, false);
    assert!(d.messages.is_empty(), "waits for its patch inside the grace window");
    assert!(hub.has_pending());
    let d = hub.take_deliverable(&SafePoint::BeforeBreak, true);
    assert_eq!(d.delivered, vec![env.id.clone()]);
    assert_eq!(steer_of(&d.messages[0]).unwrap().1, env.text);
    assert!(!hub.has_pending());
    // Delivered once only.
    hub.enqueue(vec![env]);
    assert!(hub.take_deliverable(&SafePoint::BeforeModel, true).messages.is_empty());
}

#[test]
fn a_late_patch_becomes_a_patch_note_and_is_applied_once() {
    let hub = SteerHub::new();
    hub.set_grace_ms(0);
    let env = SteerEnvelope::new("actually build it for arm64 instead of x86 everywhere");
    hub.enqueue(vec![env.clone()]);
    let d = hub.take_deliverable(&SafePoint::BeforeModel, false);
    assert_eq!(d.delivered.len(), 1);
    let mut p = parse_patch(r#"{"intent":"Amend","goal_edit":"arm64 build"}"#, &[env.id.clone()], &PatchBase::default()).unwrap();
    p.source = "model".into();
    hub.store_patch(p);
    let d = hub.take_deliverable(&SafePoint::BetweenTools, false);
    assert_eq!(d.patches.len(), 1);
    assert!(d.redirect.is_some());
    assert!(steer_of(&d.messages[0]).unwrap().2);
    assert!(hub.take_deliverable(&SafePoint::BetweenTools, false).patches.is_empty());
}

#[test]
fn new_task_and_question_do_not_enter_the_running_turn() {
    let hub = SteerHub::new();
    hub.set_grace_ms(60_000);
    let a = SteerEnvelope::new("also book me a flight to Dhaka tomorrow morning");
    let b = SteerEnvelope::new("how far along are you with the tests?");
    hub.enqueue(vec![a.clone(), b.clone()]);
    hub.store_patch(parse_patch(r#"{"intent":"NewTask"}"#, &[a.id.clone()], &PatchBase::default()).unwrap());
    hub.store_patch(parse_patch(r#"{"intent":"Question","answer":"step 3 of 5"}"#, &[b.id.clone()], &PatchBase::default()).unwrap());
    let d = hub.take_deliverable(&SafePoint::BeforeModel, false);
    assert!(d.messages.is_empty());
    assert!(!hub.has_pending());
}

#[tokio::test]
async fn a_second_steer_goes_to_the_existing_steer_process() {
    let hub = Arc::new(SteerHub::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    {
        let calls = calls.clone();
        let seen = seen.clone();
        hub.set_model(Arc::new(move |_s, user, _t| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            seen.lock().unwrap().push(user);
            Box::pin(async move {
                if n == 0 {
                    // The first reading is slow: the second steer interrupts it.
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                Ok(r#"{"intent":"Amend","goal_edit":"use yarn and pnpm-free scripts"}"#.to_string())
            })
        }));
    }
    let first = SteerEnvelope::new("please switch the package manager over to yarn now");
    let second = SteerEnvelope::new("and do not touch the pnpm scripts in tools either");
    assert!(hub.submit(first.clone()).is_none());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(hub.submit(second.clone()).is_none());
    for _ in 0..100 {
        if hub.state.lock().unwrap().patches.contains_key(&second.id) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(hub.spawned.load(Ordering::SeqCst), 1, "one steer process per handle");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "the running reading was re-asked");
    let second_req = seen.lock().unwrap()[1].clone();
    assert!(second_req.contains(&first.text) && second_req.contains(&second.text));
    assert!(second_req.contains("Newest message (wins on conflict)"));
    let s = hub.state.lock().unwrap();
    assert_eq!(s.patches[&first.id].uid, s.patches[&second.id].uid, "one patch covers both");
}

#[test]
fn apply_patch_tx_keeps_user_checklists_read_only_and_supersedes_the_plan() {
    let path = std::env::temp_dir().join(format!("steer-apply-{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let db = path.to_str().unwrap();
    let conn = Connection::open(db).unwrap();
    crate::db::ensure_schema(&conn).unwrap();
    crate::context_tree::store::ensure_tables(&conn).unwrap();
    crate::context_tree::store::put_strategy(&conn, "s", "old plan: step 1 done, step 2", None, 1).unwrap();
    let env = SteerEnvelope::new("x");
    inbox_insert(&conn, "s", &env, "accepted").unwrap();
    let mut p = parse_patch(
        r#"{"intent":"Redirect","plan_edit":"new plan","ctx_ops":[{"id":"ucl/1","action":"exclude"}]}"#,
        &[env.id.clone()],
        &PatchBase::default(),
    )
    .unwrap();
    p.base.ctx_rev = 0;
    let out = apply_patch_tx(db, "s", &p).unwrap();
    assert_eq!(out.refused_locked, 1);
    let (_, text, _) = crate::context_tree::store::latest_strategy(&conn, "s").unwrap().unwrap();
    assert!(text.starts_with("new plan"));
    assert!(text.contains("Superseded by steer") && text.contains("old plan: step 1 done"));
    assert_eq!(inbox_status(&conn, &env.id).as_deref(), Some("applied"));
}

#[test]
fn unapplied_inbox_rows_surface_after_a_restart() {
    let conn = Connection::open_in_memory().unwrap();
    let a = SteerEnvelope::new("left behind");
    let b = SteerEnvelope::new("went in");
    inbox_insert(&conn, "s", &a, "accepted").unwrap();
    inbox_insert(&conn, "s", &b, "applied").unwrap();
    let rows = inbox_take_unapplied(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].text, "left behind");
    assert_eq!(inbox_status(&conn, &a.id).as_deref(), Some("unapplied"));
    inbox_dismiss(&conn, &a.id).unwrap();
    assert!(inbox_take_unapplied(&conn).unwrap().is_empty());
}

#[test]
fn per_steer_checklists_are_active_by_default_and_goal_revisions_dedupe_by_id() {
    let hub = SteerHub::new();
    let mut p = parse_patch(r#"{"intent":"Amend","goal_edit":"g1","checklist":["a","b"]}"#, &["st-1".into()], &PatchBase::default()).unwrap();
    hub.record_patch(&p);
    p.goal_edit = Some("g2".into());
    p.checklist_ops.clear();
    hub.record_patch(&p);
    let lines = hub.task_lines();
    assert_eq!(lines[0], "Goal as changed by steer st-1: g2");
    assert_eq!(lines[1], "Steer st-1 to-do: [ ] a; [ ] b");
    assert!(hub.set_checklist_active("st-1", false));
    assert_eq!(hub.task_lines().len(), 1);
}

#[test]
fn a_last_step_steer_stays_in_the_running_turn() {
    // SP3: the model answered, a steer was waiting, the loop continued with it.
    let env = SteerEnvelope::new("also mention the date");
    let msgs = vec![
        Message::user("write the report"),
        Message::assistant_text("Here is the report."),
        steer_message(&env, None),
        Message::assistant_text("Here is the report, dated."),
        Message::user("next question"),
    ];
    let turns = crate::turn_memory::split_turns(&msgs);
    assert_eq!(turns.len(), 2, "the steer joined turn 1; only the next prompt opens turn 2");
    assert_eq!((turns[0].start, turns[0].end), (0, 4));
    assert_eq!(
        crate::turn_memory::origin_of(&msgs[2]),
        crate::turn_memory::MessageOrigin::Steer { id: env.id.clone() }
    );
}

#[test]
fn goal_revisions_dedupe_by_steer_id_not_text() {
    let mut g = crate::context_policy::task_goal::TaskGoal::new("do x", &[], None, 1);
    assert!(g.add_steer_with_id("st-1", "only the errors please"));
    assert!(!g.add_steer_with_id("st-1", "only the errors please"));
    assert!(g.add_steer_with_id("st-2", "only the errors please"), "same words, new steer");
    assert_eq!(g.steer_messages.len(), 2);
}
