# AGENTIC_MEMORY_PROGRESS — living progress file

Branch `feat/agentic-context-memory` from `origin/wip/genui` = `4778059`. Spec: user's `Writing.txt` (copy at `/home/sprite/memory-audit/SPEC_Writing.txt`, not committed).
Docs: `docs/agentic-memory/` (01 audit, 02 feature matrix, 03 architecture, 04 test & performance report, 05 migration report).
Status values: NOT_STARTED / IN_PROGRESS / BLOCKED / IMPLEMENTED / TESTED / VERIFIED (VERIFIED = connected to the real loop and covered by an executed test).

## Per-requirement status

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| P0 | Repository research, audit report | VERIFIED | `docs/agentic-memory/01-AUDIT_REPORT.md` |
| P1 | Feature matrix | VERIFIED | `docs/agentic-memory/02-FEATURE_MATRIX.md` |
| P2 | Architecture + lifecycles + ADRs + research log | VERIFIED | `docs/agentic-memory/03-ARCHITECTURE.md` |
| D2 | FTS5 retrieval over original turns (schema v5) | IN_PROGRESS | `turn_memory/fts.rs`, `fts_tests.rs` |
| E4 | Provider overflow recovery | NOT_STARTED | |
| A4 | Context assembly record / observability | NOT_STARTED | |
| E5 | grep continuation (no first-N cut) | NOT_STARTED | |
| F1 | `memory_inspect` reachable by the loop | NOT_STARTED | |
| H4 | UI version comparison + context panel | NOT_STARTED | |
| L1 | Ground-truth long-conversation benchmark + metrics | NOT_STARTED | |

## Commits

(appended per commit)

## Next step

Commit FTS (D2) with tests; then E4 overflow recovery.
