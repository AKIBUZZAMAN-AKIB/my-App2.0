//! The main agent as a group host (unified plan, Phase 4).

use super::*;
use crate::ws::groups;
use crate::subagents::main_groups::*;

fn setup() -> (Arc<SubagentManager>, ParentEnv) {
    let (m, _s, _a, e, _) = super::setup();
    std::fs::create_dir_all(&m.state_dir).unwrap();
    let db = m.state_dir.join("agent.db");
    {
        let c = crate::db::open_db(&db.to_string_lossy()).unwrap();
        crate::db::ensure_schema(&c).unwrap();
    }
    m.set_tree_db(&db.to_string_lossy());
    (m, e)
}

async fn agents(mgr: &Arc<SubagentManager>, env: &ParentEnv, names: &[&str]) -> Vec<SubagentRecord> {
    let mut ids = Vec::new();
    for name in names {
        ids.push(mgr.spawn(0, SpawnSpec { name: Some(name.to_string()), ..spec("ok") }, env).unwrap().id);
    }
    mgr.wait_for(&ids, None, Duration::from_secs(5)).await;
    ids.iter().map(|i| mgr.get(i).unwrap()).collect()
}

#[tokio::test]
async fn main_group_create_uses_own_session_as_home() {
    let (mgr, env) = setup();
    agents(&mgr, &env, &["writer", "critic", "editor"]).await;
    let (out, err) = mgr.handle_main_group_tool(TOOL_MAIN_GROUP_CREATE, &json!({"name": "Review", "members": ["writer", "@critic", "Editor"], "preset": "round_robin"}), &env);
    assert!(!err, "{out}");
    let conn = mgr.ws_conn().unwrap();
    let root = mgr.root_of(&env.session_key);
    let ids = groups::of_home(&conn, &root).unwrap();
    assert_eq!(ids.len(), 1, "the chat that asked is the home");
    let g = groups::get(&conn, &ids[0], &mgr.group_agents()).unwrap();
    assert_eq!(g["group"]["homeRoot"], root.as_str());
    // The host is a member, but not one of the three agents it named.
    let agents_in: Vec<&Value> = g["members"].as_array().unwrap().iter().filter(|m| m["pid"] != "user" && m["pid"] != groups::HOST_PID).collect();
    assert_eq!(agents_in.len(), 3);
    // It shows up in list_groups for this chat only.
    let (list, _) = mgr.handle_main_group_tool(TOOL_MAIN_LIST_GROUPS, &json!({}), &env);
    assert!(list.contains("#review") || list.to_lowercase().contains("review"), "{list}");
    let other = ParentEnv { session_key: "chat-2".into(), ..env.clone() };
    let (none, _) = mgr.handle_main_group_tool(TOOL_MAIN_LIST_GROUPS, &json!({}), &other);
    assert_eq!(none, "This chat has no groups.");
}

#[tokio::test]
async fn main_group_create_with_two_agents_explains() {
    let (mgr, env) = setup();
    agents(&mgr, &env, &["writer", "critic"]).await;
    let (out, err) = mgr.handle_main_group_tool(TOOL_MAIN_GROUP_CREATE, &json!({"name": "Duo", "members": ["writer", "critic"]}), &env);
    assert!(err);
    assert!(out.contains("need 3 agents"), "{out}");
    assert!(out.contains("this chat has 2 (critic, writer)"), "{out}");
    assert!(out.contains("spawn one or pick a shareable one"), "{out}");
    // An unknown name is named in the error.
    let (out, err) = mgr.handle_main_group_tool(TOOL_MAIN_GROUP_CREATE, &json!({"name": "Trio", "members": ["writer", "critic", "ghost"]}), &env);
    assert!(err && out.contains("ghost"), "{out}");
}

#[tokio::test]
async fn main_group_names_prefer_this_chat_and_refuse_private_agents_elsewhere() {
    let (mgr, env) = setup();
    let other = ParentEnv { session_key: "chat-2".into(), ..env.clone() };
    let theirs = agents(&mgr, &other, &["scout"]).await;
    agents(&mgr, &env, &["writer", "critic"]).await;
    let (out, err) = mgr.handle_main_group_tool(TOOL_MAIN_GROUP_CREATE, &json!({"name": "Mix", "members": ["writer", "critic", "scout"]}), &env);
    assert!(err && out.contains("another chat") && out.contains("not shareable"), "{out}");
    // Once shareable, the other chat's agent can join.
    mgr.update(&theirs[0].id, |r| r.shareable = true);
    let (out, err) = mgr.handle_main_group_tool(TOOL_MAIN_GROUP_CREATE, &json!({"name": "Mix", "members": ["writer", "critic", "scout"]}), &env);
    assert!(!err, "{out}");
}

#[test]
fn main_tool_list_has_group_tools_and_sub_agent_list_does_not() {
    let main: Vec<String> = SubagentManager::main_group_tool_definitions().into_iter().map(|t| t.name).collect();
    for n in MAIN_GROUP_TOOL_NAMES {
        assert!(main.iter().any(|m| m == n), "{n} offered to the main agent");
    }
    let sub: Vec<String> = SubagentManager::group_tool_definitions().into_iter().map(|t| t.name).collect();
    assert!(!sub.iter().any(|t| t == TOOL_MAIN_GROUP_CREATE), "sub-agents cannot create groups: {sub:?}");
    assert!(!sub.iter().any(|t| t == TOOL_MAIN_GROUP_MEMBERS));
}
