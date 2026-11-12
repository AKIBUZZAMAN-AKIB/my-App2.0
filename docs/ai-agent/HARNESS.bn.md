# NativeKit AI Agent Harness — সম্পূর্ণ আর্কিটেকচার পরিকল্পনা

তারিখ: ২০২৬-০৮-২৩ · Ownerের সিদ্ধান্ত: brain = **ক্লাউড API (Claude/GPT/Gemini)** · আকার = **main app-এ একটাই global agent** · প্রথম মাইলস্টোন = এই পরিকল্পনা (পরে chat+tool implementation)

---

## ১) লক্ষ্য এক লাইনে
ফোনের ভিতরেই এমন একটা **AI agent** থাকবে যে owner-এর বাংলা/ইংরেজি নির্দেশ পড়ে **নিজে ভেঙে** চলেছে, দরকার হলে আমাদের secured native টুল (ফাইল, ক্যামেরা, নেটওয়ার্ক, অ্যালার্ম, mini-app) ডাকে, শেষে ফলাফল ফেরত দেয় — সব কিছু audit-এ লেখা থাকে আর permission owner-এর হাতে।

## ২) বড় ছবি — মূল ৭টা স্তর

```
┌───────────────────────────────────────────────────────────┐
│ Agent UI (www/)        — চ্যাট স্ক্রিন + টুল-কার্ড + গোপন │
├───────────────────────────────────────────────────────────┤
│ Agent Runtime (www/agent/) — loop controller, turn counter │
├───────────────────────────────────────────────────────────┤
│ Provider Adapter (www/agent/providers/)                  │
│   ├── anthropic.js  (Claude — primary)                   │
│   ├── openai.js     (GPT — পরে চাইলে optional)           │
│   └── gemini.js     (Google — পরে)                      │
├───────────────────────────────────────────────────────────┤
│ Tool Registry (www/agent/tools/) — ঘোষণা + dispatcher    │
│   kit.files / kit.http / kit.camera / kit.alarms / ...   │
├───────────────────────────────────────────────────────────┤
│ Security Gate (bridge/app-browser.ts থেকে গেটিং)               │
│   capabilityDecisions(ask/allow/block) + agent-specific   │
│   "autonomy" সিদ্ধান্ত                                    │
├───────────────────────────────────────────────────────────┤
│ Memory (IndexedDB)     — conversations, facts, audit       │
├───────────────────────────────────────────────────────────┤
│ LLM Cloud              — সরাসরি https (networkMode=full)   │
└───────────────────────────────────────────────────────────┘
```

## ৩) Agent loop — কিভাবে চলবে (per turn)

```
1. owner-এর বাংলা/ইংরেজি নির্দেশ (UI ইনপুট)
2. Agent Runtime: messages[] জমা করে → system prompt (নতুন memory facts, available tools) তৈরি
3. Provider Adapter: HTTPS POST (network full mode দিয়ে) → LLM রেসপন্স
4. রেসপন্স যদি tool_use হয় → Tool Registry dispatcher:
   a. টুলখানা permission-যুক্ত কিনা দেখে Security Gate জিজ্ঞেস করে
      - allow → সোজা চলে
      - ask → UI-তে "agent ক্যামেরা চালু করতে চায়" কার্ড দেখে owner চাপায়
      - block → LLM-কে জানিয়ে দাও "এই টুল বন্ধ আছে"
   b. native API (token-secured bridge দিয়ে) চালায়
   c. ফলাফল tool_result হিসেবে messages[]-এ ফেরত দেয়
5. টেক্সট রেসপন্স আসা পর্যন্ত ৩-৪ ঘুরতে থাকে, max_turns-শেষ হলে থামে
6. টেক্সট আসলে UI-তে দেখায় + memory-এ facts জমা করে + audit লগে লেখে
```

**নিরাপদ সীমা:** `max turns` (ডিফল্ট ৮), `max time` (২ মিনিট), `max tool cost` (চাইলে) — তিনটাই policy-তে owner বদলাতে পারবে।

## ৪) Tool Registry — প্রথম তরঙ্গে কী থাকবে

| tool name | আমাদের API | ক্যাটাগরি | permission |
|---|---|---|---|
| `ki.memory_save` / `memory_get` | vault IndexedDB | free | allow (স্কোপ-only) |
| `http.request` | kit.http (brokered) | নেটওয়ার্ক | ask প্রথমবার |
| `files.read/list/write` | kit.filesystem | ডিভাইস | ask |
| `device.info` | kit.device | ডিভাইস | allow (no cost) |
| `alarm.schedule` | kit.alarms | নোটিফিকেশন | ask |
| `miniapp.open/speak` | kit.appBrowser | UI | ask |
| `camera.snap` | kit.camera | ডিভাইস | **সবসময় ask** (privacy-বিশেষ) |

পরে যোগ হবে: `location.get`, `share.open`, `tts.speak` (আমাদের native সেট করলে)।

প্রতি টুলের ঘোষণা Claude-এর `tools: [{name, description, input_schema}]` ফরম্যাটে থাকবে — সুতরাং provider বদল হলেও tool definition এক একই রাখা যায়।

## ৫) Provider Adapter — প্রথমে Claude
- Base URL `https://api.anthropic.com` (network full-এ সরাসরি)
- API key → **কখনো source-এ নয়** — আমাদের `Secure Preferences`/keystore-backed স্টোরে; owner settings-এ একবার দিলে save হবে
- মডিউল: `www/agent/providers/anthropic.js` — `complete({system, messages, tools, max_tokens})`
- Per-turn টোকেন গণনা + ব্যয় stats Manager-এ দেখা যাবে (netstat-এর পাশে "agent" ট্যাব)

## ৬) Memory আর্কিটেকচার (IDB-এ তিন layer)
1. **conversations** — প্রতি সেশনের full message ডুম্প (ordered)
2. **facts** — `key: value` পার মেমরি ("আমার নাম X", "আমার পছন্দ Y") — system prompt-ে inject হয়
3. **audit** — প্রতি tool call: সময়, টুল, ইনপুট সারণী, ফলাফল, approve দিয়েছিল কিনা — immutable append-only log, privacy-friendly (owner সেট clearing করতে পারবে)

IDB v 4-এ আগেই `netstats` আছে; পরের মাইগ্রেশনে `agentConv`, `agentFacts`, `agentAudit` store যোগ হবে.

## ৭) নিরাপত্তা (আমাদের কঠোর নিয়ম কখনো ভাঙবে না)
- LLM-কে **কখনো raw নেটিভ ব্রিজ access দেওয়া হবে না** — শুধু Tool Registry-র সাদা তালিকা; এটা compartment/threat model-এর সোনালী নিয়ম
- API key WWW সোর্সে কখনো নেই; রানটাইমে secure store থেকে বের হয়
- Mini-app দিয়ে agent কথোপকথন চললে সেও আলাদা `appId`-এর policy-র কোপে পড়ে (owner প্রতিটা mini-app কেও agent-টুল দিতে চায় কিনা সেটা আলাদা অনুমতি)
- "always allow" network গড়ি বৃদ্ধি না করে Agentের জন্য `agentAllowList: ["api.anthropic.com"]` কনফিগ allow hosts-এ মেনে কাজ করে (default full mode এটা শুধু optional tightening)

## ৮) UI — কোথায় কী আসবে (www/)
- `www/agent/index.html` — চ্যাট ভিউ (বাংলা ready), tool-কার্ড ("ক্যামেরা ব্যবহার করছি…"), typing indicator
- `www/agent/settings.html` — provider বাছাই, API key ইনপুট, per-tool permission টেবিল, ব্যালান্স/limit
- Manager-এ নতুন ট্যাব: **🤖 Agent** — audit লগ নজরে রাখা, token ব্যয়, memory facts এডিট/মুছতে পারা

## ৯) মাইলস্টোন টাইমলাইন
- **M1 (প্রথম deliver):** চ্যাট UI + anthropic.js + ৪টা basic tool (memory/files/http/device) + approval prompt → owner "একটা কথা লিখলে ফাইলে লিখে রাখি" টাইপ জিনিস করতে পারবে
- **M2:** টুল রেজিস্ট্রি সম্পন্ন (অ্যালার্ম, camera ask, miniapp.open) + Agent Manager ট্যাব + audit
- **M3:** ব্যাকগ্রাউন্ড autonomous টাস্ক (backgroundRunner-এ চলমান agent tick), আরও memory ফ্যাক্ট ফ্রেগমেন্টেশন, token ব্যয় রেপোর্ট
- **M4 (ভবিষ্যৎ):** প্রতি mini-app-এর নিজস্ব agent instance (policy-গেইট)

## ১০) প্রথমে owner-এর কাছ থেকে যা লাগবে
1. **Anthropic API key** (settings-এ দিলে চলবে তাহলে আমরা নিজেরাই M1-এ ব্যবহার করতে পারব না)
2. প্রথম "goal" যেটা agent-কে দিতে চান — টেস্ট করার জন্য

---

## সংযোজন: ভবিষ্যতের পথ (Node runtime research-এর পরবর্তি)
আগেকার deep research (`docs/research/NODE-RUNTIME.bn.md`) জানালাম — Node.js প্রয়োজন নেই এই হারনেসের জন্য: **চাহিদা পুরোটাই আমাদের WebView JS + bridge নিশেই মেটে**; npm ecosystem যেখানে লেগে থাকে সেখানেই তখন capacitor-nodejs-এর Android অংশ wrapper হিসেবে আনা হবে।

## সংযোজন-২ (২০২৬-০৮-২৪): রোডম্যাপ ডকের সাথে সংশোধন ও স্ট্যাটাস

- এই ডকুমেন্ট **কংক্রিট প্রতিমান**; কৌশলগত/গ্যাপ-ভিত্তিক রূপরেখা: [`docs/research/AGENTIC-ROADMAP.bn.md`](../research/AGENTIC-ROADMAP.bn.md) (P0–P3 ফেজ: tool JSON Schema + risk matrix + on-device GGUF + MCP ব্রিজ)। দুটোই একই পরিকল্পনার দুই দিক — এই ডকে M1-ই রোডম্যাপের P0.1।
- টুল-ট্যাঙ্ক বৃদ্ধি (রোডম্যাপ/প্লাগিন-ম্যাপ থেকে — [`docs/research/PLUGIN-ECOSYSTEM.bn.md`](../research/PLUGIN-ECOSYSTEM.bn.md)):
  - `location.geofence.add/remove` — geocoder + geofence প্লাগিন দিয়ে **"যেখানে পৌঁছালে মনে করাও"** (টায়ার-২)
  - `speech.listen` / `speech.say` — STT/TTS (টায়ার-১) — ভয়েস-এজেন্ট মোড
  - `torch.toggle`, `qr.scan` (টায়ার-১/২) — Utilities-স্তর দ্রুত জয়
  - `nearby.send/peers` — v1.4.x-এ **শিপড** Nearby P2P ভেতরে; agent-mesh-এ P2 ফেজে রাখা আছে
  - `clipboard.read/write`, `dialog.confirm` — টায়ার-১ প্যাকে; dialog-চাইতে high-risk consent-এর আলাদা UI না বানিয়েই
- স্ট্যাটাস: M0 (এই নকশা) ✅ · M1 (chat + ৪ টুল + approval) ⏳ — মূল অবকাঠামো (secure store, SSE streaming, audit, consent prompts) বিদ্যমান; মূল কাজ `www/agent/` মডিউলটাই লেখা।

> Provider নোট: প্রথম বাছাই Claude/Anthropic থাকলেও, এজেন্ট-লুপ ও টুল-রেজিস্ট্রি সম্পূর্ণ provider-agnostic রাখা আবশ্যক — একই tool schema দিয়ে Claude tool_use, OpenAI function calling ও Gemini function-declarations তিনটাই চলে; adapter-ই পার্স করে।
