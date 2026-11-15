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
