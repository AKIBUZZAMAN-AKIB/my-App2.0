# Context Tree — ARCHITECTURE

> temp.md-এর §5–§10 আর §13 অনুযায়ী লেখা। কোড: `plugins/native-agent/rust/native-agent-ffi/src/context_tree/`।
> ভাষা: বাংলা, টেকনিক্যাল নাম ইংরেজিতে।

## ১. মূল ধারণা

কথোপকথনের প্রতিটা অংশ (টার্ন, tool result, ফাইল, note, summary, sub-agent-এর report) একটা **item**। প্রতিটা item-এর একটা **state** থাকে:

| state | মানে |
|---|---|
| `in` | পুরো লেখা request-এ যায় |
| `note` | item-এর জায়গায় তার সাথে লাগানো ছোট note যায় |
| `temp` | item-এর জায়গায় একটা summary যায় (summary নিজেও item: `temp/…`) |
| `out` | কিছুই যায় না, কিন্তু জমা থাকে; `ctx recall` দিয়ে ফেরত আনা যায় |

AI নিজেই `ctx` tool দিয়ে state বদলায়। engine শুধু নিয়ম আর বাজেট মানায়। কিছু বাদ দেওয়া মানে মুছে ফেলা নয়।

## ২. ফাইল আর দায়িত্ব

| ফাইল | কাজ |
|---|---|
| `model.rs` | `NodeKind`, `ItemState`, `Pin`, engine-এর marker (`CHECKLIST_MARKER`, `RESUME_MARKER`) |
| `store.rs` | SQLite টেবিল (`ctx_*`), CRUD, quota, GC, rewind/reset |
| `budget.rs` | বাজেটের হিসাব: window − reserve_out − headroom − locked |
| `select.rs` / `reading.rs` / `assemble.rs` | কোন item কোন রূপে request-এ যাবে তা ঠিক করা, request জোড়া লাগানো |
| `render.rs` | প্রতি request-এ যাওয়া checklist আর model-কে দেওয়া উত্তরের লেখা |
| `catalog.rs` | system prompt-এর অংশগুলো (`ctx prompt` দিয়ে load/unload) |
| `ops.rs` | state বদলের নিয়ম (lock, pin, note লাগবে কিনা, বাজেট পেরোবে কিনা) |
| `dispatch.rs` | `ctx` tool-এর প্রতিটা action, secret redaction |
| `tools.rs` | model-কে দেওয়া `ctx` tool-এর schema |
| `settings.rs` | settings (চালু/বন্ধ, strategy, sub-agent lifetime-এর default) |
| `wiring.rs` | agent loop-এর সাথে জোড়া: turn ingest, request তৈরি, call-এর সীমা, GC, mirror |
| `mirror.rs` | `.context/` mirror ফাইল (§৭ নিচে) |

Sub-agent lifetime আছে `src/subagents/lifetime.rs`-এ (§৬ নিচে)।

## ৩. একটা টার্নের পথ

1. **Ingest:** নতুন টার্ন আর tool result `ctx_nodes`-এ item হিসেবে যায় (`turn/tN`, `tool/…`)।
2. **Budget:** model-এর window থেকে reserve_out, headroom আর locked অংশ (system prompt, tool schema, checklist, শেষ টার্ন — যা সবসময় যায়) বাদ দিয়ে selectable বাজেট বের হয়।
3. **Selection:** pin করা আর `in` item আগে, তারপর `note`/`temp`; বাজেট পেরোলে compact stage-এ যায়। `out` টার্ন request থেকে সত্যিই বাদ যায়।
4. **Checklist:** request-এর মাথায় engine-এর marker দিয়ে একটা checklist যায়; note-এর লেখা থেকে এই marker সরিয়ে দেওয়া হয়, তাই কোনো note checklist সাজতে পারে না।
5. **Model-এর `ctx` call:** প্রতি ধাপে সর্বোচ্চ ৪টা, প্রতি টার্নে ২৪টা; একই ধাপে হুবহু একই call আগের উত্তর পায়।
6. **Audit:** প্রতিটা request-এর রেকর্ডে tree revision, বাদ পড়া item, বাদ পড়া টার্ন আর token-এর হিসাব থাকে।
7. **GC:** প্রতি ৫০ টার্নে একবার quota মানায় (`nodes` 4,000, note 512 KiB, temp summary 1 MiB), মুছে ফেলা রেকর্ড পরিষ্কার করে, লগ সর্বোচ্চ ২০,০০০ লাইনে রাখে।

## ৪. Rewind আর reset

- **Rewind** (`memory.revert` / chat rewind): `forget_turns_after` রাখা টার্নের পরের সব টার্ন, তাদের সিদ্ধান্ত আর note মুছে দেয়, তাই একই নম্বরের নতুন টার্ন পরিষ্কার শুরু হয়।
- **Reset** (`ctx.reset`, panel-এর "Reset tree" বোতাম): একটা চ্যাটের সব item, note, summary, strategy আর লগ মুছে দেয়; settings থাকে। সেই চ্যাটের `.context/` mirror ফোল্ডারও মুছে যায়।

## ৫. ডেটার মালিকানা

সব ডেটা memory database-এ (`ctx_*` টেবিল, schema 7; settings `ctx_meta`-তে)। ডেটাবেসই একমাত্র সত্য। `.context/` mirror শুধু পড়ার জন্য, কখনো ফেরত পড়া হয় না। বিস্তারিত: `MIGRATION-v7.md`।

## ৬. Sub-agent lifetime (temp.md stage 7)

`spawn_subagent`-এ নতুন তিনটা argument:

| argument | মান | কাজ |
|---|---|---|
| `lifetime` | `reusable` (default) | আগের মতোই: user মুছে না দেওয়া পর্যন্ত থাকে |
| | `temp` | report parent-এর কাছে পৌঁছানোর পর `temp_keep_secs` (default 0) পেরোলেই মুছে যায় |
| | `standby` | কাজ না করে `ttl_secs` (default: setting-এর `standby_ttl_secs`, ২৪ ঘণ্টা; ৩০০ সেকেন্ড থেকে ৩০ দিন) পেরোলে মুছে যায়; প্রতিবার reuse-এ ঘড়ি নতুন করে শুরু হয় |
| `ttl_secs` | পূর্ণসংখ্যা | শুধু standby-এর জন্য |
| `render_in_chat` | bool | চূড়ান্ত উত্তর chat-এ আলাদা message হিসেবে দেখায়; parent পুরো লেখার বদলে একটা note (`in`) পায় |

নিয়ম:

- কোন report parent পায়নি (background run, কেউ wait করেনি) এমন temp agent standby TTL পর্যন্ত থাকে, যাতে উত্তর হারায় না।
- temp agent মোছার আগে তার report parent-এর tree-তে একটা `out` note হিসেবে রাখা হয়: "Report from sub-agent …"। তাই `ctx recall` দিয়ে পরে পাওয়া যায়।
- মোছা মানে agent-এর chat, log, record আর (অন্য কোনো agent একই নাম না নিলে) তার private memory। Agent-এর বানানো ফাইল user-এর কাজ, সেগুলো থাকে।
- sweep চলে: run শেষ হলে (`max_kept` prune-এর আগে, temp.md §10 অনুযায়ী), report পৌঁছালে, প্রতিটা sub-agent tool call-এ, আর app-এর তালিকা আনার সময়। প্রতিটা মোছার জন্য `subagent.deleted` event যায় (`reason`: `temp_done` বা `standby_expired`)।
- চলমান বা approval-এর অপেক্ষায় থাকা agent কখনো মোছা হয় না। আগের সব record `reusable` থাকে।
- `ctx summarize`-এর জন্য বানানো child এখন `lifetime: temp` নিয়ে তৈরি হয়, তাই engine নিজেই সেটা মুছে দেয়।
- Settings সেভ হলেই নতুন lifetime মান পরের sweep থেকে কাজ করে।

## ৭. `.context/` mirror (temp.md §6.5)

```text
<workspace>/.context/<session-slug>/SESSION        কোন session-এর ফোল্ডার
<workspace>/.context/<session-slug>/strategy.md    সর্বশেষ strategy আর পরের ধাপ
<workspace>/.context/<session-slug>/notes/<id>.md  প্রতিটা জীবিত note-এর জন্য একটা ফাইল
```

- `ctx note`, `ctx strategy`, `ctx set` আর `ctx category` সফল হলে সেই session-এর mirror আপডেট হয়; app চালু হলে সব mirror ডেটাবেস থেকে আবার বানানো হয়।
- লেখা হয় atomic ভাবে (temp ফাইল, তারপর rename), আর শুধু লেখা বদলালে।
- কেউ ফাইল বদলালে, যোগ করলে বা মুছলে পরের sync-এ ডেটাবেসের মতো করে ফেরত আসে; `notes/`-এ বাড়তি ফাইল মুছে যায়।
- mirror-এ লেখার আগে secret redact আর engine marker সরানো হয়।
- শুধু `SESSION` ফাইল আছে এমন ফোল্ডারই কখনো মোছা হয়।
- mirror লিখতে না পারলে কোনো টার্ন বা `ctx` call fail হয় না।

## ৮. UI

`tools/agent-html-src/58-context-tree.js` panel দেখায়: বাজেট, item-এর তালিকা, কেন কী বাদ গেল, "Turn off" আর এখন **"Reset tree"** বোতাম (confirm চায়, তারপর `ctx.reset`)। `10-subagents.js` render_in_chat উত্তরকে sub-agent card-এর ভেতরে "Answer from <name>" message হিসেবে দেখায়, আর `subagent.deleted` এলে agent-কে তালিকা থেকে সরায়। Build: `npm run build` (`tools/agent-html-src/build.py` → `www/agent.html`)।
