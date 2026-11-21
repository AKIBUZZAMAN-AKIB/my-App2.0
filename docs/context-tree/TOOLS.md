# Context Tree — TOOLS

> temp.md §7 অনুযায়ী `ctx` tool আর app-এর action-এর তালিকা। Schema: `context_tree/tools.rs`, কাজ: `context_tree/dispatch.rs`।

## ১. Model-এর `ctx` tool

একটাই tool, `action` দিয়ে কাজ ঠিক হয়। temp.md-এর আটটা আলাদা নাম (`ctx_view`, `ctx_set`, …) এখনো চেনা হয় এবং `ctx`-এর action-এ যায়।

| action | কী করে | মূল argument |
|---|---|---|
| `view` | বাজেট (locked token-এর আসল হিসাবসহ) আর item-এর তালিকা; `since_rev` দিলে শুধু তার পরের বদল | `path`, `since_rev` |
| `set` | একসাথে কয়েকটা বদল: `include`, `exclude`, `note_only`, `pin`, `unpin`, `move`, `tag` (সর্বোচ্চ ১২টা op) | `ops`, `expect_rev`, `dry_run` |
| `category` | নিজের category (`cat/…`) তৈরি, নাম বদল বা মোছা | `id`, `title`, `delete_contents` |
| `summarize` | কয়েকটা item-এর summary (`temp/…`) বানায়; `via_subagent` দিলে একটা temp sub-agent দিয়ে | `ids`, `focus`, `max_tokens`, `via_subagent` |
| `recall` | `out` item-এর লেখা ফেরত পড়ে (দরকারে workspace-এর ফাইল থেকে) | `id`, `offset`, `max_tokens`, `question` |
| `note` | নিজের notebook-এ note লেখে বা বদলায় | `title`, `text`, `state` (`in`/`out`), `category`, `id`, `long_term` |
| `strategy` | strategy আর পরের ধাপ লিখে রাখে (version করা); argument ছাড়া শেষ version পড়ে | `text`, `step` |
| `prompt` | system prompt-এর অংশ load / unload করে | `load`, `unload` |

সীমা:

- প্রতি ধাপে সর্বোচ্চ ৪টা `ctx` call, প্রতি টার্নে ২৪টা; একই ধাপে হুবহু একই call আগের উত্তর পায়, গোনা হয় না।
- note আর summary-র লেখা থেকে secret (GitHub token `ghp_…`, `github_pat_…` সহ) আর engine marker (`[native-agent-…]`) সরানো হয়।
- note-এর জায়গার হিসাব অক্ষর দিয়ে হয়, byte দিয়ে নয়।
- `note`, `strategy`, `set` আর `category` সফল হলে `.context/` mirror আপডেট হয়।
- `reset` model-এর tool-এ নেই: শুধু user panel থেকে করতে পারেন।

উদাহরণ:

```json
{"action": "set", "ops": [{"id": "turn/t4", "action": "exclude"}, {"id": "res/R7", "action": "note_only", "note": "build log, already fixed"}]}
{"action": "note", "title": "Build fix", "text": "cargo needs --locked on CI", "state": "in"}
```

## ২. `spawn_subagent`-এর lifetime argument (stage 7)

| argument | মান |
|---|---|
| `lifetime` | `temp` / `reusable` (default) / `standby` |
| `ttl_secs` | standby-এর idle সময়, ৩০০–২,৫৯২,০০০ সেকেন্ড; না দিলে setting-এর `standby_ttl_secs` |
| `render_in_chat` | `true` হলে উত্তর chat-এ আলাদা message, parent পায় note |

ভুল `lifetime` দিলে call ফেরত যায়: `Unknown lifetime "…": use temp, reusable or standby.` reuse-এর সময় `lifetime` দিলে বদলে যায় (যেমন standby → temp)।

উদাহরণ:

```json
{"task": "এই ৩টা ফাইলের সারাংশ দাও", "name": "summarizer", "lifetime": "temp", "render_in_chat": true}
```

## ৩. App (UI) action

`NativeAgent.memory_request`-এর মাধ্যমে:

| action | কাজ |
|---|---|
| `ctx.tree` | panel-এর জন্য বর্তমান tree |
| `ctx.settings` | settings পড়া বা সেভ করা; সেভ হলে sub-agent lifetime নীতিও সাথে সাথে আপডেট হয় |
| `ctx.reset` | একটা চ্যাটের পুরো tree মোছা (settings থাকে); উত্তরে `removed` গণনা আর `mirrorRemoved` |

## ৪. Event

| event | কখন |
|---|---|
| `context.tree` | tree বদলালে, panel আপডেটের জন্য |
| `subagent.finished` | run শেষ হলে; render_in_chat হলে `renderInChat: true` আর পুরো `answer` থাকে, আর `lifetime` |
| `subagent.deleted` | temp/standby agent মুছে গেলে; `reason`: `temp_done` বা `standby_expired` |
