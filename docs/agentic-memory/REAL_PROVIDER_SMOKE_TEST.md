# Real-provider smoke test: plan and results

Run: 15–16 Nov 2026, VM, branch `feat/agentic-context-memory` (`427c64a`, same code as `wip/genui` merge `9a37022`).
**Budget: $0. Free tiers only, no API key** (Akib's decision). Hard cap: no paid provider is reachable from the harness, because OpenRouter, the Free Router's keyed fallback, is pointed at a dead port.

## 1. Plan

| # | Test | How | Pass criterion |
|---|---|---|---|
| 1 | Normal invocation | one-word answer | real 200 response, app emits `agent.completed` with that text |
| 2 | Real context overflow | 3 seeded turns of ~55k estimated tokens, model with a real 32,768-token window | provider rejects, app classifies the error as overflow |
| 3 | Reduction + retry | same turn | the retry request is smaller and the turn completes |
| 4 | Tool call + result preservation | `read_file notes.txt`, then ask again without tools | tool result is sent back to the model and is still in the next prompt's request |
| 5 | Bengali summarization | 14 seeded Bengali turns (port 8742 → 9150 supersede, deadline, hostname…) | memory row is written with Bengali content and the supersede |
| 6 | Historical recall | ask for the port/deadline, then force `recall_turns` | correct answer from memory or `recall_turns` |
| 7 | Context reconstruction across calls | multi-prompt chat with a tool call in between | every request carries the right history, with `context.assembly` before each |
| 8 | Provider usage vs local estimate | compare `usage.prompt_tokens` with `context.assembly.estimatedInputTokens` | numbers recorded |
| 9 | Streaming | default app path | real SSE chunks reach the app |

**How the real path is used.** The ignored Rust test `real_provider_smoke` (`src/real_provider_smoke_tests.rs`) calls the product entry point `NativeAgentHandle::send_message`, which runs the real agent loop, `llm_driver` and memory loop. The only change is `providerBaseUrls` in the runtime config, which is the app's own override. It points `kilo` and `ovhcloud` at a local recording proxy (`tools/real-provider-smoke/proxy.py`). The proxy forwards bytes unchanged and records each real request and response: ids, usage, status and SSE chunks. `run.sh` runs the scenarios and `analyze.py` joins the proxy records with the app's events. Nothing in the product was changed for the test.

**Providers and models (free, used by the app's own routing):**
- **Kilo Gateway free route** `kilo-auto/free`. This is the app's "Free Router" default (`provider: auto`). Every call was served by `nvidia/nemotron-3.5-super-vl:free`, a reasoning model, per the response `model` field. It is anonymous: the app sent no `Authorization` header.
- **OVHcloud AI Endpoints, anonymous tier** (app provider `ovhcloud`, limited to 2 requests per minute per model). `Meta-Llama-3_3-70B-Instruct` was used for tools and Bengali, because it is on the app's OVH tool-model list. `Qwen2.5-VL-72B-Instruct` was used for overflow, with a real window of 32,768 tokens per the provider's own error. The `/models` answer was given `context_length` 60,000 so that the app's estimate (54,946) would send the request.
- Not tested: `Mistral-Small-3.2-24B` (the app refused to send tools to it, because it is not on the app's OVH tool list). Other keyed providers were not tested.

## 2. Results

Provider requests: 32 POSTs in total (Kilo 15, OVHcloud 17, of which 3 returned HTTP 400), plus 22 `/models` GETs. **Cost: $0.** Kilo `usage.cost` was 0 on every response, and OVHcloud was anonymous. No `Authorization` header was ever sent (0 of 54 requests).

| # | Status | Evidence (real ids) |
|---|---|---|
| 1 | **VERIFIED** (Kilo + OVHcloud) | Kilo `gen-1794785128-UfGv4loTjKND4` → "PONG-7", usage 757/26. OVHcloud `chatcmpl-ab0454ab8a185a3c` (x-kong-request-id `781ff34b…`) → "PONG-7" |
| 2 | **VERIFIED, non-streaming only** | OVHcloud HTTP 400 ×3 (kong ids `597fab31…`, `3023ae5b…`, `81adef0a…`): "maximum context length is 32768 tokens… at least 32769 input tokens". The app emitted `context.overflow` attempts 1–3 and `agent.error` with `errorCategory: context_limit`. **With streaming on (the app default)** OVHcloud answered HTTP 200 with only `data: [DONE]` (kong `18096d25…`). The app then emitted `agent.completed` with empty text, and the overflow went **undetected** |
| 3 | **FAILED** | The retry ran, but all three requests were identical: 142,650 characters each, estimate 54,946. Budget 239,760 → 143,856 → 83,916 stayed above the real request, so nothing was cut and the turn ended in `agent.error`. Cause: the window was not reported (catalog `source: not_reported`), so the budget came from a fallback |
| 4 | **VERIFIED** (Kilo + OVHcloud) | Kilo `gen-1794785137-QOWU9M9Xv4zCQ` returned `tool_calls: [read_file]`. The next request (`gen-1794785138-9ETuvHHlSvjvj`) carried the tool result "vault code: TIGER-5521", and the answer was "The vault code written in notes.txt is TIGER-5521." The next prompt, asked without tools (`gen-1794785142-7HOJl9LHLuaI9`), still carried the tool result and answered "TIGER-5521". OVHcloud gave the same result (`chatcmpl-af6bcf2d3670a63d` → `chatcmpl-9a96fedb7e846d37` → `chatcmpl-9b19d7030625b463`) |
| 5 | **FAILED** (both providers) | Kilo: 4 summary calls (`max_tokens` 4096, non-stream), all `finish_reason: length` with 4096 completion tokens (`gen-1794785239-G5jHsjOGP421n` etc.). The reasoning used up the budget, and `memory.failed`: "the answer was not a JSON object". OVHcloud Llama 3.3: wrote a Bengali JSON summary in a ```json fence (`chatcmpl-851b430907bfd89e`, usage 1618/1286), with goal "নীলপদ্ম প্রজেক্টের বিবরণ নির্ধারণ" and the item "পোর্ট 9150 … supersedes". **Validation rejected it:** "superseded entry names unknown decision "N6"", and the repair call (`chatcmpl-b590b8fc5530fa74`) failed the same way. The next attempt hit the app's summary timeout: the request waited 48 s in the harness's 2-per-minute throttle and then took 66 s upstream. No memory row was written. `turn_archive` and `turn_fts` got 15 rows each |
| 6 | **PARTIAL** | The answers were correct: "সার্ভারের পোর্ট: 9150। ডেডলাইন: ২০ ডিসেম্বর।" (Kilo `gen-1794785357-BvXp6NVIq65EM`, the superseded value handled correctly) and "kakatua-17.lan" (Kilo and OVHcloud). Real models **did call `recall_turns`** (Kilo `gen-1794785444-vFIfveqBqjCHO`, OVHcloud `chatcmpl-a96990d232b13689`). But because no memory had formed (test 5), `recall_turns` answered "Nothing is summarized in this chat yet" by design, and the answers came from the history still in context. **FTS recall over summarized turns is not verified on a real provider** |
| 7 | **VERIFIED** (history across calls) | 3 prompts and 4 calls per provider: each request held the previous turns and the tool result, and a `context.assembly` was emitted before each one (4 of 4 Kilo, 4 of 4 OVHcloud). Rebuilding from memory summaries is not verified (test 5) |
| 8 | **MEASURED** (Kilo) | estimate → provider `prompt_tokens`: 431→757, 895→794, 657→937, 1254→964, 2538→2911, 3430→3004, 3293→3280 (ratio 0.57–1.30). OVHcloud: no usage on streamed answers, because the app does not send `stream_options.include_usage`. Non-streamed summary usage was 1618/1286. Overflow: estimate 54,946 vs provider "at least 32,769", a lower bound because the provider stops counting at the limit |
| 9 | **VERIFIED** (Kilo + OVHcloud) | real SSE: Kilo 9–113 chunks per answer, OVHcloud 6–39. Example: OVHcloud `chatcmpl-a96990d232b13689` had first byte at 5,033 ms. The app emitted streaming text events |

## 3. Findings to fix (by priority)

1. **Overflow retry does not shrink** when the model's window is unknown (test 3). Read `maximum context length is N` from the error and set the retry budget to `min(N, estimatedInput) × 0.6/0.35`. Also remember N for that model.
2. **Streaming overflow is silent** (test 2). Treat an empty stream (no content, no tool call, no `finish_reason`) as an error and retry once without streaming, so the overflow path can see the 400.
3. **Memory summaries fail on free models** (test 5). For reasoning models, send `reasoning: {effort: low}` or exclude reasoning, or raise the summary budget. Give the summarizer the valid decision ids, or drop unknown `superseded` entries instead of rejecting the whole summary. Add a real-provider test for the summary JSON.
4. **Token estimate** misses system prompt and tool schemas (test 8). Add them, and ask for `stream_options.include_usage` where the provider supports it.

## 4. Not done

Keyed or paid providers (OpenAI, Anthropic, Gemini and others). Mobile devices. Long chats where memory actually folds on a real model. The `grep_files` paging tool with a real model.

Raw records: `/home/sprite/memory-audit/smoke2/` on the VM (proxy `requests.jsonl`, bodies, `analysis.jsonl`, app events). They are not committed because they hold full prompts.

## 5. Re-run after the fixes (16 Nov 2026, branch `feat/agentic-context-memory`)

Same harness, free keyless providers only, $0: Kilo `kilo-auto/free` (served by `nvidia/nemotron-3.5-super-vl:free`) and OVHcloud AI Endpoints anonymous (`Meta-Llama-3_3-70B-Instruct`; `Qwen2.5-VL-72B-Instruct`, real window 32,768, for overflow). 30 model requests (OVHcloud 18, Kilo 12) plus 16 catalog GETs. No key or Authorization header was sent. Kilo reported `usage.cost: 0` on every response that carried usage (5 non-streamed). Raw records: `/home/sprite/memory-audit/smoke3/` (not committed: full prompts).

Only results observed in the real request/response are marked verified.

| # | What | Result |
|---|------|--------|
| 1 | Overflow detected **with streaming on** (app default) | **Verified.** OVHcloud answered the streamed 142,650-char request with HTTP 200 + only `[DONE]` (proxy #3). The driver asked once more without streaming (#4) and got the real HTTP 400 "maximum context length is 32768 tokens … at least 32769 input tokens". |
| 2 | Retry actually smaller, and it succeeds | **Verified.** `context.overflow`: window 32,768 parsed, learned limit recorded, next transcript budget 22,938 (was 239,760 → 143,856 → 83,916 before). The retry transcript was 234 est. tokens / 680 chars (#7, was 54,946 / 142,650); the compacted history was summarised by a non-streamed call (#6, provider `prompt_tokens` 9,319). The model answered correctly: "Your very first question in this chat was about describing item set 1 in detail." Two provider calls for the overflow instead of three identical failures. |
| 2b | Learned window used on the next turn | **Verified.** Turn 2: `context.limit_resolved` source `learned_from_provider_error`, 32,768, output capped to 8,192; budget 22,528; no overflow; answer "ACK-3" (#10). |
| 3 | Bengali summary creates memory | **Verified on both providers.** Kilo: two cut-off answers (`finish_reason: length` at 4,096, no JSON) were each retried with 8,192 (`memory.summarizer_retry`), then saved: version 1, 4 segments, 6 current decisions; one stray reference dropped ("N5" supersededBy "N6"). OVHcloud Llama: saved on the correction round: version 1, 6 segments, 6 current decisions; dropped "N7" (supersededBy "N5") and "new fact supersedes unknown item N8". Before the fix both runs saved nothing. |
| 3b | Reasoning hint on Kilo | **Sent, but not honoured by this model.** The summarizer sent `reasoning: {"effort":"none"}`; nemotron still spent ~4,000 reasoning tokens. Direct probes (same route): none of `effort:"none"`, `enabled:false`, `max_tokens:64`, `/no_think`, `chat_template_kwargs.enable_thinking:false` turned reasoning off (141–355 reasoning tokens on a tiny prompt, run-to-run noise). The length retry is what made it work here. |
| 4 | FTS recall through `recall_turns` returns real results | **Verified.** OVHcloud Llama called `recall_turns` twice; results said "Found in the memory index: turn 2, turns 5-6. Found by full-text search of the original turns: turn 2, turns 5-6" and "…full-text search…: turn 3"; answers "পোর্ট নম্বর 9150 … ডেডলাইন ২০ ডিসেম্বর" and "kakatua-17.lan". Kilo also called `recall_turns` (turns 1–7) and got the turn-3 quote; answer "kakatua-17.lan". |
| 5 | Context rebuilt from memory across calls | **Verified.** `memory.applied`: 14 messages folded into memory, 7–8 recent turns kept, memory block 869 (Kilo) / 671 (OVHcloud) tokens; the next main call answered from it: Kilo "সার্ভার পোর্ট: ৯১৫০ ডেডলাইন: ২০ ডিসেম্বর". |
| 6 | Tool call / result pairing, history, streaming | **Verified on both** (read_file → "TIGER-5521", follow-up without tools correct, "PONG-7"). |
| 7 | Token estimate vs provider `prompt_tokens` | **Measured; mixed.** Kilo `kilo-auto/free`: 431/757, 895/794, 1,352/965 (est/actual 0.57, 1.13, 1.40); nemotron key: 657/937; Bengali run: 3,025/3,329, 3,586/3,421, 4,029/4,158 (0.91, 1.05, 0.97). The first request per key is uncalibrated; after it the errors lean high (safe for budgeting) but the spread in this short run was not smaller than before. Offline replay of the seven earlier Kilo counts: within 7.4 % after two requests. OVHcloud streamed answers still carry no usage, so nothing to calibrate there. Correction: system prompt and tool schemas *were* already in the estimate (e.g. 411 of 431 tokens); the earlier finding 4 was wrong. |

Commits: `fix(context)` overflow window, `fix(provider)` empty stream, `fix(memory)` summarizer, `fix(tokens)` calibration, then this report.

## 6. Superseded decisions fix and re-run (16 Nov 2026, branch `feat/agentic-context-memory`, fix commit `cbdd1b3`)

### 6.1 Root cause, confirmed from the raw records (`/home/sprite/memory-audit/smoke3/`)

The seeded conversation changes the server port **8742 → 9150** (turns 5 → 6), not 8080 as written in the task brief.

- **Kilo `kilo-auto/free` (nemotron), saved answer:** `current` held `{"id":"N6","text":"সার্ভার পোর্ট 9150"}`; `superseded` held only `{"id":"N5","supersededBy":"N6"}`. "N5" was a temporary label the model never defined anywhere (no text, not under `current`). Code (5cf080b) could not resolve it: `memory.dropped_refs` = `superseded entry names unknown decision "N5" (supersededBy "N6")`. Result: 6 current, **0 superseded**; the old port existed only as fact F5 (superseded by F6).
- **OVHcloud Llama-3.3-70B, saved answer:** `superseded` `{"id":"N7","supersededBy":"N5"}`, N7 never defined; the item op `supersedes: "N8"` also named an undefined label. Dropped both. Result: 0 superseded decisions and **no record of 8742 at all** (fact F5 = 9150 only).
- So the brief's inferred cause was half right: the links failed because model-side temporary labels were never mapped to code-generated stable IDs (`apply_update_logged` only mapped labels of decisions listed under `current`, and `items::apply_ops_logged` had no label map at all). In these two runs the old value was not listed as current, so the outdated port was *lost from history*, not shown as current. The other shape the code allowed (both values listed under current with no link, or a `supersededBy` that does not resolve) **does** leave both current; the new unit test `both_values_listed_as_current_without_a_link_the_later_turn_wins_bengali` reproduces it on the old code path.

### 6.2 What changed (`cbdd1b3`)

- `turn_memory.rs` `apply_update_full`: two-pass resolution. Pass 1 gives every new decision its stable `D<n>` and maps the model's label to it; a decision made **and** replaced inside the batch may be defined inline under `superseded` (`text` + `madeInTurn`; when `madeInTurn` is missing, the turn of the one matching fact/preference in the same answer). Pass 2 resolves `supersededBy`/`supersedes` through the label map, then stored IDs, then an exact (case/space-insensitive) text match of exactly one decision. A label that matches nothing is still dropped and logged.
- Recovery of a text-less label (the shape both live models produced): if the replacement decision has a `key` and the same answer superseded exactly one *new* fact/preference with that key, before the replacement's turn, that value becomes the superseded decision (`origin: "summary-recovered"`, logged in `memory.auto_superseded`). Zero or two candidates: nothing is invented.
- `turn_memory/slots.rs` (new), deterministic slot rule, no model call: two current decisions (or facts, or preferences) are the same subject only when **both have the same explicit `key`**, or, when a key is missing, their texts are identical after removing **one trailing value token that contains a digit**, with at least two words left. Different keys never match. The strictly later turn supersedes; a tie or an unknown turn (0) changes nothing (logged). Files and open items never take part. Precedent: Graphiti/Zep invalidate an old edge only against a new one about the same entity pair and let the newer win, and forbid treating facts as contradicted from shared words alone.
- `turn_memory/items.rs`: items get temporary labels too (`"id": "T1"` on an add, referenced by a later or earlier add's `supersedes`); a label equal to a stored ID keeps meaning the stored item.
- Optional `key` on decisions and items (serde-skipped when empty, so old rows load unchanged), shown in the summary context; the summarizer, merge and portion prompts ask for keys and for both sides of a same-batch change.
- Events: `memory.auto_superseded`; `droppedRefs`/`autoSuperseded` in the version detail and background `memory.updated`.
- Unchanged: lost current decision, revived superseded decision, coverage gaps, turn validity, invented D-numbers, repair strictness, stable ID counter, versioning, atomic save. The parallel-portion path goes through the same `apply_update_full` (merge answer), and the incremental path (decision in DB, change in a later batch) is covered by explicit links and by the slot rule.

### 6.3 Re-run (free, keyless, $0; raw records `/home/sprite/memory-audit/smoke5/`, not committed)

19 model POSTs (OVHcloud `Meta-Llama-3_3-70B-Instruct` 13, Kilo `kilo-auto/free` → `nvidia/nemotron-3.5-super-vl:free` 6), all HTTP 200. Authorization header on 0 requests. Kilo `usage.cost` 0 on all 6.

| Scenario | Memory after the summary | Answer / recall |
|---|---|---|
| Kilo Bengali | **Verified.** v1, 5 current, **1 superseded**: D6 "সার্ভারের পোর্ট 8742" (turn 5) superseded by D5 "সার্ভারের পোর্ট 9150" at turn 6, reason "8742 অন্য সার্ভিস নিয়েছে, তাই পোর্ট 9150 করা হয়েছে". The model again sent a text-less label "N5"; recovered from fact F6 (key "server port"). One length retry (4,096 → 8,192). | Answered from memory (14 messages folded): "সার্ভারের পোর্ট: ৯১৫০। ডেডলাইন: ২০ ডিসেম্বর।" `recall_turns` status lines: "D6 (turn 5) … was SUPERSEDED by D5 … D5 is current". |
| OVHcloud Bengali | **Verified.** v1, 6 current, **1 superseded**: D7 "8742" (turn 5) superseded by D5 "9150" at turn 6 (text-less label "N7", recovered from fact F5). One correction round. | Llama called `recall_turns`: "The server port is 9150 (from turn 6, current)"; status "D7 (turn 5): "8742" was SUPERSEDED by D5 ("9150") at turn 6". Answer "সার্ভারের পোর্ট এখন 9150, আর প্রজেক্টের ডেডলাইন 20 ডিসেম্বর।" Staging: "kakatua-17.lan". |
| OVHcloud English (new scenario) | **Verified.** v1, 5 current, **1 superseded**: D5 "server port 8742" (turn 5) superseded by D6 "server port 9150" at turn 6, reason "another service took 8742". The model defined the old decision inline (text + key, no `madeInTurn`); turn taken from fact F5. | `recall_turns` → answer "The server port is 9150 (turn 6, current), which was changed from 8742 (turn 5, superseded) because another service took 8742. The deadline is December 20 (turn 2, current)…" |

A pre-final run (`smoke4-pre`, code before the recovery and item-turn rules) showed the gaps those rules close: OVHcloud Bengali and English still saved 0 superseded (text-less "N7"; inline entry without `madeInTurn`), while Kilo, which that time listed both N5/N6 under current, saved 1.

Not verified: Kilo English (not run, to stay inside free-tier limits); a real cross-batch change (covered by unit tests only); the parallel-portion path with a real provider (mock loop test only).
