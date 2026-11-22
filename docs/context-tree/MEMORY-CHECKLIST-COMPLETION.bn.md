# মেমোরি চেকলিস্ট: আগের কাজ যাচাই, বাকি অংশ সম্পূর্ণ করা, আর কীভাবে পরীক্ষা করবেন

এই লেখায় আছে: আগের AI এজেন্টের `0.zip` আর `memory-checklist.patch` (1.txt) আসলে কী করেছিল, কোন কাজগুলো বাকি বা ভুল ছিল, এবার প্রতিটি ফাইলে কী বদলানো হলো আর কেন, এবং নিজে কীভাবে পরীক্ষা করবেন। Repo: `AKIBUZZAMAN-AKIB/my-App2.0`, base commit `7176940` (`main`)। তারিখ: ২২ নভেম্বর ২০২৬।

## ১. মূল লক্ষ্য

মডেলের কাছে context যায় দুইভাবে: দরকার অনুযায়ী (on demand), অথবা ইউজার checklist থেকে বেছে পাঠান। তাই:

1. চ্যাটের সব মেমোরি **checklist tree-র ভেতরে আলাদা আলাদা group-এ** থাকবে: versions, goal history, facts, topic, title, decisions, files, পুরোনো range, replaced/closed decisions।
2. যা বাদ পড়েছে (left out) আর যা "show more"-এর পেছনে আছে, সেগুলো **আলাদা রঙে** দেখাবে।
3. আলাদা memory inspection tool থাকবে না। Checklist **সবসময় চালু** (default on/off নেই), তাই memory tool আর লাগবে না।
4. Files নিজের group, প্রতিটি group **version-ভিত্তিক**, আগের version পড়া যায় এবং context-এ আনা যায়, ফাইল reuse হয়। বারবার memory থেকে recall নয়, সব tree-তে থাকে।
5. কথোপকথনে যেখানে কোনো data ব্যবহার হয়, সেখানে তার নাম `#tag` দিয়ে (version সহ, যেমন `#plan.md@v2`)।
6. একই tag অনেকবার এলে **context যায় শুধু শেষ tag-এর জায়গায়**, একবার। প্রতিটি tag আলাদাভাবে remove বা inactive করা যায়, আর আলাদাভাবে দেখায়।
7. Context reusable, কখনো duplicate নয়।

## ২. `0.zip` আর patch-এ কী ছিল

`0.zip`-এ ১৯টা ফাইল: `memory-checklist.patch` (1.txt-এর সাথে byte-by-byte হুবহু এক), আগের plan (`docs/context-tree/MEMORY-CHECKLIST-PLAN.bn.md`, যেটা আপনার পাঠানো `memory-checklist-plan-v2.bn.md`-এর সাথেও হুবহু এক), আর patch প্রয়োগের পরের ১৭টা কোড ফাইলের কপি। প্রতিটি কপি `7176940`-এ patch apply করার পরের ফাইলের সাথে হুবহু মেলে, তাই zip-এ patch-এর বাইরে নতুন কিছু নেই। Patch-টা ১৮টা ফাইল ছোঁয় (+2545, −257 লাইন), আর `origin/main`-এ এটা এখনো ছিল না।

### ২.১ Patch যা ঠিকভাবে করেছিল (রাখা হয়েছে)

- **Group:** `context_tree/memory_checklist.rs`-এর `GROUPS`-এ: Goals, Closed goals, Goal history, Topics & titles, Decisions in force, Replaced / closed decisions, Facts, Preferences, Replaced / retired, Files, Open tasks, Closed tasks, Ranges, Old ranges, Memory versions। Nested group parent-এর ভেতরে বসে।
- **Record-ভিত্তিক version:** নতুন টেবিল `ctx_mem_versions`; লেখা বদলালে নতুন version, আগেরটা কখনো মোছে না (`sync_versions`)।
- **রঙ:** sent, left out, show more, tag inactive, earlier version sent (`colour()` আর UI-র `MEM_COLOURS`), সাথে "Show N more" paging।
- **সবসময় চালু:** `settings.rs`, `store.rs`, `wiring.rs`-এ `enabled` সবসময় true, পুরোনো database-এর `enabled = 0` উপেক্ষা হয়; UI-তে "Turn on" বোতাম নেই।
- **`memory_inspect` বাদ:** `agent_loop.rs` মডেলকে আর এই tool দেয় না; পুরোনো client ডাকলে checklist-এর `ctx memory` view থেকে উত্তর যায়।
- **`ctx memory` আর `ctx set`:** `dispatch.rs`-এ `mem/D12` বা `#D12`-এ include, exclude, auto, all_versions, latest, inactive, active, remove।
- **`#tag` স্ক্যান:** `scan_mentions`, `record_mentions`; শেষ mention-এর turn আর version রাখা হয়; remove করার পরে পুরোনো mention গোনা হয় না।
- **হুবহু একই tool result বাদ:** `duplicate_calls` দিয়ে request থেকে আগের একই result সরানো হয়।

### ২.২ যা বাকি বা ভুল ছিল

1. **"শেষ tag-এর জায়গায় context" হয়নি।** Patch শুধু dedupe করত: tag করা record memory block-এ (চ্যাটের শুরুতে) একবার যেত, শেষ `#tag`-এর জায়গায় কিছু যেত না।
2. **ফাইলের আগের version-এর লেখা পড়া যেত না।** `ctx_mem_files`-এ শুধু hash ছিল; `#plan.md@v1` বললে শুধু একটা লাইন আসত, পুরোনো content নয়।
3. **একই ফাইল আবার পড়লে মিথ্যা নতুন version হতো,** কারণ version-লাইনে "last read in turn N" আর "N read(s)" লেখা থাকত। এতে reuse ভাঙত।
4. **প্রথম summary-র আগে checklist চলত না।** `memory_loop.rs`-এ `through_turn == 0` হলে আগেই return হতো, তাই নতুন চ্যাটে বাস্তবে "always active" ছিল না।
5. **Tag chip-এ নিজস্ব control ছিল না।** Remove বা inactive শুধু record-এর সারি থেকে করা যেত।
6. **Composer-এ `#` লিখলে tag খোঁজার সুবিধা ছিল না।**
7. **মডেলকে বলা হয়নি** যে ব্যবহার করা data-র নাম `#tag` দিয়ে নিতে হবে, আর `#file@vN` দিয়ে পুরোনো version পড়া যায়।
8. **চ্যাটের message-এর ভেতরে `#tag` আলাদা করে দেখা যেত না।** কোনটা active, কোনটা inactive বা removed, আর কোন mention-এ context যাচ্ছে, তা message-এ বোঝার উপায় ছিল না।
9. ছোট: `turn_memory/ranges.rs`-এর একটা কমেন্টে তখনো `memory_inspect` লেখা ছিল।

এর আগে একটা বাতিল হওয়া run ১ থেকে ৭ আর ৯ নম্বর অংশের কোড লিখেছিল, কিন্তু commit বা push করেনি। এবার সেই কোড লাইন ধরে যাচাই করা হয়েছে, দুটো ত্রুটি পাওয়া গেছে (নিচে ৩.২), সেগুলো ঠিক করা হয়েছে, আর ৮ নম্বর নতুন করে করা হয়েছে।

## ৩. প্রতিটি ফাইলে কী বদলানো হলো, আর কেন

সব Rust ফাইল `plugins/native-agent/rust/native-agent-ffi/src/`-এর ভেতরে।

### ৩.১ `context_tree/memory_checklist.rs`: শেষ `#tag`-এ context (anchor)

- নতুন `struct Anchor { rid, tag, version, turn, text, names }`। প্রতি record-এ একটাই anchor।
- `anchors()`: প্রতিটি **active** tag-এর শেষ mention যদি এখনো view-তে থাকা কোনো turn-এ পড়ে (summary-র পরের turn), তাহলে ওই record-এর জন্য anchor হয়। বাদ যায়: inactive বা removed tag, হাতে tick দেওয়া বা "all versions" record (এগুলো block-এ পুরোপুরি যায়), আর active goal (block সবসময় এটা রাখে)। `#D6@v1`-এর মতো পুরোনো version বললে anchor-এ সেই version-এর লেখা যায়, সাথে নতুনটা কোন version তাও লেখা থাকে।
- `place_anchors()`: anchor-এর লেখা যোগ হয় **শুধু সেই turn-এর শেষ user/assistant message-এ, যেখানে tag-টা আছে**। শুধু request-এর view বদলায়; সংরক্ষিত transcript বদলায় না। আগের mention-গুলো শুধু reference থাকে।
- `prepare_anchored()` (`prepare` এটাকেই ডাকে) records, picks আর anchors একসাথে দেয়; `build_picks_with()` anchor পাওয়া record-কে `Picks::inline`-এ রাখে, তাই block-এ আর যায় না। **একই context দুবার যায় না।**
- `save_status`: এমন record-এর কারণ `inline`, রঙ "sent"।

### ৩.২ `context_tree/memory_checklist.rs`: আগের run-এর দুটো ত্রুটি ঠিক করা (এবার)

- **ভুল message-এ anchor:** আগে message খোঁজা হতো `text.contains("#d1")` দিয়ে, ফলে `#d12` লেখা message-ও `#d1`-এর জায়গা হিসেবে ধরা পড়ত। এখন নতুন `names_tag()` একই tag regex দিয়ে পুরো tag মেলায় (tag, ID, `mem/<ID>`, alias), আর `anchor_slot()` সেই message বের করে।
- **Context হারিয়ে যাওয়ার ঝুঁকি:** আগে anchor তৈরি হলেই record block থেকে বাদ পড়ত, message পাওয়া না গেলেও। তাহলে record কোথাও যেত না। এখন `prepare_anchored` শুধু সেই anchor রাখে যার জন্য message আছে; না থাকলে record আগের মতো block দিয়ে যায়।

### ৩.৩ `context_tree/memory_checklist.rs`: ফাইলের প্রতিটি version পড়া যায়, মিথ্যা version বন্ধ

- `FileRead`-এ নতুন `tool_use_id`: যে tool call ফাইলটা পড়েছিল তার ID। ওই result আগে থেকেই `tool_results` টেবিলে একবার রাখা থাকে, তাই দ্বিতীয় কপি রাখা হয় না (reuse)।
- `ensure_tables`: পুরোনো `ctx_mem_files`-এ `tool_use_id` না থাকলে `ALTER TABLE` দিয়ে যোগ হয়; বারবার চালালেও নিরাপদ।
- `file_version()`: version-এর লাইন থেকে hash নিয়ে, সেই hash-এর সবচেয়ে নতুন read খুঁজে, `turn_memory::load_result` থেকে content আনে, আর hash মিলিয়ে দেখে যাতে ভুল content না আসে।
- `file_anchor_text()`: ওই version-এর read এখনো view-তে থাকলে শুধু pointer যায় ("content is the file read of turn N above"), লেখা আবার যায় না। View থেকে চলে গেলে content নিজেই যায়, সর্বোচ্চ ৬০০০ অক্ষর (`INLINE_FILE_CHARS`); বাকিটা `ctx memory id=#plan.md@v1` দিয়ে পড়া যায়। Content আর না থাকলে সেটা পরিষ্কার বলা হয়।
- `view()` (`ctx memory`) এখন `id=#plan.md@v2` বোঝে আর সেই version-এর পুরো content দেখায়।
- ফাইলের version-লাইন এখন শুধু `- File <path> (content <hash>, <chars> chars)`। Read-এর সংখ্যা আর শেষ turn `status`-এ গেছে। ফলে **content বদলালেই কেবল নতুন version**।

### ৩.৪ `turn_memory/select.rs`

- `Picks`-এ নতুন `inline: BTreeSet<String>`; `apply_picks` এগুলোকে block আর include তালিকা থেকে বাদ দেয় (active goal ছাড়া); কারণ লেখা হয় `"inline"`; `Picks::is_empty`-তে `inline` যোগ।

### ৩.৫ `agent_loop/memory_loop.rs`

- `prepare` থেকে `prepare_anchored`-এ বদল; "view-তে আছে" মানে `turn > mem.through_turn`; তারপর `place_anchors`; `memory.applied` event-এর `checklist` অংশে `anchored` তালিকা (rid, tag, turn, version)।
- নতুন `checklist_only()`: চ্যাটে কোনো summary বা goal না থাকলেও checklist চলে: ফাইল আর version track হয়, tag রেকর্ড হয়, status সেভ হয়, শেষ tag-এ anchor বসে। **এখন checklist আসলেই সবসময় চালু।**

### ৩.৬ `context_tree/assemble.rs`

- মডেলের নিয়মে যোগ: "The last #tag of a record decides what is sent; its context goes there once (id=#plan.md@v1 reads a file version). Name stored data you use by its #tag." Token বাজেট টেস্টের সীমার ভেতরে।

### ৩.৭ `turn_memory/ranges.rs`

- কমেন্টে `memory_inspect`-এর জায়গায় `ctx memory`।

### ৩.৮ UI: `tools/agent-html-src/58-context-tree.js` আর `.css`, যা `build.py` দিয়ে `www/agent.html`-এ বসে

- **Tag chip-এ নিজস্ব control (`tagChip`)**: active tag-এ ⏸ (inactive) আর × (remove); inactive বা removed tag-এ ↺ (আবার active)। সব `ctx.set` দিয়ে `mem/<rid>` পাঠায়। Inactive আর removed আলাদা রঙ ও দাগে।
- **Composer-এ `#` autocomplete**: `#` লিখলে checklist-এর tag-এর তালিকা আসে (group আর শিরোনামসহ); বেছে নিলে tag বসে যায়; Esc বা focus সরালে বন্ধ।
- **চ্যাটের message-এ `#tag` (এবার নতুন, `decorateChatTags`)**: রেন্ডার হওয়া message-এ (`.aui-md`) চেনা tag খুঁজে আলাদা করে দেখায়।
  - রঙ checklist-এর অবস্থা অনুযায়ী: active সবুজ, inactive হলুদ-বাদামি ও কাটা দাগ, removed ধূসর ও অস্পষ্ট, tag করা হয়নি এমন record ধূসর।
  - একটা record-এর **শেষ active mention** গাঢ় (নিচে দাগ), কারণ context শুধু সেখানেই যায়; আগের mention-গুলো শুধু outline, অর্থাৎ reference।
  - Version tag (`#plan.md@v1`) version সহ থাকে।
  - Tag-এ tap (বা Enter) করলে active থেকে inactive, inactive বা removed থেকে আবার active হয়, panel-এর মতোই `ctx.set` দিয়ে।
  - `code`, `pre`, link, `C#`, `&#39;` আর অচেনা tag ছোঁয়া হয় না; লেখা শুধু text হিসেবে বসে (কোনো HTML ঢোকে না); দুবার চালালেও দুবার wrap হয় না।
  - Streaming-এর সময় নতুন message এলে `MutationObserver` আবার চালায় (১২০ ms debounce)।
- `install`-এর doc comment ভুল জায়গায় সরে গিয়েছিল, সেটা ঠিক জায়গায় ফেরানো হয়েছে।

### ৩.৯ টেস্ট

- `context_tree/memory_checklist_tests.rs`: আগের run-এর ৫টা টেস্ট (শেষ mention-এ context, summary হয়ে যাওয়া tag block দিয়ে যায়, inactive/removed/হাতে বাছা record-এ anchor নেই, ফাইল আবার পড়লে version নয় আর সব version পড়া যায়, পুরোনো টেবিলের migration), আর এবার নতুন `an_anchor_goes_to_a_whole_tag_never_to_a_longer_one` (`#d1` বনাম `#d12`, message না থাকলে slot নেই, `#mem/D1` চেনা)।
- `tools/agent-html-tests/context-tree.js`: আগের ৩টা চেক (chip-এর বোতাম, chip থেকে engine-এ অনুরোধ, `#` autocomplete), আর এবার message-এর tag নিয়ে ৭টা নতুন চেক।

## ৪. পুরো প্রবাহ এখন কেমন

1. প্রতিটি request-এ `memory_loop::apply` চলে। নতুন চ্যাটে `checklist_only`, নাহলে পুরো পথ।
2. `prepare_anchored`: memory, goal আর file read থেকে records বানায়, version sync করে, চ্যাট থেকে `#tag` স্ক্যান করে, anchors বের করে (যাদের message আছে শুধু তারা), picks বানায়।
3. Memory block-এ যায়: active goal, হাতে tick দেওয়া record, আর যেসব tag-এর শেষ mention summary-তে ঢুকে গেছে। Anchor পাওয়া record block-এ যায় না।
4. `place_anchors` প্রতিটি record-এর context বসায় তার শেষ tag-এর message-এর শেষে, একবার।
5. হুবহু একই tool result শুধু শেষবারের জায়গায় থাকে।
6. UI-তে সব group, রঙ, version, tag chip, `#` autocomplete, আর message-এর ভেতরে রঙিন tag দেখা যায়।

## ৫. কীভাবে পরীক্ষা করবেন

Rust (host-এ):

```bash
cd plugins/native-agent/rust/native-agent-ffi
cargo build --lib
cargo test --lib
cargo test --lib memory_checklist
```

UI (headless Chromium লাগে; `playwright-core` না থাকলে `npm i --prefix tools/agent-html-tests playwright-core` আর `npx playwright-core install chromium-headless-shell`):

```bash
python3 tools/agent-html-src/build.py
cd tools/agent-html-tests
node context-tree.js
node memory.js
node render.js
```

হাতে পরীক্ষা (app-এ):

1. নতুন চ্যাটে একটা ফাইল পড়ান, তারপর context sheet খুলুন: Chat memory-র Files group-এ ফাইলটা থাকবে (প্রথম summary-র আগেই)।
2. একই ফাইল আবার পড়ান: version সংখ্যা বাড়বে না। ফাইল বদলে আবার পড়ান: v2 হবে।
3. চ্যাটে `#plan.md@v1` লিখুন: পুরোনো version-এর context যাবে; message-এ tag-টা গাঢ় সবুজ দেখাবে।
4. একই tag তিনবার লিখুন: শুধু শেষটা গাঢ় (context সেখানে), আগেরগুলো outline।
5. Message-এর tag-এ tap করুন: হলুদ-বাদামি ও কাটা দাগ (inactive)। Panel-এর chip থেকে × দিলে removed।
6. `memory.applied` event-এর `checklist.anchored`-এ দেখুন কোন tag কোন turn-এ বসেছে।

এই মেশিনে চালানো ফলাফল:

- `cargo build --lib`: কোনো warning বা error নেই।
- `cargo test --lib`: **836 passed, 0 failed** (1 ignored)।
- `context-tree.js`: **80/80 passed**।
- `memory.js`: **320/320 passed**।
- `render.js`: **119/119 passed** (একবার একটা streaming layout-jump চেক ব্যর্থ হয়েছিল, পরের দুইবার পাস; চেকটা এই কাজের কোড ছোঁয় না, তাই এটা flaky বলে ধরা হয়েছে)।
- `no-null-text.js`: **16/16 passed**।

## ৬. সীমা আর যা যাচাই হয়নি

- **Native library:** Android `.so` আর iOS `.xcframework` এই মেশিনে build হয়নি। App-এ চালানোর আগে repo-র নিজের script দিয়ে FFI slice আবার build করতে হবে।
- **আসল device-এ end-to-end চালানো হয়নি;** শুধু unit, integration (mock provider) আর Playwright টেস্ট।
- **Vitest চালানো হয়নি;** TypeScript-এ পরিবর্তন নেই।
- **Prompt cache:** anchor শেষ tag-এর message-এ বসে; tag পরের turn-এ সরলে ওই অংশের cache ভাঙে। প্রতি turn-এ শুরুর memory block বদলানোর চেয়ে এটা কম ক্ষতিকর।
- **পুরোনো ফাইল content:** `tool_results`-এ result থাকলেই পড়া যায়; ছোট বা মুছে ফেলা result হলে পরিষ্কার বলা হয় "read the file again"। আগের build-এর file row-তে `tool_use_id` খালি থাকে; ফাইল আবার পড়লে ঠিক হয়।
- **Message-এর tag-এর রঙ** নির্ভর করে panel-এর শেষ memory snapshot-এর ওপর; snapshot না আসা পর্যন্ত tag সাধারণ লেখা থাকে।
- পুরোনো docs (`docs/agentic-memory/*`, `docs/context-tree/IMPLEMENTATION-PLAN.md`)-এ এখনো `memory_inspect` আর "default off"-এর কথা আছে; সেগুলো ইতিহাস হিসেবে রাখা, এই ফাইল আর `MEMORY-CHECKLIST-PLAN.bn.md` এখন নির্ভরযোগ্য উৎস।
