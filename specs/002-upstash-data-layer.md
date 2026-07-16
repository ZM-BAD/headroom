# 002: Upstash Data Layer (Redis Structure + Transport Pipeline)

## Status

Done (interaction layer + structure locked + probe + unit tests); live acceptance pending.

**Scope**: Cloud transport pipeline + Redis data structure. This spec **only provides primitives** — how to talk to Upstash, what structures to store. **Does not include sync strategy** (when to read / write, how to merge dialogue records) — that is [003](./003-cross-device-sync.md). Wiring the background to call these primitives at the right time is also 003.

## Summary

Connect Upstash as the cloud transport layer into the extension: lock down data structures on Redis, implement and decouple all Upstash interactions (GET / SET/ DEL × dialogue / settings).

**Key boundary**: 002's write primitives are **pure overwrite writes** (`setDialogue` = PUT entire record). The "read → merge → write" orchestration, merge semantics (union dialogue rounds by messageId), go to 003. 002 does not care about call timing or merge logic.

## Motivation

The README positions BYO Upstash as a product pillar ("your data stays in your own private storage"). This layer must be nailed down first and independently verifiable: **wrong Redis structure means 003's reconciliation / deletion / cross-device all lose their correctness foundation**. Upstash interactions are a small set of REST calls and naturally decoupled — determine storage structure first, then sync semantics (003).

## Decisions

- **Only two value types on Redis**, both stored as **String** type:
  - `headroom:conv:{platform}:{dialogueId}` → `DialogueRecord` JSON (structure in [001](./001-headroom-core.md) Data Model; carries `updatedAt`).
  - `headroom:settings` → `{ thresholds, language, contextLimits, tokenCoefficients, updatedAt }`. **Credentials never go to the cloud** — without them you can't read Redis, so storing them is both pointless and a leak.
- **Value type is String (serialized JSON), not Redis JSON.** Rationale:
  1. **Dedup requires full read** — before each round's write, must check whether `messageId` already exists (prevent regenerate double-counting); this step is unavoidable. Since the full `rounds[]` is already being read, JSON type's partial-update advantage disappears.
  2. **Invariant atomicity** — `totalTokens` must always equal `sum(rounds[].total)`. String's GET → in-memory modify → SET is logically one coherent read-modify-write; both values update synchronously. JSON type splits into multiple commands (`JSON.ARRAPPEND` + `JSON.SET totalTokens` + `JSON.SET roundCount`); service worker may be evicted between commands, corrupting data.
  3. **Memory** — JSON type's internal tree structure has 2–5× memory amplification vs. serialized string. 200-round conversation goes from ~4 KB to 8–20 KB.
  4. **Dependency** — String is a built-in Redis type; JSON requires RedisJSON module (Upstash supports it but adds platform coupling).
  5. **Serialization overhead not critical** — 4 KB document `JSON.parse` / `stringify` in-browser is microsecond-level, not a bottleneck. The real cost is network round-trips, which are equal for both types.
- **Client layering**: generic primitives `kvGet` / `kvSet` / `kvDel` (shape-agnostic transport layer) + one typed wrapper per domain value (`getDialogue` / `setDialogue` / `delDialogue`, `getCloudSettings` / `setCloudSettings` / `delCloudSettings`). New Redis value type = new thin wrapper, **not a fourth fetch path**.
- **Credentials stay local** (`Settings.upstash`, which is the REST API pair: `UPSTASH_REDIS_REST_URL` + `_TOKEN`, not Redis password); debug probe reads `.env` (gitignored).
- **Merge semantics not in this layer**:
  - Settings: LWW (last-write-wins, by `updatedAt`) — settings are stateless, LWW is safe. `mergeCloudSettings` provides merge primitive.
  - Dialogue: **union by messageId** (003). 002's `setDialogue` is purely overwrite-writing the entire record; "read old record → union merge → write new record" orchestration is 003's responsibility.

## Requirements

### P0

- [x] Redis structure locked (2 keys) + full interaction GET / SET / DEL × (conv + cloud-settings)
- [x] Credential stripping (`toCloudSettings`) + settings LWW merge primitive (`mergeCloudSettings`)
- [x] Live probe `scripts/probe-upstash.mjs` (self-cleans, asserts no credential leak)
- [x] Unit test coverage: kv primitives / dialogue wrapper / credential stripping / settings LWW (mocked fetch)

### P1

- [x] Live acceptance (see Acceptance)

## Design

### REST Contract

Browser extensions can only speak HTTPS REST (can't speak native Redis). **One HTTPS POST = one command**:

```
POST {UPSTASH_REDIS_REST_URL}/
Header: Authorization: Bearer {UPSTASH_REDIS_REST_TOKEN}
Body:   JSON command array  ["GET", key] / ["SET", key, val] / ["DEL", key] / ["SCAN", cursor, "MATCH", pattern, "COUNT", n]
→ { "result": <string|null> }
```

- **8s `AbortController` timeout** — a wedged Upstash must not hang the service worker.
- **Empty credentials ⇒ every op silently no-ops** (Upstash is optional; the gauge works off local state, see 001).
- Failure handling: this layer throws; **the caller (003) decides whether to warn-and-drop or retry**. 002 does not build in retry / buffering.

### Client Layering

```
kvGet / kvSet / kvDel / kvScan   ← generic primitives (shape-agnostic, only REST transport)
   │
   ├─ getDialogue / setDialogue / delDialogue         ← typed wrapper (dialogue domain)
   └─ getCloudSettings / setCloudSettings / delCloudSettings  ← typed wrapper (settings domain)
```

`setDialogue` = overwrite-write entire record (pure PUT, doesn't read old value). Merge orchestration (`getDialogue` → union → `setDialogue`) is in 003.

### Data Structures

| Redis key                               | Value                                                                               | Credentials? |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| `headroom:conv:{platform}:{dialogueId}` | `DialogueRecord` JSON (`rounds[]` contains only token counts, no text; `updatedAt`) | —            |
| `headroom:settings`                     | `{ thresholds, language, contextLimits, tokenCoefficients, updatedAt }`             | ❌ Never     |

> `DialogueRecord` / `RoundRecord` structure is defined in [001](./001-headroom-core.md). Local `Settings` keeps the full object (including credentials); cloud stores only the stripped shape (`toCloudSettings`).

### Free-Tier Budget (Why Read-Modify-Write Is Acceptable)

Upstash free tier: 256 MB storage, **500K commands/month** (account-level, not per-key). Incremental path costs ~2 commands per round (GET + SET), delete = 1, settings save = 1. 500K/month ≈ 250K rounds/month — far beyond a single user. `DialogueRecord` stores only token counts (50 rounds ≈ 4 KB); 256 MB ≈ 65K conversations — storage is not the bottleneck. (003's zombie cleanup may burst commands after long offline periods, but the total stays within budget — all real user activity.)

> What if credentials leak: others can read your dialogue token counts (no text). So credentials are stored locally only, never in the cloud, never logged. Detailed budget and credential security in `AGENTS.md` "Upstash (Redis) data model".

### Probe

`node scripts/probe-upstash.mjs` — reads `.env`, runs GET / SET / DEL × (conv + settings) against throwaway `headroom:_probe:*` keys, self-cleans in `finally`, and asserts no credentials in the stored settings JSON. **Not part of `npm test`**.

## Implementation Plan

1. Interaction layer + probe + unit tests — done.
2. Credential stripping + settings LWW primitives — done.

Remaining: live acceptance (two Acceptance items pending).

## Acceptance Criteria

> Detailed steps in [`specs/acceptance-checklist.md`](./acceptance-checklist.md) "002 Upstash Data Layer" section.

- Unit tests: kv primitives / dialogue wrapper / credential stripping / settings LWW (mocked fetch)
- Live probe: 6/6 (conv and settings each SET → GET → DEL), stored JSON has no credentials
- Live: DeepSeek chat a few rounds → Upstash console shows `headroom:conv:deepseek:*` (depends on 003 wiring)
- Live: Settings Save → Upstash shows `headroom:settings` (no credential fields)

## Open Questions

- How callers handle push-to-cloud failure: 002 only throws; warn-and-drop / recompute-on-next-open strategy is decided by 003 (already partitioned this way).
