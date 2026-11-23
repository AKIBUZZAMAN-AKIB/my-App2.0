# মেমরি চেকলিস্ট ট্রি — পূর্ণ পরিকল্পনা, রিভিউ ও বাকি কাজের বাস্তবায়ন

রিপো: `AKIBUZZAMAN-AKIB/my-App2.0` (main, HEAD `fdedbc9`)
তারিখ: ২২ নভেম্বর ২০২৬
সাথের ফাইল: `memory-checklist-remaining.patch` (main-এর উপর `git apply` / `git am` করা যায়)

---

## ১. পূর্ণ লক্ষ্য (Goal)

১. কনটেক্সট পাঠানো হবে চাহিদা অনুযায়ী, অথবা ইউজার চেকলিস্টে টিক দিয়ে বেছে দেবেন। তাই **সব কিছু** চেকলিস্টে থাকবে — আলাদা আলাদা গ্রুপে, একটি পেশাদার **চেকলিস্ট ট্রি** হিসেবে: ভার্সন, গোল হিস্টরি, ফ্যাক্ট, টপিক, টাইটেল ডিসিশন, ফাইল লিস্ট, পুরনো রেঞ্জ, রিপ্লেসড ডিসিশন, ক্লোজড ডিসিশন, টাস্ক ইত্যাদি।
২. যা বাদ পড়েছে (left out) এবং যা "show more"-এর পেছনে আছে — তাদের আলাদা রঙ।
৩. আলাদা কোনো মেমরি ইনস্পেকশন টুল থাকবে না; সব কিছু চেকলিস্ট দিয়েই হবে। চেকলিস্ট **সবসময় চালু** — কোনো ডিফল্ট on/off সুইচ নয়।
৪. ফাইল নিজের আলাদা গ্রুপ। এমন অনেক গ্রুপ থাকবে, প্রত্যেকটি **ভার্সন-ভিত্তিক**: আগের সব ভার্সন সংরক্ষিত থাকে, পড়া যায়, কনটেক্সটে দেওয়া যায়। ফাইল পুনঃব্যবহার হয়।
৫. আগে কনভারসেশনের বাইরের গ্রুপগুলো (দীর্ঘমেয়াদি মেমরি) বারবার মেমরি টুল দিয়ে recall করা হতো — একই জিনিস বারবার। এখন সব ট্রিতে থাকবে।
৬. কনভারসেশনে যেখানে ডেটা ব্যবহার হয়, সেখানে `#নাম` ট্যাগ দিয়ে রেফার করা হবে (ভার্সনসহ, যেমন `#plan.md@v2`)।
৭. একই ট্যাগ বহুবার থাকতে পারে; কনটেক্সট যাবে শুধু **শেষ** ট্যাগের জায়গায় (একবার)। প্রতিটি ট্যাগ আলাদাভাবে remove বা inactive করা যাবে।
৮. কনটেক্সট পুনঃব্যবহারযোগ্য; একই কনটেক্সট দুইবার যাবে না।

---

## ২. বর্তমান কোডবেসের বিশ্লেষণ (কোন ফাইলে কী আছে)

মূল ইঞ্জিন Rust-এ: `plugins/native-agent/rust/native-agent-ffi/src/`। UI হলো একক `www/agent.html`, যা `tools/agent-html-src/NN-*.js/.css` থেকে `tools/agent-html-src/build.py` দিয়ে জোড়া লাগানো হয়। iOS/Android-এর জন্য প্রি-বিল্ট বাইনারি (xcframework, .so) রিপোতেই কমিট করা থাকে।

| ফাইল | কাজ |
|---|---|
| `src/context_tree/memory_checklist.rs` (~১৫৭০ লাইন) | মেমরি চেকলিস্টের কেন্দ্র: `GROUPS` (গ্রুপের তালিকা), `Record`, `records()`, `current_records()`, `sync_versions()` / `load_versions()`, `scan_mentions()` / `record_mentions()` (#ট্যাগ), `build_picks_with()` (in/out/inline/extra), `prepare_anchored()` (শেষ ট্যাগে কনটেক্সট বসানো), `apply_ops()`, `snapshot()` (UI-এর জন্য), `view()` (`ctx memory`), ফাইল ভার্সন (`ctx_mem_files`)। SQLite টেবিল: `ctx_mem_versions`, `ctx_mem_picks`, `ctx_mem_tags`, `ctx_mem_files`, `ctx_mem_status`। |
| `src/context_tree/dispatch.rs` | `ctx` টুলের প্রতিটি action: view, set, category, summarize, recall, note, strategy, prompt, original, memory। `set`-এ `mem/…` বা `#…` আইডি মেমরি চেকলিস্টে যায়। |
| `src/context_tree/tools.rs` | `ctx` টুলের JSON schema (`ACTIONS`, `MAX_SCHEMA_CHARS`), `legacy_alias`। |
| `src/context_tree/assemble.rs` | মডেলকে দেওয়া চেকলিস্ট নির্দেশনা `instructions()` (টোকেন বাজেট ≤ ৩৪০)। |
| `src/context_tree/wiring.rs` | `enabled()` — চেকলিস্ট সবসময় চালু (`enabled_on` সবসময় true)। স্ন্যাপশট/অ্যাকশন FFI-তে পৌঁছায়। |
| `src/agent_loop.rs` | প্রতি রিকোয়েস্টে টুল তালিকা তৈরি (`merged_tool_definitions`), `ctx` যোগ, `recall_turns` হ্যান্ডলার, `memory_inspect` লিগ্যাসি হ্যান্ডলার, `ctx` ডিসপ্যাচ। |
| `src/agent_loop/memory_loop.rs` | মেমরি ফোল্ড, সিলেকশন, `recall_tool()` (পুরনো টার্ন / স্টোর করা রেজাল্ট পড়া), চেকলিস্ট প্রয়োগ। |
| `src/turn_memory.rs`, `src/turn_memory/*` | টার্ন-মেমরি: `MemorySettings` (`enabled`, keep_recent, batch…), `RECALL_TOOL = "recall_turns"`, select.rs (মেমরি ব্লক), results.rs (`[result #R…]` রেফারেন্স), inspect.rs (`memory_inspect`), repair.rs। |
| `src/tool_runner.rs` | বিল্ট-ইন টুল চালায়; `memory_recall/store/forget/search/list` → প্ল্যাটফর্মের `MemoryProvider` (দীর্ঘমেয়াদি মেমরি, সব চ্যাটের)। |
| `src/lib.rs` | `MemoryProvider` trait (store/recall/forget/search/list), FFI, e2e টেস্ট। |
| `plugins/native-agent/ios/.../MemoryProviderImpl.swift` | দীর্ঘমেয়াদি মেমরির iOS বাস্তবায়ন: `list` → কী-এর JSON array, `search` → `[{key,text,score}]`। |
| `src/workspace.rs` | সিস্টেম প্রম্পটের "## Chat memory" গাইড (`CHAT_MEMORY_PROMPT`)। |
| `tools/agent-html-src/58-context-tree.js/.css` | কম্পোজারের উপরে কনটেক্সট কার্ড: Checklist / Summary / Log / Settings ট্যাব; `memoryTree()`, `memGroup()`, `memRow()`, `MEM_COLOURS`, ট্যাগ চিপ (inactive/remove/restore), চ্যাটে `#ট্যাগ` রঙ (`decorateChatTags`)। |
| `tools/agent-html-src/57-memory.js` | পুরনো "Chat memory" স্ক্রিন/ডায়ালগ (Summary, Settings) — এতে ছিল "Summarize older turns" অন/অফ সুইচ। |
| `tools/agent-html-src/17-agent-goals.js` | সাব-এজেন্টের Memory ট্যাব; "Open full memory" বোতাম আলাদা মেমরি স্ক্রিন খুলত। |
| `tools/agent-html-tests/*.js` | Playwright UI টেস্ট (memory.js, context-tree.js ইত্যাদি)। |

---

## ৩. প্যাচ (1.txt) ও 0.zip-এর রিভিউ

**কী পাওয়া গেল:** 1.txt হলো `memory-checklist.patch` (৩৬০৯ লাইন, ১৮টি ফাইল)। 0.zip-এ একই প্যাচ, `MEMORY-CHECKLIST-PLAN.bn.md`, এবং পরিবর্তিত ফাইলগুলোর পূর্ণ কপি।

**রিপোর সাথে তুলনা:** প্যাচটি main-এ **আগেই প্রয়োগ করা আছে** — কমিট `2bb631b` ("Apply memory-checklist.patch…")। `git apply --check` ব্যর্থ হয় (ফাইল আগে থেকেই আছে), আর উল্টো (`-R`) চেক প্রায় পুরোটা মেলে; শুধু `www/agent.html` ও `tools/agent-html-tests/context-tree.js` মেলে না, কারণ পরের কমিট `2e0076a` ("context at the last #tag, readable file versions, chat tags") এগুলো আরও বদলেছে। তাই 1.txt আবার প্রয়োগ করা উচিত নয়; আমার নতুন প্যাচ বর্তমান main-এর উপর বানানো।

### ৩.১ যা ঠিকভাবে করা হয়েছে (Done)
- গ্রুপ ট্রি: Goals, Goal history, Topics & titles, Decisions in force, Replaced decisions, Closed decisions, Facts & preferences, Files, Tasks, Turn ranges, Old ranges, Memory versions (`GROUPS`)।
- প্রতিটি রেকর্ডের ভার্সন (`ctx_mem_versions`), কখনো ওভাররাইট হয় না; `all_versions` / `latest`।
- রঙ: sent / pinned / left out / show more / not shown (`colour()`, `MEM_COLOURS`, CSS `cc-mc-*`), "Show N more" বোতাম আলাদা রঙে।
- চেকলিস্ট সবসময় চালু (`wiring::enabled_on` সবসময় true; Settings-এ সুইচ নেই)।
- `memory_inspect` আর অফার করা হয় না; পুরনো কল `ctx memory` থেকে উত্তর পায়।
- #ট্যাগ স্ক্যান, পুরো-শব্দ মিল (`#d1` ≠ `#d12`), শেষ উল্লেখেই কনটেক্সট (`prepare_anchored`, `Anchor`), ট্যাগ inactive / active / remove, ট্যাগ চিপ, চ্যাটে ট্যাগ রঙ।
- ফাইল নিজস্ব গ্রুপ, `#file@vN` দিয়ে পুরনো ভার্সন পড়া, একই কনটেন্ট আবার পড়লে নতুন ভার্সন হয় না।
- ডুপ্লিকেট টুল রেজাল্ট বাদ।

### ৩.২ আংশিক / ভুল (Partial / Wrong)
1. **মেমরি এখনো বন্ধ করা যেত:** `57-memory.js`-এ "Summarize older turns" সুইচ ছিল, `MemorySettings.enabled=false` হলে `memory_loop` পুরো মেমরি ফোল্ড বন্ধ করে দেয় — ফলে চেকলিস্টের মেমরি গ্রুপগুলো খালি থাকে। অর্থাৎ "সবসময় চালু" কথাটা শুধু ট্রির জন্য সত্য ছিল, মেমরির জন্য নয়।
2. **`recall_turns` এখনো আলাদা মেমরি টুল:** প্রতি রিকোয়েস্টে `ctx`-এর পাশাপাশি `recall_turns` অফার হতো, এবং e2e টেস্টও এটাই দাবি করত। মডেল-মুখী সব টেক্সট (`results.rs`-এর `[result #R…]`, `read_budget.rs`, `select.rs`, `inspect.rs`, `workspace.rs`-এর গাইড) `recall_turns` ডাকতে বলত।
3. **`ctx` schema-তে `long_term` প্রপার্টি ছিল, কিন্তু `dispatch.rs`-এ কোথাও ব্যবহার হতো না** (মৃত ফিল্ড)।
4. **সাব-এজেন্টের "Open full memory"** আলাদা মেমরি স্ক্রিন খুলত — আলাদা ইনস্পেকশন UI।
5. আগের প্ল্যানে "checklist always active" এমনভাবে লেখা ছিল যেন এটি ডিফল্ট সেটিং — আসলে এটা কোনো অপশনই নয়; এখন কোড ও ডকে স্পষ্ট।

### ৩.৩ একেবারে বাকি ছিল (Missing)
1. **কনভারসেশনের বাইরের গ্রুপ (দীর্ঘমেয়াদি মেমরি) ট্রিতে ছিল না।** `memory_recall / memory_search / memory_list / memory_store / memory_forget` টুল দিয়ে মডেল বারবার একই জিনিস খুঁজত — ঠিক যেটা ইউজার বন্ধ করতে চেয়েছেন।
2. **পুরো গ্রুপ একসাথে টিক দেওয়া** (সব in / সব out / auto) — চেকলিস্ট সিলেকশনের মৌলিক কাজ — ছিল না।
3. দীর্ঘমেয়াদি মেমরির লেখা/মোছা `ctx` দিয়ে করার পথ ছিল না।

---

## ৪. ডেটা মডেল

**গ্রুপ (`GROUPS`)** — ট্রির মূল `mem` ("Chat memory"), তার নিচে:
`mem.goals`, `mem.goal_history`, `mem.topics`, `mem.decisions`, `mem.decisions_replaced`, `mem.decisions_closed`, `mem.facts`, `mem.files`, `mem.tasks`, `mem.ranges`, `mem.ranges_old`, `mem.versions`, এবং নতুন **`mem.longterm`** ("Long-term memory (every chat)")।

**রেকর্ড (`Record`)**: `rid` (যেমন `D12`, `file:src/a.rs`, নতুন `lt:<key>`), `group`, `title`, `line` (যা কনটেক্সটে যায়), `tag`, `aliases`, `status`, `turn`, `native` (true = টার্ন-মেমরি সিলেক্টর চেনে; false = চেকলিস্ট নিজে `extra` লাইন হিসেবে পাঠায়)।

**ভার্সন**: `ctx_mem_versions(session_key, rid, version, line, …)` — লাইন বদলালে নতুন ভার্সন; পুরনোটা থাকে। `#D12@v1`, `#plan.md@v2` দিয়ে নির্দিষ্ট ভার্সন।

**পিক (`ctx_mem_picks`)**: `in` / `out` / `auto`, `pin`, `versions = latest | all`।

**ট্যাগ (`ctx_mem_tags`, PK = session_key + tag)**: `state = active | inactive | removed`, `mentions`, `first_turn`, `last_turn`, `version`।
- একই ট্যাগ বহুবার থাকলে কনটেক্সট যায় শুধু শেষ উল্লেখের জায়গায়, একবার (`prepare_anchored` → `Anchor`)।
- `inactive`: ট্যাগ থাকে, কিন্তু কিছু টানে না। `removed`: মুছে যায়; নতুন উল্লেখ এলে আবার active।
- পিক `out` সবকিছুর উপরে; তারপর inline (শেষ ট্যাগ), তারপর in, তারপর relevance।

**নতুন — দীর্ঘমেয়াদি মেমরি মিরর (`ctx_mem_longterm`)**: `key` (PK), `text`, `updated_at`, `removed`। এটা **session-নিরপেক্ষ** (সব চ্যাটের), তাই চ্যাট রিসেট একে ছোঁয় না। প্রতিটি এন্ট্রি রেকর্ড `lt:<key>`, ট্যাগ `#lt:<key-slug>` (ছোট হাতের, অনুমোদিত অক্ষর)। লেখা বদলালে অন্য রেকর্ডের মতোই ভার্সন হয়।

---

## ৫. UI ও রঙের নিয়ম

- সবুজ ধাঁচ = **sent** (কনটেক্সটে গেছে), **pinned** আলাদা; **left out** (বাদ পড়েছে) আলাদা রঙ; **show more** (জমা আছে, পাঠানো হয়নি, "Show N more"-এর পেছনে) নিজস্ব রঙ; **not shown** নিরপেক্ষ। লেজেন্ড ট্রির মাথায় (`cc-mem-legend`)।
- গ্রুপ হেডারে `sent/total` এবং "N left out" কাউন্ট।
- **নতুন:** প্রতিটি গ্রুপ হেডারে "All in" / "All out" / "Auto" বোতাম (`groupOps()`), সাব-গ্রুপসহ পুরো গ্রুপে প্রযোজ্য।
- **নতুন:** দীর্ঘমেয়াদি মেমরি গ্রুপের নাম ইটালিকে, যাতে বোঝা যায় এটি সব চ্যাটের।
- ট্যাগ চিপ: inactive / remove / restore; চ্যাটে `#ট্যাগ` তার অবস্থার রঙে, শেষ active উল্লেখ চিহ্নিত।
- Settings-এ আর কোনো মেমরি অন/অফ সুইচ নেই; তার জায়গায় নোট: "Memory and its checklist are always on…"।

---

## ৬. সম্পূর্ণ টাস্ক তালিকা (গ্রুপ অনুযায়ী) — ফাইল, কী বদলাতে হবে, কেন

চিহ্ন: ✅ = এই প্যাচে বাস্তবায়িত, ⏳ = এখনো বাকি।

### ক. সবসময় চালু (কোনো on/off নয়)
- ✅ **A1** `src/turn_memory.rs` → `MemorySettings::clamped()`: `self.enabled = true`। কেন: পুরনো সেটিংস ফাইলে `enabled:false` থাকলেও মেমরি ও চেকলিস্ট বন্ধ হবে না।
- ✅ **A2** `tools/agent-html-src/57-memory.js` → `DEFAULTS` থেকে `enabled` বাদ, `paintSettings()` থেকে "Summarize older turns" সুইচ ও তার listener বাদ, `phase()`-এ `'off'` অবস্থা বাদ, Save আর `enabled` পাঠায় না। কেন: UI-তে বন্ধ করার কোনো পথ না রাখা।
- ✅ **A3** `tools/agent-html-tests/memory.js` → পুরনো "switch off" টেস্টের জায়গায় "কোনো সুইচ নেই, always-on নোট আছে, `enabled` কখনো পাঠানো হয় না"।
- ✅ **A4** `src/lib.rs` e2e টেস্ট `the_stored_transcript_is_the_same_with_memory_on_and_off` → এখন `enabled:false` থাকলেও মেমরি চলে, ট্রান্সক্রিপ্ট একই থাকে।

### খ. আলাদা মেমরি টুল সরানো (সব চেকলিস্ট দিয়ে)
- ✅ **B1** `src/context_tree/tools.rs` → `REPLACED_MEMORY_TOOLS` = recall_turns, memory_inspect, memory_recall, memory_search, memory_list, memory_store, memory_forget; `ACTIONS`-এ `remember`, `forget`; schema-তে `from_turn`, `to_turn`, `result_id`, `key`।
- ✅ **B2** `src/agent_loop.rs` → চেকলিস্ট চালু থাকলে `tools.retain(...)` দিয়ে ওই সাতটি টুল আর অফার হয় না। পুরনো ট্রান্সক্রিপ্ট থেকে কল এলে লিগ্যাসি হ্যান্ডলার এখনো উত্তর দেয় (কিছু ভাঙে না)।
- ✅ **B3** `src/agent_loop.rs` → `ctx` ইন্টারসেপ্ট: `action=recall` + (`from_turn`/`to_turn`/`result_id`/`question`, কিন্তু `id` নেই) হলে `memory_loop::recall_tool()` চলে — যেটা আগে `recall_turns` করত। `id` থাকলে আগের মতো ট্রি-আইটেম recall।
- ✅ **B4** মডেল-মুখী টেক্সট `recall_turns` → `ctx recall`: `read_budget.rs`, `turn_memory/select.rs`, `results.rs`, `inspect.rs`, `repair.rs`, `workspace.rs` (`CHAT_MEMORY_PROMPT`)। কেন: মডেলকে যেন আর লুকানো টুল ডাকতে না বলা হয়।
- ✅ **B5** `src/context_tree/assemble.rs` → `instructions()`-এ recall-এর নতুন রূপ, `remember`, `forget`, এবং long-term `#lt:key` — ৩৪০ টোকেন বাজেটের ভেতরে।
- ✅ **B6** `17-agent-goals.js` → "Open full memory"-এর জায়গায় "Open in checklist", যা `ContextTree.open(null, 'items', key)` খোলে (ContextTree না থাকলে পুরনো স্ক্রিন fallback)।

### গ. কনভারসেশনের বাইরের গ্রুপ — দীর্ঘমেয়াদি মেমরি ট্রিতে
- ✅ **C1** `memory_checklist.rs` → `GROUPS`-এ `mem.longterm`; `ensure_tables()`-এ `ctx_mem_longterm` টেবিল।
- ✅ **C2** `memory_checklist.rs` → `long_term_tag()`, `long_term_put()`, `long_term_remove()`, `long_term_entries()`, `parse_long_term_keys()`, `parse_long_term_text()`, `sync_long_term()`, `long_term_records()`।
- ✅ **C3** `prepare_anchored()` ও `current_records()` → দীর্ঘমেয়াদি রেকর্ড যোগ; ফলে ভার্সন, পিক, #ট্যাগ (শেষ উল্লেখ), রঙ, স্ন্যাপশট, `ctx memory` — সব স্বয়ংক্রিয়ভাবে কাজ করে। এরা `native:false`, তাই `in` বা শেষ ট্যাগে একবার `extra` লাইন হিসেবে যায়।
- ✅ **C4** `src/agent_loop.rs` → প্রতি রিকোয়েস্টে প্রোভাইডারের `list` (≤২০০) দিয়ে মিরর সিঙ্ক; নতুন কী-এর টেক্সট `search(key)` দিয়ে একবারই আনা হয়; list ব্যর্থ হলে কিছু মোছা হয় না।
- ✅ **C5** `memory_checklist.rs` → `long_term_action()` / `long_term_apply()`: `ctx remember` (key, text) প্রোভাইডারে `store` + মিরর; `ctx forget` (key বা `#lt:` ট্যাগ) প্রোভাইডারে `forget` + মিররে `removed=1` (পুরনো ভার্সন পড়া যায়)। প্রোভাইডার না থাকলে শুধু মিররে।
- ✅ **C6** `dispatch.rs` → `remember` / `forget` action (প্রোভাইডার ছাড়া পথ), এরর মেসেজে নতুন action-এর নাম।
- ✅ **C7** `tool_runner.rs` → `mirror_long_term()`: পুরনো `memory_store` / `memory_forget` কলও মিরর আপডেট করে, যাতে ট্রি সবসময় মিলে থাকে।

### ঘ. চেকলিস্ট সিলেকশন
- ✅ **D1** `memory_checklist.rs::apply_ops()` → `group:<id>` / `memgrp/<id>` (`mem/` প্রিফিক্সসহও) আইডি হলে op পুরো গ্রুপ ও তার সাব-গ্রুপের প্রতিটি রেকর্ডে প্রয়োগ।
- ✅ **D2** `58-context-tree.js` → `groupOps()` বোতাম (All in / All out / Auto), `setMemory('group:'+id, op)` দিয়ে; `58-context-tree.css`-এ স্টাইল।

### ঙ. এখনো বাকি (⏳) — পরের ধাপ
- ⏳ **E1 ফাইল সব চ্যাটে পুনঃব্যবহার:** `ctx_mem_files` এখনো `session_key` অনুযায়ী। পরিকল্পনা: `ctx_mem_longterm`-এর মতো একটি গ্লোবাল `ctx_files_global(path, content_hash, version, …)` টেবিল, চ্যাট-ভিত্তিক টেবিলে শুধু রেফারেন্স; `#file@vN` সব চ্যাটে একই অর্থ। ফাইল: `memory_checklist.rs` (`load_files`, ফাইল ভার্সন অংশ)।
- ⏳ **E2 ভার্সন-ভিত্তিক আলাদা ট্যাগ অবস্থা:** এখন `ctx_mem_tags`-এর PK (session_key, tag), তাই `#plan.md@v1` ও `#plan.md@v2` একই সারি — শেষটাই জেতে (ইউজারের "শেষ ট্যাগ" নিয়মের সাথে মেলে)। প্রতিটি ভার্সনকে আলাদাভাবে inactive করতে চাইলে PK-তে `version` যোগ করে মাইগ্রেশন লাগবে।
- ⏳ **E3 দীর্ঘমেয়াদি এন্ট্রির ভার্সন সব চ্যাটে এক:** এখন ভার্সন `ctx_mem_versions`-এ চ্যাট অনুযায়ী জমা হয়। গ্লোবাল করতে `session_key='*'` ব্যবহার করে `sync_versions` বাড়াতে হবে।
- ⏳ **E4 পুরনো "Chat memory" ডায়ালগ** (`57-memory.js::open`) এখনো Summary/Settings ট্যাবের ভেতরের অংশ হিসেবে এবং কনটেক্সট কার্ড না থাকলে fallback হিসেবে আছে। পুরোপুরি সরাতে Summary ও Settings সরাসরি `58-context-tree.js`-এ সরাতে হবে।
- ⏳ **E5 Android প্রোভাইডার:** রিপোতে শুধু iOS-এর `MemoryProviderImpl.swift` পাওয়া গেছে। Android-এ প্রোভাইডার না থাকলে দীর্ঘমেয়াদি গ্রুপ শুধু `ctx remember` দিয়ে লেখা মিরর দেখাবে।
- ⏳ **E6 নেটিভ বাইনারি রিবিল্ড:** Rust বদলেছে, তাই iOS xcframework ও Android `.so` আবার বানাতে হবে (রিপোর আগের কমিট `ffc0e79`, `fdedbc9`-এর মতো)। এই পরিবেশে মোবাইল টুলচেইন নেই, তাই বাইনারি প্যাচে নেই।
- ⏳ **E7 গ্রুপ বোতামের UI টেস্ট:** মক ইঞ্জিন `group:` op চেনে না, তাই Playwright-এ শুধু রিগ্রেশন চালানো হয়েছে; Rust ইউনিট টেস্ট যুক্ত আছে।

---

## ৭. মাইগ্রেশন (মেমরি টুল সরানো)

1. নতুন বিল্ডে মডেলকে শুধু `ctx` দেওয়া হয়; সাতটি পুরনো মেমরি টুল অফার হয় না।
2. পুরনো চ্যাটের ট্রান্সক্রিপ্টে থাকা `recall_turns` / `memory_*` / `memory_inspect` কল এখনো উত্তর পায় — হ্যান্ডলারগুলো রাখা আছে, তাই কিছু ভাঙে না।
3. পুরনো সেটিংসের `enabled:false` চুপচাপ উপেক্ষিত (true হিসেবে পড়া)।
4. `ctx_mem_longterm` টেবিল `CREATE TABLE IF NOT EXISTS` দিয়ে প্রথম ব্যবহারে তৈরি হয়; প্রথম রিকোয়েস্টে প্রোভাইডার থেকে ভরে যায়।
5. পরের রিলিজে (সব ক্লায়েন্ট আপডেট হলে) লিগ্যাসি হ্যান্ডলার ও `inspect.rs` সরানো যাবে।

---

## ৮. টেস্টিং — কী চালানো হয়েছে ও ফল

- `cargo test --lib` (native-agent-ffi): আগে ৮৩৬ পাস; এখন **৮৪০ পাস, ০ ফেল, ১ ignored**।
- নতুন Rust টেস্ট (`memory_checklist_tests.rs`):
  - `the_long_term_memory_is_a_versioned_group_of_the_tree` — সিঙ্ক, গ্রুপ, ট্যাগ `#lt:diet-pref`, শেষ উল্লেখে একবার, ভার্সন, প্রোভাইডার থেকে বাদ পড়লে গ্রুপ থেকে বাদ।
  - `ctx_remember_and_forget_write_the_long_term_group_without_a_memory_tool`
  - `the_memory_is_always_on_even_when_an_old_settings_file_says_off`
  - `a_whole_group_is_checked_in_or_out_with_one_op`
- বদলানো টেস্ট: `assemble.rs` (নতুন action, ≤৩৪০ টোকেন), `lib.rs` e2e (শুধু `ctx` অফার, `recall_turns`/`memory_inspect` নয়; memory on/off ইনভারিয়েন্ট)।
- UI (Playwright, হেডলেস Chromium): `tools/agent-html-tests/memory.js` **৩২০/৩২০ পাস**, `context-tree.js` **৮০/৮০ পাস**।
- `www/agent.html` `build.py` দিয়ে আবার বানানো হয়েছে।

---

## ৯. কাজের ক্রম (প্রয়োগ ও পরের ধাপ)

1. `git checkout main && git pull` → `git am memory-checklist-remaining.patch` (অথবা `git apply`)।
2. `cd plugins/native-agent/rust/native-agent-ffi && cargo test --lib`।
3. `python3 tools/agent-html-src/build.py` (প্যাচে `www/agent.html` আগেই আছে; সোর্স বদলালে আবার চালান)।
4. iOS xcframework ও Android `.so` রিবিল্ড (E6)।
5. ডিভাইসে যাচাই: কনটেক্সট কার্ড → Checklist → "Long-term memory (every chat)" গ্রুপ, All in/out/Auto, `#lt:…` ট্যাগ।
6. এরপর E1 → E3 → E2 → E4 → E5 ক্রমে।

---

## ১০. এই প্যাচে বদলানো ফাইল

Rust: `agent_loop.rs`, `context_tree/assemble.rs`, `context_tree/dispatch.rs`, `context_tree/memory_checklist.rs`, `context_tree/memory_checklist_tests.rs`, `context_tree/tools.rs`, `lib.rs`, `read_budget.rs`, `tool_runner.rs`, `turn_memory.rs`, `turn_memory/inspect.rs`, `turn_memory/repair.rs`, `turn_memory/results.rs`, `turn_memory/select.rs`, `workspace.rs`।
UI: `tools/agent-html-src/17-agent-goals.js`, `57-memory.js`, `58-context-tree.js`, `58-context-tree.css`, `www/agent.html`, টেস্ট `tools/agent-html-tests/memory.js`।
ডক: এই ফাইল (`docs/context-tree/MEMORY-CHECKLIST-FULL-PLAN.bn.md`)।
