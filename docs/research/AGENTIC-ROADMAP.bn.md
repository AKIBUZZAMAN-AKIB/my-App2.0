# 🧠 Agentic App রোডম্যাপ — গভীর রিসার্চ (v1, 2026-08-24)

> প্রশ্ন: আমাদের NativeKit শেল-এ মিনি-অ্যাপ সিস্টেম আছে — ভবিষ্যতে এটাকে **"সবচেয়ে শক্তিশালী agentic অ্যাপ"** বানাতে আসলে কী কী ফাংশনালিটি যোগ করতে হবে? এই ডকুমেন্ট: ২০২৫-২৬-এর agentic best-practice সাহিত্য + on-device AI স্ট্যাক + আমাদের বিদ্যমান আর্কিটেকচারের ম্যাপিং → কংক্রিট গ্যাপ-লিস্ট ও ফেজড রোডম্যাপ।

---

## ১) আশ্চর্যজনক সত্য: আমাদের মিনি-অ্যাপ ভিত্তি **ইতিমধ্যে agentic-ready**

২০২৬-এর agentic security সাহিত্য ([Augment Code — Agentic SDLC](https://www.augmentcode.com/guides/security-architecture-agentic-sdlc), [Northflank — sandboxing AI agents](https://northflank.com/blog/how-to-sandbox-ai-agents), [WorkOS — agent credentials](https://workos.com/blog/ai-agent-credentials), [harness engineering guide](https://medium.com/@tort_mario/ai-agent-best-practices-production-ready-harness-engineering-2026-guide-c1236d713fac)) যে নীতিগুলো জোর দেয়, সেগুলোর প্রায় সবই আমাদের `appBrowser` সাবসিস্টেমে আজ **হুবহু আছে**:

| ২০২৬ agentic best-practice | আমাদের বিদ্যমান উপাদান |
|---|---|
| Execution isolation (untrusted code = sandbox) | আপলোড করা মিনি-অ্যাপ **opaque-origin sandbox**-এ চলে; `renderer: iframe \| isolated` (নেটিভ isolated WebView) |
| Tool registry + typed schema | হোস্ট-মেনেজড **`NativeKit` facade** — ১৯টা নামকৃত capability, রানটাইম feature-gate |
| Least-privilege / per-tool permission resolution | `appBrowser.defaultCapabilities` + per-টোকেন RPC façade (মিনি-অ্যাপ পুরো ব্রিজ পায় না) |
| Human-in-the-loop gates | `permissionPrompts: { requestedCapabilityDefault / unrequestedCapabilityDefault: ask\|allow\|block }` — এটা agent-কনসেন্ট UI-এর জন্য রেডি হুক |
| Immutable audit trail | `auditLogLimit`-সহ appBrowser audit log |
| Budget/rate control | `maxRequestsPerMinute`, `maxApps`, `maxPackageBytes`, `maxFiles` |
| Zero-trust network egress | `allowDirectWebNetwork: false` + `urlMode.allowedHosts` allowlist — হুবহু "egress filtering" প্যাটার্ন |
| Delegation নিয়ন্ত্রণ | টোকেন-বাউন্ড RPC — প্রতিটি মিনি-অ্যাপ নিজস্ব ক্ষমতা পায়, হোস্ট-কন্ট্রোল্ড |

**উপসংহার-১:** যেখানে বাকিরা agent sandbox বলতে microVM/gVisor লাগায়, মোবাইল অ্যাপ-কনটেক্সটে আমারি **WebView sandbox + capability-gated RPC** একই ইফেক্ট দেয় — এবং এটা ইতিমধ্যে বিল্ট-ইন। আমাদের শুধু উপরে "ব্রেন" বসাতে হবে।

---

## ২) গ্যাপ-অ্যানালাইসিস: "সবচেয়ে শক্তিশালী agentic অ্যাপ"-এ যা যোগ করতে হবে

### 🔴 P0 — কোর এজেন্ট স্ট্যাক (এগুলোই "agentic" বানায়)

**A. LLM ব্রেইন লেয়ার (`features.llm`)**
- **প্রথম ধাপ (hack-less):** cloud API — BYOK (bring-your-own-key) পথ: OpenAI/Anthropic/Gemini — আমাদের `NativeKit.http` native-SSE ফ্যাসাডে আগে থেকেই স্ট্রিমিং আছে (`stream` অ্যাকশন), তাই চ্যাট-স্ট্রিমিং ইঞ্জিন রাতারাতি সম্ভব।
- **দ্বিতীয় ধাপ (অফলাইন মোড):** on-device inference —
  - [`llama-cpp-capacitor@0.2.2`](https://www.npmjs.com/package/llama-cpp-capacitor) (arusatech): llama.cpp সরাসরি ভেতরে — chat, streaming, **multimodal**, **TTS**, LoRA, **embeddings, reranking** — Android+iOS+Web। লো-এন্ড ডিভাইসে llama.cpp-ই সবচেয়ে ধারাবাহিক ([2026 গাইড](https://docs.octomil.com/blog/on-device-llm-inference-2025-2026/) — লো পাওয়ার টার্গেটে CPU ≈ GPU)।
  - বিকল্প: [Cap-go/`capacitor-llm`](https://open-awesome.com/projects/capacitor-llm) (Android MediaPipe GenAI + iOS Apple Intelligence) — সিস্টেম-মডেল ব্যবহারের পথ।
  - বাস্তব লক্ষ্য: **1B-3B GGUF** (Qwen2.5-1.5B / Llama-3.2-1B/3B / SmolLM2 / Phi-4-mini) — মিডরেঞ্জে ~10-20 tok/s ([বেঞ্চমার্ক](https://docs.octomil.com/blog/on-device-llm-inference-2025-2026/)); মডেল ডাউনলোড/সচল সংরক্ষণে আমাদের `fileTransfer`+`filesystem` (বিদ্যমান!) + GMS-নিরপেক্ষ বিকল্প হোস্টিং।
- **ট্যাগলাইন হিসেবে মাথায় রাখুন:** "ক্লাউড না থাকলেও এজেন্ট চলে" — আমাদের Nearby P2P আর এটা মিলে পুরোপুরি ওয়্যার-টাইম-প্রুফ।

**B. ফরমাল Tool Registry (risk-classified)**
- প্রতিটি `NativeKit.*` মেথডকে **JSON Schema tool** আকারে অটো-জেনারেট করা (name/description/params/returns) — তাহলে যেকোনো LLM-এ সরাসরি `tools[]` হিসেবে দেওয়া যায়; কোড-ভিত্তিক টুল-ডিসকভারি = agent-harness-এর স্ট্যান্ডার্ড ([harness guide](https://medium.com/@tort_mario/ai-agent-best-practices-production-ready-harness-engineering-2026-guide-c1236d713fac))।
- প্রতিটি টুলে **risk class:** `read` (ক্যামেরা-রিড, লোকেশন), `write` (filesystem, sqlite), `external-effect` (share, browser), `expensive` (background GPS, LLM inference), `destructive` (deleteDatabase, cancelFolder) — কনসেন্ট-ম্যাট্রিক্সে ক্লাস অনুযায়ী ask/allow/block। আমাদের `permissionPrompts` কনফিগটা এই ম্যাট্রিক্সের এলাকা প্রসারণ মাত্র।

**C. এজেন্ট রানটাইম লুপ (বাজেট + স্টপ-কন্ডিশন)**
- `agent.loop(goal, tools, budget)` JS-API: turn cap, token/cost cap, tool-call cap, timeout, compaction trigger — বাজেট-ট্র্যাকিং ও স্টপ-কন্ডিশন ছাড়া কোনো প্রোডাকশন হারনেস নেই।
- **background-runner** (বিদ্যমান)-এ long-task orchestration; প্রতিটি রানের audit লগে tool-call choreography সংরক্ষণ।

**D. মেমরি লেয়ার (vector + per-agent)**
- Embeddings → KNN — আমরা [`@capacitor-community/sqlite`](https://github.com/capacitor-community/sqlite) ব্যবহার করি, `sqlite-vec` এক্সটেনশন একই অথরের কমিউনিটি প্যাকেজে পাওয়া যায়; না পেলে JS-side brute-force KNN (১০ হাজার রেকর্ড পর্যন্ত যথেষ্ট)।
- প্রতিটি মিনি-অ্যাপের নিজস্ব মেমরি নেমস্পেস — টোকেন-বাউন্ড স্টোরেজের উপর memory namespace: এটাই "agent ID = first-class principal" প্যাটার্ন ([WorkOS](https://workos.com/blog/ai-agent-credentials))।

### 🟡 P1 — নিম্ন-লাগত বড়-প্রভাব মাল্টিমোডাল ইনপুট/আউটপুট

**E. ভয়েস লেয়ার:** `@capacitor-community/text-to-speech` + speech-recognition প্লাগিন — এজেন্টকে মুখ-কান দেয়; llama-cpp-capacitor-এর built-in TTS থেকে ডুয়াল পথ (অন-ডিভাইস প্রাইভেসি)।
**F. স্ক্রিন/কনটেক্সট ইনজেশন:** ক্যামেরা (বিদ্যমান) → মাল্টিমোডাল llama context; স্ক্রিনশট/শেয়ার্ড টেক্সট ইনটেন্ট ইনজেশন (custom-native প্লাগিনে ছোট এড)।
**G. এজেন্ট → বাইরের অ্যাপ:** Android Intents — অন্য অ্যাপ খোলা/ডেটা পাঠানো; [Mobile-MCP গবেষণাপত্র](https://os-for-agent.github.io/papers/AgenticOS_2026_paper_18.pdf) প্রমাণ করে Intent-ভিত্তিক tool-registry মোবাইলে কাজ করে (রেজিস্ট্রেশন→ডিসকভারি→ইনভোকেশন)। আমাদের `custom-native` প্লাগিনে `sendIntent()/queryIntents()` বসালেই এই ইকোসিস্টেম-approved পথে ঢুকে যাই।

### 🟢 P2 — প্লাটফর্ম-লেভেল এজেন্ট ফিচার

**H. MCP ব্রিজ (`features.mcp`):**
- **MCP server হিসেবে অ্যাপ:** in-app HTTP/SSE এন্ডপয়েন্ট (native SSE ইঞ্জিন আছে) যাতে Desktop/IDE এজেন্ট (Claude Code, Cursor) ফোনের টুলগুলো আবিষ্কার+কল করতে পারে — [mobile-mcp](https://github.com/mobile-next/mobile-mcp) একই মডেল (ADB/Accessibility ব্যবহার করে; আমরা সরাসরি ভেতর থেকে — আরও নিরাপদ)।
- **MCP client হিসেবে:** বাইরের MCP সার্ভারের টুল আমারি এজেন্টে যুক্ত করা।
- নোট: tool-এর name/description-ই LLM-এর রাউটিং ডেটা — রেজিস্ট্রি-ফর্মালাইজ করলে (B) এটা অটোমেটিক।

**I. মিনি-অ্যাপ "এজেন্ট" টাইপ:** ডিক্লেয়ারেশন-লেভেলে `type: 'agent'` মিনি-অ্যাপ যার defaultCapabilities ছোট (read-only বেছে নেওয়া) + LLM brain-এর অ্যাক্সেস + লুপ অ্যাক্সেস — তাহলে "installed agents" কোনো অ্যাপের অংশ, সাইড-চ্যানেল নয়। ভবিষ্যৎ মার্কেটপ্লেস-ধাঁচ এখানেই বসে।

**J. অফলাইন মাল্টি-ডিভাইস এজেন্ট মেশ:** আমরা **Nearby P2P ফুল ইন্টিগ্রেশন** 2026-08-24-এই শিপ করেছি (v1.4.0 → v1.4.1) — দুটো ফোনের এজেন্ট অফলাইনেই ইনফো/টাস্ক আদান-প্রদান করতে পারে (staging: এক ডিভাইসে LLM, আরেকটায় শুধু UI)। এই কম্বিনেশন বাজারে দুর্লভ।

**K. এজেন্ট UI অটোমেশন (mini-app DOM drive):** appBrowser-এ ডিক্লেয়ারিটিভ অটোমেশন API (query/fill/click) — তাহলে এজেন্ট কোনো মিনি-অ্যাপের UI নিজেই চালাতে পারে; sandboxed রেন্ডারারে এটা নিরাপদ, যেহেতু অ্যাকশনগুলো RPC বাউন্ডারি ভেতরে।

### ⚪ অপর্যাপ্ত নয়, তবে রেজিলিয়েন্স
**L. প্রম্পট-ইনজেকশন ব্লাস্ট-রেডিয়াস কমানো:** [CISA/অন্যান্য](https://www.augmentcode.com/guides/security-architecture-agentic-sdlc) স্বীকার করে ইনজেকশনের পূর্ণ তকনা নেই — আর্কিটেকচারে বাউন্ডারি দিন: (১) মিনি-অ্যাপ টেক্সট কখনো tool-permission পরিবর্তন করে না (আমাদেরটা ডিফল্টেই আলাদা ✓), (২) egress allowlist থাকে এজেন্টকন্টোলের বাইরে (বিদ্যমান ✓), (৩) high-risk টুলে content→action gate (D-ম্যাট্রিক্সের সম্প্রসারণ), (৪) outbound content স্ক্যান (cloud API রুটে)।

---

## ৩) রোডম্যাপ (কংক্রিট, এই রিপোর ফাইলে মজুদকরণ সহ)

| ফেজ | কাজ | নতুন নির্ভরতা/পরিবর্তন |
|---|---|---|
| **P0.1** | BYOK LLM চ্যাট + এজেন্ট লুপ (budget/stop) | কোনো নেটিভ যোগ নয় — http/SSE + `features.agent`; app.config-এ `agent: { maxTurns, toolBudgetPerRun }` |
| **P0.2** | Tool registry gen + risk matrix + consent UI গ্রেডিং | `bridge/tool-registry.ts` — NativeKit থেকে অটো-ডেরাইভ; `permissionPrompts` রিস্ক-গ্রেড |
| **P0.3** | On-device LLM | `llama-cpp-capacitor` (GGUF ডাউনলোড ফ্লো fileTransfer-এ) — `features.llm` `@capacitor-community/sqlite`-র sqlite-vec এক্সটেনশন |
| **P0.4** | মেমরি: embeddings + sqlite-vec KNN + per-agent namespaces | sqlite-vec স্ট্যাটিক এক্সটেনশন (কমিউনিটি) |
| **P1** | TTS + STT; Intent bridge (sendIntent/queryIntents custom-native-এ); ইন্টেন্ট ইনজেশন | `@capacitor-community/text-to-speech` ইত্যাদি |
| **P2** | MCP server (native SSE এন্ডপয়েন্ট) + client ফলব্যাক; `type:'agent'` মিনি-অ্যাপ; P2P এজেন্ট মেশ | হাইব্রিড জটিলতা — পর্যায়ক্রমে |
| **P3** | মিনি-অ্যাপ অটোমেশন API; advanced policies | — |

প্রতিটি ফেজে `--features` টেমপ্লেট-গেট রাখুন (যেমন আমরা `features.nearby` করেছি — বৈকল্পিক, শেখা পাঠ #১: পারমিশন/প্লিস্ট **টেমপ্লেটেই** বসে, হাতের AndroidManifest এডিট হারায়)।

---

## ৪) রিস্ক নোট
1. **অ্যাপ-স্টোর রিভিউ:** on-device মডেল ডাউনলোড + অটোমেশন — Play-এ "User Data Policy" ডিসক্লোজার আপডেট লাগবে (background GPS-এর সাথে যা করে এসেছি)।
2. **থার্মাল/ব্যাটারি:** সাস্টেইন্ড LLM inference ২-৪ ঘণ্টায় ব্যাটারি খালি করে ([মোবাইল-LLM গাইড ডেটা](https://www.promptquorum.com/local-llms/mobile-local-llms)) — ডিফল্ট `max_turns`+প্রিডিক্ট ক্যাপ অপরিহার্য।
3. **LLM টুল-কল গলগিয়ে গেলে/ভুল টুল বাছলে** loop-টিকে force-stop দেওয়ার পথ রাখুন (প্রতি রানে kill-switch UI + audit log-এ "aborted" ইভেন্ট)।
4. প্রম্পট-ইনজেকশনে সবচেয়ে বড় প্রতিরক্ষা আমাদেরটা **আগে থেকেই আছে**: capability RPC বাউন্ডারি — এটা intact রাখা প্রথম কদম।

**সোর্স:** [Mobile-MCP (GitHub)](https://github.com/mobile-next/mobile-mcp) · [Mobile-MCP (AgenticOS'26 পেপার)](https://os-for-agent.github.io/papers/AgenticOS_2026_paper_18.pdf) · [On-Device LLM গাইড 2025-26](https://docs.octomil.com/blog/on-device-llm-inference-2025-2026/) · [llama-cpp-capacitor](https://www.npmjs.com/package/llama-cpp-capacitor) · [Cap-go capacitor-llm](https://open-awesome.com/projects/capacitor-llm) · [Agentic SDLC security](https://www.augmentcode.com/guides/security-architecture-agentic-sdlc) · [Agent sandboxing 2026](https://northflank.com/blog/how-to-sandbox-ai-agents) · [Harness engineering](https://medium.com/@tort_mario/ai-agent-best-practices-production-ready-harness-engineering-2026-guide-c1236d713fac) · [WorkOS agent credentials](https://workos.com/blog/ai-agent-credentials) · [Mobile LLM apps 2026](https://www.promptquorum.com/local-llms/mobile-local-llms)

---

## সংযোজন (২০২৬-০৮-২৪): সহ-ডকুমেন্ট লিঙ্কম্যাপ

- **কংক্রিট নকশা:** [`docs/ai-agent/HARNESS.bn.md`](../ai-agent/HARNESS.bn.md) — M1 = এই রোডম্যাপের P0.1 (BYOK chat + loop + ৪ tool + approval)।
- **প্লাগিন ম্যাপ:** [`PLUGIN-ECOSYSTEM.bn.md`](./PLUGIN-ECOSYSTEM.bn.md) — STT/TTS/geofence/QR/torch কোন টায়ারে।
- **শিপড v1.4.x:** [`NEARBY-CONNECTIONS-PLUGIN.bn.md`](./NEARBY-CONNECTIONS-PLUGIN.bn.md) — P2 ফেজের "agent mesh" অর্ধেক বাস্তব।
- **নিরাপত্তা বাউন্ডারি:** [`../SECURITY-POLICY.bn.md`](../SECURITY-POLICY.bn.md) — LLM কখনো raw bridge পাবে না; risk-classified consent = গোল্ডেন নিয়ম।
