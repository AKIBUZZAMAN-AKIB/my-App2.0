# Implications of the context tree — measured, not assumed

**Companion to:** `context-tree-master-plan.md` (the plan) and `dynamic-memory-implementation-prompt.md` (the spec)
**Repo state:** `48db1fb` · **Measured:** 2026-11-20 · **Method:** direct measurement of the checkout + GitHub Actions API (nothing here is a guess unless it says *est.*)

---

## 0. বাংলা সারসংক্ষেপ — সবচেয়ে জরুরি ৭টা

1. **নতুন ৮টা `ctx_*` টুল = প্রতি request-এ ~১,৬৩০ টোকেন** (মাপা: স্কিমা ৬,২০৩ অক্ষর; ৪৩% শুধু description)। ৮k window-এ এটা **২০%** — তাই টুলগুলো একটাই `ctx` টুলে (action enum) merge করা উচিত: ~১,৬০০ → ~৪৫০ টোকেন।
2. **বাস্তবে টুল-স্কিমার ট্যাক্স অনেক বড়**: রেপোতে ২৫টা বিল্ট-ইন + `device__` **৬৬টা** + ui/folder/open-data/MCP ⇒ আসল request-এ ~১০০+ টুল। WDYT: window-এর বড় অংশ টুল-স্কিমাতেই যাচ্ছে — এটাই আসল "context সংকট", memory নয়।
3. **Engine-এর প্রতিটা পরিবর্তনে বাইনারি বাড়ে**: প্রতিবার Android slice rebuild commit = **৬৪ MB** (.so ×৪), iOS xcframework = **৯৮ MB** (.a ×২)। `.git` এখনই **৪৫৪ MB**; গত ৬০ কমিটে এমন ১১টা bot commit। ৯ স্টেজ = ৯ বার হলে **~১.৫ GB** — তাই Rust কাজ ২–৩টা মাইলস্টোনে ব্যাচ করতে হবে।
4. **CI: UI job ৪২.১ মিনিট (timeout 60)** — ২৫তম স্যুট যোগ করলে ~৪৫ মিনিট। Rust job মাত্র ৩.৪ মিনিট। یعنی খরচ সময়ের নয়, UI-র।
5. **টুলগুলো সমান্তরালে চলে (max 16) + resource lock + lock timeout** — `ctx:<session>` write lock ঠিক, কিন্তু একই step-এ ১২টা ctx op সিরিয়াল হবে ⇒ timeout/starvation ডিজাইনে ধরতে হবে; memory worker-এর সাথে `rev` race ডিজাইন-লেভেলে সমাধান লাগবে।
6. **আজ কেউ জানে না কত টোকেন system vs tools** — `reservedInputTokens` একসাথে দেখায়। `systemTokens`/`toolTokens` আলাদা করা ৩০ মিনিটের কাজ, কিন্তু পুরো প্রজেক্টের মাপার ভিত্তি এটাই।
7. **১০,০০০ পাতার বইয়ের আসল দেয়াল output reserve**, context নয় (৮k window / ১k output = ১k/step)। তাই সিস্টেমটার মূল্য = orchestration (strategy + sub-agent + file + recall), "বড় context" নয় — এবং সেই অর্থে প্ল্যানটা কাজে দেবে।

---

## 1. What was measured (raw)

| # | Measurement | Value | How |
|---|---|---|---|
| M1 | `ctx_*` tool schema text (8 tools, from the spec's own JSON) | **6,203 chars ≈ 1,632 tokens** | extracted + `json.loads` validated, ÷3.8 chars/token |
| M2 | of which `description` prose | 2,640 chars (**43%**) ≈ 695 tokens | field split |
| M3 | `CORE_RULES_PROMPT` (spec §9) | 3,072 chars ≈ **808 tokens** | extracted |
| M4 | `CHAT_MEMORY_PROMPT` (existing) | 3,115 chars ≈ **820 tokens** | `workspace.rs` |
| M5 | checklist block (spec §7.2 example) | 627 chars ≈ **165 tokens / step** | extracted |
| M6 | resume block (spec §7.4 example) | 464 chars ≈ **122 tokens, once** | extracted |
| M7 | built-in tool definitions | **25 tools**, 24,031 chars of source table | `tool_runner.rs::all_tool_definitions` |
| M8 | device tools | **66** entries | `bridge/device-tools.ts` |
| M9 | other tool families | ui, folder-access, open-data, workspace-files, MCP client (37 KB) | `bridge/*.ts` |
| M10 | Rust tests | **635** `#[test]`/`#[tokio::test]` | grep |
| M11 | UI suites in CI | **24**, `run-all.sh` NAMES | script |
| M12 | Android native libs | 16+13+18+17 = **64 MB** per build commit | `jniLibs` |
| M13 | iOS static libs | 49+49 = **98 MB** per build commit | `xcframework` |
| M14 | repo `.git` | **454 MB** | `du` |
| M15 | FFI rebuild commits | **11 of the last 60** commits | `git log` |
| M16 | CI job times (run `44658405363`) | Rust **3.4 min** · Web **0.5 min** · UI **42.1 min** (limit 60) | Actions API |
| M17 | `load_system_prompt` call sites | **17** (1 def + ~16 tests) → the wrapper must stay byte-identical | grep |
| M18 | `context.assembly` references | **32** across **11** files (Rust + `57-memory.js` + `memory.js`) | grep |
| M19 | scheduler | parallel reads, up to **16** parallel tools, resource locks + lock timeout | `tool_scheduler.rs` |
| M20 | budget inputs already computed | `effective_context_token_budget(… system_prompt, tools …)` — system & tool tokens exist, **not surfaced** | `agent_loop.rs:1887` |

---

## 2. Anatomy of one request (before vs after)

`effective_context_token_budget` = `window − tokens(system) − tokens(tools) − max_tokens − 2,048`. Post-change, the tree lives entirely inside the "transcript" part.

| Component | Today | With context tree | Δ |
|---|---|---|---|
| System prompt (workspace + formats + skills + groups) | 2–6k *est.* | +808 (`sys/core`) +820 (`sys/memory` locked) | **+1.6k** |
| Tool schemas | **the dominant term** (25 built-in + up to 66 device + ui/folder/MCP) | +1,632 (`ctx_*`) | **+1.6k** |
| Checklist block | 0 | 165 / step (≈60 with differential render, **D4**) | +60–165 |
| Resume block | 0 | 122, once per resume | +122 occasionally |
| Transcript | everything left | same budget, but *chosen* instead of *automatic* | ±0 |

**Consequence at real window sizes** (assuming ~8k of tool schemas + ~4k system, *est. — measure per M20*):

| Window | locked (sys+tools+reserve) | usable for work | ctx tax share | verdict |
|---|---|---|---|---|
| 8,192 | ~11k > window | **negative** | — | the app cannot work with 100 tools; must cull tools, not add |
| 32,768 | ~17k | ~15k | 1.6k = **10%** | tight; differential checklist + merged tool are mandatory |
| 128,000 | ~17k | ~110k | 1.5% | comfortable |
| 200,000 | ~17k | ~190k | 0.8% | negligible |

**Read:** the context tree is *cheap on big windows and expensive on small ones* — exactly inverted from where it is most needed. This drives amendments **A1–A3** below.

---

## 3. Domain-by-domain implications

### A. Token economics
* 43% of the new schema text is prose (`M2`) → moving those descriptions into `sys/core` and shipping **compact schemas** halves the tax.
* Merging `ctx_view/ctx_set/ctx_category/ctx_prompt` into one `ctx` tool with an `action` enum and pointer-style params → **~450 tokens instead of 1,632**, with *no* capability loss (the model already handles enums: `ctx_category` and `ctx_note` are enum-shaped today).
* `ctx_note` + `ctx_strategy` are the same object type (labelled text in a category) — one tool, two `kind` values.
* **Net target: ~500–600 tokens** for the whole system (a 3× reduction on the spec's 1,632).
* Every token of tool schema is paid **once per model call**, i.e. per step: a 20-step turn at 1,632 tokens ≈ 32.6k extra input tokens per turn. At $3/M input that is ~$0.10/turn — small, but on a 300-step book run ≈ **$1.5 per book**, and it is pure overhead.

### B. Context-window failure modes (ordered)
| Window | First thing to break | Trigger | Mitigation |
|---|---|---|---|
| 8k | provider overflow before the tree is even consulted | tools+system ≈ window | starved mode + tool culling (already partially in `agent_loop`) |
| 8k–32k | checklist eats the slack; `ctx_view` answers get cut | `checklist_max_tokens` cap + differential | A1/A3 |
| 32k–128k | summary of a big file doesn't fit alongside the request | `ctx_summarize` forces `via_subagent` | temp sub-agent path (already specified) |
| 128k+ | nothing structural; failure is *quality* (AI over/under-selects) | value score + warnings | D5/D10 |

### C. Prompt caching
* Verified: **no `cache_control` anywhere** in the crate (grep: zero hits). So every step already pays full input; mutating the context does **not** regress cost today.
* But: the moment caching is added (Anthropic/OpenAI both support it), a context that changes per step loses the discount. The delta **D1** (stable prefix: system → tools → locked core → *then* mutable memory → transcript) costs nothing now and preserves the option. **This is the cheapest high-value decision in the whole project.**

### D. Overflow / learned limits
* `OVERFLOW_FACTORS = [0.60, 0.35]` and `context_limits.rs` learned limits already exist — the tree must run **inside** that scaled budget for a retry, and must not persist per-call decisions (invariant I8). Any per-node write during an overflow retry would corrupt the user-visible state ⇒ the "per-call selection overlay" is a hard requirement, not a nicety.

### E. Database growth and quotas
* Node estimate per turn: 1 `turn` + ≈1.5 `turn/call` + ≈1.5 `turn/call/result` + ≈0.5 `file` ≈ **4.5 nodes/turn**.
* At the spec's 4,000-node quota ⇒ **~850 turns**. A 10,000-page book at 300 steps × 40 turns is fine, but a *long-lived* chat (2,000+ turns) **will hit the quota** — so quotas must be **per kind** (turns 3k / results 1.5k / files 1k / notes 500) with GC on the oldest, not one global number.
* `ctx_action_log` at 12 ops/call × 24 calls/turn = 288 rows/turn worst case → trim to 20k rows/session (keep policy rows 2× longer), or the log becomes the biggest table.
* SQLite writes: one transaction per revision; with the existing DB (`turn_memory/store.rs`) that is ~2–4 ms on device *est.*; GC every 50 turns keeps it off the reply path.

### F. Repository and binary growth (the one that hurts operations)
* Measured: **64 MB** added per Android slice rebuild, **98 MB** per iOS xcframework rebuild, `.git` already **454 MB**, and **11 rebuild commits in the last 60**.
* The plan has **9 stages that touch Rust**. If each lands as a rebuild, expect **+0.6 GB (Android) +0.9 GB (iOS) ≈ 1.5 GB** of binary history → slow clones, GitHub size warnings, and every CI checkout gets heavier (the Android job fetches the whole history).
* Mitigations (pick at least two):
  1. **Batch**: 9 stages → **3 milestones** (1–2, 3–5, 6–9); rebuild slices/xcframework once per milestone.
  2. Keep Android slices **out of `main`** during development (build them in a workflow artifact, commit only at milestone).
  3. Never commit `target/`-sized artifacts from a failing build (the stamp script already guards this).
  4. Consider `git gc --aggressive` + `--depth` in CI checkout (Android job already shallow? verify).
* Also: `native-agent-ffi.yml` is **manual dispatch**; `ios-agent-xcframework.yml` **auto-runs on push to main** (paths-scoped) and commits ~98 MB. So the iOS side is the *automatic* offender — gate it (e.g. only rebuild on `rust/**` change at milestone branches).

### G. CI time and gates
* UI job **42.1 min / 60 min limit** with 24 suites; adding `context-tree.js` (~2–3 min) leaves ~15 min headroom. A second new suite (mock + fallback) pushes it to ~47–50 min → **split the UI job** (subagents group / rest) or raise the timeout, but do it *before* Stage 8.
* Rust job is only **3.4 min** — new unit/property/scenario tests are cheap. Good news: the heaviest test investment (scenarios, failpoints) costs ~1 extra minute.
* The Android workflow **holds the Release** until slices match the crate (`ffi-source-stamp.sh`) — so a Rust commit on `main` *silently stops publishing APKs* until a manual FFI rebuild. Nine stages = nine windows where no release ships (or nine manual dispatches). This is the operational cost of the whole project and must be in the plan's rollout section.

### H. Concurrency, locks, races
* Tools execute **in parallel (≤16)** with `ToolNeeds.resources` locks **and a lock timeout** (`tool_scheduler.rs:153`). Consequences:
  1. `ctx_set` is a **write lock on `ctx:<session>`** → two ctx writes in one parallel batch serialize; with the lock timeout they can *fail*, so the limiter must be **per step, counted before dispatch**, not enforced by the scheduler.
  2. The memory worker writes summaries **outside** the tool loop → a `ctx_set` that planned against `rev 41` can face `rev 42`. `expect_rev` + `stale` refusal + "return fresh node" (already in the spec) is **mandatory**, and the UI must tolerate a refused action without a scary toast.
  3. Never take the `ctx:` lock while holding a file lock: order **`ctx` last** (or document `ctx` as a leaf lock) or a `ctx_recall` of a file + a concurrent `write_file` can deadlock until timeout.

### I. Security surface delta
* The system adds **8 write tools** where today the model has only read-only `recall_turns` / `memory_inspect`. That is the biggest trust change in the repo since sub-agents, and `ADR-A5` exists precisely because of it. Net risk after the three-layer design: **the model can change what it sees, never what happened** — so the worst case is *"the AI hides something from itself"*, which is recoverable (`ctx_recall`, and the sources stay in the DB).
* New attack paths to test (beyond the spec's T1–T9): **revision-exhaustion** (spam `ctx_set` to force stale refusals), **category flooding** (create 5,000 categories), **note laundering** (store a malicious instruction in a note, then read it into a later turn — the note is *your own* text, so it must be labelled `[your note]` and never treated as an instruction), **mirror spoofing** (`.context/notes/x.md` edited by the user).
* Approval: ctx tools should be **`approval_policy: None`** (they only change the prompt) — but the *first* time a session uses one, surface a one-line notice in the chat UI so the user is not surprised by "the AI rearranged its memory".

### J. Correctness and drift surface
* `load_system_prompt` has **17 call sites** (mostly tests) — the catalog must be a **byte-identical wrapper** or Stage 2 turns into a test-rewriting exercise. (The spec already says this; M17 quantifies it: 16 tests to keep green.)
* `context.assembly` has **32 references in 11 files** including `57-memory.js`, `memory.js` and `lib.rs` — extending the payload is safe (additive fields), changing field meaning is not. **Rule: only add keys.**
* The tool-group table must be **ported** from `40-permissions.js:21–37` (`files, git, shell, web, memory, docs, auto, device, mcp, ui, agents, other`) with a drift test — the repo has already been bitten twice by exactly this class of drift (bridge allow-list `ce361d0`, `dist/` staleness).

### K. UX and trust
* New vocabulary the user never asked for: *In / Note / Temp / Out*, "essentials", "policy summary", "starved". Every one needs a plain-Bangla/English label in the UI, or it reads as jargon.
* **The single most important screen is "why is this out?"** — `ctx_action_log` + actor (model / policy / user) + reason. Without it, the first unexplained eviction destroys trust in the feature.
* Warnings must never appear as blocking dialogs; the spec's "one line in the checklist" is right. In the chat UI, a compact meter + a single grey line is enough at 320 px.
* Notes/strategy mirrored to `<workspace>/.context/…` is a **very** good call: it makes the AI's inner state auditable with tools the user already has (Files manager), and it survives app removal of the DB.

### L. Does it actually deliver the 10,000-page book?
* **No system can** produce it in one reply: output reserve (typically 1k–8k tokens) is the wall, and no context size changes that. What the tree delivers is **orchestration**: strategy file → chapters as files → notes for continuity → recall on demand → temp sub-agents.
* Honest number: a 10,000-page book at ~500 words/page = 5M words ≈ **6.7M output tokens**. At 1,000 output tokens per step, that is **~6,700 steps**, i.e. ~170 turns of 40 steps. Even at $0.50 per turn that is **~$85** in output alone, plus retries. **The plan must state this**: the feature makes it *possible and resumable*, not *cheap*.
* Practical middle ground worth building as a preset (D8): 100–300 page books (≈ 60k–200k words, ~80–260 steps) — this is where the feature pays off today.

### M. Money (per 1,000 turns, rough)
* ctx tool schemas always on: 1,632 tokens × ~15 steps/turn × 1,000 turns ≈ **24.5M extra input tokens** ≈ $73 at $3/M (or $12 on a $0.50/M model). Merged tool (~500 tokens) → $22 / $3.7.
* Checklist 165/step → same order of magnitude as above; differential render cuts it ~60%.
* So: **the design choice "1 tool vs 8 tools" is worth ~$50 per 1,000 turns.** Cheap to get right, expensive to ignore.

---

## 4. Ranked implications (what actually decides success)

| Rank | Implication | Severity | Amendment |
|---|---|---|---|
| 1 | Tool-schema tax (1,632 tokens, always) on an already tool-heavy request | **high** | **A1**: one `ctx` tool (action enum) + compact schemas, target ≤600 tokens |
| 2 | Binary/repo growth: 64 MB + 98 MB per engine change, `.git` 454 MB | **high** | **A4**: 3 milestones; gate the iOS auto-rebuild; batch slice commits |
| 3 | Two-step release gating (Release held until FFI stamp matches) | **high** | **A5**: rollout doc + one "engine milestone" branch per batch |
| 4 | Small windows already starve; the tree adds cost exactly there | **high** | **A2**: differential checklist + one-line fallback + starved mode tested at 8k |
| 5 | `rev` races with the memory worker + parallel tool batches | **high** | **A6**: lock ordering (`ctx` last) + per-step limiter + `expect_rev` everywhere |
| 6 | "Why is this out?" absent ⇒ trust collapse | med-high | **A7**: `ctx_action_log` + UI explain panel from Stage 4, not Stage 8 |
| 7 | No prompt caching today, but mutating breaks it later | med | **D1** stable prefix (already in plan) |
| 8 | Quotas: one global 4k node cap breaks long chats | med | **A8**: per-kind quotas + GC policy |
| 9 | UI job at 42/60 min | med | **A9**: split UI job or raise timeout before Stage 8 |
| 10 | Byte-identical wrapper for 17 `load_system_prompt` sites | med | already specced; treat as gate |
| 11 | Cost per 1,000 turns ($22 vs $73) | med | follows A1 |
| 12 | The 10k-page promise is orchestration, not capacity | med | state it plainly in the docs (D8 + §L) |

---

## 5. Amendments to the master plan (add these to §18 as D13–D18)

| id | Amendment | Replaces / affects | Cost |
|---|---|---|---|
| **A1** | **One `ctx` tool** with `action` enum (`view/set/category/summarize/recall/note/strategy/prompt`), compact schemas, long docs moved into `sys/core`. Target ≤600 tokens; keep the 8 tool *names* as aliases accepted by the dispatcher so the spec's UX and tests still work | spec §5.1–5.8 | 0.5 d |
| **A2** | **Differential checklist by default** + automatic one-line fallback when `selectable < 4,000` tokens | §7.2 | 0.3 d |
| **A3** | **Tool culling knob**: when `selectable < 4,000`, the engine hides device/ui tool families it has not used in the last N turns (never hides `ctx`), and records it (`context.tools_culled`) | new | 0.7 d |
| **A4** | **3 engine milestones**, not 9 rebuilds; iOS xcframework auto-rebuild gated to milestone branches; slice commits batched | rollout | 0.2 d + process |
| **A5** | **Rollout doc** stating the release-gating consequence and the exact dispatch steps | docs | 0.2 d |
| **A6** | **Lock ordering rule** + per-step ctx limiter counted *before* dispatch; `ctx` is a leaf lock (never held while taking a file/tool lock) | §7 tools | 0.3 d |
| **A7** | **Explain panel in Stage 4** (moved earlier from Stage 8) | §13 | 0.2 d |
| **A8** | **Per-kind quotas** (`turn/`, `res/`, `file/`, `note/`) instead of one global cap | §8.5/§4 | 0.3 d |
| **A9** | Surface `systemTokens` / `toolTokens` in the audit (**M20** — the numbers already exist) — do this in Stage 0, it is the measurement foundation | §12 | 0.1 d |
| **A10** | Prompt the model with the **honest** book math (per-step output limit; steps needed) — a small block in `sys/core`, ~60 tokens | §9 | 0.1 d |

---

## 6. How to verify every number on a real device (cheap, 30 minutes)

1. Send one message on a real phone, then read the `context.assembly` event (or the Memory → Context tab): window, `reservedOutputTokens`, `transcriptBudgetTokens`, `reservedInputTokens`.
2. Add A9 (split system/tool tokens), repeat → **the true tool-schema tax** for that device/capability set.
3. Switch to the smallest model you support (e.g. an 8k-class local model) and repeat → confirms whether the app can function at all there (M: it likely cannot with 100 tools).
4. Run a 40-turn book scenario with the `ScriptedDriver` and count provider overflows (`context.overflow`) — target 0.
5. Time one turn on the device with the tree enabled vs `contextTree=false` (the golden fixture) → assembly overhead (target ≤15 ms).
6. Kill the app mid-`ctx_set` (dev build) → restart → tree loads, mirror rebuilt, no duplicate apply.

---

## 7. Decisions — now with their implications attached

| # | Decision | If **yes** | If **no** |
|---|---|---|---|
| 1 | Enable by default at Stage 3? | users get warnings without the safety net → bad first impression | ship after Stage 6; +1 week, safer |
| 2 | AI may delete its own notes/temp automatically? | workspace stays clean; tiny risk the AI deletes a note it would need (recoverable: notes are mirrored + audited) | notes accumulate → quota pressure in ~6 months |
| 3 | Per-category caps (D2)? | makes an 8k/32k window usable; +0.7 d | categories stay informative only |
| 4 | `render_in_chat` default | temp summarizer output clutters the chat | user never sees what the temp agent said (only its summary) |
| 5 | Standby TTL 1 day vs 7 | 1 d = less storage (mobile!), more re-spawn cost | 7 d = faster reuse, bigger registry, more `max_kept` pressure |

---

## 8. Residual unknowns (verified as unknown, and how to close each)

| Unknown | Why it matters | Close it with |
|---|---|---|
| Real tool-schema tokens on device | decides whether the feature is usable at 8k–32k | A9 + one real turn (§6.2) |
| Device assembly latency with 1,000 nodes | mobile UX | `adb logcat` timing, one profile build |
| Whether the provider accepts **8 extra tools** (some enforce a cap) | hard failure at request time | test one call per provider with 100+ tools |
| SQLite write cost per revision on iOS | GC cadence | Instruments trace, 100 revisions |
| Real-model quality of `ctx_*` usage (does it over/under-prune?) | the whole premise | D9 harness: 20 scripted tasks, measure tokens/task + misses |
| GitHub repo size ceiling for this project | the 1.5 GB risk | `git count-objects -vH` per milestone; decide LFS/artifact storage before Stage 4 |

---

## 9. One-paragraph conclusion

The feature is **sound and buildable**, and the measured implications change *how* to build it more than *whether*: the request already spends most of its non-transcript budget on tool schemas, so the context system must be introduced as **one cheap tool (≈600 tokens) with a differential checklist**, not eight verbose ones (1,632); the engine's binary workflow means Rust work must land in **three milestones**, not nine, or the repository nearly doubles; the risks that will actually bite are **`rev` races and trust**, not token math; and the 10,000-page book is delivered by **orchestration + files + recall** (at real money and real step counts), which the docs must state honestly rather than promise as a context-size victory.
