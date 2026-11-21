# temp.md / IMPLEMENTATION-PLAN — অডিট (২১ নভেম্বর ২০২৬)

`context-tree-fixes` branch-এর উপর করা অডিট। প্রতিটি বিষয় কোডে মিলিয়ে দেখা হয়েছে
(`plugins/native-agent/rust/native-agent-ffi/src/context_tree/*`, `agent_loop.rs`,
`turn_memory/store.rs`, `lib.rs`)। যাচাই: `cargo test --lib` — 791 passed, 0 failed;
`cargo check --lib` — 0 warning।

## আগেই ছিল (main + context-tree-fixes)

- স্টোর, id, মডেল, বাজেট, সিলেকশন, রেন্ডার, `ctx` tool dispatch, recall, temp summary, strategy, note।
- agent loop-এ `before_request` (checklist + dropped turns), `ctx` tool loop নিজেই উত্তর দেয়।
- context-tree-fixes-এর ৪টি commit: turn ঠিকমতো request থেকে বাদ যাওয়া, note/temp-এর লেখা
  আসলে prompt-এ যাওয়া, panel/settings, per-chat bridge, `ctx` আর "Unknown tool" হয় না।
- Tool group drift test (Rust ↔ `40-permissions.js`), starved mode, settings clamp।

## এই commit-এ ঠিক করা হলো

1. **Rewind/reset hook (plan §15.3)** — `forget_after` / `reset_memory` এখন tree-এর পরের
   turn node-গুলো tombstone করে ও note মুছে দেয়। আগে rewind-এর পর নতুন turn একই নম্বর পেলে
   পুরনো turn-এর `out`/`note` সিদ্ধান্ত আর পুরনো note টেক্সট পেয়ে যেত।
2. **Schema v7 (plan §15.1)** — `MEMORY_SCHEMA_VERSION` 6 → 7; memory টেবিলের সাথে `ctx_*`
   টেবিলও তৈরি হয় (একই transaction, ব্যর্থ হলে rollback)।
3. **`ctx.reset` action (plan §15.4)** — একটি chat-এর সব `ctx_*` row মুছে, settings রেখে।
4. **Token economy (plan §6.4)** — প্রতি step-এ সর্বোচ্চ ৪টি, প্রতি turn-এ ২৪টি `ctx` call;
   একই step-এ হুবহু একই call আবার এলে আগের উত্তর `cached: true` দিয়ে ফেরত, গণনায় ধরা হয় না।
5. **I3: `ctx view`-এর বাজেট** — আগে `locked = 0` ধরে হিসাব হতো, তাই view বেশি জায়গা দেখাত।
   এখন request-এর আসল locked token ব্যবহার হয়।
6. **Audit row (plan §15.5)** — `context.assembly` event-এ `contextTree`: `treeRev`, stage,
   starved, `policyActions`, `droppedTurns`, token হিসাব, `ctxCallsThisTurn`; persisted row-এর
   actions-এ `tree_policy_evicted` / `tree_turns_dropped`।
7. **GC (plan §6.6)** — quota-র কোড ছিল কিন্তু কেউ ডাকত না। এখন প্রতি ৫০ turn-এ একবার: note/temp
   byte quota, পুরনো material tombstone purge (শেষ ৫০০টি রাখা), action log ≤ ২০,০০০ row।
   Live turn/result node এখানে ছাঁটা হয় না, কারণ সেগুলো পরের request-এ আবার `in` হয়ে ফিরে আসত।
8. **SECURITY T2** — note/summary টেক্সট prompt-এ যাওয়ার আগে `[native-agent-…]` marker সরানো হয়,
   যাতে কোনো note checklist বা resume block সেজে আসতে না পারে।
9. **SECURITY T8** — note ও summary সংরক্ষণের আগে secret redaction (bearer, `key=value`,
   `sk-…`, এবং নতুন: `ghp_…`, `github_pat_…`)। পুরনো note-ও prompt-এ যাওয়ার সময় redact হয়।
10. ছোট বাগ: kept-text বাজেট byte দিয়ে গোনা হতো (বাংলা note ~৩ গুণ দ্রুত বাজেট শেষ করত) — এখন character।

## আগে বাকি ছিল, এখন শেষ

- ✅ Sub-agent lifetime (temp / standby, plan Stage 7): `spawn_subagent`-এ `lifetime`, `ttl_secs`, `render_in_chat`; engine নিজে মোছে (`subagents/lifetime.rs`), temp agent-এর report parent-এর tree-তে note হিসেবে থাকে, `subagent.deleted` event।
- ✅ `.context/` mirror ফাইল (`context_tree/mirror.rs`): note আর strategy atomic ভাবে লেখা, app চালু হলে ডেটাবেস থেকে আবার বানানো, reset-এ মোছা।
- ✅ Panel-এ "Reset tree" বোতাম (confirm চায়, তারপর `ctx.reset`), `www/agent.html` আবার build করা।
- ✅ আলাদা ডক: `ARCHITECTURE.md`, `TOOLS.md`, `SECURITY.md`, `MIGRATION-v7.md`।
