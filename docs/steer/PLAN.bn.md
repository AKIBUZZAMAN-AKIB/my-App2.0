# Concept 3 implementation plan: কাজ চলার মধ্যেই কথা বলা

লক্ষ্য: agent কাজ করার সময়ও user মেসেজ দিতে পারবে। নতুন তথ্য চলমান কাজে ঢুকে যাবে, কাজ থামাতে হবে না বা শেষ হওয়া পর্যন্ত অপেক্ষা করতে হবে না। Repo: `AKIBUZZAMAN-AKIB/my-App2.0`, branch `ui0`, base commit `7571558`।

## এখনকার অবস্থা (সংক্ষেপে)

- **UI:** main chat চলার সময় message queue-তে বসে থাকে (`agent.html`)। "Send now" চাপলে আগে run বন্ধ হয়, তারপর পাঠানো হয়।
- **Engine:** `steer` আগে থেকেই আছে (`lib.rs` L486), কিন্তু main chat এটা ব্যবহার করে না।
- **Steer পড়া হয় শুধু loop-এর শুরুতে** (`agent_loop.rs` L669–681)। লম্বা tool চললে message ততক্ষণ বসে থাকে।
- **শেষ step-এ steer হারায়:** main agent-এ ভুল turn-এ চলে যায়, sub-agent-এ drop হয় (`agent_loop.rs` L1899, `subagents.rs` L2140)।
- **Steer শুধু কাঁচা লেখা:** goal, plan (`ctx_strategy`) বা checklist কিছু বদলায় না।
- **Steer-এর গায়ে কোনো id বা চিহ্ন নেই,** তাই turn counting অনুমানের ওপর চলে।
- **Live snapshot নেই:** চলমান turn-এর messages শুধু RAM-এ থাকে, অন্য কেউ দেখতে পায় না।

## যা ঠিক হয়েছে (user-এর সিদ্ধান্ত)

### UI

- **Default আগের মতোই:** কাজ চলার সময় Enter চাপলে message queue-তে যাবে, waiting দেখাবে।
- **পাশে দুটো symbol button:** **Steer** (কাজ না থামিয়ে চলমান কাজে তথ্য ঢোকাবে) আর **Update**।
- **Steer message transcript-এ থাকবে,** steer হিসেবে আলাদা করে চেনা যাবে।

### Steer process

- **আলাদা process মানে একই handle-এর ভেতরে একটা tokio task,** OS process না। Memory আর DB share হবে, কোনো copy তৈরি হবে না। iOS/Android-এও চলবে।
- **Model:** main agent বা sub-agent যেখান থেকে steer তৈরি হচ্ছে, সেখানকার configuration-এর model-ই ব্যবহার হবে।
- **Memory:** steer process আগের memory (turn memory, session) আর main agent এখন কী করছে তা পড়তে পারবে।
- **Context আর task data:** নতুন তথ্য অনুযায়ী steer process task, context আর checklist বদলাতে পারবে।
- **Steer চলার মধ্যে আবার steer দিলে:** নতুন process খুলবে না, message আগের steer process-এই যাবে। যতটুকু কাজ হয়েছে সেখানে থামবে আর save হবে, তারপর আগের কাজ আর নতুন steer একসাথে নিয়ে আবার request যাবে।

### Steer checklist

- **প্রতিটা steer-এর নিজের checklist থাকবে,** তাতে শুধু ওই steer-এর কাজগুলো।
- **Default-এ active।**
- **Context window ভরে গেলে** steer process main agent-এর মতোই নিজে context management করবে।

### File আর permission

- **Permission system:** "সবসময় edit করতে দাও" অথবা "প্রতিবার জিজ্ঞেস করো"।
- **প্রতিটা file বদল git tool দিয়ে হবে,** যাতে version থাকে আর আগের অবস্থায় ফেরা যায়।

### v1-এর scope

- **v1-এ থাকবে:** sub-agent auto-routing। Steer চলমান sub-agent-এর জন্য হলে interpreter নিজেই ঠিক করবে কোন sub-agent-এ পাঠাতে হবে (`subagents.message` দিয়ে)।
- **v1-এ থাকবে:** steer process-এর ভেতরের থামানো, save আর নতুন steer নিয়ে আবার পাঠানো।
- **পরে আসবে:** পুরো engine-এর সাথে সাথে interrupt (model লেখার মাঝে stream কাটা, প্রতিটা tool-এর আলাদা cancel token)। কারণ এটা কঠিন, turn counting-এ নতুন bug আনতে পারে, আর v1-এ লাভ তুলনায় কম।

## Architecture

মূল নিয়ম দুটো:

1. user-এর হুবহু লেখা সবসময় পরের নিরাপদ জায়গায় model-এ পৌঁছাবে, interpreter ধীর হলেও বা fail করলেও।
2. Steer process পড়ে আর patch প্রস্তাব করে, কিন্তু লেখে একমাত্র main loop (single writer)।

### প্রবাহ

1. UI-তে Steer button চাপলে `steer(SteerEnvelope{id, text, attachments, at, target})` যাবে।
2. Engine `steer.accepted{id}` event পাঠাবে আর message `steer_inbox`-এ রাখবে।
3. Turn চলমান থাকলে handle একটা `SteerInterpreter` tokio task চালাবে, অথবা আগে থেকে চলমান steer process-এ message পাঠাবে।
4. Interpreter `SteerPatch` বানিয়ে patch queue-তে দেবে।
5. Main loop নিরাপদ জায়গায় (safe point) patch apply করে `steer.applied{id, step}` পাঠাবে।

### Read-only snapshot

- Loop প্রতি step-এ `tokio::sync::watch`-এ নিজের অবস্থা প্রকাশ করবে: `AgentSnapshot{turn_id, step, phase, goal, plan, temp_checklist, recent_tools, files_touched, ctx_rev}`।
- Reader সর্বশেষ clone পাবে, main loop কখনো আটকাবে না।

### SteerPatch

- **Fast path, model ছাড়া:** "stop/থামো" হলে Cancel। খুব ছোট তথ্য হলে AddInfo, শুধু হুবহু লেখাটা যাবে।
- **নাহলে একটা model call** (ওই agent-এর configured model দিয়ে), structured JSON চেয়ে: `intent: AddInfo|Amend|Redirect|Cancel|NewTask|Question`, `goal_edit`, `plan_edit`, `ctx_ops`, `checklist_ops`, `target_agent`, `agent_note`।
- **প্রতিটা patch-এ** `base{step, ctx_rev, strategy_version}` থাকবে, conflict ধরার জন্য।

### Safe point (সব `agent_loop.rs`-এ)

- **SP1:** loop-এর শুরু (এখনই আছে)।
- **SP2:** sequential tool call-গুলোর মাঝে (L2085)।
- **SP3:** `break`-এর আগে। Steer অপেক্ষায় থাকলে loop শেষ না করে `continue`।
- **SP4:** approval-এর অপেক্ষার সময়।

Apply করলে যা হবে: হুবহু লেখাটা `Message::user` হিসেবে `origin: Steer{id}` চিহ্নসহ যাবে। `TaskGoal`-এ revision যোগ হবে, `ctx_strategy`-এর নতুন version তৈরি হবে, আর checklist/ctx ops যাবে actor `steer` হিসেবে। DB-র সব write একটা `BEGIN IMMEDIATE`-এর ভেতরে, `expect_rev`-সহ।

### Conflict

- সর্বশেষ user-এর কথা জিতবে।
- `ctx_rev` stale হলে ops নতুন tree-র ওপর আবার মেলানো হবে। না মিললে শুধু হুবহু লেখা আর note যাবে।
- Plan-এর যে step আগেই শেষ, সেটা মুছবে না। সেটাকে "superseded" চিহ্ন দেওয়া হবে, আর note-এ লেখা থাকবে কী কী বানানো হয়ে গেছে।

## Edge case

- **"থামো":** Cancel, এখনকার abort।
- **"এটাও যোগ করো":** Amend, একই turn।
- **সম্পর্কহীন নতুন কাজ:** NewTask, queue-তে যাবে।
- **প্রশ্ন ("কতদূর হলো?"):** steer process snapshot দেখে উত্তর দেবে, main loop-কে ছোঁবে না।
- **Sub-agent চলছে:** patch `subagents.message` দিয়ে ওই sub-agent-এ যাবে। Run শেষে বেঁচে যাওয়া steer drop না হয়ে FollowUp হবে।
- **Redirect-এ আগে বানানো file:** permission অনুযায়ী agent নিজে বদলাবে বা জিজ্ঞেস করবে, সব বদল git commit হিসেবে থাকবে।
- **`ucl/*` user checklist:** steer process শুধু পড়তে পারবে, মুছতে পারবে না (locked rule)।
- **App বন্ধ হয়ে গেল:** `steer_inbox`-এ যা apply হয়নি, পরেরবার user-কে দেখানো হবে।
- **Turn counting:** steer চলমান turn-এর অংশ, নতুন turn না (390e531 আর 50357da-এর নিয়ম)। `origin: Steer` চিহ্ন থাকায় আর অনুমান করতে হবে না।

## ধাপে ধাপে কাজ

### ধাপ ০: UI

- `agent.html`: composer-এর পাশে Steer আর Update symbol button। Default Enter আগের মতোই queue।
- Steer button চাপলে `NK.agent.steer`-এ যাবে। Bubble-এ "pending" দেখাবে, apply হলে "applied"।
- Transcript-এ steer message আলাদা style-এ।
- `tools/agent-html-tests`-এ main chat-এর steer button-এর test।

### ধাপ ১: Engine-এ delivery ঠিক করা

- `lib.rs`, `types.rs`: `SteerEnvelope`, `steer.accepted` আর `steer.applied` event।
- `agent_loop.rs`: SP2, SP3, SP4 যোগ করা, যাতে steer হারায় না বা ভুল turn-এ না যায়।
- `subagents.rs`: run শেষে channel-এ পড়ে থাকা steer drain করে FollowUp বানানো।
- `turn_memory.rs`: `origin: Steer` চিহ্ন দিয়ে turn split।

### ধাপ ২: Steer process আর snapshot

- নতুন `steer.rs`: `SteerInterpreter` tokio task, `SteerPatch`, patch queue।
- `agent_loop.rs`: `AgentSnapshot` watch channel।
- একই steer process-এ নতুন steer এলে: চলমান কাজ থামানো, save, নতুন steer সহ আবার request।
- Model: ওই agent-এর configuration থেকে।

### ধাপ ৩: Steer checklist আর context

- প্রতিটা steer-এর নিজের checklist, default active।
- Steer process-এর নিজের context management (window ভরলে)।
- `context_policy`: `TaskGoal`-এ revision, text দিয়ে dedupe না করে id দিয়ে।
- ctx instructions-এ মাত্র ১ token জায়গা বাকি, তাই নতুন লেখা task block-এ (`render_task_block`) যাবে। ctx tool definition ছোঁয়া যাবে না (২,০৬৩ / ২,০৬৭ অক্ষর)।

### ধাপ ৪: Permission আর git

- Steer থেকে file বদলের permission: always allow / ask।
- প্রতিটা বদল git commit হিসেবে, যাতে retrieve আর revert করা যায়।

### ধাপ ৫: Sub-agent auto-routing

- Interpreter `target_agent` ঠিক করবে, `subagents.message` দিয়ে পাঠাবে।

### পরে (v2)

- Model লেখার মাঝে stream কেটে নতুন request।
- প্রতিটা tool-এর নিজস্ব cancel token, যাতে turn না থামিয়ে একটা command থামানো যায়।

## যাচাই

- প্রতিটা ধাপের পরে `cargo test` পুরো pass থাকতে হবে (এখন ৯২৮ pass, ০ fail)।
- Context tree-র আকারের test দুটো (`the_instructions_name_every_action_and_the_locked_rule`, `seven_times_cheaper_than_the_eight_tool_design`) যেন আবার fail না করে।
- নতুন test: steer হারায় না, শেষ step-এ steer ঠিক turn-এ যায়, sub-agent-এ বেঁচে যাওয়া steer FollowUp হয়, দ্বিতীয় steer আগের steer process-এ যায়।
