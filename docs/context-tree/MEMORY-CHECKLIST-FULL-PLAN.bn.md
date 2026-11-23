# মেমরি চেকলিস্ট ট্রি — পূর্ণ পরিকল্পনা, রিভিউ ও বাকি কাজের বাস্তবায়ন

রিপো: `AKIBUZZAMAN-AKIB/my-App2.0` (ভিত্তি: main, HEAD `fdedbc9`)
তারিখ: ২২ নভেম্বর ২০২৬ (যাচাই ও হালনাগাদ: ২৩ নভেম্বর ২০২৬)
সাথের ফাইল: `0.patch` (আগে `memory-checklist-remaining.patch` নামে লেখা ছিল) — এখন আর আলাদা প্যাচ লাগবে না: প্যাচ, এই প্ল্যান ও বাকি কাজ সরাসরি main-এ কমিট করা হয়েছে (দেখুন §১১)।

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

মূল ইঞ্জিন Rust-এ: `plugins/native-agent/rust/native-agent-ffi/src/`। UI হলো একক `www/agent.html`, যা `tools/agent-html-src/NN-*.js/.css` থেকে `tools/agent-html-src/build.py` দিয়ে জোড়া লাগানো হয়। iOS/Android-এর জন্য প্রি-বিল্ট বাইনারি (xcframework, .so) রিপোতেই কমিট করা থাকে; main-এ `plugins/native-agent/rust/**` বদলে push হলে GitHub Actions (`ios-agent-xcframework.yml`, `native-agent-ffi.yml`) নিজেরাই এগুলো আবার বানিয়ে কমিট করে (যেমন কমিট `ffc0e79`, `fdedbc9`)।

| ফাইল | কাজ |
|---|---|
| `src/context_tree/memory_checklist.rs` (main `fdedbc9`-এ ১৩০৯ লাইন; 0.patch-এর পর ১৫৭০; E3-এর পর ১৬০৩; E1-এর পর ১৮১১) | মেমরি চেকলিস্টের কেন্দ্র: `GROUPS` (গ্রুপের তালিকা), `Record`, `records()`, `current_records()`, `sync_versions()` / `load_versions()`, `scan_mentions()` / `record_mentions()` (#ট্যাগ), `build_picks_with()` (in/out/inline/extra), `prepare_anchored()` (শেষ ট্যাগে কনটেক্সট বসানো), `apply_ops()`, `snapshot()` (UI-এর জন্য), `view()` (`ctx memory`), ফাইল ভার্সন (`ctx_mem_files`)। SQLite টেবিল: `ctx_mem_versions`, `ctx_mem_picks`, `ctx_mem_tags`, `ctx_mem_files`, `ctx_mem_status` (0.patch যোগ করে `ctx_mem_longterm`; E1 যোগ করে সব চ্যাটের `ctx_mem_file_store`)। সব টেবিল একই `agent.db`-তে, `session_key` কলাম দিয়ে চ্যাট আলাদা। |
| `src/context_tree/dispatch.rs` | `ctx` টুলের প্রতিটি action: view, set, category, summarize, recall, note, strategy, prompt, original, memory। `set`-এ `mem/…` বা `#…` আইডি মেমরি চেকলিস্টে যায়। |
| `src/context_tree/tools.rs` | `ctx` টুলের JSON schema (`ACTIONS`, `MAX_SCHEMA_CHARS`), `legacy_alias`। |
| `src/context_tree/assemble.rs` | মডেলকে দেওয়া চেকলিস্ট নির্দেশনা `instructions()` (টোকেন বাজেট ≤ ৩৪০)। |
| `src/context_tree/wiring.rs` | `enabled()` — চেকলিস্ট সবসময় চালু (`enabled_on` সবসময় true)। স্ন্যাপশট/অ্যাকশন FFI-তে পৌঁছায়। |
| `src/agent_loop.rs` | প্রতি রিকোয়েস্টে টুল তালিকা তৈরি (`merged_tool_definitions`), `ctx` যোগ, `recall_turns` হ্যান্ডলার, `memory_inspect` লিগ্যাসি হ্যান্ডলার, `ctx` ডিসপ্যাচ। |
| `src/agent_loop/memory_loop.rs` | মেমরি ফোল্ড, সিলেকশন, `recall_tool()` (পুরনো টার্ন / স্টোর করা রেজাল্ট পড়া), চেকলিস্ট প্রয়োগ। |
| `src/turn_memory.rs`, `src/turn_memory/*` | টার্ন-মেমরি: `MemorySettings` (`enabled`, keep_recent, batch…), `RECALL_TOOL = "recall_turns"`, select.rs (মেমরি ব্লক), results.rs (`[result #R…]` রেফারেন্স), inspect.rs (`memory_inspect`), repair.rs। |
| `src/tool_runner.rs` | বিল্ট-ইন টুল চালায়; `memory_recall/store/forget/search/list` → প্ল্যাটফর্মের `MemoryProvider` (দীর্ঘমেয়াদি মেমরি, সব চ্যাটের)। |
| `src/lib.rs` | `MemoryProvider` trait (store/recall/forget/search/list), FFI, e2e টেস্ট। |
| `plugins/native-agent/ios/.../MemoryProviderImpl.swift` | দীর্ঘমেয়াদি মেমরির iOS বাস্তবায়ন: `list` → কী-এর JSON array, `search` → `[{key,text,score}]`। সর্বোচ্চ ২০০০ এন্ট্রি রাখে, `list` সর্বোচ্চ ২০০টি দেয়। |
| `plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/MemoryProviderImpl.kt` | Android বাস্তবায়ন — একই চুক্তি (`list` → কী-এর array, `search` → `[{key,text,score}]`), `NativeAgentPlugin.kt`-এ যুক্ত। সর্বোচ্চ ২০০০ এন্ট্রি, `list` সর্বোচ্চ ২০০। |
| `src/workspace.rs` | সিস্টেম প্রম্পটের "## Chat memory" গাইড (`CHAT_MEMORY_PROMPT`)। |
| `tools/agent-html-src/58-context-tree.js/.css` | কম্পোজারের উপরে কনটেক্সট কার্ড: Checklist / Summary / Log / Settings ট্যাব; `memoryTree()`, `memGroup()`, `memRow()`, `MEM_COLOURS`, ট্যাগ চিপ (inactive/remove/restore), চ্যাটে `#ট্যাগ` রঙ (`decorateChatTags`)। |
| `tools/agent-html-src/57-memory.js` | পুরনো "Chat memory" স্ক্রিন/ডায়ালগ (Summary, Settings) — এতে ছিল "Summarize older turns" অন/অফ সুইচ। |
| `tools/agent-html-src/17-agent-goals.js` | সাব-এজেন্টের Memory ট্যাব; "Open full memory" বোতাম আলাদা মেমরি স্ক্রিন খুলত। |
| `tools/agent-html-tests/*.js` | Playwright UI টেস্ট (memory.js, context-tree.js ইত্যাদি)। |

---

## ৩. আগের প্যাচ (1.txt) ও 0.zip-এর রিভিউ

**কী পাওয়া গেল:** 1.txt হলো `memory-checklist.patch` (৩৬০৯ লাইন, ১৮টি ফাইল)। 0.zip-এ একই প্যাচ, `MEMORY-CHECKLIST-PLAN.bn.md`, এবং পরিবর্তিত ফাইলগুলোর পূর্ণ কপি।

**রিপোর সাথে তুলনা:** প্যাচটি main-এ **আগেই প্রয়োগ করা আছে** — কমিট `2bb631b` ("feat(memory): memory checklist as the always-on context tree")। `git apply --check` ব্যর্থ হয় (ফাইল আগে থেকেই আছে), আর উল্টো (`-R`) চেক প্রায় পুরোটা মেলে; শুধু `www/agent.html` ও `tools/agent-html-tests/context-tree.js` মেলে না, কারণ পরের কমিট `2e0076a` ("context at the last #tag, readable file versions, chat tags") এগুলো আরও বদলেছে। তাই 1.txt আবার প্রয়োগ করা উচিত নয়; আমার নতুন প্যাচ বর্তমান main-এর উপর বানানো।

### ৩.১ যা ঠিকভাবে করা হয়েছে (Done)
- গ্রুপ ট্রি (`GROUPS`-এর আসল শিরোনাম): Goals → Closed goals, Goal history; Topics & titles; Decisions in force → Replaced / closed decisions (রিপ্লেসড ও ক্লোজড ডিসিশন একটাই সাব-গ্রুপ); Facts; Preferences; Replaced / retired facts, preferences & files; Files; Open tasks → Closed tasks; Ranges (turn summaries) → Old ranges; Memory versions।
- প্রতিটি রেকর্ডের ভার্সন (`ctx_mem_versions`), কখনো ওভাররাইট হয় না; `all_versions` / `latest`।
- রঙ: sent / pinned ("Earlier version sent") / left out / show more / inactive ("Tag inactive") — `colour()`, `MEM_COLOURS`, CSS `cc-mc-*`; "Show N more" বোতাম আলাদা রঙে। ("not shown" নামে কোনো রঙ নেই: কারণ `not_shown` হলে রঙ `show_more`।)
- চেকলিস্ট সবসময় চালু (`wiring::enabled_on` সবসময় true; Settings-এ সুইচ নেই)।
- `memory_inspect` আর অফার করা হয় না; পুরনো কল `ctx memory` থেকে উত্তর পায়।
- #ট্যাগ স্ক্যান, পুরো-শব্দ মিল (`#d1` ≠ `#d12`), শেষ উল্লেখেই কনটেক্সট (`prepare_anchored`, `Anchor`), ট্যাগ inactive / active / remove, ট্যাগ চিপ, চ্যাটে ট্যাগ রঙ।
- ফাইল নিজস্ব গ্রুপ, `#file@vN` দিয়ে পুরনো ভার্সন পড়া, একই কনটেন্ট আবার পড়লে নতুন ভার্সন হয় না।
- ডুপ্লিকেট টুল রেজাল্ট বাদ।

### ৩.২ আংশিক / ভুল (Partial / Wrong)
1. **মেমরি এখনো বন্ধ করা যেত:** `57-memory.js`-এ "Summarize older turns" সুইচ ছিল, `MemorySettings.enabled=false` হলে `memory_loop` পুরো মেমরি ফোল্ড বন্ধ করে দেয় — ফলে চেকলিস্টের মেমরি গ্রুপগুলো খালি থাকে। অর্থাৎ "সবসময় চালু" কথাটা শুধু ট্রির জন্য সত্য ছিল, মেমরির জন্য নয়।
2. **`recall_turns` এখনো আলাদা মেমরি টুল:** প্রতি রিকোয়েস্টে `ctx`-এর পাশাপাশি `recall_turns` অফার হতো, এবং e2e টেস্টও এটাই দাবি করত। মডেল-মুখী সব টেক্সট (`results.rs`-এর `[result #R…]`, `read_budget.rs`, `select.rs`, `inspect.rs`, `workspace.rs`-এর গাইড) `recall_turns` ডাকতে বলত।
3. **`ctx` schema-তে `long_term` প্রপার্টি ছিল, কিন্তু `dispatch.rs`-এ কোথাও ব্যবহার হতো না** (মৃত ফিল্ড)। দ্রষ্টব্য: 0.patch এটা সরায়নি — ২৩ নভেম্বরের হালনাগাদে সরানো হয়েছে (F3), কারণ এখন `ctx remember` সেই কাজ করে।
4. **সাব-এজেন্টের "Open full memory"** আলাদা মেমরি স্ক্রিন খুলত — আলাদা ইনস্পেকশন UI।
5. আগের প্ল্যানে "checklist always active" এমনভাবে লেখা ছিল যেন এটি ডিফল্ট সেটিং — আসলে এটা কোনো অপশনই নয়; এখন কোড ও ডকে স্পষ্ট।

### ৩.৩ একেবারে বাকি ছিল (Missing)
1. **কনভারসেশনের বাইরের গ্রুপ (দীর্ঘমেয়াদি মেমরি) ট্রিতে ছিল না।** `memory_recall / memory_search / memory_list / memory_store / memory_forget` টুল দিয়ে মডেল বারবার একই জিনিস খুঁজত — ঠিক যেটা ইউজার বন্ধ করতে চেয়েছেন।
2. **পুরো গ্রুপ একসাথে টিক দেওয়া** (সব in / সব out / auto) — চেকলিস্ট সিলেকশনের মৌলিক কাজ — ছিল না।
3. দীর্ঘমেয়াদি মেমরির লেখা/মোছা `ctx` দিয়ে করার পথ ছিল না।

---

## ৪. ডেটা মডেল

**গ্রুপ (`GROUPS`)** — ট্রির মূল `mem` ("Chat memory"), তার নিচে:
`mem.goals` (সাব-গ্রুপ `mem.goals.closed`, `mem.goal_history`), `mem.topics`, `mem.decisions` (সাব-গ্রুপ `mem.decisions.closed` — রিপ্লেসড ও ক্লোজড একসাথে), `mem.facts`, `mem.prefs`, `mem.replaced`, `mem.files`, `mem.tasks` (সাব-গ্রুপ `mem.tasks.closed`), `mem.ranges` (সাব-গ্রুপ `mem.ranges.old`), `mem.versions`, এবং নতুন **`mem.longterm`** ("Long-term memory (every chat)")। (আগের লেখায় `mem.decisions_replaced`, `mem.decisions_closed`, `mem.ranges_old` ছিল — কোডে এই নাম নেই।)

**রেকর্ড (`Record`)**: `rid` (যেমন `D12`, `file:src/a.rs`, নতুন `lt:<key>`), `group`, `title`, `line` (যা কনটেক্সটে যায়), `tag`, `aliases`, `status`, `turn`, `native` (true = টার্ন-মেমরি সিলেক্টর চেনে; false = চেকলিস্ট নিজে `extra` লাইন হিসেবে পাঠায়)।

**ভার্সন**: `ctx_mem_versions(session_key, rid, version, line, …)` — লাইন বদলালে নতুন ভার্সন; পুরনোটা থাকে। দীর্ঘমেয়াদি এন্ট্রির (`lt:…`) ভার্সন এখন `session_key = '*'`-এ, সব চ্যাটে একই ইতিহাস (E3)। ফাইলের (`file:…`) ভার্সনও এখন `'*'`-এ (E1): একই কনটেন্ট মানে একই ভার্সন নম্বর, সব চ্যাটে। `#D12@v1`, `#plan.md@v2` দিয়ে নির্দিষ্ট ভার্সন।

**পিক (`ctx_mem_picks`)**: `in` / `out` / `auto`, `pin`, `versions = latest | all`।

**ট্যাগ (`ctx_mem_tags`, PK = session_key + tag)**: `state = active | inactive | removed`, `mentions`, `first_turn`, `last_turn`, `version`।
- একই ট্যাগ বহুবার থাকলে কনটেক্সট যায় শুধু শেষ উল্লেখের জায়গায়, একবার (`prepare_anchored` → `Anchor`)।
- `inactive`: ট্যাগ থাকে, কিন্তু কিছু টানে না। `removed`: মুছে যায়; নতুন উল্লেখ এলে আবার active।
- পিক `out` সবকিছুর উপরে; তারপর inline (শেষ ট্যাগ), তারপর in, তারপর relevance।

**নতুন — দীর্ঘমেয়াদি মেমরি মিরর (`ctx_mem_longterm`)**: `key` (PK), `text`, `updated_at`, `removed`। এটা **session-নিরপেক্ষ** (সব চ্যাটের), তাই চ্যাট রিসেট একে ছোঁয় না। প্রতিটি এন্ট্রি রেকর্ড `lt:<key>`, ট্যাগ `#lt:<key-slug>` (ছোট হাতের, অনুমোদিত অক্ষর)। লেখা বদলালে অন্য রেকর্ডের মতোই ভার্সন হয় (সব চ্যাটের জন্য একটাই ইতিহাস)। প্রোভাইডারের `list` সর্বোচ্চ ২০০টি কী দেয়, তাই মিরর নতুন ২০০টির জানালা; পূর্ণ (২০০) তালিকায় কোনো কী না থাকলে সেটাকে আর মোছা ধরা হয় না (F1)।

**নতুন — সব চ্যাটের ফাইল স্টোর (`ctx_mem_file_store`, E1)**: `path` + `hash` (PK), `content`, `chars`, `bytes`, `first_seen`, `last_seen`। কোনো `session_key` নেই, তাই চ্যাট রিসেট একে ছোঁয় না। প্রতিটি পাথের প্রতিটি আলাদা কনটেন্ট একবারই জমা হয় (একই কনটেন্ট আবার পড়লে শুধু `last_seen` বদলায়)। সীমা: একটি ফাইলের সর্বোচ্চ ২,০০,০০০ অক্ষর (`FILE_STORE_MAX_CHARS`; বড় হলে ভার্সন থাকে, লেখা নয়), পুরো স্টোর ৩২ MiB (`FILE_STORE_BUDGET_BYTES`; বেশি হলে সবচেয়ে কম ব্যবহৃত লেখা আগে মোছে, ভার্সনের সারি থাকে), সর্বোচ্চ ২০০০ সারি (`FILE_STORE_MAX_ROWS`), আর অন্য চ্যাটের সর্বোচ্চ ২০০টি ফাইল ট্রিতে দেখায় (`SHARED_FILES_MAX`)।

---

## ৫. UI ও রঙের নিয়ম

- সবুজ = **sent** (কনটেক্সটে গেছে); বেগুনি = **pinned** ("Earlier version sent", পুরনো ভার্সন পাঠানো); লাল = **left out** (বাদ পড়েছে, হালকা লাল পটভূমি); ধূসর ড্যাশ = **show more** (জমা আছে, পাঠানো হয়নি, "Show N more"-এর পেছনে); অ্যাম্বার + লাইন-থ্রু = **inactive** (ট্যাগ inactive)। লেজেন্ড ট্রির মাথায় (`cc-mem-legend`)।
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
- ✅ **E1 ফাইল সব চ্যাটে পুনঃব্যবহার** (২৩ নভেম্বর, ইউজারের সিদ্ধান্ত: হ্যাঁ, ফাইলের লেখা সব চ্যাটের জন্য এক জায়গায় থাকবে): `memory_checklist.rs` →
  - নতুন টেবিল `ctx_mem_file_store` (§৪), ফাংশন `store_file_content()`, `trim_file_store()`, `shared_file_content()`, `shared_files()`, `shared_file_records()`।
  - `prepare_anchored()` প্রতিটি রিকোয়েস্টে ট্রান্সক্রিপ্টের প্রতিটি ফাইল-পড়ার কনটেন্ট স্টোরে রাখে (`scan_calls()` — `duplicate_calls_abs()`-এর মতোই, সাথে কনটেন্ট)।
  - `is_shared_rid()` / `version_scope()`: `file:` রেকর্ডের ভার্সন `'*'`-এ, তাই `#plan.md@v2` সব চ্যাটে একই কনটেন্ট। `sync_versions()` ফাইলের জন্য কনটেন্ট অনুযায়ী নকল বাদ দেয়: যে কনটেন্ট কোনো চ্যাট আগে ভার্সন হিসেবে রেখেছে, সেটা আবার পড়লে নতুন ভার্সন হয় না।
  - `current_records()` / `prepare_anchored()`: যে ফাইল এই চ্যাটে পড়া হয়নি কিন্তু অন্য চ্যাটে পড়া হয়েছে, সেটা `mem.files` গ্রুপে সারি হিসেবে আসে (status "read in another chat (shared)", `native=false`) — নিজে থেকে কিছু পাঠায় না; `#ট্যাগ` বা check-in করলে পাঠায়।
  - `file_version()`: ভার্সন না বললে এই চ্যাটের শেষ পড়া কনটেন্ট (না থাকলে স্টোরের সবশেষ ব্যবহৃত); লেখা আগে এই চ্যাটের `tool_results` থেকে, না পেলে শেয়ার্ড স্টোর থেকে। আগের বিল্ডে পড়া ফাইল (`tool_results`-এ আছে কিন্তু স্টোরে নেই) প্রথম পড়ার সময় স্টোরে তুলে রাখা হয়।
  - চ্যাট রিসেট বা `tool_results` প্রুনিং-এর পরেও ভার্সন ও লেখা পড়া যায়।
  - iOS/Android প্রোভাইডারে কোনো বদল লাগেনি: স্টোর Rust-এর `agent.db` SQLite-এ, কোনো নতুন FFI নেই।
  - টেস্ট: `a_file_read_in_one_chat_is_usable_in_every_chat_and_survives_a_reset`, `the_shared_file_store_keeps_its_limits`।
  - নোট: আগে চ্যাট-ভিত্তিকভাবে জমা `file:` ভার্সন রয়ে যায় কিন্তু আর পড়া হয় না; শেয়ার্ড ইতিহাস v1 থেকে শুরু, তাই কোনো পুরনো চ্যাটে লেখা `#file@vN`-এর নম্বর এখন অন্য কনটেন্ট বোঝাতে পারে। একই পাথ (যেমন `README.md`) আলাদা প্রজেক্টে থাকলে তারা একই ফাইলের ভার্সন হিসেবে গণ্য হয়। স্টোর থেকে একটি ফাইল হাতে মোছার কোনো op এখনো নেই।
- ⏳ **E2 ভার্সন-ভিত্তিক আলাদা ট্যাগ অবস্থা:** এখন `ctx_mem_tags`-এর PK (session_key, tag), তাই `#plan.md@v1` ও `#plan.md@v2` একই সারি — শেষটাই জেতে (ইউজারের "শেষ ট্যাগ" নিয়মের সাথে মেলে)। প্রতিটি ভার্সনকে আলাদাভাবে inactive করতে চাইলে PK-তে `version` যোগ করে মাইগ্রেশন লাগবে।
- ✅ **E3 দীর্ঘমেয়াদি এন্ট্রির ভার্সন সব চ্যাটে এক** (২৩ নভেম্বর): `memory_checklist.rs` → `GLOBAL_VERSIONS_KEY = "*"`, `version_scope()`; `load_versions()`, `latest_versions()`, `sync_versions()` `lt:` রেকর্ডের ভার্সন `'*'`-এ রাখে/পড়ে। চ্যাট রিসেট এগুলো ছোঁয় না। অন্য চ্যাট একই লেখা দেখলে নকল ভার্সন হয় না। টেস্ট: `a_long_term_entry_keeps_one_version_history_for_every_chat`। নোট: আগে চ্যাট-ভিত্তিকভাবে জমা `lt:` ভার্সন রয়ে যায় কিন্তু আর পড়া হয় না; নতুন ইতিহাস v1 থেকে শুরু।
- ⏳ **E4 পুরনো "Chat memory" ডায়ালগ** (`57-memory.js::open`) এখনো Summary/Settings ট্যাবের ভেতরের অংশ হিসেবে এবং কনটেক্সট কার্ড না থাকলে fallback হিসেবে আছে। পুরোপুরি সরাতে Summary ও Settings সরাসরি `58-context-tree.js`-এ সরাতে হবে।
- ✅ **E5 Android প্রোভাইডার — আগের দাবি ভুল ছিল:** Android-এ `plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/MemoryProviderImpl.kt` আছে এবং `NativeAgentPlugin.kt`-এ যুক্ত। এর `list` (কী-এর JSON array) ও `search` (`[{key,text,score}]`) Rust-এর `parse_long_term_keys()` / `parse_long_term_text()`-এর সাথে মেলে। কোনো কাজ বাকি নেই।
- ✅ **E6 নেটিভ বাইনারি রিবিল্ড — হাতে করতে হয় না:** main-এ `plugins/native-agent/rust/**` বদলে push হলে `ios-agent-xcframework.yml` ও `native-agent-ffi.yml` নিজেরাই xcframework ও Android `.so` বানিয়ে কমিট করে (আগের `ffc0e79`, `fdedbc9` এভাবেই এসেছে)। push-এর পর Actions-এ এই দুই রান সফল হয়েছে কি না দেখে নিলেই হবে।
- ✅ **E7 গ্রুপ বোতামের UI টেস্ট** (২৩ নভেম্বর): মক ইঞ্জিন শুধু পাঠানো payload রেকর্ড করে, তাই `group:` চেনার দরকার নেই। `tools/agent-html-tests/context-tree.js`-এ দুটি নতুন চেক: প্রতিটি গ্রুপে All in / All out / Auto আছে, এবং "All out" চাপলে একটিমাত্র `ctx.set` op `{id: 'mem/group:mem.decisions', action: 'exclude'}` যায়।

### চ. যাচাইয়ে পাওয়া নতুন ত্রুটি ও সমাধান (২৩ নভেম্বর)
- ✅ **F1 কাটা `list`-এ এন্ট্রি ভুলে যাওয়া:** প্রোভাইডার (iOS/Android) ২০০০ এন্ট্রি রাখে, কিন্তু `list` সর্বোচ্চ ২০০ দেয়। `sync_long_term()` তালিকায় না থাকা যেকোনো কী-কে `removed=1` করত — ফলে পূর্ণ তালিকায় কোনো এন্ট্রি বাদ পড়লে তা ভুলভাবে "ভুলে যাওয়া" দেখাত। এখন তালিকা `LONG_TERM_MAX` (২০০)-এর চেয়ে ছোট হলেই (অর্থাৎ পুরো তালিকা) মোছা হয়। টেস্ট: `a_full_long_term_list_may_be_cut_short_so_it_forgets_nothing`।
- ✅ **F2 `mem/` ছাড়া গ্রুপ op ভুল পথে যেত:** D1 বলে `group:<id>` / `memgrp/<id>` প্রিফিক্স ছাড়াও চলে — `apply_ops()`-এ সত্য, কিন্তু `is_memory_id()` শুধু `mem/` ও `#` চিনত, তাই `ctx set` / `ctx.set`-এ `group:mem.files` ট্রি-op হিসেবে গিয়ে ব্যর্থ হতো। এখন `group:mem…` ও `memgrp/mem…`-ও মেমরি op। টেস্ট: `a_group_op_without_the_mem_prefix_is_routed_to_the_memory`।
- ✅ **F3 মৃত `long_term` ফিল্ড:** `context_tree/tools.rs`-এর schema থেকে সরানো হয়েছে; `docs/context-tree/TOOLS.md` হালনাগাদ (`ctx remember` ব্যবহার করতে বলা)।
- ✅ **F4 composer-এ `#` অটো-কমপ্লিট** (plan v2 §৯-এর ৬ নম্বর): `2e0076a`-তে আগেই আছে এবং `context-tree.js`-এ টেস্ট করা।

---

## ৭. মাইগ্রেশন (মেমরি টুল সরানো)

1. নতুন বিল্ডে মডেলকে শুধু `ctx` দেওয়া হয়; সাতটি পুরনো মেমরি টুল অফার হয় না।
2. পুরনো চ্যাটের ট্রান্সক্রিপ্টে থাকা `recall_turns` / `memory_*` / `memory_inspect` কল এখনো উত্তর পায় — হ্যান্ডলারগুলো রাখা আছে, তাই কিছু ভাঙে না।
3. পুরনো সেটিংসের `enabled:false` চুপচাপ উপেক্ষিত (true হিসেবে পড়া)।
4. `ctx_mem_longterm` টেবিল `CREATE TABLE IF NOT EXISTS` দিয়ে প্রথম ব্যবহারে তৈরি হয়; প্রথম রিকোয়েস্টে প্রোভাইডার থেকে ভরে যায়।
5. পরের রিলিজে (সব ক্লায়েন্ট আপডেট হলে) লিগ্যাসি হ্যান্ডলার ও `inspect.rs` সরানো যাবে।

---

## ৮. টেস্টিং — কী চালানো হয়েছে ও ফল

- `cargo test --lib` (native-agent-ffi): main-এ ৮৩৬ পাস; 0.patch-এর পর ৮৪০ পাস (যাচাই করা); ২৩ নভেম্বরের হালনাগাদের পর **৮৪৩ পাস, ০ ফেল, ১ ignored**; E1-এর পর **৮৪৫ পাস, ০ ফেল, ১ ignored**। কম্পাইলে ০ warning।
- নতুন Rust টেস্ট (`memory_checklist_tests.rs`):
  - `the_long_term_memory_is_a_versioned_group_of_the_tree` — সিঙ্ক, গ্রুপ, ট্যাগ `#lt:diet-pref`, শেষ উল্লেখে একবার, ভার্সন, প্রোভাইডার থেকে বাদ পড়লে গ্রুপ থেকে বাদ।
  - `ctx_remember_and_forget_write_the_long_term_group_without_a_memory_tool`
  - `the_memory_is_always_on_even_when_an_old_settings_file_says_off`
  - `a_whole_group_is_checked_in_or_out_with_one_op`
- বদলানো টেস্ট: `assemble.rs` (নতুন action, ≤৩৪০ টোকেন), `lib.rs` e2e (শুধু `ctx` অফার, `recall_turns`/`memory_inspect` নয়; memory on/off ইনভারিয়েন্ট)।
- ২৩ নভেম্বরের নতুন Rust টেস্ট: `a_long_term_entry_keeps_one_version_history_for_every_chat`, `a_full_long_term_list_may_be_cut_short_so_it_forgets_nothing`, `a_group_op_without_the_mem_prefix_is_routed_to_the_memory`।
- E1-এর নতুন Rust টেস্ট: `a_file_read_in_one_chat_is_usable_in_every_chat_and_survives_a_reset`, `the_shared_file_store_keeps_its_limits`। E1-এর পর UI আবার চালানো হয়েছে: memory ৩২০/৩২০, context-tree ৮২/৮২, render ১১৯/১১৯ পাস (E1-এ UI কোড বদলায়নি)।
- UI (Playwright, হেডলেস Chromium): `tools/agent-html-tests/memory.js` **৩২০/৩২০ পাস**, `context-tree.js` 0.patch-এর পর ৮০/৮০, E7-এর পর **৮২/৮২ পাস**, `render.js` **১১৯/১১৯ পাস**।
- `www/agent.html` `build.py` দিয়ে আবার বানানো হয়েছে; আবার বানালে কোনো পার্থক্য হয় না (সোর্সের সাথে মেলে)।

---

## ৯. কাজের ক্রম (প্রয়োগ ও পরের ধাপ)

1. ✅ 0.patch, বাকি কাজ (E1, E3, E7, F1–F3) ও এই প্ল্যান main-এ কমিট ও push করা হয়েছে — আর `git apply` লাগবে না; শুধু `git pull`।
2. `cd plugins/native-agent/rust/native-agent-ffi && cargo test --lib`।
3. `python3 tools/agent-html-src/build.py` (সোর্স বদলালে)।
4. GitHub Actions-এ `ios-agent-xcframework.yml` ও `native-agent-ffi.yml` রান সফল কি না দেখুন (E6, স্বয়ংক্রিয়)।
5. ডিভাইসে যাচাই: কনটেক্সট কার্ড → Checklist → "Long-term memory (every chat)" গ্রুপ, All in/out/Auto, `#lt:…` ট্যাগ।
6. বাকি: E2 → E4 (নিচে কারণ)। E1 ২৩ নভেম্বর হয়েছে।

---

## ১০. এই প্যাচে বদলানো ফাইল

Rust: `agent_loop.rs`, `context_tree/assemble.rs`, `context_tree/dispatch.rs`, `context_tree/memory_checklist.rs`, `context_tree/memory_checklist_tests.rs`, `context_tree/tools.rs`, `lib.rs`, `read_budget.rs`, `tool_runner.rs`, `turn_memory.rs`, `turn_memory/inspect.rs`, `turn_memory/repair.rs`, `turn_memory/results.rs`, `turn_memory/select.rs`, `workspace.rs`।
UI: `tools/agent-html-src/17-agent-goals.js`, `57-memory.js`, `58-context-tree.js`, `58-context-tree.css`, `www/agent.html`, টেস্ট `tools/agent-html-tests/memory.js`।
ডক: এই ফাইল (`docs/context-tree/MEMORY-CHECKLIST-FULL-PLAN.bn.md`)।
২৩ নভেম্বরের হালনাগাদ: `context_tree/memory_checklist.rs` (E3, F1, F2), `context_tree/memory_checklist_tests.rs` (৩টি নতুন টেস্ট), `context_tree/tools.rs` (F3), `docs/context-tree/TOOLS.md` (F3), `tools/agent-html-tests/context-tree.js` (E7), এবং `docs/context-tree/memory-checklist-plan-v2.bn.md` (plan v2, রেফারেন্সের জন্য)।
E1 হালনাগাদ: `context_tree/memory_checklist.rs`, `context_tree/memory_checklist_tests.rs` (২টি নতুন টেস্ট), এই ফাইল।

---

## ১১. ২৩ নভেম্বরের যাচাই — সারাংশ

**যাচাই পদ্ধতি:** main (`fdedbc9`)-এর উপর 0.patch প্রয়োগ করা ওয়ার্কিং ট্রি ফাইল-বাই-ফাইল মেলানো হয়েছে (হুবহু মেলে); প্ল্যানের প্রতিটি ফাংশন, টেবিল, গ্রুপ, রঙ, টেস্টের নাম ও সংখ্যা কোডে খোঁজা হয়েছে; Rust ও Playwright টেস্ট নিজে চালানো হয়েছে।

**যা ভুল ছিল এবং ঠিক করা হয়েছে:** গ্রুপের আইডি/শিরোনাম (§৩.১, §৪), রঙের তালিকা ("not shown" নেই, "inactive" আছে; §৩.১, §৫), `2bb631b`-এর কমিট মেসেজ (§৩), `memory_checklist.rs`-এর লাইন সংখ্যা (§২), Android প্রোভাইডার নেই বলে দাবি (E5), বাইনারি হাতে বানাতে হবে বলে দাবি (E6), মক ইঞ্জিনের কারণে UI টেস্ট সম্ভব নয় বলে দাবি (E7), এবং `long_term` মৃত ফিল্ড "ঠিক হয়েছে" বলে ধরে নেওয়া (F3)।

**যা ঠিক ছিল (যাচাই করা):** A1–A4, B1–B6, C1–C7, D1–D2 সব কোডে আছে; `REPLACED_MEMORY_TOOLS`-এ সাতটি টুল; `enabled_on` সবসময় true; `ctx` নির্দেশনা ≤৩৪০ টোকেন; ৮৪০ Rust ও ৩২০ + ৮০ UI টেস্ট পাস।

**এখনো বাকি (⏳) ও কেন:**
- ~~**E1** (ফাইল সব চ্যাটে)~~ — ✅ হয়েছে (২৩ নভেম্বর, ইউজার "হ্যাঁ" বলার পর): ফাইলের প্রতিটি আলাদা কনটেন্ট এখন সব চ্যাটের জন্য একবার `ctx_mem_file_store`-এ জমা থাকে, ভার্সন নম্বর সব চ্যাটে এক, চ্যাট রিসেটে মোছে না; বিস্তারিত §৬ঙ।
- **E2** (ভার্সন-ভিত্তিক ট্যাগ অবস্থা): বর্তমান আচরণ ("শেষ ট্যাগ জেতে") ইউজারের নিয়মের সাথে মেলে; PK মাইগ্রেশন ঐচ্ছিক।
- **E4** (পুরনো Chat memory ডায়ালগ): Summary/Settings UI সরানো বড় রিফ্যাক্টর, ৩২০টি `memory.js` টেস্ট এর উপর নির্ভর করে — আলাদা কাজ হিসেবে করা ভালো।
- লক্ষ্যণীয়: প্রথম রিকোয়েস্টে মিররে নতুন প্রতিটি কী-এর জন্য প্রোভাইডারে একটি `search` হয় (সর্বোচ্চ ২০০); আর প্রোভাইডারে বাইরে থেকে কোনো এন্ট্রির লেখা বদলালে (মেমরি টুল ছাড়া) মিরর তা আপডেট করে না।
