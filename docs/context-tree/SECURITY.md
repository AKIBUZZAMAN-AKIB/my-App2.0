# Context Tree — SECURITY

> temp.md §8-এর threat model (T1–T9), প্রতিটার পাশে কোডে কোথায় প্রতিরোধ আছে। শেষে stage 7 (sub-agent lifetime) আর reset-এর নিয়ম।

| # | Threat (temp.md) | প্রতিরোধ | কোড |
|---|---|---|---|
| T1 | tool result, ওয়েব পেজ বা ফাইলের লেখা AI-কে `sys/core` বাদ দিতে বা memory মুছতে বলে | শুধু আসল `ctx` tool call tree বদলায়; locked item বদলানোর চেষ্টা refuse হয়; marker escape করা | `ops.rs`, `render.rs` |
| T2 | title বা note-এ marker নকল (`[native-agent-resume-v1]`) | title ১২০ অক্ষরে কাটা; prompt-এ আর mirror-এ যাওয়ার আগে note থেকে `[native-agent-…]` marker সরানো হয়, তাই কোনো note checklist বা resume block সাজতে পারে না | `model.rs`, `wiring.rs`, `mirror.rs` |
| T3 | MCP বা `device__*` tool দিয়ে ctx-এর কাজ করানো | শুধু engine-এর নিজের `ctx` tool নাম এই পথে যায় | `agent_loop.rs` |
| T4 | sub-agent parent-এর tree বদলায় | প্রতিটা `ctx` call নিজের `session_key`-এ কাজ করে; অন্য session-এর id → "no such item"। temp agent-এর report parent-এর tree-তে যায় শুধু engine-এর মাধ্যমে, সাব-এজেন্টের নিজের call-এ নয় | `dispatch.rs`, `subagents/lifetime.rs` |
| T5 | checklist-এ এক চ্যাটের তথ্য অন্য চ্যাটে | প্রতিটা query `session_key` দিয়ে filter করে; mirror-এও প্রতি session-এর আলাদা ফোল্ডার | `store.rs`, `mirror.rs` |
| T6 | বাজেট DoS (AI `ctx view`-এ loop করে) | প্রতি ধাপে ৪টা, প্রতি টার্নে ২৪টা call (তারপর `limit`); একই call আগের উত্তর পায়; output-এর সীমা | `wiring.rs`, `agent_loop.rs` |
| T7 | sub-agent ইচ্ছামতো UI দেখায় | `ui__` tool শুধু main agent-এর; `render_in_chat` শুধু একটা display flag: উত্তরটা সাধারণ লেখা হিসেবে (HTML নয়) card-এর ভেতরে দেখায় | `subagents.rs`, `10-subagents.js` |
| T8 | note, strategy বা mirror-এ secret | `redact_secrets` (GitHub token `ghp_…`, `github_pat_…` সহ) note, summary আর mirror ফাইলে | `error_taxonomy.rs`, `dispatch.rs`, `mirror.rs` |
| T9 | user হাতে `.context/` ফাইল বদলায় | ডেটাবেসই সত্য; mirror কখনো ফেরত পড়া হয় না; পরের sync আর app চালু হলে আবার লেখা হয়; বাড়তি ফাইল মুছে যায়; শুধু নিজের লেখা (`SESSION` ফাইলসহ) ফোল্ডার মোছে | `mirror.rs` (test: `tampered_mirror_is_rebuilt_from_the_database`) |

## Stage 7: sub-agent lifetime

- চলমান বা approval-এর অপেক্ষায় থাকা agent কখনো মোছা হয় না।
- temp agent মোছার আগে তার report parent-এর tree-তে `out` note হয়; parent না পাওয়া report standby TTL পর্যন্ত থাকে। ফলে উত্তর হারায় না।
- মোছা মানে agent-এর chat, log, record আর private memory; agent-এর বানানো ফাইল থাকে। অন্য agent একই নাম নিলে বা shared memory হলে memory থাকে।
- render_in_chat হলে parent পুরো লেখার বদলে note id পায়, তাই একই লেখা দুবার context খায় না।

## Reset

`ctx.reset` শুধু app (user) থেকে আসে, model-এর `ctx` tool-এ এই action নেই। panel-এর "Reset tree" বোতাম আগে confirm চায়। সেই চ্যাটের `.context/` ফোল্ডারও মোছে, তবে শুধু যদি তার `SESSION` ফাইল এই চ্যাটেরই হয়।

## যা এখনো user-এর দায়িত্ব

Redaction শুধু context tree-এর note, summary আর mirror থেকে secret সরায়; chat history বা অন্য জায়গা থেকে নয়। chat-এ শেয়ার হওয়া token সবসময় revoke করুন।
