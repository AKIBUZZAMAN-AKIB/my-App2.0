# Task Context Policy Engine (TCPE)

TCPE একটা task চলার সময় provider-এ কতটুকু context যাবে তা ঠিক করে। Tool schema আর system rules সবসময় পুরো যায়; শুধু chat-এর পুরনো অংশ ছোট হয়। Default policy সবসময় **T7 full_context** — অর্থাৎ policy বন্ধ থাকলে আগের মতোই সব যায়।

## কীভাবে চলে

1. Turn-এর প্রথম request সবসময় T7 (পুরো context)।
2. Model প্রথম tool call করলে task শুরু হয়। একই reply-তে model `ctx` tool দিয়ে `{"action":"task","id":"T1"}` পাঠাতে পারে (Auto mode) — আলাদা request লাগে না।
3. পরের follow-up request-এ temp checklist অনুযায়ী view ছোট হয়; task block (`[native-agent-task-context-v1]`) system prompt-এর **শেষে** যোগ হয়, তাই prompt cache prefix অক্ষত থাকে।
4. Task শেষ হলে (final answer) পরের turn আবার T7 থেকে শুরু।

## Safeguard (সব ক্ষেত্রে T7-এ ফেরে, `fallback` event লেখে)

- policy step-এ panic
- tool schema বদলে গেলে
- view T7-এর চেয়ে বড় হলে
- system prompt prefix না মিললে
- task চলার মাঝে নতুন steer message এলে (শুধু সেই request T7)

Turn শেষে status: `max_turns_reached` হলে `failed`, safeguard লাগলে `fallback`, সময় শেষ হলে `timed_out`।

## Policy

| ID | নাম | কী রাখে |
|---|---|---|
| T1 | current_task_only | request + চলমান task-এর result |
| T2 | relevant ranges | T1 + প্রাসঙ্গিক range |
| T3 | relevant memory | T1 + প্রাসঙ্গিক memory |
| T4 | compact results | সব, পুরনো search result ছোট |
| T5 | recent_turns | T1 + শেষ N turn (default 2) |
| T6 | selected | বেছে নেওয়া item |
| T7 | full_context | সব (default, locked) |

## Sub-agent

Task চলার সময় নতুন sub-agent-এর task text-এর শেষে parent-এর brief যায় (request, goal, constraints, answer requirements, রাখা item, শেষ ৩টা result) — মোট `TASK_CAP`-এর মধ্যে।

## UI

Context card-এ **Policy** tab (mode, চলমান task, token) আর **Context Policies** workspace: mode, per-chat pin, preset, automatic rule (builder + JSON editor, engine validate না করলে save হয় না), exclusions (system/essentials locked), task timeline, token/latency/fallback। শুধু engine `contextPolicy` feature দিলে দেখায়।

## Metrics

`policy.metrics` action (`{"limit": 200}`) per policy ও per source দেয়: tasks, completed/failed/fallback/timedOut, successRate, requests, inputTokens, t7Tokens, savedPct, avgLatencyMs, avgFirstTokenMs, fallbacks, retries, escalations। কোনো event না থাকলে মান `null` — অনুমান করা হয় না।

## Benchmark (mock provider, deterministic)

`cargo test --lib policy_benchmark -- --nocapture` — ৮টা পুরনো turn-সহ একই task, প্রতিটা policy pin করে:

| Policy | Requests | Follow-up bytes | T7-এর তুলনায় | savedPct | Status |
|---|---|---|---|---|---|
| T1 | 2 | 1,391 | 15% | 81.6 | completed |
| T2 | 2 | 1,391 | 15% | 81.6 | completed |
| T3 | 2 | 1,391 | 15% | 81.6 | completed |
| T4 | 2 | 9,415 | 100% | 0 | completed |
| T5 | 2 | 3,397 | 36% | 61.2 | completed |
| T6 | 2 | 1,391 | 15% | 81.6 | completed |
| T7 | 2 | 9,415 | 100% | 0 | completed |

প্রতিটা policy-তে যাচাই: request সংখ্যা T7-এর সমান, tool schema ও rules অপরিবর্তিত, user request ও task result সবসময় যায়, view কখনো T7-এর চেয়ে বড় নয়। (T2/T3 এখানে T1-এর সমান কারণ এই scenario-তে কোনো range/memory নেই; T4 এখানে T7-এর সমান কারণ ছোট করার মতো পুরনো search result নেই।)


## Test

- `cargo test --lib context_policy` — unit
- `cargo test --lib task_policy` — off/auto end-to-end
- `cargo test --lib policy_benchmark` — benchmark
- `node tools/agent-html-tests/context-policy.js` — UI (২৬টা check)
