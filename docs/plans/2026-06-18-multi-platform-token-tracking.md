# Multi-Platform Token Tracking — Design + Plan

> Working doc (NOT committed). Survives context compaction. Source of truth
> for this effort alongside `specs/001-headroom-core.md` (which gets updated at
> the end, locally only — user said no commit/push).

## Decisions (locked with user, 2026-06-18)

1. **Drop the mode distinction.** DeepSeek context = 1,048,576 (1<<20) regardless of
   快速/专家 (both V4-flash and V4-pro are 1M). `model_type` detection adds
   nothing to the token/context ratio. `utils/models.ts` + mode label removed.
   The `webRequest` infra STAYS — it's the foundation for reading request bodies
   (prompt + dialogueId) for token counting.
2. **Sequencing: Foundation first.** Refactor to the platform-adapter pattern,
   build the full shared pipeline (capture prompt → detect round-complete →
   count tokens → Upstash read-modify-write → side-panel broadcast) end-to-end
   on DeepSeek, THEN add the other 6 platforms one-by-one.
3. **Token counting: platform-provided → estimate.** v1 answer-side = DOM
   scrape + char-based estimate (chosen path A). True platform `usage` deferred
   (needs `chrome.debugger` — invasive, Chrome-only; revisit later).
   Request-side prompt text is exact (from `webRequest` body).
4. **No commits / no push.** All edits local on branch `f_create_sidepanel`.

## Architecture — adapter pattern, one file per platform

```
adapters/<platform>.ts        platform-specific knowledge, imported by BOTH
                              background (parseRequest) and the platform's
                              content script (DOM selectors + round-complete)
adapters/index.ts             ADAPTERS[] registry — background builds its
                              webRequest URL filter from this; adding a
                              platform = add adapter + content script, no
                              other registration
entrypoints/<platform>.content.ts   thin: imports its adapter, runs DOM
                                    observation, sends ROUND_COMPLETE
entrypoints/background.ts     shared engine: webRequest dispatch → pending
                              prompt → on ROUND_COMPLETE: count tokens,
                              upstash RMW, broadcast STATE_UPDATE
utils/upstash.ts              REST KV client (get/set dialogue record)
utils/dialogue-record.ts      record schema + helpers
utils/tokens.ts               token estimation (chars heuristic)
utils/platform-adapter.ts     PlatformAdapter interface
utils/messages.ts             UsageState.platformId + ROUND_COMPLETE msg
```

**Adding a platform = 2 files** (`adapters/<p>.ts` + `entrypoints/<p>.content.ts`)

- an entry in `ADAPTERS[]` + its host in `wxt.config.ts host_permissions`.

## PlatformAdapter contract

```ts
interface PlatformAdapter {
  platformId: string; // "deepseek" | "chatgpt" | ...
  displayName: string; // "DeepSeek" — side panel label
  completionUrl: string; // webRequest substring match
  contextLimit: number; // tokens
  matchPattern: string; // content-script matches
  parseRequest(body: unknown): {
    prompt: string | null;
    dialogueId: string | null;
  };
  // DOM (run in content script):
  answerSelector?: string; // latest AI message
  conversationSelector?: string; // observe target
}
```

## Round lifecycle (single active conversation assumed for v1)

1. User sends → `webRequest.onBeforeRequest` fires for the platform's
   `completionUrl` → `parseRequest(body)` → store pending prompt
   (`storage.local` key `headroom:pending:{platform}:{dialogueId}`).
2. AI streams → DOM mutates → content script detects round-complete (new
   assistant msg stabilized ~1.5s) → sends
   `ROUND_COMPLETE { platformId, dialogueId, answerText }`.
3. Background: read pending prompt, count prompt + answer tokens, RMW the
   Upstash record (append round, recompute totals), broadcast `STATE_UPDATE`.

> Known v1 limitation: pending prompt is per-dialogue; rapid interleaved sends
> across conversations can mismatch. Acceptable.

## Upstash / Redis schema

Keys (Redis-colon style, one JSON value per dialogue — fewest round trips over
HTTPS REST):

```
headroom:conv:{platform}:{dialogueId}   →  DialogueRecord (JSON)
headroom:settings                       →  { thresholds, language, upstash }  (local-mirrored)
headroom:pending:{platform}:{dialogueId}→  { prompt, ts }  (storage.local, ephemeral)
```

```ts
interface RoundRecord {
  n: number; // 1-based
  promptTokens: number;
  answerTokens: number;
  total: number; // promptTokens + answerTokens
  ts: number; // epoch ms
}
interface DialogueRecord {
  platform: string;
  dialogueId: string;
  contextLimit: number;
  totalTokens: number; // sum of round totals
  roundCount: number;
  rounds: RoundRecord[];
  updatedAt: number;
}
```

The side panel's live `UsageState` = a projection of the active dialogue's
`DialogueRecord` (totals + last round) + `contextLimit`.

## Upstash REST client

`POST {url}` with `Authorization: Bearer {token}`, body a JSON pipeline array:
`["GET", key]` → `{result: jsonStr|null}`; `["SET", key, jsonStr]` → `{result:"OK"}`.
CORS-permissive (side panel already PINGs it directly).

## Token estimation (v1)

Heuristic by script: CJK chars ≈ 1 token each; latin ≈ 0.25 token/char (≈4
chars/token). Cheap, no bundle weight. Real tokenizer deferred with the
`debugger`-API accuracy upgrade.

## Files to create / change

NEW: `utils/upstash.ts`, `utils/dialogue-record.ts`, `utils/tokens.ts`,
`utils/platform-adapter.ts`, `adapters/deepseek.ts`,
`adapters/{chatgpt,gemini,kimi,qwen,qianwen,doubao}.ts`, `adapters/index.ts`,
`entrypoints/{chatgpt,gemini,kimi,qwen,qianwen,doubao}.content.ts`.
CHANGE: `entrypoints/background.ts` (engine), `entrypoints/deepseek.content.ts`
(DOM), `utils/messages.ts` (UsageState + msgs), `entrypoints/sidepanel/main.ts`
(drop mode → platform label), `wxt.config.ts` (host_permissions all platforms),
`specs/001-headroom-core.md` (decisions).
DELETE: `utils/models.ts`.

## Verification

typecheck + lint + build green after each milestone. Runtime (browser) pending
user return — DOM selectors for all platforms are best-guess and NEED live
DevTools tuning. Each non-DeepSeek adapter is flagged `// UNVERIFIED — needs
runtime confirmation`.

## Per-platform research (fill from background agents)

- [pending] ChatGPT, Gemini, Kimi, Qwen, Tongyi(千问), Doubao — agents running.
