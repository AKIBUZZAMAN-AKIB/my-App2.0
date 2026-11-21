# Context Tree — MIGRATION-v7

> temp.md §9 অনুযায়ী memory database-এর schema 6 → 7।

## কী বদলায়

`MEMORY_SCHEMA_VERSION` এখন `7` (`turn_memory/store.rs`)। v7-এ context tree-এর টেবিলগুলো memory-র টেবিলের পাশে একই database-এ তৈরি হয়:

| টেবিল | কী রাখে |
|---|---|
| `ctx_meta` | settings আর চালু/বন্ধ flag |
| `ctx_sessions` | প্রতি চ্যাটের revision আর counter |
| `ctx_nodes` | প্রতিটা item: id, kind, title, state, pin, token, deleted flag |
| `ctx_categories` | built-in আর নিজের (`cat/…`) category |
| `ctx_notes` | note-এর লেখা |
| `ctx_temp_summaries` | summary-র লেখা |
| `ctx_strategy` | strategy-র version, লেখা, পরের ধাপ |
| `ctx_action_log` | কোন item কেন বদলাল (সর্বোচ্চ ২০,০০০ লাইন) |

## কীভাবে চলে

1. database খোলার সময় `ensure_tables` stored version পড়ে; ৭ বা বেশি হলে কিছু করে না।
2. কম হলে write lock নিয়ে **এক transaction-এ**: পুরনো migration, `context_tree::store::ensure_tables`, FTS, v6-এর goal migration, তারপর `schema_version = 7`।
3. মাঝপথে কিছু fail হলে পুরো transaction rollback হয়, পরের বার আবার চলে। সব ধাপ idempotent।
4. version কখনো নিচে নামে না (`WHERE … < excluded.value`)।

## Sub-agent record (stage 7)

Sub-agent-এর record JSON ফাইলে থাকে (sub-agent state ফোল্ডারের `registry.json`), database-এ নয়। নতুন field সব optional, তাই কোনো migration লাগে না:

| field | default |
|---|---|
| `lifetime` | নেই = `reusable`, আগের সব agent এভাবেই থাকে |
| `standbyTtlSecs` | নেই = setting-এর `standby_ttl_secs` |
| `renderInChat` | `false` |
| `reportDelivered` | `false` |
| `keptNote` | নেই |

পুরনো app নতুন record পড়লে অচেনা field উপেক্ষা করে।

## `.context/` mirror

কোনো migration নেই। app চালু হলে context tree চালু থাকলে প্রতিটা session-এর mirror ডেটাবেস থেকে বানানো হয়। ফোল্ডারটা মুছে দিলে পরের চালুতে ফেরত আসে।

## ফেরত যাওয়া (downgrade)

পুরনো (schema 6) app v7 database খুললে `ctx_*` টেবিলগুলো উপেক্ষা করে; memory-র টেবিল বদলায়নি। context tree-এর ডেটা পুরোপুরি মুছতে প্রতিটা চ্যাটে "Reset tree" ব্যবহার করুন।

## পরীক্ষা

`cargo test --lib`-এর `turn_memory/migration_tests.rs`: পুরনো (v5) database ফিক্সচার এক ধাপে v7-এ ওঠে এবং `ctx_nodes`, `ctx_notes`, `ctx_action_log` টেবিল তৈরি হয় (খালি); মাঝপথে থেমে যাওয়া upgrade rollback হয়ে আবার চলে। `.context/` mirror-এর test: `context_tree/mirror.rs` আর `context_tree/wiring.rs`।
