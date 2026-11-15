# Pre-merge report: `feat/agentic-context-memory` → `wip/genui`

Review date: 15–16 Nov 2026. Reviewer: the agent, on the VM worktree `/home/sprite/acm`.
**Decision: SAFE TO MERGE into `wip/genui` (not `main`).** The reasons and every check are below. Real-provider findings (Phase 2) that appeared during the review are listed under "Known issues carried into wip/genui". None of them is a regression against `wip/genui`.

## 1. Refs (after `git fetch`, confirmed with `git ls-remote`)

| Ref | Hash | Note |
|---|---|---|
| `origin/wip/genui` | `4778059` | has not moved since the feature branch was created |
| `origin/feat/agentic-context-memory` | `eae0a3d` | 8 commits on top of `4778059` |
| `origin/main` | `5dd7f88` | not touched |
| tag `backup/wip-genui-pre-memory-aea3dbd` | → `aea3dbd` | backup from the earlier merge |

`git merge-base --is-ancestor origin/wip/genui eae0a3d` is true, so `wip/genui` is a strict ancestor. A fast-forward is possible, a textual conflict is impossible, and the merged tree equals `eae0a3d` exactly.

## 2. The eight commits (24 files, +1964 / −23)

| Commit | Content | Review notes |
|---|---|---|
| `4e93d33` | docs P0–2 (audit, matrix, architecture) | docs only |
| `df137d3` | FTS5 over `turn_archive`, schema v4→v5, `recall_turns` merges segment hits with FTS hits | additive migration inside a savepoint. Tokenizer `unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 0` keeps Bengali vowel signs/virama inside words. A delete trigger keeps FTS in step with retention. `turn_archive` rows are never updated in place, so no update trigger is needed |
| `3c7e053` | `agent_loop/assembly.rs`: `context.assembly` event before every model call, overflow detection, retry at 60% then 35% budget (max 2) | rate-limit/TPM/quota errors are excluded from overflow. Wired into the real `agent_loop.rs` call path (seen on a real provider, §6) |
| `5813e7b` | `grep_files` `offset`/`nextOffset` paging | additive tool argument. Old calls behave as before |
| `2d133f0` | read-only `memory_inspect` tool + loop test | no write tool exposed to the model (ADR-A5) |
| `3a994be` | 400-turn retrieval benchmark (Rust test) | test-only |
| `be043da` | UI: memory version compare (LCS diff), Context tab | `www/agent.html` matches `tools/agent-html-src/build.py` output (rebuilt and compared byte-for-byte: identical) |
| `eae0a3d` | docs 04–06 + progress file | docs only |

Sub-agent code is untouched. No file under the sub-agent engine/UI (`subagents*`, `team.rs`, `10-subagents.js`) appears in `git diff --name-only 4778059..eae0a3d`.

## 3. Conflicts and regression risk

- **Textual conflicts:** none possible (ancestor relation, §1).
- **Behavioural overlap with `8ed7c6d`** (nested spawn, topologies, templates, Always Allow, graph): `8ed7c6d` is an ancestor of both branches, and none of its files are changed by the eight commits. Its tests still pass on `eae0a3d`: the Rust lib suite includes the sub-agent engine tests (471/471 pass in total), and the UI `subagents` suite is 155/155. The real-loop depth-3 check and the UI bugs found by the separate sub-agent audit are unchanged by this branch: they neither get better nor worse.
- **Tool schema:** two additive changes, `memory_inspect` and grep `offset`. A provider that strictly validates tool lists still receives valid JSON schema (real requests in §6 carried `read_file, grep_files, recall_turns, memory_inspect` and were accepted by Kilo).
- **Cost regression (minor, found in Phase 2):** on a real overflow the retry re-sends an identical request twice when the app does not know the model's real window (§7, issue K1). Before this branch the turn failed after one request. Now it fails after three. The result is the same, but the wasted calls are paid ones.

## 4. Checks run on `eae0a3d` (real exit codes)

| Check | Result |
|---|---|
| `cargo check --lib` | exit 0 |
| `cargo test --lib` | exit 0: **471 passed, 0 failed** |
| `cargo clippy --lib` | exit 0, 66 warnings (base `4778059`: 65). The +1 is a style lint. CI does not run clippy |
| `cargo fmt --check` | exit 1. This is pre-existing: base `4778059` already has 1733 diff hunks and the feature branch has 1819. The repo is not rustfmt-formatted, and CI does not run fmt |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | first run exit 1: `tests/staging.test.ts` `beforeAll` hit its 10 s timeout while cargo was compiling in parallel (440 passed, 5 skipped). Re-run alone: **exit 0, 31/31 files, 444 passed, 1 skipped** |
| `npm run validate:config` | exit 0 |
| `npm run check:plugin-dist` | exit 0 |
| `npm audit --audit-level=moderate` | exit 0, 0 vulnerabilities |
| `tools/agent-html-tests/run-all.sh` (16 suites) | 15 suites pass in full (subagents 155, s1 206, files 299, feat 320, ui2 550, v2 392, r3 700, vault 83, genui 736, folders 344, tools 95, turnbar 88, stream 200, controls 443, **memory 345**). `render` 110/112 |
| `render.js` re-run alone, 3× | 112/112, 111/112, 111/112. The failing check is the known flaky "no layout jumps while streaming" at 320×640 (timing of a table wrapper), unrelated to these commits |
| GitHub Actions "Verify" on `eae0a3d` | run `43737794879`: **completed / success** |
| `agent.html` rebuilt from sources | byte-identical |

## 5. Context tab and memory version compare

Covered by the `memory` UI suite (345/345, including the new compare and Context-tab checks) against the real `57-memory.js` code with a mock bridge. On a real provider (§6), the event the Context tab reads, `context.assembly`, is emitted with real numbers: `bySource`, `estimatedInputTokens`, `reservedOutputTokens`, `overflowRetry`, `actions`. **Not done:** viewing the tab in the shipped Android/iOS app, and visually checking screenshots.

## 6. Is it reachable from the real agent loop? (observed with real providers, Phase 2)

These were driven through `NativeAgentHandle::send_message` → agent loop → `llm_driver`, with Kilo free routes and OVHcloud anonymous endpoints (details in `REAL_PROVIDER_SMOKE_TEST.md`):

- `context.assembly` is emitted before every real call (17 `context.assembly` events for 17 real chat requests, counted across the smoke runs at review time).
- Overflow detection fires on a real provider error (`context.overflow` ×3 on an OVHcloud HTTP 400), and the retry runs with budget 239,760 → 143,856 → 83,916.
- `recall_turns` and `memory_inspect` are offered to the real model, and a real model called `recall_turns` and got its result back.
- `turn_archive` + `turn_fts` are written by the real loop (15 archived turns → 15 FTS rows in the Bengali chat).
- `grep_files` paging: unit/loop tests only, not exercised by a real model.

## 7. SQLite migration

The fixture was built with the **old code** (`wip/genui` = `4778059`, schema v4): `ensure_schema` + `ensure_tables`, then two chats archived (35 turns, Bengali text). The upgraded copy was then opened with the **new code** (`eae0a3d`):

- `schema_version` 4 → **5**. `memory_meta.fts` = `ok; backfilled 35 turns`.
- `turn_archive` rows 35 → **35**, and the per-row fingerprint (session, turn, payload length) is identical before and after.
- `turn_fts` rows **35**. Search works in both chats, and the Bengali word `স্টেজিং` is found.
- **Re-run (idempotency):** reopened, `ensure_tables` called twice more, and the result is still v5 / 35 / 35, with no second backfill and `PRAGMA integrity_check` = `ok`.
- **Pre-memory DB** (base schema only, no memory tables) → v5, `turn_fts` created.
- Existing Rust tests also cover a v4→v5 backfill (`an_existing_v4_database_is_backfilled_without_losing_rows`) and keeping FTS in step on rewind/reset/rewrite (`rewind_reset_and_rewrite_keep_the_index_in_step_with_the_archive`).
- **Not covered:** v1–v3 databases were not rebuilt from old commits. Their path is the existing v1→v4 chain followed by the same v5 step. A device's SQLite build: the app uses `rusqlite` with the bundled SQLite, which is compiled with FTS5 enabled, so the migration does not depend on the phone's system SQLite.

## 8. Known issues carried into `wip/genui` (none block a wip merge)

- **K1, overflow reduction can be a no-op (real provider).** When the model's window is not reported (OVHcloud catalog → `source: not_reported`), the budget falls back to a configured 239,760 and the 60%/35% cuts stay above the real 54,946-token request. Result: three identical 142,650-char requests, then `agent.error`. Fix: parse `maximum context length is N tokens` from the error, and cap the retry budget at `min(budget, estimatedInput) × factor`.
- **K2, streaming overflow is silent on OVHcloud.** With `stream: true`, the provider answered HTTP 200 with only `data: [DONE]`. The app ended the turn as `agent.completed` with empty text and no overflow handling. This is pre-existing stream handling, but the new recovery cannot see it. Fix: treat an empty stream (no content, no tool call, no finish_reason) as an error, and retry once without streaming.
- **K3, memory summarizer and reasoning models.** On `kilo-auto/free` (served by `nvidia/nemotron-3.5-super-vl:free`) the summary call (`max_tokens` 4096, non-stream) used all 4096 tokens on reasoning (`finish_reason: length`) four times. Memory was never formed (`memory.failed`: "the answer was not a JSON object"). The same scenario on OVHcloud Llama 3.3 is in the smoke report.
- **K4, local token estimate vs provider.** The estimate leaves out tool schemas and the system prompt. Example: 431 estimated vs 757 provider `prompt_tokens` on the first Kilo call. Numbers are in the smoke report.
- Earlier carry-overs: `subagents.rs::set_settings` resets everything on one bad key. Sub-agent UI approval bugs (separate audit).

## 9. Merge plan (executed only because §3–§7 hold)

1. Create and push an annotated tag `backup/wip-genui-pre-agentic-4778059` → `4778059`.
2. `git merge --no-ff` of the feature branch (including this report and the progress fix) into `wip/genui`, non-force push, and `git ls-remote` check.
3. Check GitHub Actions "Verify" on the new tip.
4. Revert path: `git revert -m 1 <merge>`. An exact reset needs a force-push from the backup tag, which is done only on explicit request.
