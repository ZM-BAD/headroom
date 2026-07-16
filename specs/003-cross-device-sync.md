# 003: Cross-Device Reconciliation Engine

## Status

Union reconciliation engine, incremental cloud push, delete linkage (local + cloud DEL), and local cache LRU eviction implemented; live acceptance pending. Zombie cleanup unified engine implemented (periodic alarms 60min + home-page trigger, shared 5min throttle); reconciliation frequency control (debounce + REFRESH_HISTORY immediate pull) implemented. All 7 platforms' `fetchConversationList`, history-fetch APIs, and deletion endpoints reverse-engineered and live-captured (2026-06).

**Scope**: Cross-device sync semantics. Combines [001](./001-headroom-core.md)'s estimation capability with [002](./002-upstash-data-layer.md)'s transport pipeline to make dialogue records correct across devices.

## Summary

**Truth = platform history text content; tokens = our estimates** (001 engine). Open conversation → pull full history from platform → estimate tokens per round → union-merge with Upstash existing records by **stable messageId** (positional `n` is display-only, re-sorted by time after merge) → **display in panel first, then sync to Redis in background**. Platform servers store history text; Upstash is the cross-device aggregation layer; `browser.storage.local` is the acceleration cache. Incremental interception (001) is downgraded in this spec to "immediate feedback between two full reconciliations."

Four sync actions (product-level interactions; DeepSeek as example):

| Action                           | Trigger                                  | What it does                                                                                                                                     |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A Zombie Cleanup**             | Open platform home page, no conv. opened | Background pulls conversation list ↔ diff against Upstash keys → DEL the difference (deleted on another device / mobile but not synced to cloud) |
| **B Open-and-Reconcile**         | Click into a specific conversation       | Pull full platform history → estimate tokens per round → union-merge with cloud records → **display first, then sync**                           |
| **C Real-Time Incremental Push** | Mid-conversation, model output done      | Estimate this round's input/output tokens → best-effort push to cloud                                                                            |
| **D Delete Linkage**             | Manually delete conversation on page     | Intercept delete request → DEL Upstash + local cache                                                                                             |

## Motivation

### Why Not Rely Solely on Incremental Interception

Rounds chatted on mobile are simply never intercepted by the extension — those rounds are not in our cumulative tally. For "cross-device" to be real, we must pull full history from the platform in one shot when the user **opens a conversation**. Like WeChat: you don't receive messages without opening, but once opened, full history syncs. Rounds chatted on mobile, on other devices, or lost during network outages — all naturally corrected on next open.

### Why Union Merge, Not Overwrite

Tokens are always re-estimated from text; every reconciliation re-estimates all rounds — we only need to "preserve all rounds ever seen." **Union (by stable messageId)**: each platform message / round has a **stable identity** (DeepSeek `message_id`, ChatGPT mapping node id, Kimi msg `id`, Qwen object map key, Doubao `index_in_conv`, all live-confirmed 2026-06). Merging **pairs rounds by messageId**: rounds still returned by platform are re-estimated from platform text; old rounds no longer returned keep their old estimates.

> **Why positional round-n should not be used as the merge key**: Positional `n` is "the index in this response array," not a stable identity. When the platform's returned round set **changes** (truncation, pagination fetch failure, single-round deletion, regenerate shift), positional `n` drifts as a whole, mismapping different real rounds to the same `n` → `totalTokens` silently miscalculated. Verified reproduction (real `unionRounds` / `upsertRound`): 50-round conversation, Device B only gets the last 30 rounds re-indexed as `n=1..30`; after merge `totalTokens` evaluates to **1875 instead of the real 1275** (last 20 rounds double-counted, first 20 lost). Hence `n` is **display-only**, reassigned after merge by time order; the merge key must be a stable messageId.

> **Truncation in practice (2026-06 live test, 7 platforms)**: Under normal circumstances **none truncate** — DeepSeek / Kimi / Qwen return full history in one call; ChatGPT returns the entire mapping tree; Doubao / Tongyi Qianwen paginate but **walk all pages**. The value of the union's "preserve old rounds" behavior exists only in edge cases: ultra-long sessions hitting pagination caps (Doubao / Tongyi Qianwen 50-page cap), pagination fetch interruption, single-round deletion / regenerate changing the round set. Overwrite would lose rounds in these cases.

### Why No Outbox / Alarms Drain

The cost of incremental loss (during network outages) drops from "permanently lost" to "recomputed and recovered on next open." The complexity of outbox + alarms drain adds no value for cross-device correctness (mobile bypassing interception is the real problem); full reconciliation is the fundamental solution.

## User Interaction Scenarios (Cross-Device Goal)

> 6 user interactions (see [001](./001-headroom-core.md) "User Interaction Scenarios (Local Layer)") already have local behavior in 001; this section only marks **which interactions get upgraded after 003 wiring and what they upgrade to**. One "interaction × 003 action" matrix to avoid contradicting 001's local descriptions.

| #   | Interaction                         | 001 Local Behavior (current)                           | 003 Upgrade (goal)                                                                                                              |
| --- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open platform home page             | IDLE state                                             | **+ Zombie Cleanup (P1)**: `fetchConversationList` ↔ diff against Upstash keys → DEL the difference (deleted on another device) |
| 2   | Start new conversation, first round | REPLACE local record                                   | Degrades to union (cloud record empty, semantics same as REPLACE); new round best-effort pushed to cloud                        |
| 3   | Open existing conversation          | REPLACE local record                                   | **★Core: union merge + display-first-then-sync** (see sequence diagram)                                                         |
| 4a  | Append new Q&A round                | REPLACE local record                                   | Changed to union; after local write, best-effort push entire record to cloud (failure warns, recovered on next open)            |
| 4b  | Regenerate / Stop                   | REPLACE (round count unchanged, round N token updated) | Union handles naturally: platform round N new text re-estimates and overwrites old estimate, round count unchanged              |
| 5   | Delete conversation                 | `onBeforeRequest` + `parseDelete` → delete local       | **+ Upstash DEL** (best-effort); mobile deletion goes through periodic alarm / home-page diff cleanup                           |

**How to read the matrix**: Interactions marked "—" or "degrades" — 003 does not change their local behavior, only adds best-effort cloud push; interaction 3 marked "★Core" is the primary reason 003 exists; the rest are accompanying sync actions.

### Scenario Sequence Diagram · Open Existing Conversation (Interaction 3, 003 Core Upgrade)

One reconciliation = pull history → estimate per round → union merge → **display first, then sync**. "Display first" uses local cache / estimation to open the gauge in milliseconds, not waiting for the network; "sync later" is best-effort background push to Upstash; failure does not block the UI.

```mermaid
sequenceDiagram
    actor U as User
    participant C as Content Script
    participant B as Background SW
    participant H as Platform History API
    participant L as Local Cache
    participant R as Upstash Redis
    participant S as Side Panel
    U->>C: Click into existing conversation (chatted on another device)
    C->>B: PAGE_READY
    B->>L: Read local cache (instant fallback, 001 already has: projectForTab side effect)
    B->>S: STATE_UPDATE (display first: old record / 0)
    C->>H: fetchHistory(dialogueId)
    H-->>C: Full history text (including rounds from other devices / mobile)
    C->>B: HISTORY_PARSED(rounds)
    B->>R: getDialogue(key)
    R-->>B: cloudRecord (may be empty)
    Note over B,R: ===== 003 new orchestration below =====
    B->>B: estimateTokens per round
    B->>B: union(cloudRecord.rounds, historyRounds)
    B->>L: setLocalDialogue (merged record)
    B->>S: STATE_UPDATE (corrected display: real cumulative)
    B--)R: setDialogue (overwrite entire record, best-effort)
    Note over B,R: Failure only warns, does not block UI;<br/>recomputed and recovered on next open
```

**Relationship to 001 Diagram A**: 001 Diagram A is this flow's **single-device predecessor** (no Upstash involved, REPLACE locally). After 003 wiring, two items are preserved, one is modified, and one is added: ① `fetchHistory` primitive unchanged; ② "read cache first to display" already in 001 (`projectForTab` reads local cache and broadcasts on `PAGE_READY`), 003 reuses it; ③ REPLACE is upgraded to **union merge**; ④ new "background best-effort cloud push" post-sync added. **003's real additions are union + post-sync, not "display first"**.

**Preserved**:

- **Two-layer storage**: local cache (accelerates opening, still available offline) + Upstash (cross-device aggregation). Roles unchanged.
- **Delete linkage** (interception + storage effect).
- **Incremental interception is preserved**, downgraded to "immediate feedback between two full reconciliations" (no longer the truth source).

**Added**:

- **Open-and-full-reconciliation (core)**: content script `PAGE_READY` → background `fetchHistory` → full platform history → estimate tokens per round with 001 engine → union merge → overwrite-write local cache + Upstash → re-project gauge.
- **Union merge (by messageId)**: `getDialogue` → `union(cloudRounds, historyRounds)` → `setDialogue`. 002's `setDialogue` is pure overwrite-write; merge orchestration is in this spec.
- **Zombie cleanup (unified engine, two trigger entries)**: periodic alarms (60min) + home-page open → shared throttle (5min) → `fetchConversationList` → diff against Upstash keys → DEL difference.
- **Multi-conversation local cache + LRU eviction**.
- **Product boundary statement**: Headroom only accurately records conversations "opened on a device with the extension installed." Cross-device relies on "open-and-sync" — as long as a conversation is opened on any device with the extension, it fully syncs; conversations never opened on an extension-installed device are not in the data. README / PRIVACY state this explicitly.

**Not adopted**: outbox (incremental loss is covered by "recompute on next open," see Motivation above). **`chrome.alarms` is adopted only for zombie cleanup scheduling** (60min period, not incremental drain). The gauge is derived directly from the cache record (`projectUsage`); no separate runtime state snapshot is stored.

## Requirements

### P0 — Core

- [x] **Open-and-full-reconciliation engine**: `PAGE_READY` → `fetchHistory` → estimate tokens per round → union merge local + Upstash → **display first, then sync**.
- [x] **Union merge semantics (by messageId)**: rounds present on platform take priority; old rounds no longer returned are preserved; `totalTokens` / `roundCount` recomputed as real cumulative after merge.
- [x] **Multi-conversation local cache**: `headroom:conv:{p}:{id}` stores the latest reconciliation / incremental result; gauge opens instantly from cache (GET_STATE projection). LRU eviction in P1.
- [x] **Incremental cloud push**: after this round's history lands (`onCompleted` → `fetchHistory` → `applyHistory`) → best-effort push to Upstash (overwrite entire record); failure only warns, recovered on next open.
- [x] **Delete linkage (storage effect)**: webRequest hits `deleteUrl` → `parseDelete` extracts id → delete local cache + Upstash `DEL` (best-effort).
- [x] **Gauge derived from local cache record** (`projectUsage`): already landed in 001, 003 reuses.

### P1 — Enhancement

- [x] **Zombie cleanup (unified engine)**: `chrome.alarms` (60min period) + home-page open → shared throttle (5min) → `fetchConversationList` → diff against Upstash → DEL difference.
- [x] **Reconciliation frequency control**: debounce when rapidly switching conversations / only trigger full reconciliation for conversations stayed >N seconds.
- [x] All 7 platforms' history-fetch APIs verified (2026-06 live capture, text extractable on all platforms).
- [x] All 7 platforms' deletion endpoints confirmed (interception layer ready).

## Design

### Architecture

```
Side Panel (UI)  ↔ GET_STATE / STATE_UPDATE
Background (SW, ephemeral)
  ├─ Open conversation: PAGE_READY → fetchHistory → full reconciliation → union merge → display first, then sync
  ├─ webRequest: send (+pending) / delete (+DEL)   [immediate feedback / web delete follow]
  └─ Read: local cache first (instant) → background reconciliation corrects
       ↕                                    ↕ (best-effort overwrite)
  browser.storage.local ──────────────→ Upstash Redis KV
  (cache + acceleration)                 (cross-device aggregation)
                                          ↑
                                  AI Platform Server (history text = truth)
```

### Local Keys

```
headroom:settings           → full object including credentials + updatedAt
headroom:conv:{p}:{id}      → DialogueRecord (latest reconciliation / incremental result)
headroom:conv-index         → { <full-key>: updatedAt } metadata (for LRU eviction, avoids full scan)
```

### Union Merge (by messageId)

```
One reconciliation:
  cloudRecord  = getDialogue(key)                     // may be empty
  historyRounds = fetchHistory(dialogueId)            // full platform history, each round carries stable messageId
  newRounds = historyRounds.map(h => ({ messageId: h.messageId, ...estimate(h) }))
  mergedRounds = union(cloudRecord.rounds, newRounds)  // by messageId: history wins; cloud-only messageIds preserved
  mergedRounds.sort(by time-order).forEach((r,i)=> r.n = i+1)   // n is display-only, reassigned after merge by time
  record = { ...cloudRecord,
             rounds: mergedRounds,
             totalTokens: Σ mergedRounds.total,        // real cumulative recomputed
             roundCount: mergedRounds.length,          // = number of distinct messageIds in merged set
             updatedAt: now }
```

- **Rounds still returned by platform** → re-estimated from platform text, overwriting old estimates (platform is text truth).
- **Rounds no longer returned by platform** (truncation / pagination miss) → keep old estimates from `cloudRecord`, not lost.
- **`totalTokens` / `roundCount`** recomputed from merged set: `totalTokens = Σ mergedRounds.total`; `roundCount = number of distinct messageIds in merged set` (stable-identity dedup, naturally truncation-resistant / duplicate-resistant). Both unaffected by `rounds[]` trimming (see 001 invariants).

> **Normal case = full overwrite write**: When platform returns complete history, every round wins with a re-estimated value, old cloud values replaced as a whole — so coefficient upgrades (tokenizer change / 004 calibration / user override) are refreshed on every open; old estimates don't get stuck. Union's "selectivity" only manifests when platform **truncates / paginates**: dropped early rounds keep old cloud estimates; the cost is those rounds stay on whatever coefficient set they were estimated with (`DialogueRecord` stores only counts, no text, so no text means no re-estimation); the benefit is not losing those rounds' cumulative totals. DeepSeek returns full history, no pagination (see 001), so this limitation does not exist.

**Display-first-then-sync** (key UX): reconciliation computes record → immediately write local cache + broadcast gauge (user sees in ms, not waiting for network) → background best-effort `setDialogue` pushes to Upstash (failure only warns, does not block UI, recovered on next open).

### Local Cache Eviction (LRU)

After introducing multi-conversation local cache, `storage.local` grows with use. Eviction is needed — but local is **cache, not truth** (Upstash has complete records; after eviction, can re-pull from cloud), so eviction is routine space management, not data loss.

**Quota measured (2026-06)**:

| Browser                      | `storage.local` default quota                                   | With `unlimitedStorage` |
| ---------------------------- | --------------------------------------------------------------- | ----------------------- |
| Chrome / Edge (Chromium MV3) | ~10 MB (was 5MB before Chrome 113)                              | Removed                 |
| Firefox                      | Follows IndexedDB quota (typically up to 50% of available disk) | Removed                 |

Single `DialogueRecord`: 50 rounds ≈ 4 KB, full 200 rounds ≈ 16 KB (`RoundRecord` stores only token counts, no text). 10 MB can cache ~2,500 50-round conversations / ~600 200-round conversations — sufficient for individual users.

**Algorithm: LRU, evict by `updatedAt`** (`DialogueRecord.updatedAt` is refreshed on every write, naturally an LRU timestamp, zero extra storage). `conv-index` stores `{ <full-key>: updatedAt }` mapping, avoiding full `storage.local.get(null)` scan. **Trigger**: local total exceeds **soft threshold 8 MB** (leaves 2 MB for settings) → evict oldest by `updatedAt` ascending (synchronously delete conv-index entry) → down to **6 MB** (hysteresis zone, avoids frequent eviction). Eviction **only deletes local**, not Upstash; next open of that conversation re-pulls from cloud.

**No `unlimitedStorage` permission added**: one more permission = one more store-review defense + one more user consent prompt + reload may gray-card (see `AGENTS.md`); Firefox behavior depends on disk quota, not guaranteed persistent. 10 MB + LRU is sufficient for individual users, and eviction does not lose truth.

### Data Flow

- **Open conversation (B)**: `PAGE_READY` → `fetchHistory` → estimate per round → union merge → local SET + broadcast gauge → background Upstash SET.
- **Continue chatting (C)**: after `onCompleted` pulls new round and `applyHistory` lands it → best-effort push to Upstash (overwrite entire record); failure warns, recovered on next open.
- **Read usage**: `GET_STATE` → read local cache record → `projectUsage` (instant); corrected after background reconciliation completes.
- **Web delete conversation (D)**: webRequest hits `deleteUrl` → `parseDelete` → delete local cache + Upstash `DEL` (best-effort).
- **Mobile delete conversation**: next home-page open or periodic alarm → `fetchConversationList` diff cleanup.
- **Zombie cleanup (A)**: periodic alarms (60min) + home-page open → shared throttle (5min) → `fetchConversationList` → diff against Upstash keys → DEL difference.

### Adapter Field Ownership (Primitive vs. Orchestration)

`fetchHistory` is easily misread as "003-exclusive." In reality it has two layers that must be nailed down:

- **Primitive (contract definition + DeepSeek implementation) goes to [001](./001-headroom-core.md)** — interface signature `fetchHistory?(dialogueId) → HistoryRound[]`, DeepSeek's reverse-engineered implementation, `HistoryRound` type, all defined in 001 and already landed (`utils/platform-adapter.ts`, `adapters/deepseek.ts`). 001's "open / switch / reply-complete all pull history → REPLACE local record" also uses it.
- **Orchestration (how to merge after pulling history) goes to 003** — 001 uses REPLACE (history is truth, sufficient for single device); 003 adds **union merge + display-first-then-sync** on top of the primitive, giving the same pull-history action cross-device capability. 002's `setDialogue` is pure overwrite-write; "read cloud record → union → write" orchestration is 003's responsibility.

Fields **newly added** by 003 on the adapter contract (primitives still defined by 001, here only marking 003 usage):

- **`fetchConversationList?() → string[]`**: pull conversation id list (for zombie cleanup).
- **`deleteUrl` / `parseDelete` / `deleteHost?` / `deleteMethod?`**: delete-interception primitives (001 already implements local delete linkage; 003 adds Upstash DEL on top, see delete scenario).

Platforms without `fetchHistory` → 003 reconciliation skips, degrades to pure incremental mode (that platform does not overwrite cross-device).

### Zombie Cleanup (Unified Engine, Two Trigger Entries)

**Problem**: Conversations have been deleted (manual web delete / mobile delete / platform recycling), but Upstash still holds the corresponding `headroom:conv:{p}:{id}` key, wasting storage and polluting data.

**Design principle**: Two trigger scenarios (periodic, home page) share one cleanup engine and throttle logic, avoiding duplicate execution.

#### Cleanup Engine (Platform-Agnostic)

```typescript
// background.ts

async function cleanupZombies(
  platformId: string,
  liveIds: string[],
): Promise<void> {
  // 1. Throttle: skip if last run <5min ago
  const state = await getCleanupState();
  if (!shouldRunCleanup(state, platformId, Date.now())) return;

  // 2. SCAN Upstash keys for this platform
  const cloudKeys = await kvScan(creds, `headroom:conv:${platformId}:*`);

  // 3. Compute diff → DEL
  const zombies = selectZombieKeys(cloudKeys, new Set(liveIds), platformId);
  await Promise.all(zombies.map((k) => kvDel(creds, k).catch(() => {})));

  // 4. Record this cleanup time
  await setCleanupState(cleanupStateAfterRun(state, platformId, Date.now()));
}
```

#### Two Trigger Entries

| Trigger              | Implementation                                                    | Call                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Periodic (60min)** | `chrome.alarms.create("zombie-cleanup", { periodInMinutes: 60 })` | `onAlarm` → iterate 7 platforms → if tab exists, send `FETCH_CONVERSATION_LIST`; if no tab, skip (user not active on this platform, no background action triggered) |
| **Home page open**   | content script detects home URL (`dialogueIdFromUrl === null`)    | content script proactively sends `CONVERSATION_LIST` → background calls `cleanupZombies(platform, ids)`                                                             |

#### Throttle Logic

```
Any batch trigger (periodic / home) ──→ runZombieCleanup(platform)
                                │
                                ▼
                      Check lastCleanupTime[platform]
                                │
                    ┌──── <5min? ────┐
                    │ YES            │ NO
                    ▼                ▼
                  Skip          Run cleanup
                                 │
                                 ▼
                          Update lastCleanupTime
```

**Why 5 minutes**: periodic 60min + home-page trigger may fire simultaneously → 5min throttle guarantees at most one execution.

#### Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Trigger Layer                            │
│                                                                 │
│       chrome.alarms(60min)         CONVERSATION_LIST(home)       │
│              │                            │                     │
│              ▼                            ▼                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │            cleanupZombies(platform, liveIds)              │   │
│  │                                                          │   │
│  │  Throttle check (5min) → kvScan → diff → kvDel → stamp   │   │
│  └──────────────────────────────────────────────────────────┘   │
│              │                                                  │
│              ▼ (when alarm has no tab)                          │
│        Skip — user not active on this platform,                 │
│        no background cleanup triggered                          │
└─────────────────────────────────────────────────────────────────┘
```

#### Preconditions & Degradation

| Condition                             | When not met                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform tab open                     | Periodic cleanup skips. When user is not active on this platform, no background action is triggered (respects user expectation: no cleanup without activity) |
| User logged into platform             | content script cannot pull list → skip                                                                                                                       |
| Upstash configured                    | Only clean local (nothing in cloud to clean)                                                                                                                 |
| `fetchConversationList` accurate live | Cleanup effectiveness discounted (fundamental dependency)                                                                                                    |

#### Platform Coverage

| Platform                                                   | `fetchConversationList` method | Cleanup reliability                                                                       |
| ---------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| DeepSeek / ChatGPT / Kimi / Qwen / Tongyi Qianwen / Doubao | API pull                       | High                                                                                      |
| Gemini                                                     | DOM sidebar scrape             | Low (virtualization truncation; only conversations not visible in sidebar can be cleaned) |

**Gemini special handling**: DOM-scraped liveList is incomplete → may misjudge "conversations not visible in sidebar" as zombies. Mitigation: Gemini periodic cleanup is best-effort only; if Gemini users find over-cleaning, next open of that conversation auto-recovers from cloud (union merge preserves cloud-only rounds).

#### Storage

```typescript
// storage.local new key
headroom:cleanup-state → { <platform>: lastCleanupTimestamp }
```

#### Permissions

```json
// manifest.json
"permissions": ["alarms"]
```

### 7-Platform History APIs (2026-06 Live Capture)

| Platform       | API                                                           | Text extractable                                        | Data structure        | Server tokens (calibration reference only) |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------- | --------------------- | ------------------------------------------ |
| DeepSeek       | `GET /api/v0/chat/history_messages?chat_session_id=`          | ✅ `fragments[].content`                                | Flat messages[]       | ✅ `accumulated_token_usage`               |
| ChatGPT        | `GET /backend-api/conversation/<id>`                          | ✅ `mapping.{id}.message.content.parts[]`               | Tree (mapping)        | ❌                                         |
| Gemini         | Content in SSR HTML / DOM                                     | ✅ DOM scrapable                                        | DOM                   | ❌                                         |
| Kimi           | `POST /apiv2/...ChatService/ListMessages`                     | ✅ `messages[].blocks[].text.content`                   | Tree (parentId)       | ❌                                         |
| Qwen           | `GET /api/v2/chats/<id>`                                      | ✅ `messages[].content` / `content_list[].content`      | map + array           | ✅ `content_list[].usage.total_tokens`     |
| Tongyi Qianwen | `GET .../api/v1/session/msg/list?session_id=` (**paginated**) | ✅ `request/response_messages[].content`                | Paginated list        | ✅ `extra_info...total_usage`              |
| Doubao         | `POST /im/chain/single`                                       | ✅ `messages[].content_block[].content.text_block.text` | ByteDance IM protocol | ❌                                         |

> **Text extractable on all** — this is the prerequisite for reconciliation (estimating tokens depends on text). Server tokens column is only for [004](./004-optimizations.md) calibration reference, **not in the core path** (product is designed as "text → estimate"). Tongyi Qianwen pagination requires walking all pages.

> **Stable messageId source (union merge key, 2026-06 live-verified, 7/7 all confirmed)**: DeepSeek `message_id` · ChatGPT mapping node id · Kimi msg `id` · Qwen (chat.qwen.ai) object map key · Doubao `index_in_conv` · Tongyi Qianwen `req_id` (per-round request id, list item field) · Gemini turn wrapper `<div id>` (16-char hex, stable across reload, unrelated to Angular `_ngcontent-ng-c…` build hash). order (display sequence): DeepSeek / Doubao / Tongyi Qianwen use their respective create_time / created_at; ChatGPT `create_time`; Kimi `createTime`; Qwen `timestamp`; Gemini DOM order. Most adapters already read these ids during parsing (for pairing / tree-building); the old implementation discarded them and emitted positional `n` instead — this change makes messageId transparent as the merge key.

### Browser APIs

`webRequest` (existing, send + delete monitoring). `fetchHistory` / `fetchConversationList` use plain `fetch` (same-origin, consumes platform cookie session). `chrome.alarms` (zombie cleanup periodic scheduling, 60min period, requires `alarms` permission).

## Implementation Plan

1. **Pure logic (TDD)**: `union` merge + `projectUsage`; multi-conversation local cache read/write; LRU eviction (conv-index + threshold judgment).
2. **fetchHistory adapters**: DeepSeek first (simplest, text directly extractable) as reference; then expand to remaining 6. ChatGPT's mapping tree traversal, Gemini's DOM scraping, Tongyi Qianwen's pagination are each platform's hard part.
3. **Open-and-reconcile engine**: `PAGE_READY` → `fetchHistory` → union → display-first-then-sync.
4. **Incremental cloud push**: overwrite-write entire record after `applyHistory` lands + best-effort; failure warns.
5. **Delete linkage**: `parseDelete` → delete local cache + Upstash `DEL`.
6. **P1**: zombie cleanup unified engine (alarms periodic + home-page trigger, shared throttle), reconciliation frequency control.

## Acceptance Criteria

> Detailed steps in [`specs/acceptance-checklist.md`](./acceptance-checklist.md) "003 Cross-Device Reconciliation" section.

- Fresh install, fill credentials → open an existing conversation → gauge climbs from 0 to real cumulative (reconciliation effective)
- **Cross-device continuation**: Device A chats 5 rounds → Device B opens same conversation → B shows 5-round cumulative (not 0, doesn't overwrite and lose A's)
- **Mobile rounds**: Phone chats 3 rounds → web opens same conversation → gauge includes those 3 rounds (in platform history, reconciliation includes them)
- **No loss on disconnect**: Chat a few rounds offline (incremental push fails with warning) → reopen conversation after reconnect → reconciliation recovers (no outbox needed)
- **Union merge by stable messageId**: When platform's returned round set changes (truncation / single-round deletion / regenerate shift), `totalTokens` still correct — no double-counting, no early-round loss (regression test: 50 rounds truncated to 30 → `totalTokens` unchanged; old implementation would compute 1875 ≠ 1275)
- Web delete conversation → both local cache and Upstash key disappear
- Mobile delete conversation → next home-page open or periodic alarm → Upstash record cleaned up by diff
- **Periodic zombie cleanup**: `chrome.alarms` fires every 60min → auto-cleans dead records when platform tab exists; shares 5min throttle with home-page trigger
- Tab switch / panel open reads local cache (instant), does not block network

## Open Questions

- ChatGPT's mapping tree traversal: take the main line (current_node backtrack) or all user→assistant pairs? How to handle regenerated branches?
- Gemini history content scraping method (2026-06 live-confirmed: content in SSR HTML / DOM, `fetchHistory` uses DOM scraping as fallback, text extractable; whether to upgrade to more stable batchexecute RPC left to [004](./004-optimizations.md)).
- `fetchHistory` frequency control threshold: when rapidly switching conversations, how much debounce / how many seconds of stay before triggering full reconciliation?
- Zombie cleanup trigger frequency: periodic alarms (60min) + home-page trigger, shared 5min throttle (already designed).
- New conversation's first message has no dialogueId (Kimi etc.) → first round cannot fetchHistory; must wait for dialogueId to appear.
- Whether `MAX_RETAINED_ROUNDS` (200) is still reasonable under full reconciliation: platform history may be longer; should reconciliation truncate?
