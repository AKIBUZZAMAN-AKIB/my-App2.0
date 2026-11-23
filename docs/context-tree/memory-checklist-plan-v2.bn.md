# Memory Checklist: পুরো পরিকল্পনা আর বাস্তবায়ন (my-App2.0)

এই লেখাটা আগের `memory-checklist-plan.bn.md`-এর জায়গা নেয়। আগের plan-এ যা ছিল না, এখানে তা যোগ করা হয়েছে: পুরো group-এর তালিকা, প্রতিটি record-এর version, `#tag` আর "শেষ tag-ই জেতে" নিয়ম, tag inactive বা remove করা, file-কে আলাদা group হিসেবে রাখা, একই context বারবার না পাঠানো, আর checklist সবসময় চালু রাখা। প্রতিটি অংশের জন্য কোন ফাইলে কী আছে, কেন বদলাতে হলো, আর ঠিক কী বদলানো হয়েছে, সব লেখা আছে। এই plan অনুযায়ী কোড বাস্তবায়ন করা হয়েছে, আর tests চালানো হয়েছে।

---

## ১. পুরো লক্ষ্য (Goal)

মডেলকে কী context দেওয়া হবে, সেটা ঠিক হয় দুইভাবে: দরকার অনুযায়ী (on demand), অথবা ইউজার checklist-এ যা বেছে দেন। তাই chat-এর পুরো memory checklist tree-র ভেতরে থাকবে। আলাদা কোনো জগৎ থাকবে না।

1. **সবকিছু checklist tree-তে, আলাদা আলাদা group-এ।** Goals, বন্ধ goals, goal history, topics আর titles, চালু decisions, বদলানো বা বন্ধ decisions, facts, preferences, বদলানো facts/prefs/files, files, খোলা tasks, বন্ধ tasks, ranges, পুরনো ranges, আর memory versions। প্রতিটির নিজের group আছে, আর nested group-গুলো তাদের parent-এর ভেতরে বসে।
2. **Checklist সবসময় চালু।** কোনো default on/off নেই, কোনো switch নেই। পুরনো database-এ `enabled = 0` লেখা থাকলেও সেটা মানা হয় না। এর ফলে আলাদা memory tool আর লাগে না, কারণ সব কাজ checklist থেকেই হয়।
3. **আলাদা memory inspection tool নেই।** `memory_inspect` আর মডেলকে দেওয়া হয় না। একই কাজ এখন `ctx memory` (পড়া) আর `ctx set` (`mem/<ID>` দিয়ে পাঠানো বা বাদ দেওয়া) করে।
4. **প্রতিটি record version-ভিত্তিক।** কোনো record-এর লেখা বদলালে নতুন version তৈরি হয়। আগের version কখনো মুছে বা overwrite হয় না। যেকোনো আগের version পড়া যায়, আবার পাঠানোও যায় (`#D12@v1`)।
5. **Files একটা আলাদা group, আর reuse হয়।** একই file একই content নিয়ে আবার পড়া হলে সেটা একটাই node থাকে, আর আগের হুবহু একই tool result request থেকে বাদ যায়। Content বদলালে সেটা নতুন version হয়।
6. **`#tag` দিয়ে reference।** Conversation-এর যেখানে কোনো data ব্যবহার হবে, সেখানে তার নাম `#tag` হিসেবে লেখা যায়: `#D12`, `#F4`, `#G2`, `#S3-7`, file হলে তার নাম (`#plan.md`), আর আগের version হলে `#D12@v1`।
7. **একই tag বারবার এলে শুধু শেষেরটা গোনা হয়।** Active checklist-এ একই tag অনেকবার থাকতে পারে, কিন্তু context যায় শুধু শেষ mention-এর জায়গা থেকে (তার version সহ), একবারই। প্রতিটি tag আলাদাভাবে **inactive** করা যায় (tag থাকে, কিন্তু record টেনে আনে না), আবার **remove**-ও করা যায় (এ পর্যন্ত যতবার নাম এসেছে সব ভুলে যাওয়া হয়; নতুন করে নাম এলে আবার ফেরে)। এই দুটো আলাদা জিনিস।
8. **রং।** যা বাদ পড়েছে (left out) আর যা "show more"-এর পেছনে আছে, তাদের আলাদা রং হবে। মোট পাঁচটা রং: পাঠানো হয়েছে, বাদ পড়েছে, show more, tag inactive, আর আগের version পাঠানো হয়েছে।
9. **একই context বারবার না।** বারবার একই জিনিস memory থেকে recall করা বন্ধ হবে। একই লাইন একটা request-এ দুবার যায় না, আর হুবহু একই tool result শুধু শেষবারের জায়গায় থাকে।

---

## ২. এখনকার architecture: কোন ফাইলে কী আছে (গবেষণা)

Repo: `AKIBUZZAMAN-AKIB/my-App2.0`। এটা একটা Capacitor app। মূল engine Rust-এ লেখা (`plugins/native-agent/rust/native-agent-ffi`), আর UI হলো একটাই HTML ফাইল (`www/agent.html`), যেটা `tools/agent-html-src/*.js|css` থেকে `build.py` দিয়ে তৈরি হয়।

### ২.১ Rust engine (`plugins/native-agent/rust/native-agent-ffi/src/`)

| ফাইল | কী আছে | এই কাজে ভূমিকা |
|---|---|---|
| `turn_memory.rs` | Chat memory-র মূল type (`TurnMemory`, `Segment`, `Decision`), turn ভাগ করা (`split_turns`), `topic_groups`, `recall_turns` tool | Record-এর উৎস |
| `turn_memory/items.rs` | Fact, preference, file, open-item (`MemoryItem`, `Kind`), `superseded_by` | Facts, prefs, files, tasks group |
| `turn_memory/goals.rs` | Goals আর goal events (create, complete, cancel, supersede) | Goals, closed goals, goal history |
| `turn_memory/store.rs` | Memory-র version (`save_version`, `list_versions`) | Memory versions group |
| `turn_memory/select.rs` | **প্রতিটি request-এ memory block বেছে নেয়** (`select`)। Active goal, চালু decision, essential items, lexical match, FTS, token cap। যা দেখানো হয়নি তা ID দিয়ে "Not shown here" তালিকায় যায় | এখানে picks, tags আর reasons ঢুকেছে |
| `turn_memory/inspect.rs` | `memory_inspect` tool: memory record শুধু পড়ে দেখায় (read-only) | Tool হিসেবে বাদ; ভেতরের section view `ctx memory` থেকে আবার ব্যবহার হয় |
| `agent_loop/memory_loop.rs` | প্রতিটি request-এর আগে fold বা select চালায়, block বসায়, `memory.applied` event পাঠায় | Checklist-এর `prepare` আর `save_status` এখানে ডাকা হয় |
| `agent_loop.rs` | মূল loop। Tool list বানায়, `memory_inspect` যোগ করত, context tree-র `before_request` আর `drop_calls` | `memory_inspect` বাদ, duplicate result বাদ দেওয়া |
| `context_tree.rs` + `context_tree/*` | Checklist tree। `model.rs` (node), `store.rs` (`ctx_*` table), `ops.rs` (include/exclude/pin), `dispatch.rs` (`ctx` tool-এর action), `tools.rs` (schema), `assemble.rs` (locked rules prompt), `settings.rs` (on/off সহ settings), `wiring.rs` (`enabled`, `before_request`, `snapshot`) | এখানে নতুন module `memory_checklist.rs` |
| `lib.rs` | FFI: `ctx.tree`, `ctx.set`, `ctx.settings` ইত্যাদি action, আর integration tests | Memory row-এর `ctx.set` routing, snapshot-এ memory |

### ২.২ আগে কী সমস্যা ছিল (code থেকে প্রমাণসহ)

1. **Checklist default-এ বন্ধ ছিল।** `wiring.rs`-এর `enabled_on` শুধু `ctx_meta.enabled == "1"` হলেই true দিত। `settings.rs`-এ `enabled: false` ছিল default। UI-তে "Context tree is off" লেখা আর একটা "Turn on" বোতাম দেখাত।
2. **Memory আর checklist আলাদা জগৎ ছিল।** Checklist শুধু turn আর tool call চিনত। Memory record (goal, decision, fact) checklist-এর node ছিল না। `sum/memory` node-টা `Pin::Policy` (locked), তাই memory-র কোনো অংশ বাদ দেওয়া যেত না।
3. **একই জিনিস বারবার recall হতো।** `select()` প্রতিটি request-এ নিজের relevance দিয়ে বাছত। ইউজার বা মডেলের কোনো স্থায়ী পছন্দ ছিল না। তাই মডেল `memory_inspect` বা `recall_turns` দিয়ে একই record বারবার আনত, আর সেই একই tool result transcript-এ জমতে থাকত।
4. **Version ছিল শুধু পুরো memory-র।** `store.rs` পুরো memory-র snapshot রাখে। একটা decision-এর লেখা কীভাবে বদলেছে, সেটা record ধরে রাখা হতো না। `superseded_by` শুধু decision বা item-এর পরম্পরা জানায়, কিন্তু একই ID-র লেখা বদলালে আগের লেখা হারিয়ে যেত।
5. **Files-এর আলাদা জায়গা ছিল না।** File-kind item ছিল facts-এর পাশে। আর tool দিয়ে পড়া file-এর কোনো হিসাব ছিল না: একই file দশবার পড়লে দশটা পুরো result request-এ যেত।
6. **#tag ছিল না।** কোনো record-কে conversation-এ নাম ধরে ডাকার উপায় ছিল না।
7. **UI-র ভুল তথ্য (আগের plan-এর §২.৫):** Summary tab-এ "Always sent" লেখা থাকত, যদিও `select()` বেছে বেছে পাঠায়। সব range row একই `segment` info key ব্যবহার করত, তাই একটা (i) চাপলে সব tip একসাথে খুলে যেত।

### ২.৩ আগের plan-এর ঘাটতি

আগের plan memory-র জন্য শুধু checked/unchecked আর reason যোগ করতে চেয়েছিল। এতে বাকি ছিল:

- Checklist সবসময় চালু রাখা (উল্টে plan-এ খোলা প্রশ্ন ছিল "tree বন্ধ থাকলে কী হবে")।
- Group-এর পুরো তালিকা: goal history, topics/titles, files, পুরনো ranges, versions।
- Record ধরে version রাখা।
- `#tag`, শেষ mention-এর নিয়ম, inactive আর remove।
- Files-কে আলাদা group করা আর reuse।
- একই context-এর duplicate বাদ দেওয়া।
- `memory_inspect` সরাসরি বাদ দেওয়া (plan-এ ছিল ধীরে ধীরে, `modelRecall` setting দিয়ে)।
- নতুন bridge action (`memory.pick`) লাগত। এখানে আগের `ctx.set` আর `ctx.tree` দিয়েই কাজ হয়েছে, তাই bridge বা TypeScript-এ কোনো পরিবর্তন লাগেনি।

---

## ৩. Target design

### ৩.১ মূল নীতি

- **এক জায়গায় সব:** memory-র প্রতিটি record checklist tree-র একটা row।
- **কিছুই মুছে যায় না:** বাদ দেওয়া মানে "পাঠানো হবে না"। Record, তার version আর tag সব থাকে।
- **স্থায়ী পছন্দ relevance-এর চেয়ে বড়:** ইউজার বা মডেল যা include করেছে তা সবসময় যায়। যা exclude করেছে তা কখনো যায় না, এমনকি essential হলেও। একমাত্র ব্যতিক্রম active goal, যেটা বাদ দেওয়া যায় না।
- **প্রতিটি row-এর একটা কারণ থাকে:** প্রতিটি request-এর পর engine প্রতিটি row-এর জন্য লেখে কেন সেটা গেছে বা যায়নি। UI সেই কারণ দেখে রং বসায়।

### ৩.২ Groups (tree)

`memory_checklist.rs`-এর `GROUPS` থেকে, দেখানোর ক্রমে:

```
mem                    Chat memory
├─ mem.goals           Goals (active, paused)
│  ├─ mem.goals.closed     Closed goals (done, cancelled, replaced)
│  └─ mem.goal_history     Goal history (every create/complete/cancel/supersede event)
├─ mem.topics          Topics & titles (each topic's ranges and the titles they got)
├─ mem.decisions       Decisions in force
│  └─ mem.decisions.closed Replaced / closed decisions
├─ mem.facts           Facts
├─ mem.prefs           Preferences
├─ mem.replaced        Replaced / retired facts, preferences & files
├─ mem.files           Files (file items + every file read by a tool, by path)
├─ mem.tasks           Open tasks
│  └─ mem.tasks.closed     Closed tasks
├─ mem.ranges          Ranges (newest 3 turn summaries)
│  └─ mem.ranges.old       Old ranges
└─ mem.versions        Memory versions (V1, V2, ...)
```

### ৩.৩ Record ID আর #tag

| Record | ID | Tag |
|---|---|---|
| Goal | `G2` | `#g2` |
| Goal history event | `GH4` | `#gh4` |
| Decision (চালু বা বদলানো) | `D12` | `#d12` |
| Fact / Preference / File item / Task | `F4`, `P1`, `L3`, `O5` | `#f4` ... |
| Range | `S3-7` | `#s3-7` |
| Topic | `T-billing` | `#t-billing` |
| Memory version | `V7` | `#v7` |
| Tool দিয়ে পড়া file | `file:src/main.rs` | `#main.rs` (file-এর নাম) |

Tag case-insensitive। `#D12`, `#d12`, `mem/D12` তিনটাই একই row বোঝায়। File item-এর লেখায় কোনো file-এর নাম থাকলে (`docs/plan.md`) সেই নামেও (`#plan.md`) row-টা পাওয়া যায়। `C#` বা HTML entity (`&#39;`) tag হিসেবে ধরা হয় না, আর অচেনা tag উপেক্ষা করা হয়।

### ৩.৪ Version

- Table `ctx_mem_versions`: (session, rid, version, hash, line, status, memory_version, turn, created_at)।
- প্রতিটি request-এ `sync_versions` প্রতিটি row-এর এখনকার লাইনের hash নেয়। শেষ version-এর hash থেকে আলাদা হলে নতুন version লেখে (`INSERT OR IGNORE`, তাই কখনো overwrite হয় না)।
- `ctx memory id=D12` সব version দেখায় (সবচেয়ে পুরনোটা আগে), আর কোন record-গুলোর জায়গায় এটা এসেছে তাও দেখায় (`Replaced earlier records: D7, D3`)।
- **All versions:** কোনো row-এ `all_versions` দিলে সেটা পাঠানোর সময় সাথে যায় (ক) একই ID-র আগের লেখাগুলো, আর (খ) যে record-গুলোর জায়গায় এটা এসেছে (`superseded_by` chain, যেমন D12 ← D7 ← D3)।
- **Version tag:** `#D12@v1` লিখলে ঠিক সেই version-এর লেখা যায়, আলাদা section-এ: "Earlier versions chosen in the checklist (history only; the current version is above)"।

### ৩.৫ #tag-এর নিয়ম (শেষ mention, inactive, remove)

- **Scan:** প্রতিটি request-এ ইউজার আর assistant-এর লেখা পড়া হয়। Tool result আর memory block বাদ থাকে, কারণ ওগুলো data, আদেশ নয়।
- **শেষটাই জেতে:** Table `ctx_mem_tags`-এ প্রতিটি tag-এর একটাই row থাকে: শেষ mention-এর turn আর version, প্রথম turn, আর মোট কতবার নাম এসেছে। Picks-এ প্রতিটি tag একবারই ঢোকে, যতবারই নাম আসুক। শেষ mention যদি পুরনো version বলে (`@v1`), তাহলে সেই version-ই যায়, newest নয়।
- **Inactive:** tag থাকে, তালিকায় দেখায় (কাটা দাগ দিয়ে), কিন্তু record আর টেনে আনে না। Row-এর কারণ হয় `inactive`। নতুন mention এলেও state inactive থাকে, যতক্ষণ না `active` করা হয়।
- **Remove:** `removed_through` = শেষ mention-এর turn। এ পর্যন্ত যত mention, সব উপেক্ষা হয়। এর পরের turn-এ নতুন করে নাম এলে tag আবার active হয়।
- **Remove আর exclude আলাদা:** exclude record-এর ওপর কাজ করে (কখনো পাঠানো হবে না)। Remove tag-এর ওপর কাজ করে (এ পর্যন্ত tag-এর mention ভুলে যাওয়া)। Inactive-ও tag-এর ওপর কাজ করে (রাখা হয়, কিন্তু কাজ করে না)।

### ৩.৬ Picks আর selection

Table `ctx_mem_picks`: (session, rid, pick = `in|out|auto`, versions = `latest|all`, actor = `user|model`)।

`build_picks` সব picks আর tags মিলিয়ে selector-এর জন্য একটা `Picks` বানায়:

- `include`: `in` করা row (`user_pick`) আর active tag-ওয়ালা row (`mentioned`)।
- `exclude`: `out` করা row।
- `inactive`: inactive tag-ওয়ালা row।
- `with_history`: `all_versions` করা row।
- `extra`: যে row-গুলো selector চেনে না (topics, goal history, versions, files) সেগুলোর লাইন, আর pin করা আগের version।

`select_with` (`select.rs`) এগুলো প্রয়োগ করে: excluded বাদ যায় (active goal ছাড়া), included essential হয় (score 200), extra যায় নিজের section-এ। তারপর একই লাইন দুবার থাকলে একটা বাদ যায়, তারপর token cap প্রয়োগ হয়। কোনো pick না থাকলে `select_with` হুবহু আগের `select`-এর মতো কাজ করে (`select()` এখন `select_with(…, &Picks::default())`)।

### ৩.৭ Reason আর রং

`Selection.reasons`-এ প্রতিটি row-এর কারণ থাকে:

| Reason | রং (class) | মানে |
|---|---|---|
| `active_goal`, `user_pick`, `mentioned`, `essential`, `lexical`, `fts`, `newest_segment` ... | `sent` (সবুজ) | এই request-এ গেছে |
| `versions`, `pinned_version` | `pinned` (বেগুনি) | আগের version গেছে |
| `cut` | `left_out` (লাল) | Request-এর সাথে মিলেছিল, কিন্তু জায়গার অভাবে বাদ পড়েছে |
| `excluded` | `left_out` (লাল) | Checklist-এ বাদ দেওয়া |
| `inactive` | `inactive` (হলুদ-বাদামি, কাটা দাগ) | Tag inactive |
| `not_shown` | `show_more` (ধূসর, ড্যাশ border) | রাখা আছে, এখন লাগেনি; "Show N more"-এর পেছনে |

Reasons থাকে `ctx_mem_status`-এ, আর `ctx.tree` snapshot-এ প্রতিটি row-এর সাথে `reason` আর `colour` হিসেবে যায়।

### ৩.৮ Files আর duplicate বাদ দেওয়া

- `duplicate_calls_abs`: transcript-এর প্রতিটি tool call আর তার result মিলিয়ে দেখে। একই tool আর হুবহু একই result (whitespace বাদে, অন্তত ১২০ অক্ষর) একাধিকবার থাকলে **শেষটা রেখে** বাকিগুলো (turn, call index) হিসেবে দেয়। `agent_loop.rs` এগুলো tree-র `drop_calls`-এ যোগ করে, তাই আগের কপিগুলো request থেকে বাদ যায়। এটা file পড়া, একই memory আবার recall, সব ক্ষেত্রেই কাজ করে।
- File পড়া (`read_file`, `*_read`, `view_file`, `open_file`) ধরা হয় path, content hash, turn আর chars সহ, আর রাখা হয় `ctx_mem_files`-এ। এতে summarize হয়ে যাওয়া turn-এর file-ও হারায় না। Files group-এ প্রতিটি path একটা row: "N version(s), M read(s); the newest read is the one sent"।

### ৩.৯ Checklist সবসময় চালু

- `wiring.rs::enabled_on` সবসময় `true` দেয়। শুধু database খোলাই না গেলে `enabled()` false দেয়, আর তখন request আগের মতো যায়।
- `set_enabled(_, false)` উপেক্ষা হয়, সবসময় `1` লেখে।
- `Settings` default-এ `enabled: true`। Patch-এ `enabled: false` এলে গ্রহণ করা হয় কিন্তু মানা হয় না। পুরনো `0` পড়লেও `true` হয়।
- UI-তে "Turn on" বোতাম আর "Context tree is off" screen নেই। Settings-এ switch-এর জায়গায় একটা "Always on" badge আছে।

### ৩.১০ `memory_inspect` বাদ

- মডেলকে আর এই tool দেওয়া হয় না (`agent_loop.rs`-এ `tools.retain(...)` থাকে, কিন্তু `push` নেই)।
- পুরনো transcript বা মডেলের অভ্যাসে কেউ এটা ডাকলে উত্তর আসে checklist-এর `view` থেকে (`section` হয়ে যায় `path`, `query` হয়ে যায় `question`)। তাই কিছু ভাঙে না।
- `inspect.rs` module রাখা হয়েছে, কারণ `ctx memory path=goals|decisions|items|tasks|segments|versions|results|search|overview` তার পুরনো section view আবার ব্যবহার করে।
- `recall_turns` থাকে। এটা মূল turn আর stored tool result (`result_id`) আনে, যা checklist দিয়ে বদলানো যায় না। এখন হুবহু একই recall result দ্বিতীয়বার এলে আগেরটা বাদ যায় (§৩.৮)।
- মডেলের "Not shown here" লেখাও বদলানো হয়েছে: এখন বলে checklist (`ctx memory`, `ctx set` with `mem/D12`) আর `#ID`-এর কথা।

---

## ৪. Interface (FFI / tool / UI data)

### ৪.১ `ctx` tool (মডেলের জন্য)

- নতুন action **`memory`**: `ctx memory` দেয় group আর row-এর তালিকা (প্রতিটির ID, tag, অবস্থা)। `path=mem.decisions` দেয় একটা group পুরো। `id=D12` বা `id=#plan.md` দেয় একটা record সব version সহ। `path=goals` ইত্যাদি দেয় পুরনো inspect section।
- `ctx set`-এ `mem/<ID>` বা `#tag` id দিয়ে op: `include`, `exclude`, `auto`, `pin`, `unpin`, `all_versions`, `latest`, `inactive`, `active`, `remove`। Tree-র নিজের op আর memory op একই batch-এ পাঠানো যায়। Memory op আলাদা হয়ে `memory_checklist::apply_ops`-এ যায়। `dry_run` হলে কিছু লেখা হয় না।
- `tools.rs` schema-র enum-এ নতুন action আর op যোগ হয়েছে। `assemble.rs`-এর locked rules prompt-এ `memory`-র ছোট ব্যাখ্যা আছে (budget test 260 থেকে বাড়িয়ে 340 token)।

### ৪.২ FFI (`lib.rs`)

- `ctx.set`: ops-এর মধ্যে memory row আলাদা করে `apply_ops`-এ (actor `user`) যায়, বাকিটা আগের মতো `apply_batch`-এ। শুধু memory op থাকলে শুধু memory-র ফল ফেরে।
- `ctx.tree` (`wiring::snapshot`): নতুন field `alwaysOn: true` আর `memory` (`memory_checklist::snapshot`): `groups[]` (id, title, parent, count, items[]), `tags[]`, `counts` (sent, leftOut, showMore, inactive), `actions`।
- প্রতিটি item: `id` (`mem/D12`), `rid`, `tag`, `aliases`, `title`, `line`, `status`, `turn`, `pick`, `pickedBy`, `versionsMode`, `reason`, `colour`, `versionCount`, `versions[]` (newest 8টা; সব DB-তে থাকে), `tagState`, `mentions`।
- `memory.applied` event-এ নতুন `checklist` field: `picked`, `excluded`, `inactiveTags`, `versions`।
- TypeScript bridge-এ কোনো পরিবর্তন লাগেনি, কারণ `ctx.set` আর `ctx.tree` আগে থেকেই আছে।

### ৪.৩ Data schema আর migration

নতুন table (`CREATE TABLE IF NOT EXISTS`, chat-এর নিজের database-এ, `ctx_*` table-এর পাশে):

- `ctx_mem_picks(session_key, rid, pick, versions, actor, updated_at)`
- `ctx_mem_versions(session_key, rid, version, hash, line, status, memory_version, turn, created_at)`
- `ctx_mem_tags(session_key, tag, rid, version, first_turn, last_turn, mentions, state, removed_through, updated_at)`
- `ctx_mem_files(session_key, path, hash, turn, call_index, chars)`
- `ctx_mem_status(session_key, reasons_json, updated_at)`

**Migration:** কোনো পুরনো data বদলাতে হয় না। প্রথম request-এ table তৈরি হয়, প্রতিটি record-এর version 1 লেখা হয়, transcript-এ এখনো থাকা file read আর tag ধরা হয়। পুরনো `ctx_meta.enabled = 0` উপেক্ষা হয় আর পরের `Settings::save`-এ `1` হয়ে যায়। Tree reset (`ctx.reset`) করলে এই পাঁচটা table-ও সেই chat-এর জন্য খালি হয়, কিন্তু memory নিজে থাকে।

---

## ৫. UI (`tools/agent-html-src/58-context-tree.js` + `.css` → `www/agent.html`)

- **Checklist tab:** Rules আর Memory group-এর পরে, conversation-এর আগে, একটা **Chat memory** root group থাকে (প্রথমবার খোলা অবস্থায়)। মাথায় থাকে মোট হিসাব ("N sent · N left out · N more"), একটা (i) tip, রঙের legend, আর chat-এর `#tag`-গুলো (inactive হলে কাটা দাগ, removed হলে ফিকে)।
- **Group:** nested ভাবে আঁকা হয় (`parent` দিয়ে)। মাথায় থাকে "sent/total" আর লাল রঙে "N left out"। আগে আসে sent আর left-out row, তারপর show-more row যতটা জায়গা থাকে (৬টা পর্যন্ত), বাকিগুলো **"Show N more"** বোতামের পেছনে (ধূসর, ড্যাশ border)।
- **Row:** বাঁ দিকে রঙিন border আর ডানে একটা রঙিন dot। আছে checkbox (tick দিলে `include`, untick দিলে `exclude`; auto অবস্থায় হালকা দেখায়), tag, title, `vN` badge (একাধিক version থাকলে), আর `×N` badge (কতবার নাম এসেছে)। খুললে দেখা যায় পুরো লাইন, অবস্থা, কারণ, কে pick করেছে, আর বোতাম: ↺ Auto, All versions বা Newest only, Tag inactive বা Tag active, Remove tag। নিচে version-এর তালিকা।
- **রং (CSS variable):** sent `#16a34a`, left_out `#dc2626` (হালকা লাল background-ও), show_more `#6b7280` (ড্যাশ, একটু ফিকে), inactive `#a16207` (title-এ কাটা দাগ), pinned `#7c3aed`।
- **Settings tab:** switch নেই, "Always on" badge আছে।
- **ঠিক করা পুরনো bug:** Summary-র "Always sent" বদলে "Chosen per request" করা হয়েছে, আর info-র লেখাও ঠিক করা হয়েছে। প্রতিটি range row-এর নিজের info key আছে (`segment:3-7`), তাই একটা (i) চাপলে একটাই tip খোলে।
- **API:** `window.__contextTree.setMemory(rid, action)` নতুন। `setEnabled()` রাখা হয়েছে, কিন্তু কিছু বন্ধ করে না।

---

## ৬. ফাইল ধরে ধরে: কী ছিল, কেন বদলাল, কী বদলাল

| ফাইল | আগে | কেন | যা বদলানো হয়েছে |
|---|---|---|---|
| `src/context_tree/memory_checklist.rs` (**নতুন**, ~1100 লাইন) | ছিল না | Memory-কে tree-তে আনার পুরো যুক্তি এক জায়গায় রাখতে | Groups, `records()`, ৫টা table, `sync_versions`, tag scan আর last-mention, `build_picks`, `save_status`, `colour`, `prepare`, `duplicate_calls`, `apply_ops`, `snapshot`, `view` |
| `src/context_tree/memory_checklist_tests.rs` (**নতুন**) | ছিল না | প্রতিটি নিয়মের প্রমাণ | ৮টা test (§৮) |
| `src/turn_memory/select.rs` | শুধু relevance দিয়ে বাছত | Picks, tags আর reasons ঢোকাতে | `Picks`, `select_with`, `apply_picks`, `cand_for`, `predecessors`, `all_ids`, duplicate লাইন বাদ, `Selection.reasons`, `Group::Pinned` section, নতুন "Not shown" লেখা। Line helper-গুলো `pub(crate)` করা হয়েছে |
| `src/agent_loop/memory_loop.rs` | `select()` ডাকত | প্রতিটি request-এ checklist প্রয়োগ করতে | `prepare` → `select_with` → `save_status`। `Injected`-এ `picks` রাখা হয়, যাতে ছোট করে আবার বাছার সময়ও picks মানা হয়। `memory.applied`-এ `checklist` |
| `src/agent_loop.rs` | `memory_inspect` দিত। Tree off হলে কিছু করত না | Tool বাদ দেওয়া, duplicate বাদ দেওয়া | `memory_inspect` আর push হয় না। পুরনো call-এর উত্তর আসে `view` থেকে। `tree_drop_calls`-এ `duplicate_calls` যোগ হয়। মন্তব্যে "ALWAYS ON" |
| `src/context_tree/wiring.rs` | `enabled_on` শুধু `"1"`-এ true দিত | সবসময় চালু রাখতে | `enabled_on` → `true`। `set_enabled` শুধু `1` লেখে। `snapshot`-এ `alwaysOn` আর `memory`। Tests নতুন নিয়মে লেখা |
| `src/context_tree/settings.rs` | default `enabled: false`, patch মানত | সবসময় চালু রাখতে | default `true`। পড়লে বা patch এলে সবসময় `true`। Doc আর tests বদলানো |
| `src/context_tree/dispatch.rs` | `memory` action ছিল না | Model-এর জন্য পড়া আর বাছা | `memory` action। `set`-এ memory op আলাদা করে প্রয়োগ, ফলের সাথে `memory` |
| `src/context_tree/tools.rs` | ৯টা action | Schema | ১০টা action (`memory`), op enum-এ নতুন action |
| `src/context_tree/assemble.rs` | Rules prompt | Model-কে জানাতে | `memory` আর `#tag` নিয়ম। Budget 340 |
| `src/context_tree/store.rs` | Reset শুধু `ctx_*` খালি করত | Memory checklist-ও reset করতে | `memory_checklist::reset_session` |
| `src/context_tree.rs` | Module তালিকা | নতুন module | `pub mod memory_checklist;` |
| `src/lib.rs` | `ctx.set` শুধু tree op নিত | Panel থেকে memory row বাছতে | Memory op routing। Tests: always on, `memory_inspect` আর offer হয় না, overflow test নতুন বাস্তবতায় |
| `tools/agent-html-src/58-context-tree.js` | Off screen, switch, memory row ছিল না | UI | `memoryTree`/`memGroup`/`memRow`, `setMemory`, সবসময় চালু, রং, show more, tags, versions, info ঠিক করা |
| `tools/agent-html-src/58-context-tree.css` | — | রং | `.cc-mem-*`, `.cc-mc-*` |
| `tools/agent-html-tests/context-tree.js` | Switch-এর test | নতুন আচরণ | Always-on test, memory tree test (রং, show more, tick, versions, inactive) |
| `www/agent.html` | Build output | `build.py` দিয়ে আবার তৈরি | — |
| `docs/context-tree/MEMORY-CHECKLIST-PLAN.bn.md` (**নতুন**) | — | এই plan | — |

---

## ৭. ধাপে ধাপে কাজ (Phase) আর acceptance criteria

সব phase বাস্তবায়ন করা হয়েছে। ✓ মানে এই repo-তে করা আর test হয়েছে। ○ মানে বাকি আছে (§৯)।

### Phase 1: সবসময় চালু ✓
- T1.1 `enabled_on` সবসময় true; `set_enabled(false)` উপেক্ষা। ✓
- T1.2 `Settings` default true, patch-এর false উপেক্ষা। ✓
- T1.3 UI-তে off screen আর switch বাদ, "Always on" badge। ✓
- **গ্রহণযোগ্যতা:** নতুন database-এ `ctx` tool offer হয় আর tree block থাকে (`context_tree_is_always_on_and_the_request_is_stable`)। `enabled:false` পাঠালেও panel চালু থাকে (Playwright)।

### Phase 2: Memory record → tree row ✓
- T2.1 `GROUPS` আর `records()`: সব ধরনের record সঠিক group-এ। ✓
- T2.2 Snapshot (`ctx.tree`-এ `memory`)। ✓
- **গ্রহণযোগ্যতা:** `every_record_is_filed_under_its_own_group`।

### Phase 3: Version ✓
- T3.1 `ctx_mem_versions`, `sync_versions` (শুধু বদলালে নতুন version, কখনো overwrite না)। ✓
- T3.2 `all_versions` (আগের লেখা আর `superseded_by` chain)। ✓
- T3.3 `#ID@vN`। ✓
- **গ্রহণযোগ্যতা:** `versions_are_kept_and_never_overwritten`, `all_versions_and_a_version_tag_send_earlier_wordings`।

### Phase 4: #tag ✓
- T4.1 Scan (শুধু user/assistant লেখা; `C#`, entity আর অচেনা tag বাদ)। ✓
- T4.2 শেষ mention জেতে, প্রতি tag একবার। ✓
- T4.3 Inactive, active, remove (নতুন mention-এ ফেরে)। ✓
- **গ্রহণযোগ্যতা:** `the_last_mention_of_a_tag_wins_and_counts_once`, `inactive_and_removed_tags_stop_pulling_their_record`।

### Phase 5: Picks → selection, reason, রং ✓
- T5.1 `select_with`, `apply_picks` (active goal বাদ দেওয়া যায় না)। ✓
- T5.2 `Selection.reasons`, `save_status`, `colour`। ✓
- T5.3 `memory_loop.rs`-এ জোড়া, ছোট করে আবার বাছার সময়ও picks মানা। ✓
- **গ্রহণযোগ্যতা:** `picks_override_relevance_and_every_record_gets_a_reason`। আগের সব `select` test অপরিবর্তিত থেকেও pass করে।

### Phase 6: Files আর duplicate ✓
- T6.1 `duplicate_calls_abs` (শেষটা থাকে, ছোট result বাদ পড়ে না)। ✓
- T6.2 `ctx_mem_files`, Files group-এ path ধরে row। ✓
- T6.3 `agent_loop.rs`-এ `drop_calls`-এ যোগ। ✓
- **গ্রহণযোগ্যতা:** `the_same_file_content_is_sent_once_and_a_change_is_a_new_version`।

### Phase 7: `memory_inspect` বাদ, `ctx memory` ✓
- T7.1 Tool আর offer হয় না; পুরনো call-এর উত্তর আসে `view` থেকে। ✓
- T7.2 `ctx memory` action, `ctx set` memory op, schema, rules prompt। ✓
- **গ্রহণযোগ্যতা:** lib.rs integration test-এ `memory_inspect` offer হয় না, `ctx` আর `recall_turns` হয়। `unknown_ids_and_actions_are_refused_and_reset_clears_everything`।

### Phase 8: UI ✓
- T8.1 Chat memory tree, nested group, row, legend, tags। ✓
- T8.2 রং আর "Show N more"। ✓
- T8.3 Tick বা untick দিলে `ctx.set` `mem/<ID>`; row-এর বোতাম। ✓
- T8.4 Summary-র ভুল তথ্য আর range info key। ✓
- **গ্রহণযোগ্যতা:** Playwright `context-tree.js` 70/70।

### Phase 9: Docs ✓ / Native slice ○
- এই ফাইল। ✓
- iOS/Android native library (`.so`, `.xcframework`) আবার build করা। ○

---

## ৮. Tests: যা চালানো হয়েছে আর ফল

- **Rust:** `cargo test --lib` (native-agent-ffi): **830 passed, 0 failed, 1 ignored**। নতুন ৮টা memory checklist test এর মধ্যে আছে:
  1. `every_record_is_filed_under_its_own_group`
  2. `versions_are_kept_and_never_overwritten`
  3. `the_last_mention_of_a_tag_wins_and_counts_once`
  4. `inactive_and_removed_tags_stop_pulling_their_record`
  5. `picks_override_relevance_and_every_record_gets_a_reason`
  6. `all_versions_and_a_version_tag_send_earlier_wordings`
  7. `the_same_file_content_is_sent_once_and_a_change_is_a_new_version`
  8. `unknown_ids_and_actions_are_refused_and_reset_clears_everything`

  বদলানো test: `the_checklist_is_always_on`, `before_request_returns_nothing_when_the_database_cannot_open`, settings-এর always-on test, `context_tree_is_always_on_and_the_request_is_stable`, `ctx_call_without_enabling_is_answered`, provider overflow test (tree এখন সবসময় চালু, তাই retry কম হতে পারে), memory-action routing test।
- **Build:** `cargo build --lib` কোনো warning ছাড়া হয়।
- **Playwright (headless Chromium):** `context-tree.js` 70/70, `memory.js` 320/320, `render.js` 119/119। `controls.js` এই VM-এ চলে না, তবে কোড বদলানোর আগেও একইভাবে চলত না (environment-এর সমস্যা, এই কাজের নয়)।

---

## ৯. যা বাকি বা যাচাই হয়নি

1. **Native library build:** Android `.so` আর iOS `.xcframework` এই VM-এ build করা যায়নি। App-এ চালানোর আগে repo-র নিজের script দিয়ে native slice আবার build করতে হবে। Rust কোড host-এ compile হয় আর test pass করে।
2. **আসল device-এ end-to-end চালানো হয়নি।** শুধু unit, integration (mock provider) আর Playwright test হয়েছে।
3. **Vitest (`npx vitest run`) চালানো হয়নি।** TypeScript-এ কোনো পরিবর্তন নেই।
4. **পুরনো docs** (`docs/agentic-memory/*`, `docs/context-tree/IMPLEMENTATION-PLAN.md`)-এ এখনো `memory_inspect` আর "default off"-এর কথা আছে। এগুলো ইতিহাস হিসেবে রাখা হয়েছে, আর এই ফাইলটাই এখন নির্ভরযোগ্য উৎস।
5. **Duplicate বাদ দেওয়া** হুবহু একই result-এর ওপর কাজ করে। একটা অক্ষর আলাদা হলেও দুটোই থাকে, আর সেটা ইচ্ছাকৃত।
6. **Composer-এ `#` লিখলে autocomplete** (tag-এর তালিকা দেখানো) এখনো নেই। এটা পরের ছোট কাজ হতে পারে।

---

## ১০. ঝুঁকি আর কীভাবে সামলানো হয়েছে

| ঝুঁকি | ব্যবস্থা |
|---|---|
| সবসময় চালু থাকায় request বদলায় (আগে off থাকলে হুবহু একই থাকত) | Database না খুললে আগের মতো চলে। Golden test এখন স্থিরতা যাচাই করে (একই history, একই tool list) |
| Include বেশি হলে token বাড়ে | Included row essential হয়, তবে token cap আর `reselect_smaller` এখনো কাজ করে। Excluded row জায়গা ছেড়ে দেয় |
| Active goal ভুল করে বাদ দেওয়া | Active goal exclude করা যায় না (test আছে) |
| ভুল tag ধরা (`C#`, `&#39;`, markdown heading) | Regex-এ আগে `\w&#/` থাকলে ধরে না। শুধু চেনা record-এ resolve হয়, অচেনা উপেক্ষা |
| মডেল tool result-এর `#tag` দিয়ে নিজেকে নির্দেশ দেবে | শুধু user আর assistant লেখা scan হয়, tool result আর memory block নয় |
| Version table বড় হয়ে যাওয়া | শুধু লেখা বদলালে নতুন version হয়। Panel-এ newest 8টা দেখায়, সব DB-তে থাকে |
| পুরনো client `memory_inspect` ডাকবে | উত্তর আসে checklist থেকে, error হয় না |
