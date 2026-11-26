//! The `policy.*` actions of `memory_action`: what the Context Policies
//! workspace and the context card's Policy tab read and write.
//!
//! Every write is validated first; a rule file with any problem is never
//! written. Nothing here runs a model or a tool.

use rusqlite::Connection;
use serde_json::{json, Value};

use super::dsl_validator;
use super::policy_selector::{self, AiPick, Candidate, SelectInput};
use super::registry;
use super::request_facts::{self, FactInput};
use super::rule_evaluator;
use super::store;
use super::types::PolicyId;

fn errors_json(errs: &[super::dsl_parser::DslError]) -> Value {
    Value::Array(errs.iter().map(|e| e.to_json()).collect())
}

fn settings(conn: &Connection) -> Result<crate::context_tree::settings::Settings, String> {
    crate::context_tree::settings::Settings::load(conn).map_err(|e| e.to_string())
}

/// The rule file as the editor shows it: the file when there is one, else the
/// built-in default written out.
fn rules_doc(loaded: &store::LoadedRules) -> Value {
    loaded.doc.clone().unwrap_or_else(|| {
        json!({
            "version": 1,
            "defaults": {"policy": "T7", "start": "first_tool_call", "end": "task_completed", "on_error": "retry_then_fallback", "max_retries": 2, "unknown_policy": "T7"},
            "policies": registry::all().iter().map(|d| json!({"id": d.id.as_str(), "name": d.id.name()})).collect::<Vec<_>>(),
            "rules": [],
            "exclusions": {"always_exclude": {"categories": [], "groups": [], "turn_ids": [], "item_ids": []}}
        })
    })
}

fn candidates(conn: &Connection, key: &str) -> Vec<Candidate> {
    crate::context_tree::store::load_nodes(conn, key)
        .map(|v| {
            v.into_iter()
                .filter(|n| {
                    let id = n.id.as_str();
                    id.starts_with("turn/t") && !id[6..].contains('/') || id.starts_with("res/")
                })
                .map(|n| Candidate {
                    id: n.id.as_str().to_string(),
                    title: n.title.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Handle one `policy.*` action. An `Err` is a message for the screen.
pub fn action(
    conn: &Connection,
    ws: &str,
    key: &str,
    action: &str,
    req: &Value,
    now_ms: i64,
) -> Result<Value, String> {
    store::ensure_tables(conn).map_err(|e| e.to_string())?;
    match action {
        "policy.get" => {
            let loaded = store::load_rules(ws);
            let s = settings(conn)?;
            let pin = store::get_pin(conn, key).map_err(|e| e.to_string())?;
            let task = store::active_task(conn, key).map_err(|e| e.to_string())?;
            let recent = store::recent_tasks(conn, key, 10).map_err(|e| e.to_string())?;
            let events = store::events(conn, key, None, 50).map_err(|e| e.to_string())?;
            let proposals =
                store::list_proposals(conn, Some("proposed")).map_err(|e| e.to_string())?;
            Ok(json!({
                "registry": registry::to_json(),
                "rules": rules_doc(&loaded),
                "rulesOrigin": loaded.origin,
                "rulesWarning": loaded.warning,
                "rulesPath": store::rules_path(ws).to_string_lossy(),
                "fields": dsl_validator::fields_json(),
                "settings": {
                    "policy_mode": s.policy_mode.as_str(),
                    "policy_max_retries": s.policy_max_retries,
                    "policy_recent_turns": s.policy_recent_turns,
                },
                "pin": pin.map(|p| json!({"policy": p.policy_id.as_str(), "params": Value::Object(p.params), "at": p.at})),
                "activeTask": task.map(|t| t.to_json()),
                "recentTasks": recent.iter().map(|t| t.to_json()).collect::<Vec<_>>(),
                "events": events,
                "proposals": proposals.iter().map(|p| p.to_json()).collect::<Vec<_>>(),
            }))
        }
        "policy.validate" => {
            let doc = req.get("rules").cloned().unwrap_or(Value::Null);
            Ok(match dsl_validator::validate(&doc) {
                Ok(set) => json!({ "valid": true, "errors": [], "rules": set.rules.len() }),
                Err(errs) => json!({ "valid": false, "errors": errors_json(&errs) }),
            })
        }
        "policy.save" => {
            let doc = req.get("rules").cloned().unwrap_or(Value::Null);
            Ok(match store::save_rules(ws, &doc) {
                Ok(set) => json!({ "saved": true, "errors": [], "rules": set.rules.len() }),
                Err(errs) => json!({ "saved": false, "errors": errors_json(&errs) }),
            })
        }
        "policy.pin" => {
            let raw = req.get("policy").and_then(Value::as_str).unwrap_or("");
            let id =
                PolicyId::parse(raw).ok_or_else(|| format!("{raw:?} is not a policy (T1..T7)"))?;
            let params =
                registry::validate_params(id, req.get("params")).map_err(|e| e.join("; "))?;
            store::set_pin(conn, key, id, &params, now_ms).map_err(|e| e.to_string())?;
            Ok(
                json!({ "pinned": true, "pin": {"policy": id.as_str(), "params": Value::Object(params), "at": now_ms} }),
            )
        }
        "policy.unpin" => {
            let removed = store::clear_pin(conn, key).map_err(|e| e.to_string())?;
            Ok(json!({ "unpinned": removed }))
        }
        "policy.preview" => {
            let request = req.get("request").and_then(Value::as_str).unwrap_or("");
            let tool: Vec<String> = req
                .get("tool")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|s| vec![s.trim().to_string()])
                .unwrap_or_default();
            // A draft rule file can be tried before it is saved.
            let (set, origin) = match req.get("rules").filter(|v| !v.is_null()) {
                Some(doc) => match dsl_validator::validate(doc) {
                    Ok(set) => (set, "draft"),
                    Err(errs) => {
                        return Ok(json!({ "valid": false, "errors": errors_json(&errs) }))
                    }
                },
                None => (store::load_rules(ws).set, "saved"),
            };
            let s = settings(conn)?;
            let mode = req
                .get("mode")
                .and_then(Value::as_str)
                .map(super::types::PolicyMode::parse_or_off)
                .unwrap_or(s.policy_mode);
            let facts = request_facts::compute(&FactInput {
                request,
                tool_names: &tool,
                first_calls: &tool,
                ..Default::default()
            });
            let pin = store::get_pin(conn, key)
                .map_err(|e| e.to_string())?
                .map(|p| (p.policy_id, p.params));
            let ai = req.get("ai").filter(|v| v.is_object()).map(|a| AiPick {
                policy: a.get("id").and_then(Value::as_str).map(String::from),
                params: None,
                ids: a
                    .get("ids")
                    .and_then(Value::as_array)
                    .map(|v| {
                        v.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
            });
            let known = crate::context_tree::dispatch::known_item(conn, key);
            let cands = candidates(conn, key);
            let group_of = crate::context_tree::memory_checklist::group_lookup(conn, key);
            let sel = policy_selector::select(&SelectInput {
                mode,
                pin,
                rules: &set,
                facts: &facts,
                ai: ai.as_ref(),
                request,
                candidates: &cands,
                known: &known,
                group_of: &group_of,
                recent_turns: s.policy_recent_turns as i64,
                steer_count: 0,
                now_ms,
            });
            Ok(json!({
                "valid": true,
                "rulesFrom": origin,
                "mode": mode.as_str(),
                "facts": request_facts::to_json(&facts),
                "match": rule_evaluator::explain(&set, &facts),
                "rule": sel.rule_id,
                "policy": sel.checklist.policy_id.as_str(),
                "policyName": sel.checklist.policy_id.name(),
                "source": sel.checklist.source.as_str(),
                "checklist": sel.checklist.to_json(),
                "removed": sel.removed.iter().map(|r| json!({"id": r.id, "reason": r.reason})).collect::<Vec<_>>(),
                "notes": sel.corrections.notes,
            }))
        }
        "policy.proposals" => {
            let status = req.get("status").and_then(Value::as_str);
            let list = store::list_proposals(conn, status).map_err(|e| e.to_string())?;
            Ok(json!({ "proposals": list.iter().map(|p| p.to_json()).collect::<Vec<_>>() }))
        }
        "policy.approve" => {
            let id = req
                .get("id")
                .and_then(Value::as_i64)
                .ok_or("policy.approve needs the proposal's id")?;
            let p = store::get_proposal(conn, id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("no proposal #{id}"))?;
            if p.status != "proposed" {
                return Err(format!("proposal #{id} is already {}", p.status));
            }
            let loaded = store::load_rules(ws);
            if loaded.origin == "builtin_after_error" {
                return Ok(
                    json!({ "approved": false, "errors": [{"path": "$", "message": loaded.warning.unwrap_or_default()}] }),
                );
            }
            let mut doc = rules_doc(&loaded);
            if !doc.get("rules").is_some_and(Value::is_array) {
                doc["rules"] = json!([]);
            }
            doc["rules"]
                .as_array_mut()
                .expect("array")
                .push(p.rule.clone());
            match store::save_rules(ws, &doc) {
                Ok(_) => {
                    store::set_proposal_status(conn, id, "approved").map_err(|e| e.to_string())?;
                    Ok(json!({ "approved": true, "errors": [] }))
                }
                Err(errs) => Ok(json!({ "approved": false, "errors": errors_json(&errs) })),
            }
        }
        "policy.reject" => {
            let id = req
                .get("id")
                .and_then(Value::as_i64)
                .ok_or("policy.reject needs the proposal's id")?;
            let done =
                store::set_proposal_status(conn, id, "rejected").map_err(|e| e.to_string())?;
            Ok(json!({ "rejected": done }))
        }
        other => Err(format!("unknown policy action {other}")),
    }
}
