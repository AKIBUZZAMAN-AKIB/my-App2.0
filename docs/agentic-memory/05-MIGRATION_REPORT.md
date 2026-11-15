# Database migration report

## Schema v4 → v5 (this branch)

File: `plugins/native-agent/rust/native-agent-ffi/src/turn_memory/store.rs` (`MEMORY_SCHEMA_VERSION = 5`), `turn_memory/fts.rs` (`create_and_backfill`).

| Change | Kind | Data effect |
|---|---|---|
| `CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(session_key UNINDEXED, turn_no UNINDEXED, body, tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 0")` | additive | new table; no existing row changes |
| `CREATE TRIGGER IF NOT EXISTS turn_archive_fts_delete AFTER DELETE ON turn_archive` | additive | deletes the index row of an archive row that is deleted (rewind, reset, chat deletion, retention) in the same transaction |
| Backfill: one `turn_fts` row per existing `turn_archive` row (`rowid` = archive `rowid`) | additive | reads archive rows; writes only the new table |
| `memory_meta.fts` = `ok; backfilled N turns` or `unavailable: <reason>` | additive | new meta key |
| `memory_meta.schema_version` 4 → 5 | update | only raised, never lowered (existing `WHERE CAST(..) < CAST(..)` guard) |

No table, column or row of user data is dropped or rewritten. Current memory, versions, items, archive and stored results are untouched.

## Safety properties

- **One transaction.** The upgrade runs inside the existing `write_tx` (BEGIN IMMEDIATE). The index work runs under `SAVEPOINT turn_fts_setup`; if it fails (for example a SQLite build without FTS5) it is rolled back to the savepoint, the reason is stored in `memory_meta.fts`, and the rest of the upgrade commits. Retrieval then uses the memory index alone (`fts::available` is false), exactly as on v4.
- **Idempotent.** `IF NOT EXISTS` everywhere; `create_and_backfill` returns at once when the table exists; `ensure_tables` returns at once when the stored version is ≥ 5.
- **Concurrent openers.** `ensure_tables` re-checks the version inside the write transaction (existing pattern), so two connections cannot both backfill.
- **Index writes are in the archive's transaction.** `archive_turns` calls `fts::index_turn` only when the archive row actually changed, inside the same transaction, so the index can never describe text the archive does not hold.
- **Downgrade.** An older build ignores `turn_fts`; if it deletes archive rows, the trigger still removes their index rows (the table exists), so a later upgrade sees a consistent index. A database opened by v4 code never loses data because of v5 objects.

## Tests that ran (cargo test --lib, see the test report for counts)

- `turn_memory::fts_tests::an_existing_v4_database_is_backfilled_without_losing_rows` — builds a v4-shaped database (archive rows, no index, version 4), upgrades it, checks the archive row count is unchanged, the index has one row per archived turn, search works, and `memory_meta.fts` = `ok; backfilled 2 turns`.
- `turn_memory::fts_tests::the_bundled_sqlite_has_fts5_and_the_index_is_created` — fresh database: version 5, `fts` ok.
- `turn_memory::fts_tests::rewind_reset_and_rewrite_keep_the_index_in_step_with_the_archive` — `forget_after`, a rewritten turn (re-indexed, not duplicated) and `reset_memory` keep `turn_fts` equal to `turn_archive`.
- `turn_memory::fts_tests::without_the_index_search_is_empty_and_archiving_still_works` — index missing: archiving and loading still work; search returns nothing.
- `turn_memory::retention_tests` (existing) — schema-version assertion updated from 4 to 5; retention behaviour unchanged.

## Size cost (measured in the benchmark)

See `04-TEST_AND_PERFORMANCE_REPORT.md`: page counts of the same 400-turn database with and without the index, after `VACUUM`.

## Not done

- If a device's SQLite lacked FTS5 at upgrade time, the version is still raised to 5 and the index is not retried later. The bundled SQLite has FTS5 (also used by `doc_index.rs`), so this path was exercised only by dropping the table in a test.
