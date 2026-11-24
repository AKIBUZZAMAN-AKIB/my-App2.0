# my-App2.0: unified context tree, peer identity, groups and shared memory (5-phase plan + Phase 0)

Repo: `AKIBUZZAMAN-AKIB/my-App2.0`, branch `main`, commit `ef10774` (2026-11-23). Cloned and read in full on the VM. This plan replaces the attached `my-App2.0-unified-context-tree-plan.md` ("the old plan") as the build plan. It keeps the old plan's good ideas, corrects what the code contradicts, and cuts the work into phases that each build, test and ship on their own.

Scope note: as you asked, this delivers the plan only. No code was changed and no `.patch` files were made. Each phase still ends with the exact command that creates its patch after its tests pass.

Revision (2026-11-23): your answers to the four open questions are now built into the phases. Section 3a lists each decision and where it lands. The code facts behind the new parts (the memory provider's record format, `send_comm`'s wake flag, the agent status values, the `shareable` flag) were checked again at `ef10774`.

The rule from your first brief still holds everywhere: **sharing references the same memory location and never copies it**, and deleting a chat or changing a permission never deletes shared items by default.

> বাংলা নোট: প্রতিটা phase আলাদাভাবে build + test করা যাবে। Test পাস করার পরেই `phaseN.patch` বানাবে, আগে না।

---

## 0. Baseline measured on the VM (before any change)

| Check | Command | Result |
|---|---|---|
| Rust engine unit tests | `cd plugins/native-agent/rust/native-agent-ffi && cargo test` | **845 passed, 0 failed, 1 ignored** (about 37 s; a clean build takes about 1 min 40 s) |
| WebView unit tests (vitest) | `npx vitest run` (repo root, after `npm ci`) | **31 files, 451 tests passed** |
| Context tree UI (Playwright, mocked bridge) | `python3 tools/agent-html-src/build.py && node tools/agent-html-tests/context-tree.js` | **82/82 passed** |
| `build.py` is deterministic | rebuild, then `git status` | `www/agent.html` unchanged |

The UI suite needs `playwright-core` plus the `chromium-headless-shell` browser and its system libraries (`npx playwright-core install-deps chromium-headless-shell`). Install it outside the repo, or the test folder picks up an extra `package.json`/`node_modules`.

Every phase below must leave these three suites green (with the specific test changes listed in that phase) before its patch is cut.

---

## 1. Where things live today (verified map)

Engine crate: `plugins/native-agent/rust/native-agent-ffi/src` (Rust, rusqlite, uniffi). WebView UI: `tools/agent-html-src/*.js`, built into `www/agent.html` by `build.py`. Bridge: `bridge/nativekit.ts`, `plugins/native-agent/src/definitions.ts`.

| Concern | Files (lines) | What is there |
|---|---|---|
| Engine entry, app requests | `lib.rs` (5,143) | `subagents_request` gates prefixes at about line 2140 (`memory.`, `ctx.`, `agents.`, `social.`), then `memory_action` (line 2209) routes `agents.*`, `social.*`, `ctx.settings/tree/set/reset`, `memory.*`. `clear_session` (about line 1090) only drops the in-memory session; it deletes nothing on disk. |
| Sessions, messages | `db.rs` (4,508) | `sessions` and `messages` tables. `db::clear_session` (about line 515) deletes messages, tool results, turn memory, scratchpad notes. It is called only from the sub-agent runner's `clear`, so only when a sub-agent or its chat is deleted. |
| Message type | `types.rs` (855) | `Message { role, content, … }`. No sender identity field. |
| Turn memory | `turn_memory.rs`, `turn_memory/*` | Range summaries, results; `MEMORY_TABLES`; `write_tx` (BEGIN IMMEDIATE). |
| Context tree engine | `context_tree/` (`store.rs`, `model.rs`, `memory_checklist.rs` 1,811, `tools.rs`, `wiring.rs`) | `ctx_*` tables (nodes, picks, notes, temp summaries, strategy, action log, sessions), checklist tables `ctx_mem_*` (picks, versions, tags, files, file_store, longterm, status). `store::reset_session` (about line 985) deletes a session's `ctx_*` rows. Checklist groups include `mem.files` (files the model read in this chat). `tools.rs` keeps the `ctx` tool schema under `MAX_SCHEMA_CHARS` (2,300). |
| Context tree UI | `58-context-tree.js` (1,633) | Rows come from the WebView `ChatStore`; it filters out `subagent:` threads. Already has a partial sub-agent memory view (`panel.memKey`, lines about 1062 and 1281). Calls the engine through `kit.agent.subagents({action})`. |
| Memory panel (older) | `57-memory.js` (959) | Earlier memory UI that overlaps the tree's Memory group. Now the chat-memory data layer behind the context card's Summary and Settings tabs; kept (see Phase 5 item 7). |
| Sub-agents | `subagents.rs` (5,866) + `subagents/` | Registry `registry.json`; per-agent memory in `memory/<name>.json` (keyed by sanitised **name**, so a rename or two agents with one name collide); `TrackedFile` list; `hidden`, `hidden_from`, `shareable` flags; `handle_app_request` ops including `delete`, `deleteData`, `memory` (`promote` copies entries into main memory). |
| Peer messages | `subagents/team.rs` (812) | `message_peer` (`to`, `text`) pushes `[Message from sub-agent "X" (id …). Reply with message_peer if you can.]` into the target's inbox. Inbox is folded by `compact::fold_notes` when it is over budget, which shortens older notes. |
| Channels, topics, requests, blackboard | `subagents/channels.rs` (1,763), `comms.rs` (327) | Broadcasts, `#topic` posts, request/reply, user-to-all; each builds its own text header (`[Broadcast from …]`, `[Post on #t from …]`, `[Reply to request …]`, `[Message from the user to all agents]`). Topic history folds via `compact::fold_queue`. |
| Cross-chat ask | `subagents/cross_session.rs` (441) | Writes `[Message from your other chat "…" …]` into the other main chat. |
| Swarm | `subagents/swarm.rs` (1,243) | Auctions, voting, topology tools. |
| Agent hub (mail + social) | `agent_hub.rs` (534) | `hub_messages` (`from`, `to`, `reply_to`, `ttl`), `hub_posts`, likes. App requests `agents.message/inbox/deliver/expire/parity`, `social.post/feed/like`. UI client: `60-swarm-protocol.js`. |
| Sub-agent UI | `10-subagents.js` (1,630), `13-subagent-chat.js`, `14-agent-view.js`, `15-agent-team.js`, `16-subagent-explorer.js`, `17-subagent-swarm.js`, `17-agent-goals.js` | Agents panel, chat, team view, "Copy to main memory" buttons (`promote`). Delete dialog says: "Removes the chat and the record. Its memory and files stay." |
| Main chat list | `www/agent.html` (`ChatStore`, `refreshSessions`, `forkChat`) | Threads live in WebView localStorage and are refreshed from the engine's session list. There is **no delete action for a main chat** in the thread menu. `forkChat` copies the transcript text into a new chat. |

---

## 2. Review of the old plan against the code

The old plan's direction is right: one object identity, many references, grants instead of copies, identity in an envelope, groups as containers, one projection for both the panel and the prompt. These points are wrong, missing or risky.

### 2.1 Gaps (things the old plan does not cover)

1. **`agent_hub.rs` is missed entirely.** It is a fourth messaging system next to `message_peer`, channels and cross-chat ask. It already has `from`, `to`, `reply_to`, but:
   - `agents.expire` deletes expired mail, which contradicts "real chat" history.
   - The next id is `COUNT(*)+1`, so after an expiry deletes rows, new ids collide with live ones.
   - `from` is supplied by the caller, so any sender can claim to be anyone.
   It must be folded into the new message store (Phase 2), not left beside it.
2. **`60-swarm-protocol.js` is misidentified.** The old plan treats the swarm UI as dead code for unused swarm tools. This file is actually the client of `agent_hub` (mail, social feed, receipts, TTL). Removing it blindly breaks `agents.*` / `social.*`.
3. **Main chats cannot be deleted today.** `lib.rs::clear_session` only drops the in-memory session, and the thread menu has no Delete. Requirement 4 ("deleting a chat must not delete what was shared from it") needs a main-chat delete designed from scratch, as a soft delete with explicit rules (Phase 4). The old plan assumes one exists.
4. **Copy paths that break "share must not copy":**
   - Sub-agent memory `promote` ("Copy to main memory" in `10-subagents.js` and `17-agent-goals.js`) copies entries.
   - `forkChat` copies the transcript text.
   - Cross-chat ask, peer messages and topic posts copy the text into the recipient's inbox, and the inbox is the only copy.
   All of them need a reference path. The old plan does not list them.
5. **Lossy folding of agent-to-agent history.** `compact::fold_notes` (inbox) and `compact::fold_queue` (topics) shorten older messages. That is fine for prompt budget, but today the folded text is the only record. A real chat needs a canonical, unfolded store; folding then applies only to the prompt view (Phase 2).
6. **Eight ad-hoc identity headers.** `team.rs:546`, `channels.rs:1074/1132/1437/1718`, `comms.rs:277`, `cross_session.rs:245`, plus the hub. Tests and code match on these strings (`lib.rs` tests about lines 4345–4450 look for `[Message from your other chat`; the mock runner in `subagents.rs` about line 3582 strips `[Message from…`). The envelope migration must update these matchers in the same phase.
7. **The Files category partly exists.** `mem.files` (files the model read in a chat) and `ctx_mem_file_store` (content-addressed bytes) already exist. What is missing is workspace files, attachments, the WebView file library and sub-agent `TrackedFile`s. The old plan says there is no Files category at all.
8. **Partial sub-agent support in the tree is already there** (`panel.memKey`). Reuse it; do not rebuild it.
9. **Privacy flags are not carried into groups or sharing.** `hidden`, `hidden_from` and `shareable` on sub-agents must restrict who can be added to a group and who an item can be shared with.
10. **Orphan rows confirmed.** `db::clear_session` does not call `context_tree::store::reset_session` or clear `ctx_mem_*` rows for that session, so deleting a sub-agent leaves its context-tree rows behind.

### 2.2 Conflicts

1. **Bytes are copied into `ct_blobs`.** The old plan's Phase 1 mirrors existing data into new object/blob tables (dual write). During the transition every message and memory exists twice, with two sources of truth to keep in sync. That is a copy, the exact thing requirement 4 forbids, and a drift risk. This plan uses a **reference index** instead: one item row per existing record, pointing at its real storage location (`loc`). Bytes stay where they are. A new store is created only for data that has no home today (peer and group messages, grants).
2. **E2 "fix tag per version".** The old plan's Phase 0 changes tag behaviour per version. The repo's own checklist design doc records "last tag wins" as the agreed rule. Do not change it inside this project. If you want E2, decide it separately.
3. **Compression and tiering (old section 11)** are a different project. They add dependencies (zstd or deflate) and risk to the storage layer, and none of the four requirements need them. Defer them.
4. **Splitting `58-context-tree.js` into four modules first** delays everything and touches all 82 UI tests. This plan adds new modules (`59-*`) next to it and changes `58` only at hook points.
5. **Groups across chats.** The old plan allows members from different parent chats, but sub-agent visibility is scoped per root chat (`peers_of`, comms config). This plan allows cross-chat groups only for agents marked `shareable`, and only with the user as creator (Phase 3).
6. **Adding an `envelope` field to `types::Message`.** `messages` rows store role and content only, so the new field would not persist without new columns, and each provider driver builds its own payload. This plan stores the envelope in its own table and renders a compact header into the content. `Message` stays unchanged, so no provider payload changes.
7. **The existing UI test asserts that sub-agents are left out of the tree** ("each stored chat is a row, sub-agents left out"). Requirement 1 reverses this. The plan keeps top-level rows as main chats only, nests sub-agents inside their parent chat, and updates the test's wording and expectations.

### 2.3 Old or legacy code to remove ("backdated")

| What | Where | Phase | Replacement |
|---|---|---|---|
| `COUNT(*)+1` id generation and the `agents.expire` hard delete | `agent_hub.rs` | 2 | Message store ids; expiry becomes a `delivered/expired` state, never a delete |
| Caller-supplied `from` in `agents.message` | `lib.rs` `memory_action`, `agent_hub.rs` | 2 | Sender derived from the authenticated caller |
| Eight hand-written identity headers | `team.rs`, `channels.rs`, `comms.rs`, `cross_session.rs` | 2 | `envelope::render_header` |
| `promote` copy op + "Copy to main memory" buttons | `subagents.rs` memory op, `10-subagents.js`, `17-agent-goals.js` | 4 | "Share with main" (reference grant, mode `mount`) |
| Name-keyed `memory/<name>.json` path | `subagents.rs` `memory_path` | 1 | Id-keyed file plus a one-time migration |
| `subagent:` filter in the tree | `58-context-tree.js` | 1 | Sub-agents nested under the parent chat |
| Overlapping memory UI | `57-memory.js` | 5 | The tree's Memory group with the permissions editor; keep only what the tree does not cover, then delete the file |
| `forkChat` copying text | `www/agent.html` | 4 | Fork by reference (the new chat starts from a range reference plus a summary) |
| Orphan `ctx_*`/`ctx_mem_*` rows | `db::clear_session` | 1 | Purge inside the same transaction, or detach when shared (Phase 4) |

---

## 3. Target design in one page

- **Item.** Everything the app shows or saves is an *item* with a permanent id (`it_<ulid>`) and **exactly one storage location** (`loc`), for example `db:messages/<session>/<rowid>`, `db:ctx_mem_file_store/<hash>`, `db:ws_messages/<id>`, `fs:subagents/<agentId>/memory.json#<key>`, `fs:workspace/<path>`. `loc` is UNIQUE, so one checklist row maps to one place.
- **Holder.** Whatever has a tree: a main chat (`session:<key>`), a sub-agent (`agent:<id>`), the main agent (`agent:main`), a group (`group:<id>`), the user's library (`user`).
- **Reference.** A holder shows an item through a reference row. Sharing adds a reference; it never copies bytes. Moving changes which holder owns the item. Deleting from one place removes one reference.
- **Grant.** Each reference carries a permission (`view`, `use`, `edit`, `manage`) and a mode: `reference` (shown in a "Shared with me" folder) or `mount` (sits directly inside the holder's own memory and is searched and used like it).
- **Envelope.** Every agent-to-agent, user-to-agent and group message carries `{id, from, to[], conversation, reply_to, mentions, at}` in its own row. The prompt text gets a short header rendered from that row.
- **Projection.** `items.tree(viewer, holder)` builds what a viewer may see. The prompt assembler uses the same projection, so the panel and the model never disagree.

New tables, all in the engine's `agent.db`, prefix `ws_`, all writes through `turn_memory::write_tx`:

```sql
-- Phase 1
CREATE TABLE ws_items (
  id          TEXT PRIMARY KEY,           -- it_<ulid>
  kind        TEXT NOT NULL,              -- chat | message | tool_result | summary | memory | memory_longterm | agent_memory | file | note | subagent | conversation | group | group_message | pin
  loc         TEXT NOT NULL UNIQUE,       -- the one place the bytes live
  owner       TEXT NOT NULL,              -- holder id: session:<k> | agent:<id> | group:<id> | user | detached
  origin      TEXT NOT NULL,              -- holder where it was born; kept after that holder is deleted
  parent_id   TEXT,                       -- tree placement (a sub-agent's chat under the sub-agent item)
  scope       TEXT,                       -- category inside the owner, e.g. group:<id> for an agent's group memory (Phase 3)
  title       TEXT NOT NULL DEFAULT '',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'live', -- live | missing | trashed | purged
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX ws_items_owner ON ws_items(owner, kind);
CREATE INDEX ws_items_scope ON ws_items(owner, scope);
CREATE TABLE ws_principals (               -- who can act and be named in an envelope
  pid TEXT PRIMARY KEY,                     -- user | agent:main | agent:<subagentId> | group:<id> | session:<key>
  kind TEXT NOT NULL, display_name TEXT NOT NULL, parent_pid TEXT,
  state TEXT NOT NULL DEFAULT 'active',     -- active | stopped | deleted (kept so old messages keep a sender)
  created_at INTEGER NOT NULL
);
CREATE TABLE ws_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- schema_version, migration markers

-- Phase 2
CREATE TABLE ws_messages (
  id TEXT PRIMARY KEY,                      -- m_<ulid>
  conversation TEXT NOT NULL,               -- peer:<pidA>|<pidB> (sorted) | group:<id> | session:<key> | topic:<root>/<name>
  from_pid TEXT NOT NULL, to_json TEXT NOT NULL, mentions_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT, thread_root TEXT,           -- thread_root = first message of the reply chain (Phase 2 item 6)
  kind TEXT NOT NULL DEFAULT 'text',        -- text | request | reply | broadcast | system | receipt
  text TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'sent',       -- sent | delivered | read | expired | deleted
  edited_at INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX ws_messages_conv ON ws_messages(conversation, created_at);
CREATE TABLE ws_cursors (pid TEXT, conversation TEXT, last_read TEXT, PRIMARY KEY(pid, conversation));

-- Phase 3: ws_groups, ws_group_members, ws_pins, ws_group_rules, ws_group_state, ws_group_dispatch
-- (full definitions in Phase 3, section 3.2)

-- Phase 4 (deletion policy): ws_delete_policy + trash columns on ws_items (full definitions in Phase 4)

-- Phase 4
CREATE TABLE ws_refs (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, holder TEXT NOT NULL,
  mode TEXT NOT NULL,                       -- owner | reference | mount
  perm TEXT NOT NULL,                       -- view | use | edit | manage
  granted_by TEXT NOT NULL, folder TEXT,    -- optional placement inside the holder's tree
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE UNIQUE INDEX ws_refs_live ON ws_refs(item_id, holder) WHERE revoked_at IS NULL;
CREATE TABLE ws_audit (id TEXT PRIMARY KEY, actor TEXT, action TEXT, item_id TEXT, detail_json TEXT, at INTEGER);

-- Phase 5
CREATE TABLE ws_context_use (holder TEXT, item_id TEXT, state TEXT NOT NULL, -- in | out | auto
  actor TEXT NOT NULL, -- user | model | policy
  updated_at INTEGER NOT NULL, PRIMARY KEY (holder, item_id));
```

New Rust module `src/workspace/` (named so it does not clash with `context_tree`): `mod.rs` (schema, `ensure_tables`, the `items.*`/`groups.*`/`refs.*` router), `registry.rs`, `principals.rs`, `envelope.rs`, `groups.rs`, `group_rules.rs`, `groups_bridge.rs` (delivery and wakes; may live in `subagents/` if it needs the manager's private methods), `refs.rs`, `trash.rs` (delete policy and sweeper), `longterm.rs` (main memory by id), `bulk.rs`, `projection.rs`. Routing: add `items.`, `groups.`, `refs.`, `conv.` to the prefix gate in `subagents_request` (about line 2140) and one fallback arm in `memory_action` that calls `workspace::action(conn, ws, key, action, req)`.

---

## 3a. Your four decisions and where they land

| Your answer | What the plan now does | Where |
|---|---|---|
| 1. Delete is customizable: delete directly, or time-based with your own retention | A delete policy with two modes: **Direct** (permanent at once) and **Timed** (Trash, removed after the time you set, or kept until you empty it). Set globally, per kind of item, or per chat, agent or group, and override on each delete. Shared items are still detached, never deleted, in both modes. | Phase 4 (engine, rules, sweeper), Phase 5 (settings screen, Trash view, bulk delete) |
| 2. Groups across chats: only `shareable` sub-agents | Enforced at add time on the agent's own flag; an agent that stops being shareable is suspended, not removed. Same-chat groups accept any visible sub-agent. | Phase 3, section 3.3 |
| 3. Groups like real social media | Inactive agents can be added and are woken by `@name` or `@all`; every message carries who is replying to whom; a "nobody answered" nudge; each agent keeps its own memory with the group as a new category; a per-group rules engine with presets, member-level rules, a fixed conflict order and a cost preview. | Phase 2 (reply threading, mentions), Phase 3 (activation, rules, memory category), Phase 5 (rules editor) |
| 4. Main memory gets a fixed id per entry | Deterministic ids added in place to the existing records (no copy); main memory is then shown, edited, shared and permissioned from the context tree like every other item. | Phase 1 (ids, read side), Phase 4 (edit, share, delete, eviction protection), Phase 5 (permissions editor) |

---

## Phase 0. Safety net and small legacy fixes (½–1 day)

This phase is small but separate, so later phases start from a clean, tested base.

What changes:

- `db.rs::clear_session`: inside the same `write_tx`, call `context_tree::store::ensure_tables` then `context_tree::store::reset_session(tx, key)`, and delete `ctx_mem_picks/versions/tags/files/status` rows for the key. Keep `ctx_mem_file_store` bytes: they are content-addressed and may be used by other chats (GC is Phase 4).
- `agent_hub.rs`: replace `COUNT(*)+1` with a ULID (or `MAX(rowid)+1` inside the transaction). Leave expiry for Phase 2.
- `subagents.rs::memory_path`: add an id-keyed path (`memory/<id>.json`) and a lazy migration. On first read, if `<id>.json` is missing and `<name>.json` exists and only one agent has that name, rename it. If two agents share the name, copy-on-migrate is **not** allowed: keep the file under the older agent's id and log a conflict entry for the user. Write a marker in `ws_meta`.
- Add a `tests/fixtures/workspace_seed.rs` helper that builds a DB with two main chats, two sub-agents (one nested), turn memory, checklist rows, file-store rows and hub mail. Every later phase's tests use it.

Tests:

- Rust: `clear_session_purges_ctx_rows`, `hub_ids_unique_after_expire`, `memory_path_migrates_by_id`, `memory_path_name_collision_keeps_both`.
- The full baseline suites stay green.

Risks: the purge runs in the sub-agent delete path, so a bug there deletes too much. The test asserts that another session's rows are untouched.

Patch: `git diff main > phase0.patch` after the tests pass, then commit.

---

## Phase 1. Unified item registry and an everything-visible context tree (Files + Sub-agents)

Goal (requirement 1, first half): everything the app shows or saves appears in the tree, including Files and every sub-agent's chat, memory and files, whether it is present or not. This phase is read-only, so it is safe to ship alone.

Files today, then the change:

1. **New `src/workspace/mod.rs`, `registry.rs`, `principals.rs`.**
   - `ensure_tables(conn)` creates `ws_items`, `ws_principals`, `ws_meta`.
   - `registry::sync(conn, state_dir, workspace_dir)` upserts one item per existing record by `loc` (idempotent), without copying bytes:
     - `sessions`: `chat` items; a `subagent:<id>` session becomes the sub-agent's chat item, with `parent_id` set to the sub-agent item.
     - `turn_memory` ranges and results, `ctx_notes`, `ctx_temp_summaries`, `ctx_strategy`: `summary`, `tool_result`, `note` items owned by `session:<key>`.
     - `ctx_mem_longterm`: `memory_longterm`, owner `user`.
     - `ctx_mem_file_store` + `ctx_mem_files`: one `file` item per hash; `meta.sessions[]` lists the chats that read it.
     - `registry.json`: a `subagent` item per agent, owner `session:<root_session_key>` (or `agent:<parent>` for nested). Each `TrackedFile` becomes a `file` item with `loc fs:workspace/<path>`. Each entry in `memory/<id>.json` becomes an `agent_memory` item with `loc fs:subagents/<id>/memory.json#<key>`.
     - Workspace dir listing (`agent/workspace`): `file` items, owner `user`.
     - `hub_messages`, `hub_posts`: `message` items in a legacy category (moved in Phase 2).
   - Items whose source is gone are set to `state='missing'`, never deleted, so "present or not" stays visible until the user removes them.
   - `principals::sync` fills `ws_principals` from the user, the main agent, sub-agents and sessions.
2. **`lib.rs`.** Add `items.` to the prefix gate. Actions: `items.sync`, `items.tree {holder?, viewer?}`, `items.get {id}`, `items.read {id, range?}` (resolves `loc` and reads from the real table or file). Run `registry::sync` lazily: on the first `items.tree` call, then incrementally after the hooks below.
3. **Hooks (keep the registry fresh without a full scan):** `db::save_messages` (new session), the sub-agent `spawn/delete/rename` paths in `subagents.rs`, the `mem.files` writer in `memory_checklist.rs`, and the memory op writer. Each calls `registry::touch(conn, loc, …)`. A missed hook only means the next `items.sync` picks the change up.
4. **`58-context-tree.js`.**
   - Remove the `subagent:` exclusion from the row builder. Top-level rows stay main chats.
   - Inside each chat's panel, add the groups `Files` (Read in this chat / Workspace / Attachments / Sub-agent files), `Sub-agents` (one row per agent: Chat, Memory, Files; opens the existing `panel.memKey` view for memory), and `Shared with me` (empty until Phase 4).
   - Add one hook, `ContextTreeExtras.sections(panel)`, where the new module plugs in.
5. **New `tools/agent-html-src/59-workspace-tree.js`.** Fetches `items.tree`, renders the Files and Sub-agents sections and an "All" view (Chats, Sub-agents, Files, Memory, Notes, Missing). Each row carries `data-item-id` (needed in Phase 5). Show state badges: missing, stopped agent.
6. **Attachments and the WebView file library.** These live in the WebView (IndexedDB library, inline `<attached_file>` blocks). Register them through a new bridge call, `items.registerClient {kind:'file', loc:'idb:library/<id>', title, size}`, sent when a file is added. The engine never holds the bytes. `items.read` returns `client_only` and the UI opens it locally.

7. **Fixed ids for main memory entries (your answer 4, read side).** The main memory lives in the host app, behind the `MemoryProvider` trait (`lib.rs` line 94: `store`, `recall`, `forget`, `search`, `list`). Both host implementations, `android/.../MemoryProviderImpl.kt` and `ios/.../MemoryProviderImpl.swift`, keep one JSON document `{version: 1, entries: [{key, text, createdAt, updatedAt, metadata?}]}`, capped at 2,000 entries (oldest removed first). Keys are unique, and an update with the same key keeps `createdAt`.
   - **The id.** `id = "mem_" + base32(SHA-256(key + "\u0000" + createdAt))[0..26]`. It is deterministic: the same entry always gets the same id, so a second backfill, a downgrade and upgrade, or a restore from backup never produces a different id. Editing the text keeps the key and `createdAt`, so the id stays. Forgetting an entry and storing the same key again is a new entry and correctly gets a new id.
   - **Backfill in place, no copy.** In both providers, `readDocument` checks for records without `id`; if any, it adds the field to those records and writes the same document back once, under the existing store lock and atomic write. No record is duplicated and no second store is created. `FORMAT_VERSION` stays 1: the field is additive and the current `readDocument` validates only `key`, `text` and `metadata`, so older builds still open the file. An older build drops `id` when it rewrites an updated record; because the id is deterministic, the new build recomputes the same value.
   - **API.** `store` keeps the id on update and returns `{success, key, id}`; `search`/`recall` hits include `id`. `list` keeps its shape (the engine's key parser in `memory_checklist.rs` about line 490 depends on it). Two methods are added to the trait: `get(id) -> record JSON` and `export(after_updated_at, limit) -> records JSON` (full records, oldest change first, for paging). This changes the uniffi interface: regenerate `native_agent_ffi.kt` and the Swift bindings and rebuild the `.so` slices for the four Android ABIs and the iOS library (the repo commits these; `ef10774` is such a build commit). Any other host that implements `MemoryProvider` must add the two methods.
   - **Engine.** `ctx_mem_longterm` gets an `entry_id TEXT` column (added in `memory_checklist::ensure_tables` with the same `ALTER TABLE` check used for `tool_use_id`). `tool_runner::mirror_long_term` (about line 477) stores the id from the `store` result. The mirror stays a cache of the newest 200 entries (`LONG_TERM_MAX`); `registry::sync` pages `export` so **every** entry becomes a `memory_longterm` item with `loc host:memory#<id>` and `meta.key`, owner `agent:main`. The checklist keeps its `lt:<slug>` record ids and tags; a map `lt:<slug> ↔ entry_id` links the two.
   - **Fallback.** If a host returns no `id` (an older host build), the item gets `loc host:memory@key:<key>` and a read-only badge, and Phase 4 treats it as view-only until the host is updated.
   - In this phase main memory is shown in the tree (Memory → Main memory, paged, searchable) but not yet edited or shared; that is Phase 4.

Data model: `ws_items` (with the `scope` column used from Phase 3 on), `ws_principals`, `ws_meta` (above); `ctx_mem_longterm.entry_id`; `id` on each provider record.

Migration: none destructive. A first `items.sync` on a large DB may take seconds, so run it in the background and show "indexing…" in the tree. The provider backfill runs once on first open and touches only records that lack an id.

Risks:

- The registry drifts from the source. Mitigation: `loc` is the truth, the registry is an index, and `items.sync` repairs it. Add `items.fsck` (counts per source versus per registry).
- Tree size on phones. Lazy-load each category; paginate messages (do not register every message as an item in this phase; a chat item expands into message rows on demand from `messages`).

Tests:

- Rust (`workspace::registry` tests): `sync_is_idempotent`, `every_source_has_one_item_per_loc`, `subagent_chat_nested_under_parent`, `missing_source_marks_missing_not_deleted`, `loc_unique_rejects_duplicate`, `items_read_resolves_each_loc_kind`, `longterm_id_is_deterministic`, `longterm_items_indexed_beyond_mirror_cap` (2,000 provider entries, 200 in the mirror, 2,000 items), `mirror_stores_entry_id`, `longterm_without_id_is_read_only`.
- Host providers: Android unit test (Robolectric or JVM) and an iOS XCTest for `backfill_adds_ids_in_place` (entry count and order unchanged, file written once), `update_keeps_id`, `forget_then_store_same_key_new_id`, `old_format_without_ids_still_loads`, `get_and_export_return_ids`. If the repo has no native test target yet, add a minimal one for these five.
- UI (`tools/agent-html-tests/context-tree.js`): change "each stored chat is a row, sub-agents left out" to "each stored chat is a row; sub-agents appear inside their parent chat". Add a new `workspace-tree.js` suite: Files group lists read, workspace and sub-agent files; a sub-agent row opens its chat and memory; a missing file shows the badge; 375 px layout; keyboard access.
- All baseline suites green.

Patch: `git diff phase0 > phase1.patch` (or `git diff main…HEAD` against the Phase 0 commit) after the tests pass.

---

## Phase 2. Identity envelope and one peer-chat store (requirement 1, second half)

Goal: when one agent asks another, it is a normal peer chat, and each message carries its sender identity inside the message itself. One store replaces four.

Changes:

1. **New `src/workspace/envelope.rs`.**
   - `Party {pid, kind, name}`, `Envelope {id, conversation, from, to, mentions, reply_to, kind, at}`.
   - `post(conn, env, text, attachments) -> id` writes to `ws_messages` (the canonical, never-folded record) and registers a `message` item with `loc db:ws_messages/<id>`.
   - `render_header(env)` gives one fixed format for every path: `⟦from: Researcher (agent:sa_3) → to: Writer (agent:sa_5) · peer chat · msg m_…· reply to m_…⟧`. The recipient model therefore always sees who wrote it, to whom, and in reply to what.
   - `peer_conversation(a, b)` sorts the two pids into one key, so both sides see one thread.
2. **Rewire senders to `envelope::post` + `render_header`:**
   - `team.rs` `message_peer` (line about 546). Add optional `reply_to` to the tool schema; `from` is always `me` (never a model argument).
   - `channels.rs` broadcasts (1074), topic posts (1132), request replies (1437), user posts (1718).
   - `comms.rs` user-to-all (277).
   - `cross_session.rs` (245): conversation `session:<target>` with `from session:<source>`.
   The inbox still gets a note, but the note is now *view text*. `compact::fold_notes` / `fold_queue` may fold it for the prompt budget, and the full message stays in `ws_messages`. Add a model tool `read_conversation {with|conversation, before?, limit}` so an agent can re-read the unfolded thread.
3. **Merge `agent_hub.rs`.**
   - `agents.message` → `envelope::post`. The sender is derived from the request context (`user` for the app, or the engine principal), and a `from` argument that differs from the caller is rejected.
   - `agents.inbox` reads `ws_messages` + `ws_cursors`. `agents.deliver` sets `state='delivered'`. `agents.expire` sets `state='expired'` and **deletes nothing**.
   - `social.*` stays (feed is not chat) but uses principals for authorship.
   - One-time migration copies `hub_messages` into `ws_messages`, a one-time move (not a share): rows are inserted once, then `hub_messages` is dropped in the same transaction after a count check.
   - Update `60-swarm-protocol.js` to the new response shape (ids are strings, `expired` is a state).
4. **Principals in prompts.** The system prompt for every agent gets a short "You are <name> (<pid>). Messages start with a ⟦from … → to …⟧ header; reply with message_peer to the sender pid" line (in `subagents.rs` where the sub-agent system prompt is built, and in the main assembly).
5. **UI.** `13-subagent-chat.js` / `14-agent-view.js` show a "Peer chats" tab per agent (conversation list → thread with sender names and reply quotes). The tree gets a `Peer chats` group under each sub-agent.
6. **Reply threading and mentions (groundwork for your answer 3).**
   - `ws_messages.thread_root`: when `reply_to` is set, `thread_root` is the replied message's `thread_root` (or its id), so a whole thread loads with one indexed query (`CREATE INDEX ws_messages_thread ON ws_messages(thread_root, created_at)`).
   - `envelope::post` checks that `reply_to` exists in the same conversation and is not a purged message.
   - `render_header` always names the replied-to sender and a short quote: `⟦from: Writer (agent:sa_5) → to: Researcher · replying to Researcher m_41 "the numbers in…"⟧`. Quote length is 40 characters, so the header stays under the 160-character budget.
   - `envelope::parse_mentions(text, roster) -> Vec<pid>` resolves `@Name` (case-insensitive name or title), `@id` and `@all`; `@@` is a literal @. Peer chats store mentions but do not act on them; Phase 3 uses them for wakes.
   - `message_peer` and `read_conversation` gain `reply_to` / thread output, so a peer chat also shows who answered what.

Update string matchers in the same patch: `lib.rs` tests about lines 4345–4450 (`[Message from your other chat`), the mock runner in `subagents.rs` about line 3582, and the topic/inbox tests in `compact.rs` that assert header text.

Remove: the eight hand-written headers, `hub_messages` (after migration), `COUNT(*)` ids, hard-delete expiry.

Risks:

- Prompt wording changes can shift model behaviour. Keep the header short (under 160 characters including the reply quote) and A/B it on the existing swarm and team scenarios.
- Rate limits, hop limits and the wait-for graph in `channels.rs` must still run before `post`. Test that they do.

Tests:

- Rust: `peer_message_has_envelope_from_me` (a model cannot set `from`), `peer_thread_same_for_both_sides`, `reply_to_must_exist_in_conversation`, `fold_keeps_canonical_record`, `read_conversation_returns_unfolded`, `hub_expire_never_deletes`, `hub_from_spoof_rejected`, `hub_migration_counts_match`, `thread_root_follows_chain`, `reply_header_names_replied_sender`, `parse_mentions_name_id_all_and_escape`, plus the existing hop/rate-limit tests.
- vitest: swarm protocol client handles string ids and the `expired` state.
- UI: the peer chat thread shows the sender name on each bubble and quotes the replied message.

Patch: `git diff <phase1-commit> > phase2.patch` after the tests pass.

---

## Phase 3. Groups that work like real social media: panel, threads, mentions, rules, own context tree (requirement 2 + your answers 2 and 3)

Goal: a group is a real chat room. You can add agents whether they are running or not, every message shows who is replying to whom, you wake agents with `@name` or `@all`, each agent keeps its own memory (group data is only a new category inside it), and each group has its own rules that decide who answers.

> বাংলা নোট: Group-এ inactive agent-ও add করা যাবে। `@নাম` বা `@all` দিলে সে active হবে। প্রতিটা message-এ দেখা যাবে কে কার reply দিচ্ছে। প্রত্যেক agent-এর memory আলাদা থাকবে; group শুধু তার memory-তে একটা নতুন category যোগ করে। কে কখন reply দেবে সেটা প্রতিটা group-এর নিজস্ব rules ঠিক করবে, আর rules তুমি নিজের মতো বদলাতে পারবে।

### 3.1 What the code gives us to build on (checked at `ef10774`)

- `subagents/channels.rs::send_comm(to, note, hop, wake, env)` already has a `wake` flag. With `wake=true` and an agent that is not running and not paused, it calls `rerun_existing(..., PendingPrior::Resume, ...)`, which starts a new run of the same agent with the note. Otherwise the note waits in the inbox (`deliver`). This is the activation path for mentions; no new run machinery is needed.
- `SubagentRecord.status` is one of `running`, `queued`, `finished`, `error`, `cancelled`, `paused`, `interrupted`, with a separate `paused: bool`. `is_active()` is `running || queued`. `comms.rs::resume` un-pauses.
- `guard_send` (channels.rs about line 908) enforces the per-chat hop limit (`max_hops`, 10-minute window), the per-chat message cap, the per-pair cap and the per-minute send rate (`check_send_rules`). All of these are keyed on the **root chat**, so a group that spans chats needs its own counters (below).
- `SubagentRecord.shareable` defaults to `false` and is set by the app through the team settings request (`team.rs` about line 676). `hidden` and `hidden_from` also exist.
- `MemoryEntry { key, text, metadata: Option<Value>, updated_at }` in `subagents.rs` (about line 3412): `metadata` is free JSON, so a group category needs no file format change.
- Memory modes are `private`, `read_parent`, `shared` (`subagents.rs` about line 378). A `shared` agent writes straight into the main memory, which matters for keeping memories apart in groups (3.6).

### 3.2 Data model

The Phase 2 tables (`ws_messages`, `ws_cursors`) carry group messages. Phase 3 adds or extends:

```sql
CREATE TABLE ws_groups (
  id TEXT PRIMARY KEY,                 -- g_<ulid>
  name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
  home_root TEXT,                      -- root chat the group was created from; NULL when created from the Groups panel
  created_by TEXT NOT NULL,            -- always 'user' in this version
  state TEXT NOT NULL DEFAULT 'active',-- active | paused | archived | trashed | deleted
  preset TEXT NOT NULL DEFAULT 'social',
  settings_json TEXT NOT NULL DEFAULT '{}', -- budgets, notification level, AI-context policy (Phase 5)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE ws_group_members (
  group_id TEXT NOT NULL, pid TEXT NOT NULL,
  role TEXT NOT NULL,                  -- owner | admin | member | observer
  membership TEXT NOT NULL DEFAULT 'joined', -- joined | suspended | left
  suspended_reason TEXT,               -- e.g. 'not_shareable', 'hidden', 'deleted_agent'
  engaged_until INTEGER,               -- end of the attention window after a wake (3.4)
  last_spoke_at INTEGER, last_woken_at INTEGER,
  can_post INTEGER NOT NULL DEFAULT 1, muted_until INTEGER,
  joined_at INTEGER NOT NULL, left_at INTEGER,
  PRIMARY KEY (group_id, pid, joined_at));

CREATE TABLE ws_pins (group_id TEXT, message_id TEXT, pinned_by TEXT NOT NULL, pinned_at INTEGER NOT NULL, note TEXT,
  PRIMARY KEY (group_id, message_id));

CREATE TABLE ws_group_rules (
  id TEXT PRIMARY KEY,                 -- r_<ulid>
  group_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'group', -- 'group' or a member pid
  kind TEXT NOT NULL,                  -- see 3.5
  params_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX ws_group_rules_g ON ws_group_rules(group_id, enabled);

CREATE TABLE ws_group_state (           -- counters the rules read; updated in the same tx as each post
  group_id TEXT PRIMARY KEY,
  unanswered INTEGER NOT NULL DEFAULT 0,      -- messages since the last agent reply (3.5)
  last_message_at INTEGER, last_agent_reply_at INTEGER,
  chain_depth INTEGER NOT NULL DEFAULT 0,     -- agent-to-agent wake depth of the current chain
  wakes_window_start INTEGER, wakes_in_window INTEGER NOT NULL DEFAULT 0,
  tokens_day TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
  rr_cursor TEXT);                            -- round-robin position

CREATE TABLE ws_group_dispatch (        -- why each member was or was not called, per message
  message_id TEXT NOT NULL, pid TEXT NOT NULL,
  decision TEXT NOT NULL,              -- wake | deliver | skip | queue | coalesce
  reason TEXT NOT NULL,                -- e.g. 'mention', 'at_all', 'rule:everyone_replies', 'blocked:paused', 'cap:max_replies'
  rule_id TEXT, est_tokens INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
  PRIMARY KEY (message_id, pid));
```

`ws_messages` from Phase 2 already has `reply_to` and `mentions_json`; Phase 2 also adds `thread_root` (see Phase 2 item 6). Group messages use `conversation='group:<id>'`.

### 3.3 Creating groups and who may join (your answer 2)

New `src/workspace/groups.rs`:

- `create {name, purpose, members[], preset?}` needs at least **three agent members** (the user is the owner and is not counted). Inactive agents count: a `finished`, `paused` or never-run agent can be added, and adding it **never starts a run**.
- **Same-chat members:** any sub-agent the creator can see. `hidden` agents and agents whose `hidden_from` names the group's home chat are refused with that reason.
- **Cross-chat members (your decision): only sub-agents marked `shareable` may join.** A member is cross-chat when `root_of(member.session_key) != home_root`, or always when the group has no home chat. The check reads the agent's **own** `shareable` flag, not its parent's or template's (a child copies the template flag at spawn in `team.rs` about line 218, but a later change on the child is what counts).
- Main agents of other chats cannot join (they are not sub-agents and have no `shareable` flag). Cross-chat questions to another main chat keep using the Phase 2 cross-chat ask.
- **If a member stops qualifying** (you turn its `shareable` off, hide it, or it is deleted), it is not removed: `membership='suspended'` with a reason. It gets no deliveries and no wakes, its old messages keep their sender, and the panel shows "Writer is suspended: not shareable any more. Make shareable / Remove". Turning the flag back on restores it. A hook in the team settings path (`team.rs` about line 676) and the sub-agent delete path calls `groups::recheck_member(pid)`.
- If live (joined, not suspended) agents drop below three, the group becomes `paused` (not deleted) with a banner: add a member or archive.
- `members.add/remove/role/mute`, `rename`, `purpose`, `archive`, `delete`. Group delete follows your delete policy from Phase 4 (direct or timed), and items shared out of the group follow the same detach rules as any holder.

### 3.4 Activity: inactive members, activation by mention, attention window

Each member has a presence the panel shows next to its name, computed, not stored: **Active** (running or queued), **Idle** (can be woken), **Paused** (user paused it), **Suspended** (3.3), **Gone** (record deleted; kept as a name only).

- **Adding** an idle or paused agent only adds a member row and an "added to #group" system message.
- **Activation:** when the dispatcher (3.5) decides to wake a member, `groups_bridge::wake(member, trigger)` calls `send_comm(..., wake=true, ...)` with a group note (3.7). An idle agent starts a run; a running agent gets the note before its next step ("live"); a queued agent gets it when it starts.
- **Paused agents are never started by a mention**, not even by `@all`. The message is queued in the inbox and the sender sees "Writer is paused, so it will see this when you resume it. Resume now?". This keeps your pause button absolute.
- **Attention window:** after a wake, the member is *engaged* until `engaged_until` (default: until it has posted once and then 5 minutes of group silence, max 15 minutes). While engaged, new group messages are delivered to it live as part of the same run instead of starting a new run for each, so a conversation flows without re-mentioning. When the window ends the agent goes back to idle, and only a new trigger wakes it.
- **Coalescing:** if a member is already running or queued for this group, a second wake does not start a second run; the new messages are added to its pending group note (`decision='coalesce'`).
- **Auto-post of the answer:** a woken agent normally answers with `group_post`. If its run ends with plain text and no `group_post`, the bridge posts that final text to the group with `reply_to` set to the message that woke it. An agent that has nothing to add can call `group_pass {reason}`, which posts nothing and records the pass in `ws_group_dispatch` so "why no reply?" has an answer.

### 3.5 The group rules engine (customizable per group, with defaults)

New `src/workspace/group_rules.rs`. Rules are data, not code: a fixed set of rule kinds with parameters, stored in `ws_group_rules`, each scoped to the whole group or to one member. One pure function decides each message:

```
decide(group, message, members, rules, state, now) -> Dispatch {
  wake:    [(pid, reason, rule_id, est_tokens)],   // start or continue a run
  deliver: [(pid, reason)],                        // inbox only, no run
  skip:    [(pid, reason)],                        // gets nothing now (still readable via group_read)
  queue:   [(pid, reason)],                        // paused members, delivered on resume
  needs_confirm: Option<CostWarning>,              // for the user's composer
}
```

`decide` has no side effects, so it runs for the composer's live preview ("this will wake 3 agents") and for the real post, and both give the same answer. `groups::post` writes the message, calls `decide`, writes `ws_group_dispatch` rows and updates `ws_group_state`, all in one `write_tx`, and only then calls `wake`/`deliver` outside the transaction.

**Triggers** (what can call an agent):

- `@Name` or `@id` mention, `@all` (every joined, not suspended member except the sender), a direct message inside the group (`to=[pid]`, shown as "to @Writer"), a reply to the member's own message, and rule-based calls below.

**Rule kinds and parameters:**

| Kind | Parameters | What it does |
|---|---|---|
| `delivery` | `mode: all \| mentions_and_replies \| none` | Who gets each message in the inbox without being woken. Default `all` (agents read the room when they next run). |
| `respond` | `mode: mention_only \| everyone \| round_robin \| first_available`, `on: user_messages \| all_messages` | Who is woken by an ordinary message with no mention. `mention_only` (default): nobody. `everyone`: every member must reply (your example "sobaike msg korte hobe"). `round_robin`: one member per message, in turn. `first_available`: the member idle longest. |
| `unanswered_threshold` | `n` (default 3), `count: group \| member`, `wake: all \| round_robin \| least_recent \| [pids]` | Your example "3 msg unreply thakle reply korte parbe": the scoped member(s) may reply only after `n` messages have gone unanswered. `count: group` counts messages since any agent last replied; `count: member` counts messages since this member last spoke. When the count reaches `n`, the listed members are woken and the counter resets on their reply. |
| `reply_wakes_author` | `on: bool` (default true) | A reply to an agent's message wakes that agent. |
| `agent_to_agent` | `allowed: bool` (default true), `max_depth` (default 2) | Whether an agent's `@mention` wakes another agent, and how long such a chain may run before it stops. |
| `silence_nudge` | `after_secs` (default 120), `action: notify_user \| wake [pids] \| at_all` | "If nobody is replying": after the silence, tell you (default) with quick buttons "Mention someone" / "@all", or call the named members or everyone. Fires once per unanswered user message. |
| `cooldown` | `secs` | A member is not woken again until this long after its last reply (explicit mentions by the user override it). |
| `max_replies_per_message` | `n` | Caps how many agents are woken by one message. |
| `rate` | `wakes_per_10min` (default 12) | Group-wide wake limit. |
| `budget` | `tokens_per_day` (default off), `on_exhausted: mentions_only \| pause` | Daily token cap for the group. |
| `quiet` | `members: [pids]` | Listed members are observers: they get deliveries but are never woken except by a direct mention from you. |

**Presets** (pick one at creation, then change any rule; the preset name changes to "Custom" after an edit):

- **Social (default):** delivery all, respond mention_only, reply_wakes_author on, agent_to_agent on with depth 2, silence_nudge notify_user after 2 minutes, rate 12 per 10 minutes. This is how a real group chat feels: people answer when spoken to.
- **Everyone answers:** respond everyone on user messages, max_replies_per_message off, agent_to_agent depth 1.
- **Round table:** respond round_robin on user messages.
- **Wait your turn:** respond mention_only plus unanswered_threshold n=3, wake least_recent.
- **Moderated:** only your mentions wake agents; agent_to_agent off.

**Evaluation order and conflicts** (the same order every time, written in the rules help sheet):

1. **Hard blocks always win:** member left, suspended, muted, `can_post=0`, paused (→ `queue`), the group is paused or archived, the user paused agent messages (`comms_paused`), the group budget is exhausted with `on_exhausted: pause`, or the sender is the member itself (nobody wakes itself).
2. **Explicit triggers from you:** your `@name`, `@all`, `to=[pid]` wake the member even if a rule would not (they override `mention_only`, `unanswered_threshold`, `cooldown`, `quiet`, `max_replies_per_message`), but never a hard block.
3. **Explicit triggers from agents:** an agent's mention, direct message or reply wakes only if `agent_to_agent.allowed` and `chain_depth < max_depth`, and it respects `cooldown`, `quiet` and the caps.
4. **Rule-based calls:** `respond`, `unanswered_threshold`, `silence_nudge`.
5. **Caps last:** `max_replies_per_message` and `rate` trim the wake list in this order: your explicit mentions, then direct messages, then replies, then rule-based picks ordered by who replied least recently. Trimmed members get `deliver` with reason `cap:<rule>`.

When two rules of the same kind apply to one member: a **member-scoped rule beats a group rule**; between rules of the same scope, the **higher priority** wins; on a tie, the **more restrictive** one wins (fewer wakes). `group_rules::validate(rules)` runs on every save and returns errors (block the save: unknown kind, `n < 1`, a pid that is not a member) and warnings (allowed, shown in the editor: "Everyone answers is on for the group, but Critic has Wait your turn, so Critic follows Wait your turn"; "agent_to_agent depth 0 makes reply_wakes_author useless for agent messages").

**What counts as answered:** a message M is answered when a message from a different author has `reply_to = M`, or when the next message from a different member arrives without a `reply_to` while M is the newest message (an implicit reply). `ws_group_state.unanswered` counts messages since the last agent reply and resets to 0 when an agent posts. The per-member count is derived from `last_spoke_at` and message timestamps.

**Cost:** each wake is one run of that agent. `est_tokens` per member = the agent's average tokens per run from its record (`input_tokens + output_tokens` over its finished runs), or 4,000 when it has never run, plus the size of the group note. The composer shows the live estimate ("@all wakes 6 agents, about 24k tokens"). A confirm sheet appears when one message would wake more than 4 agents or more than 20k estimated tokens (both thresholds in group settings). Actual usage is added to `ws_group_state.tokens_used` when each run ends, and the group header shows today's total. The engine's existing per-agent `token_budget` and `max_steps` still cap each run.

**Cross-chat groups and the existing limits:** `guard_send` and its counters are keyed on one root chat. For group traffic, the bridge checks the group's own counters (`chain_depth`, `rate`, `budget`) first, then calls `guard_send` for the sender's root chat, so a chat's own limits and its "pause agent messages" switch still apply to its agents when they post in a group.

### 3.6 Each agent keeps its own memory; group data is a category (your answer 3)

- Memories are **never merged**. A group has no shared brain unless you share items into it (Phase 4).
- When an agent stores memory during a group-triggered run, the entry is written to **its own** memory file (`memory/<agentId>.json` after Phase 0) with `metadata.category = "group:<groupId>"` and `metadata.group_name`. In the registry the item gets `owner=agent:<id>` and the new `scope='group:<id>'` column (added to `ws_items` in Phase 1). Nothing is copied into the group.
- The agent's tree shows Memory → General and Memory → Groups → #design. When it runs for a group, its memory search ranks that group's category first, then its general memory; when it runs alone, group-category entries are still its own and still searchable (you can switch that to "only in that group" per group).
- **`shared` memory mode agents:** today they write into the main memory. In a group run that would mix memories, so the group setting "Group runs write to the agent's own memory" (default **on**) makes `SubagentMemory` write to the agent's own file for the duration of a group run. Turned off, writes go to main memory with the same `category` tag.
- **The group's own memory** is separate: notes and pins written to the group are items owned by `group:<id>`.
- The group's context tree shows each member's group-category entries in a "Members' notes about this group" folder, read-only and visible to you only. Other agents see them only if you share them (Phase 4 references).
- When an agent leaves a group, its group-category entries stay in its memory (they are its own) and are re-labelled "from #design (left)". When a group is deleted, members' entries are not touched.

### 3.7 Reply threading and identity in every message

- Every group message is a `ws_messages` row with `from_pid`, `reply_to`, `thread_root` and `mentions_json`. The sender is always set by the engine (the user, or the agent whose run called `group_post`); a model cannot choose it.
- The note a woken agent receives starts with the Phase 2 header plus reply identity, for example `⟦#design · from: Researcher (agent:sa_3) · replying to: you (Writer) m_41 "draft v2 is…" · mentions: you⟧`, followed by the unread messages since its cursor (`ws_cursors`), each with its own one-line header. Older context is folded for the prompt budget; the full thread is always available through `group_read`.
- `group_post {group, text, reply_to?, to?}`: `reply_to` defaults to the message that woke the agent and must be in the same group. Mentions in the text are parsed by `envelope::parse_mentions(text, roster)`: `@Name` (case-insensitive name or title), `@sa_3` (id), `@all`. Ambiguous names are rejected for agents ("two members are called Writer; use @sa_3 or @sa_9") and resolved by the composer's picker for you. `@@` writes a literal @. A mention of a non-member does nothing and, for you, offers "Add to group".
- Edit and delete of own messages: an edit keeps the old text in the item's version history; a delete leaves the tombstone "message deleted" and its replies keep their link. Purging the text follows your delete policy (Phase 4).

### 3.8 Model tools

Registered beside the team tools, only for agents in at least one group, outside the `ctx` tool so its 2,300-character schema budget is untouched: `list_groups`, `group_read {group, before?, thread?, limit}`, `group_post {group, text, reply_to?, to?}`, `group_pass {group, reason}`, `group_pin {group, message_id}`. Each agent's system prompt gets a short block from `groups::for_agent(pid)`: "Groups you are in: #design (you: member; Researcher, Writer, Critic; rules: Social). Reply in the group with group_post; mention with @name." It is rebuilt when membership or rules change.

### 3.9 Group context tree

The holder `group:<id>` uses the same `ctx_*` tables with `session_key='group:<id>'`, so the existing tree code works: Chat (threads, pins), Group memory, Members' notes (3.6), Files (posted attachments), Members (presence, role, rules that apply to each).

### 3.10 UI: `tools/agent-html-src/18-groups-panel.js`

A panel built on the `10-subagents.js` sheet and list components, opened from a Groups button next to Agents (added to `build.py` order):

- **Group list:** name, member count, unread, presence dots, paused or suspended badge.
- **Thread view:** each bubble shows the sender's name and avatar; a reply shows "↪ replying to Researcher" with a one-line quote that jumps to the original; "to @Writer" chips for direct messages; mention chips; a pinned bar; system lines ("Writer was added", "Critic is paused").
- **Composer:** reply button on each message, `@` picker listing members with presence (Idle members show "will be woken"), an `@all` entry with the member count, and a live line under the box: "Wakes: Writer, Critic (about 8k tokens)".
- **Nobody answering:** after the `silence_nudge` time, a bar under the last message: "No reply yet. Mention someone or @all".
- **"Why?" sheet** on each message: the `ws_group_dispatch` rows ("Critic: not woken, Wait your turn (2 of 3 unanswered)").
- **Settings sheet:** rename, purpose, members (add with a picker that greys out non-shareable agents from other chats and says why), roles, mute, notifications, rules (preset picker plus the rule list; the full editor is Phase 5), budgets, "Group runs write to the agent's own memory", archive, delete, open the group's context tree.

### 3.11 Edge cases

- An agent mentions itself: ignored. An agent mentions `@all`: allowed only when `agent_to_agent` is on, and it counts as depth +1.
- Two agents keep replying to each other: `chain_depth` stops the chain at `max_depth`, then the next wake needs you; the pair cap from `guard_send` also applies.
- The app closes during a run woken by a group: the existing "interrupted" handling marks the run; its pending group note stays in the inbox and the group shows "Writer was interrupted".
- A message arrives while the agent is engaged but its run already ended: it becomes a new wake only if a trigger applies; otherwise it is delivered quietly.
- Clock changes: counters use engine timestamps; the silence timer is re-armed from `last_message_at` on start.
- A rule names a member who later leaves: the rule is disabled with a warning, not deleted.
- `@all` in a 20-member group: the confirm sheet appears; `max_replies_per_message` does not trim your explicit `@all` (rule 2) but the cost warning does show.

### 3.12 Migration

None: groups are new. Existing per-chat comms settings stay as they are. Agents' existing memory entries have no `category` and appear under General.

### Risks

- **Message storms and cost:** the defaults (mention_only, depth 2, rate 12 per 10 minutes, confirm above 4 agents or 20k tokens) keep a group quiet unless spoken to. The Everyone answers preset shows its cost per message in the composer.
- **Rules that surprise you:** the validator's warnings, the "Why?" sheet and the dispatch log make every decision explainable.
- **Prompt growth:** the group note is folded to a budget and the full thread stays behind `group_read`.

### Tests

Rust, `workspace::groups` and `workspace::group_rules`:

- Creation and membership: `create_requires_three_agents`, `inactive_agent_can_be_added_without_run`, `hidden_agent_refused`, `cross_chat_requires_shareable`, `cross_chat_checks_own_flag_not_template`, `unshareable_later_suspends_not_removes`, `reshareable_restores_member`, `drop_below_three_pauses`, `deleted_agent_becomes_gone_keeps_messages`.
- Activation: `mention_wakes_idle_agent` (asserts `send_comm` with `wake=true` and a new run), `mention_does_not_start_paused_agent_queues`, `at_all_wakes_every_joined_member_except_sender`, `engaged_member_gets_live_delivery_not_new_run`, `second_wake_coalesces`, `plain_text_answer_auto_posted_with_reply_to`, `group_pass_records_dispatch`.
- Threading and identity: `reply_to_must_be_in_same_group`, `reply_to_defaults_to_trigger`, `from_is_engine_set`, `mentions_parsed_by_name_id_and_all`, `ambiguous_mention_rejected_for_agents`, `header_shows_reply_identity`, `delete_message_leaves_tombstone`, `pin_unpin`.
- Rules: `default_social_wakes_nobody_without_mention`, `everyone_replies_wakes_all_on_user_message`, `everyone_on_user_messages_ignores_agent_messages`, `unanswered_threshold_waits_for_n_then_wakes`, `unanswered_resets_on_agent_reply`, `member_count_mode_uses_last_spoke`, `round_robin_rotates_and_persists_cursor`, `reply_wakes_author`, `agent_to_agent_depth_stops_chain`, `cooldown_blocks_agent_trigger_not_user_mention`, `user_mention_overrides_threshold_and_quiet`, `hard_block_beats_user_mention`, `member_rule_beats_group_rule`, `priority_then_restrictive_tie_break`, `caps_trim_in_documented_order`, `budget_exhausted_degrades_to_mentions_only`, `silence_nudge_fires_once_per_message`, `decide_is_pure_preview_equals_post`, `validate_reports_conflicts_and_errors`, `rule_for_departed_member_disabled`.
- Memory: `group_run_memory_goes_to_agent_file_with_category`, `shared_mode_agent_writes_own_file_in_group_by_default`, `memories_never_merged_across_members`, `leaving_group_keeps_agent_entries`, `group_search_ranks_category_first`.
- Limits: `group_post_respects_hop_and_rate_limits`, `cross_chat_group_uses_group_counters_and_each_root_guard`, `prompt_block_lists_groups_and_rules`.

UI, new `tools/agent-html-tests/groups-panel.js`: create flow refuses two members; adding an idle agent shows Idle and no run; a non-shareable agent from another chat is greyed out with the reason; reply quote renders and jumps; "to @member" chip; `@` picker and `@all` show the wake preview; the confirm sheet appears above the threshold; paused member shows the resume prompt; silence bar appears; "Why?" sheet lists dispatch reasons; preset switch to Custom after an edit; suspended banner; 375 px layout; Escape closes sheets.

Patch: `git diff <phase2-commit> > phase3.patch` after the tests pass.

---

## Phase 4. References, permissions and safe deletion: sharing without copies (requirement 4, core)

This is the most important phase. Rules first, then code.

**Rules (explicit, shown in the UI's help sheet):**

1. **Share = reference.** `refs.share` inserts a `ws_refs` row. Bytes stay at the item's `loc`. Every holder that shows the item reads the same row or file, and an edit by anyone with `edit` is seen everywhere.
2. **Modes.** `reference`: shown under "Shared with me" in the holder's tree; used in context only if the holder turns it on. `mount`: lives directly together with the holder's own memory; searched by `ctx memory`, picked by the checklist like the holder's own entries, and marked with its origin.
3. **Permissions.** `view` (see), `use` (may be put in model context), `edit` (change content), `manage` (re-share, change others' permissions). Only the owner or a `manage` holder can grant, and never higher than its own level.
4. **Changing or revoking a permission never touches data.** It only updates or revokes the ref row. Re-granting later restores access to the same item.
5. **Deleting a chat (or a sub-agent, or a group) by default:**
   - Items it owns with **no live refs elsewhere** follow your delete policy (rule 8): **Timed** moves them to Trash (`state='trashed'`) until the time you set; **Direct** purges them at once.
   - Items it owns **with live refs elsewhere** are **detached**: `owner='detached'`, `origin` kept, and the user's library adopts them. Every holder keeps its access, and the tree shows "from deleted chat X".
   - Refs it *holds* to other items are revoked (the items are not touched).
   - An explicit "Delete everywhere" option (owner only, with a count of affected holders) removes the item for every holder. Under Timed it goes to Trash with all its refs suspended (a restore brings the refs back); under Direct it is purged and all refs are revoked.
   - **Both modes keep shared items.** Direct mode is "permanent for what only this place owns"; it never deletes an item another holder references. Only "Delete everywhere" does that, and only after the count is shown.
6. **Moving** changes `owner` (and the `owner` ref). Refs held by others stay valid because they point at the item id, not the place.
7. **Garbage collection.** Bytes are purged only when an item is `purged` and no live ref exists. `ctx_mem_file_store` blobs are purged only when no file item points at the hash.
8. **Delete policy (your answer 1: customizable, direct or time-based).**
   - **Modes:** `direct` (purge at once, no Trash, no undo) and `timed` (Trash, purged automatically when the retention you set ends). Retention choices: 1 hour, 1 day, 7 days, 30 days, 90 days, a custom number of hours or days (1 hour to 10 years), or "until I empty the Trash" (never automatic).
   - **Where it is set,** most specific first: the choice in the delete dialog for this one action ("Move to Trash" or "Delete permanently now"), then the policy of the holder being deleted from (a chat, sub-agent or group), then the policy for the item's kind (for example messages: 7 days, files: 90 days), then the global policy. The first install default is timed, 30 days, and you can change it in Settings.
   - **Undo:** timed deletes show an Undo toast for 10 seconds and stay restorable from Trash. Direct deletes show a confirm sheet with the counts ("5 items will be removed permanently; 2 shared items will be kept") and "This can't be undone".
   - **Changing the policy** affects new deletions. The option "Apply to items already in Trash" recomputes their removal time; if that makes some due now, the save sheet says "12 items will be removed now" first. Switching to Direct never empties the existing Trash without asking.
   - **Restore** puts an item back with its original owner if that holder still exists, otherwise in your library labelled "from deleted chat X". Suspended refs become live again.

Changes:

1. **New `src/workspace/refs.rs`:** `share`, `set_perm`, `set_mode`, `revoke`, `holders_of(item)`, `visible_to(holder)`, `can(holder, item, perm)`, `delete_holder(holder, policy)`, `trash/restore/purge`, `gc`. Every change writes `ws_audit`.
2. **`db::clear_session`** becomes the low-level purge called only by `refs::purge`. The sub-agent `delete` and `deleteData` paths (`subagents.rs`, `subagents/data.rs::delete_data_request`) call `refs::delete_holder(agent:<id>, default)` first, so shared memory and files survive. Update the delete dialog text in `10-subagents.js` to match the new rules and show counts ("3 items are shared and will be kept").
3. **Main chat delete (new).** Add a Delete item to the thread menu in `www/agent.html` (via its source module), an engine action `items.deleteHolder {holder:'session:<key>', policy}`, and a preview action that returns the counts per rule. Then `ChatStore` removes the thread. Archive stays as a non-destructive alternative.
4. **Replace copies with references:**
   - Sub-agent memory `promote` → `refs.share {holder:'agent:main', mode:'mount', perm:'use'}`. Rename the buttons "Share with main" in `10-subagents.js` and `17-agent-goals.js`, and remove the `promote` op after one release (return a clear error pointing to `refs.share`).
   - `forkChat` → the new chat gets a `reference` to the source chat's message range plus a summary item, instead of the copied transcript.
   - Cross-chat ask reply → stored once in `ws_messages`; both chats reference it.
5. **Read path.** `memory_checklist.rs` and the `ctx` tool's memory search include mounted items for the holder (a `UNION` over `ws_refs` where `mode='mount' AND perm IN ('use','edit','manage')`). The prompt assembler includes `reference` items only when `ws_context_use` says `in` (Phase 5 sets this; the default here is `out`). Edits go through `refs::can(…,'edit')`.
6. **Sub-agent memory file.** Shared `agent_memory` entries need stable per-entry identity: store `id` in each `memory/<id>.json` entry (generated on first save if absent), so `loc …#<entryId>` survives key renames.
7. **Main memory, fully shareable and editable from the tree (your answer 4).** With the Phase 1 ids, each main memory entry is an item with `loc host:memory#<id>`, owner `agent:main`. New `src/workspace/longterm.rs`:
   - **Read:** `provider.get(id)`, cached in `ctx_mem_longterm` (the mirror is refreshed from `export` on each sync).
   - **Edit from the tree:** `items.edit {id, text}` checks `refs::can(viewer, item, 'edit')`, then calls `provider.store(key, text, metadata)` with the same key (so the same id), updates the mirror, records a version in `ctx_mem_versions` and writes `ws_audit` ("edited by you from #design"). Every holder sees the new text because they all read the same record.
   - **Share:** `refs.share` to a chat, sub-agent or group, as `reference` or `mount`, with view/use/edit/manage. Nothing is written to the provider except the pin flag below.
   - **Memory modes as refs:** a sub-agent with `read_parent` memory already reads all of main memory, and one with `shared` reads and writes it. The permissions editor shows these as implicit refs ("via memory mode: Use" or "Edit") so the picture is complete. They change only by changing the agent's memory mode, and per-entry refs can add access but not take away what the mode gives.
   - **No silent eviction of shared entries.** Both providers drop the oldest entry beyond 2,000. When an entry gets its first live ref outside `agent:main`, the engine merges `pinned: true` into its metadata (read with `get`, then `store` with the same key, text and merged metadata); when the last such ref goes, it removes the flag. Eviction in both providers skips pinned entries. If every candidate is pinned, `store` returns an error "memory is full of shared entries" and the tree offers a clean-up.
   - **Delete and the policy:** Trash = merge `trashed_at` into the metadata; both providers skip trashed records in `recall`, `search` and `list`. Purge = `provider.forget(key)`. Restore = remove `trashed_at`.
   - **The model's `memory_forget`** on an entry that other holders reference does not delete it. The entry is detached to your library, `main_hidden: true` is merged into its metadata so the provider's search for the main agent skips it, and the tool answers "Removed from your memory. It is shared with Researcher and #design, so their access stays." On an unshared entry, `memory_forget` follows the delete policy as today's forget does, with Trash first under Timed.
   - **Fallback:** entries without an id (older host build) stay view-only, as in Phase 1.

Delete policy and trash, new schema:

```sql
CREATE TABLE ws_delete_policy (
  scope TEXT PRIMARY KEY,         -- 'global' | 'kind:<kind>' | 'holder:<holder id>'
  mode TEXT NOT NULL,             -- direct | timed
  retain_secs INTEGER,            -- timed only; NULL = keep until the user empties the Trash
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
ALTER TABLE ws_items ADD COLUMN trashed_at INTEGER;
ALTER TABLE ws_items ADD COLUMN purge_after INTEGER;     -- NULL = never automatic
ALTER TABLE ws_items ADD COLUMN trashed_by TEXT;
ALTER TABLE ws_items ADD COLUMN restore_owner TEXT;
CREATE INDEX ws_items_purge ON ws_items(state, purge_after);
CREATE TABLE ws_pending_client_purges (item_id TEXT PRIMARY KEY, loc TEXT NOT NULL, queued_at INTEGER NOT NULL);
```

New `src/workspace/trash.rs`:

- `policy_for(conn, item, holder, action_override) -> (mode, retain_secs)` resolves the four levels in rule 8.
- `trash(item)` sets `state='trashed'`, `trashed_at`, `purge_after = trashed_at + retain_secs` (or NULL), `restore_owner`, and suspends the item's refs. `restore(item)` undoes it.
- `purge(item)` resolves `loc`: rows in `db:` tables are deleted; `fs:` files are removed; `host:memory#<id>` calls `provider.forget`; `idb:` items (WebView library) are queued in `ws_pending_client_purges` and an `items.purgeClient` event asks the WebView to delete them, retried on the next app open if the WebView is closed. A chat's transcript is purged as one unit with `db::clear_session`. If messages of that chat are referenced elsewhere (a fork range, a share), the session is kept as a hidden `detached` container holding only those messages; the rest are deleted.
- `sweep(conn, now)` purges items with `state='trashed' AND purge_after <= now` in batches of 200, one transaction per batch. A failed purge leaves the item in Trash with `meta.purge_error`, is retried on the next sweep and is logged in `ws_audit`. It runs when the engine handle starts, on `items.tree`, and next to the existing `sweep_lifetimes` calls in `subagents.rs` (four call sites), throttled to once every 10 minutes. After the app was closed past a removal time, the next start purges what is due and the tree shows "12 items were removed from Trash (their time ended)".
- Messages inside a group or peer chat: deleting one always leaves the tombstone; the text itself is trashed or purged by the policy.

Migration: create the `owner` ref for every existing item (one row per item, no data copy). Insert the global delete policy row (`timed`, 30 days) if none exists. Until Phase 4 lands, a group delete in Phase 3 moves the group to Trash for a fixed 30 days; with Phase 4 it follows the policy. Existing "copied to main memory" entries stay as they are (they are already separate data); mark them `origin='promoted-copy'` in meta so the user can see and merge them.

Risks:

- A permission check missed in one read path leaks data. Mitigation: all reads of shared items go through `refs::visible_to` / `can`, and a test enumerates every read entry point (`items.read`, checklist build, `ctx` memory search, group context, sub-agent memory op) against a revoked ref.
- Edits to a shared item surprise other holders. Mitigation: the version history from the existing `ctx_mem_versions` is kept, and the tree shows "edited by X".
- Detached items pile up. Mitigation: the library's "Detached" folder with a bulk clean-up (Phase 5).
- A direct delete removes something you wanted. Mitigation: Direct is never the first-install default, the confirm sheet names counts and says it cannot be undone, and shared items are kept in every mode.
- A host downgrade drops ids or flags from records it rewrites. Mitigation: ids are recomputed deterministically; the engine re-applies `pinned`, `trashed_at` and `main_hidden` from `ws_items`/`ws_refs` on each sync, because the engine tables are the source of truth for those flags.

Tests:

- Rust: `share_creates_ref_not_copy` (the source table row count is unchanged and both holders read the same bytes), `edit_seen_by_all_holders`, `revoke_keeps_data`, `regrant_restores_same_item`, `perm_cannot_exceed_granter`, `delete_chat_detaches_shared_items`, `delete_chat_trashes_unshared`, `delete_everywhere_purges_and_revokes`, `subagent_delete_keeps_shared_memory`, `promote_now_mounts`, `fork_references_range`, `mounted_item_found_by_ctx_memory_search`, `reference_item_not_in_prompt_until_used`, `gc_never_drops_referenced_blob`, plus the read-path enumeration test.
- Delete policy: `policy_resolution_order` (action > holder > kind > global), `direct_purges_unshared_now`, `direct_still_detaches_shared`, `timed_sets_purge_after_from_retention`, `until_empty_never_auto_purges`, `sweep_purges_only_due_items`, `sweep_failure_keeps_item_and_retries`, `sweep_after_long_offline_purges_due`, `policy_change_applies_to_new_only_by_default`, `apply_to_existing_recomputes_and_reports_due`, `restore_to_original_owner_or_library`, `restore_reactivates_suspended_refs`, `delete_everywhere_timed_suspends_refs`, `delete_everywhere_direct_revokes_and_purges`, `chat_purge_keeps_referenced_messages_in_detached_container`, `client_purge_queued_until_webview_opens`, `message_delete_always_tombstones`.
- Main memory: `longterm_edit_same_key_same_id`, `longterm_edit_seen_by_all_holders`, `longterm_share_writes_only_pin_flag`, `pinned_entry_never_evicted` (fake provider at the 2,000 cap), `all_pinned_store_errors`, `longterm_trash_hidden_from_recall_search_list`, `longterm_purge_calls_forget`, `model_forget_on_shared_detaches_and_hides`, `model_forget_on_unshared_follows_policy`, `memory_mode_shown_as_implicit_ref`, `longterm_without_id_refuses_edit`.
- Host providers: `eviction_skips_pinned`, `trashed_and_main_hidden_skipped_in_search`, `metadata_merge_keeps_other_fields`.
- UI: the delete dialog shows counts per rule and the mode (Trash with its removal date, or permanent); the Undo toast restores; a "from deleted chat" badge appears; "Share with main" replaces "Copy"; a main memory entry can be edited from the tree and the edit shows in a group that has it mounted.

Patch: `git diff <phase3-commit> > phase4.patch` after the tests pass.

---

## Phase 5. Checklist bulk actions, memory permissions UI, group AI context control (requirements 3 and 4, UI)

Changes:

1. **New `src/workspace/bulk.rs`.** `items.bulk {ids[], op, target?, perm?, mode?, dryRun}` with `op` one of `move`, `delete`, `share`, `unshare`, `setPerm`, `setMode`, `restore`. It runs everything in one `write_tx` (all or nothing) and returns per-item results. `dryRun:true` returns the consequences first ("2 shared items will be detached, 5 trashed; 1 item cannot be moved because you only have view"). Targets are a sub-agent, a group, a session, or several sessions.
   - Move semantics by kind: a memory entry, note, file or agent memory changes owner. A whole chat moves into a group or sub-agent as a reference. Single messages are never physically moved between chat transcripts (the transcript order is model history); "move message" means share as reference plus hide in the source view. The UI says this.
2. **`ws_context_use` and AI-level control.** For each holder (a chat, a sub-agent, a group) each visible item has `in`, `out` or `auto`:
   - The user sets it from the tree.
   - In groups, an optional policy lets the model decide (`actor='model'`) through a new group tool `group_context {group, item, state, reason}`. Every model change is logged and shown, and the user can lock an item ("user decides only").
   - The prompt assembler for a group conversation uses exactly the `in` set plus `auto` picks under budget, through `projection.rs`.
   - Memory per group, per agent and per chat stays managed separately: each holder has its own `ws_context_use` rows for the same shared item.
3. **UI in `59-workspace-tree.js` (+ small hooks in `58-context-tree.js` and `18-groups-panel.js`):**
   - A "Select" mode adds checkboxes to every row (`data-item-id`), with a sticky action bar: Move to…, Share with…, Remove, Delete, Permissions, Use in context.
   - The target picker has tabs Sub-agents / Groups / Sessions with multi-select for sessions.
   - A dry-run summary sheet appears before anything is committed.
   - **Memory permissions editor** per item: owner, list of holders with mode (Reference / Mount) and permission (View / Use / Edit / Manage) dropdowns, Revoke, and history (from `ws_audit`). It can be changed again at any time.
   - The group context tree shows an "AI uses this" toggle per item and the model's reason when the model changed it.
4. **Group rules editor (completes Phase 3).** In `18-groups-panel.js` settings: a preset picker (Social, Everyone answers, Round table, Wait your turn, Moderated, Custom); the rule list with an on/off switch, scope (whole group or one member), parameters as plain controls ("Reply only after [3] unanswered messages", "Count messages: in the group / since this member last spoke"), and drag to set priority; the validator's errors and warnings inline; a "Test a message" box that runs `decide` without posting and shows who would be woken and the token estimate; and the history of rule changes from `ws_audit`. Per-member rules are also reachable from each member's row.
5. **Delete settings and Trash.** A Settings screen "Deleting": the global mode (Direct or Timed) and retention, per-kind overrides (chats, messages, memory, files, agents, groups), and the list of per-holder overrides; each chat, agent and group settings sheet has its own "When I delete from here" line. A Trash view in the tree's "All" section: items with their removal date or "until you empty it", Restore, Delete now, Empty Trash (with count), and filters by kind and origin. The bulk action bar's Delete honours the policy and offers the per-action override.
6. **Main memory in the permissions editor.** Main memory entries get the same editor as any item: holders, mode, permission, implicit refs from memory modes (read-only rows), pin status ("protected from automatic removal because it is shared"), and history.
7. **Remove `57-memory.js`** once its remaining views (raw memory, jobs, storage) are reachable from the tree's Memory group. Move those views into `59-workspace-tree.js` sections first, then delete the file and its `build.py` entry.
   **Decision (audit, Nov 2026): keep `57-memory.js`.** Its own screen is gone: `__chatMemory.open()` opens the context card (58-context-tree.js), and the summary, history, results, jobs and storage views are reachable there as the card's Summary and Settings tabs. What remains in the file is the chat-memory data layer that the card and the Agents tab call: `chats` (per-chat state), `refresh`, `subscribe`, `openResult`, the memory indicator, and `paintSummary` / `paintHistory` / `paintResults` / `paintSettings`, which the card renders into its tabs (58-context-tree.js uses them at 12 call sites, 15-agent-team.js at one). Its small dialog is still the only memory view when the user hides the context card (`__ctxTreeHidden`) or the engine does not report it, and `tools/agent-html-tests/memory.js` covers both. Deleting it would break those tabs; moving it into `59-workspace-tree.js` would move about 950 lines with no change for the user. The overlap this item was about (two memory screens) no longer exists.

Risks:

- A bulk delete on the wrong selection. Mitigation: the dry run is mandatory for delete and shows whether the policy sends items to Trash (with the removal date) or removes them permanently; the action bar shows the selection count.
- Model-controlled context could hide important items. Mitigation: the user's lock wins, the default policy is `user`, and the model can only toggle items the group already has `use` on.

Tests:

- Rust: `bulk_is_atomic` (one failure rolls back all), `bulk_dry_run_matches_commit`, `bulk_share_to_multiple_sessions_creates_refs_only`, `move_message_is_reference_and_hide`, `context_use_per_holder_independent`, `model_toggle_respects_user_lock`, `group_prompt_uses_projection_in_set`, `bulk_delete_uses_policy_and_override`, `bulk_dry_run_reports_trash_vs_permanent`, `rules_test_box_matches_post` (the preview from the editor equals the real dispatch).
- UI, `groups-rules.js` suite: switch presets; add a member-scoped "Wait your turn" rule and see the conflict warning; an invalid value blocks save; the test box shows wake list and estimate; history lists the change.
- UI, `delete-settings.js` suite: set Direct globally, then a chat override to 7 days; delete in that chat goes to Trash with the right date; delete elsewhere asks for permanent confirm; "Apply to items in Trash" shows the due count; Trash restore and Empty Trash; 375 px layout.
- UI: new `workspace-bulk.js` suite (select three items across categories → share with a group → refs appear in the group tree without new data; bulk delete shows the dry run and moves to Trash; restore works; permission change then revert; the context toggle persists; 375 px layout; keyboard-only path).
- Full regression: all Rust tests, vitest, and every `tools/agent-html-tests/*.js` suite through `run-all.sh`.

Patch: `git diff <phase4-commit> > phase5.patch` after the tests pass.

---

## 4. Phase order, dependencies and sizing

| Phase | Depends on | Ships alone? | Rough size |
|---|---|---|---|
| 0 Safety net | none | yes (fixes only) | small |
| 1 Registry + full tree | 0 | yes (read-only) | medium |
| 2 Envelope + peer store | 1 | yes | medium-large (many call sites) |
| 3 Groups, activation, rules engine, memory category | 2 | yes (rules editor UI completes in 5; presets work from day one) | large |
| 4 Refs, permissions, delete policy, main memory by id | 1 (and 2/3 for message and group items) | yes | large, highest risk; includes a uniffi interface change and native rebuilds (started in Phase 1) |
| 5 Bulk UI, context control, rules editor, delete settings | 3 and 4 | yes | medium-large |

The provider id work in Phase 1 is the only part that needs native rebuilds. If the native build is not ready, Phase 1 can ship the engine side with the fallback (main memory read-only by key), and the id part lands with Phase 4.

If you need the "no copy" guarantee earlier than groups, Phase 4 can run before Phase 3. It then covers chats and sub-agents only, and Phase 3 adds group holders.

## 5. Patch procedure (same for every phase)

1. Work on branch `unified-tree`; tag the start `phase<N-1>` (`main` for Phase 0).
2. Implement the phase.
3. Run `cargo test` (crate dir), `npx vitest run`, `python3 tools/agent-html-src/build.py`, and the UI suites the phase touches (Phase 5: `run-all.sh`). Record the pass counts in the commit message.
4. Only when everything is green: `git add -A && git diff --cached phase<N-1> > phaseN.patch`, then commit and tag `phase<N>`.
5. Check the patch: `git checkout phase<N-1> && git apply --check phaseN.patch`.

## 6. Questions

Resolved (your answers, built into the phases; see section 3a):

1. Trash retention: **resolved.** Customizable: direct (permanent) or timed with your own retention, set globally, per kind, per chat, agent or group, or per delete. Phase 4 rule 8 and `trash.rs`; Phase 5 item 5.
2. Cross-chat groups: **resolved.** Only sub-agents marked `shareable`. Phase 3, section 3.3.
3. Group delivery: **resolved.** Social-media style: everyone receives messages, only mentions, replies, direct messages and your rules wake agents; inactive agents can be added and are woken by `@name` or `@all`; per-group custom rules. Phase 3, sections 3.4 to 3.7; Phase 5 item 4.
4. Main memory ids: **resolved.** Yes; deterministic ids added in place. Phase 1 item 7; Phase 4 item 7; Phase 5 item 6.
5. E2 tag behaviour: **resolved (2026-11-24).** Keep "last tag wins", the rule the checklist design doc records. This project does not change tag behaviour; a per-version tag rule (E2) would be its own task with its own plan.

Nothing is open.

## 7. As built (differences from this plan, recorded after the audit)

Not bugs; the code is right and the plan text above is older:

- The workspace module is `src/ws/`, not `src/workspace/`: `src/workspace.rs` already existed (the reason is written at the top of `ws/mod.rs`).
- The Groups panel is `tools/agent-html-src/59-groups.js`, not `18-groups-panel.js` (section 3.10).
- Peer chats show in the context tree (`peerChatsBlock` in `58-context-tree.js`), not in a tab of their own.
- The seed fixture is `src/ws/test_seed.rs`, not `tests/fixtures/workspace_seed.rs`.
- Registry write hook (Phase 1): writers call `ws::mark_stale` (chat save and delete in `db.rs`, a new stored file version in `memory_checklist.rs`, a roster change in `SubagentManager::persist`), so the next workspace request re-indexes at once; `ensure_synced`'s five-second window stays as the fallback. This replaces a `registry::touch` call in every writer.
- Main memory beyond the mirror (Phase 1 item 7): no new `MemoryProvider` methods. The registry asks the host for its keys through the existing `list(prefix, limit)` (`HostMemory::keys`); Android and iOS `list` now let an explicit limit reach `MAX_ENTRIES` (2,000), while a missing limit stays at 200. Entries the mirror does not hold are indexed by key (`host:memory@key:<key>`) and stay read-only until the mirror gives them an id.
- Trash sweep (Phase 4): `trash::maybe_sweep` (throttled to once per ten minutes) runs at engine start and inside `sweep_lifetimes`, so all four lifetime-sweep call sites get it, besides the start of every `items.*` request.
- Identity (Phase 2): requests from the app act as the user. `agents.message` takes its caller from the engine, refuses a request that names another caller, and refuses a `from` that is a real principal by id or display name or any namespaced name; workspace requests that name another `viewer` or `actor` are refused at the app boundary. `items.get` checks `can_see` like `items.read`.
- Groups in the bridge: `bridge/nativekit.ts` lists every `groups.*` action of `groups_app_request`, and `tests/agent-subagents.test.ts` checks that list against the Rust match arms.
