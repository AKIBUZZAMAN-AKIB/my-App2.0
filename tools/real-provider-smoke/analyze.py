#!/usr/bin/env python3
"""Summarises a smoke run: proxy records (real requests/responses) + app events.
Usage: analyze.py OUT_DIR  -> prints JSON lines per scenario."""
import json, os, sys

out = sys.argv[1]
recs = [json.loads(l) for l in open(os.path.join(out, "proxy", "requests.jsonl"))]
runs = [json.loads(l) for l in open(os.path.join(out, "runs.jsonl"))]
seen = {}
for run in runs:
    seen[run["scenario"]] = run  # last run of each scenario wins
for name, run in seen.items():
    ev_path = os.path.join(out, name, "events.jsonl")
    if not os.path.exists(ev_path):
        continue
    events = [json.loads(l) for l in open(ev_path)]
    posts = [r for r in recs[run["proxy_from"]:run["proxy_to"]] if r["method"] == "POST"]
    assemblies = [e["payload"] for e in events if e["event"] == "context.assembly"]
    print(json.dumps({"scenario": name, "exit": run["exit"], "post_requests": len(posts), "assembly_events": len(assemblies)}))
    ai = 0
    for r in posts:
        q, s = r.get("req", {}), r.get("resp", {})
        is_summary = q.get("n_messages") == 2 and not q.get("tools") and not q.get("stream")
        est = None
        if not is_summary and ai < len(assemblies):
            est = assemblies[ai].get("estimatedInputTokens")
            ai += 1
        u = s.get("usage") or {}
        print(json.dumps({
            "seq": r["seq"], "kind": "memory-summary" if is_summary else "chat", "upstream": r["upstream"], "status": r.get("status"),
            "model_req": q.get("model"), "model_resp": s.get("model"), "stream": q.get("stream"), "sse_chunks": s.get("sse_chunks"),
            "id": s.get("id"), "kong_request_id": (r.get("headers") or {}).get("x-kong-request-id"),
            "est_input": est, "prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens"),
            "cost": u.get("cost"), "finish": s.get("finish_reason"), "tools_offered": len(q.get("tools") or []),
            "tool_calls": s.get("tool_calls"), "tool_results_sent": [t[:90] for t in q.get("tool_results", [])],
            "content": (s.get("content") or "")[:140], "error": (s.get("error") or r.get("resp_text") or "")[:160],
            "chars": q.get("content_chars"), "latency_ms": r.get("latency_ms"), "first_byte_ms": s.get("first_byte_ms"),
        }, ensure_ascii=False))
    for e in events:
        if e["event"] in ("agent.completed", "agent.error") or e["event"].startswith("memory.") or e["event"] == "context.overflow":
            p = e["payload"]
            if e["event"] == "agent.completed":
                try:
                    msgs = json.loads(p.get("displayMessagesJson") or "[]")
                    p = {"final_text": (msgs[-1].get("text") or msgs[-1].get("content") or "")[:200] if msgs else ""}
                except Exception:
                    p = {"keys": list(p)[:8]}
            print(json.dumps({"prompt": e["prompt"], "event": e["event"], "payload": p}, ensure_ascii=False)[:420])
