# 005: Tool & Web-Search Token Tracking

## Summary

Count the tokens consumed by web-search results and tool-call executions — the context a model reads (search snippets, opened pages) and the text a model generates (tool invocations) — so a "round" reports `promptTokens + toolTokens + answerTokens` instead of just prompt + answer.

## Motivation

When a user asks a question that triggers web search / tool calls, the platform injects the results into the model's context window (input tokens) and the model generates tool-invocation text (output tokens). Today Headroom counts only the user prompt and the final answer text, so a search-heavy round can undercount by thousands of tokens (measured: a DeepSeek search round injected ~28 result snippets + opened pages; a Kimi search round carried 7 result cards with multi-hundred-char snippets; a Doubao search round referenced 7 source pages with long summaries).

Mechanism (verified across all 7 platforms): search/tool results are plain text injected as input; the invocation itself (function name + args/queries) is model-generated output. Results are truncated per-platform (Gemini ~2,000-word grounding budget; ChatGPT `search_context_size`), but the text the history APIs expose is exactly what we estimate — no new coefficients needed (search text is ordinary CJK/Latin mixed content; spec 004's 6-way estimator applies).

## Requirements

### P0 — Core

- [x] `HistoryRound` carries per-round tool/search text (the injected context + the invocation text) from platforms where the history API exposes it
- [x] `RoundRecord` gains `toolTokens` (default 0); `total = promptTokens + toolTokens + answerTokens`; old records without the field read as 0
- [x] Kimi / Qwen / Qianwen / Doubao adapters extract search-result text from their history APIs (fields confirmed live 2026-08-14, below)
- [x] ChatGPT adapter extracts the turn's search-call node(s) (`content_type: "code"`, `recipient: "web"`) — invocation text counts, result text is unavailable (documented limitation)
- [x] DeepSeek + Qwen adapter **structure fixes** (payload shapes changed 2026-08; without the fix the platforms produce empty text and the whole estimate is broken — found during 005 probing)
- [x] Gauge/panel displays tool tokens in the round breakdown (single `toolTokens` bucket; no per-tool granularity in v1)

### P1 — Enhancement

- [x] Gemini: count search-source **site names** from DOM (no click interaction in v1; snippet text needs the source dialog which we won't auto-open) — implemented 2026-08: deduped site names join into toolText

## Design

### Data model

`HistoryRound` (utils/platform-adapter.ts) gains one optional field:

```ts
export interface HistoryRound {
  messageId: string;
  order: number;
  promptText: string;
  answerText: string;
  /** Text the model consumed/produced for search & tool calls this round
   *  (search snippets, opened pages, invocation text). Empty = no tools. */
  toolText?: string;
  createdAt?: number;
}
```

`RoundRecord` (utils/dialogue-record.ts) gains `toolTokens: number` (always present, 0 when absent). `upsertRound`/`unionRounds`/`projectUsage` treat it like the other counts; legacy cloud records without the field → 0.

Estimation (entrypoints/background.ts `applyHistory`): `toolTokens = Math.round(estimateTokens(round.toolText, coeff))` — same single-pass estimator, same per-platform coefficients. **Counting scope:** like `promptTokens`, tool text is counted once in the round where it occurred, never re-counted on later rounds (lifetime content-cost semantics; matches how every other text is treated). Tool text is **turn-scoped**: tree walks stop at the next user node (a turn never picks up a later turn's search text), and ALL invocations within one turn (multi-step browsing) are joined into that round's `toolText`. On IM-shaped platforms (Doubao) the search card and the answer may stream as separate bot messages — every bot row between two user rows merges into that round.

### Counting what, per platform (live-confirmed 2026-08-14)

| Platform | Tool text source (history API)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Counts as            | Availability   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------- |
| Kimi     | `ListMessages` → assistant `blocks[]` → block with `tool` → `contents[].searchResult.base.title + snippet` (+ `args.queries` invocation)                                                                                                                                                                                                                                                                                                                                                                                                                                | input (+ invocation) | ✅ full        |
| Qwen     | `GET /api/v2/chats/<id>` → `chat.messages[]` assistant → `content_list[]` phase `web_search` → `extra.web_search_info[].title + snippet`                                                                                                                                                                                                                                                                                                                                                                                                                                | input                | ✅ full        |
| Qianwen  | `msg/list` → item `response_messages[]` `mime_type "bar/iframe"` → `meta_data.sources[].content.list[].summary`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | input                | ✅ full        |
| Doubao   | `im/chain/single` → bot msg `content_block[]` with `search_query_result_block` → `results[].text_card.summary` (+ `queries`). The search card and the answer may stream as SEPARATE bot messages — all bot rows between two user rows merge into one round (answers joined, tool text joined, order = last bot)                                                                                                                                                                                                                                                         | input (+ invocation) | ✅ full        |
| ChatGPT  | ALL `content_type "code"` + `recipient "web"` nodes **within the turn** (turn boundary = next user node) → **`content.text`** (`search("…")`) — CONFIRMED live 2026-08-16: code nodes carry `text`, NOT `parts` (a parts-only reader silently produced empty toolText; fixed)                                                                                                                                                                                                                                                                                           | invocation (output)  | ⚠️ call only   |
| DeepSeek | **none** — `search_results` is `null` in WIP and FINISHED states; `TOOL_SEARCH`/`TOOL_OPEN` fragments are EMPTY markers (only the type proves the search ran); content lives only in the SSE stream. Verified 2026-08-16: the next-round completion request carries ONLY `parent_message_id` + new prompt (server-side incremental continuation) — search content does NOT persist into subsequent context, so `toolTokens = 0` matches the real context state (a "—" row is correct, not a miss). Ephemeral-injection model: [spec 006](006-tool-context-occupancy.md) | —                    | ❌ unavailable |
| Gemini   | DOM `source-title` spans (site names, deduped) — snippets need the source dialog (not auto-opened)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                    | ⚠️ names only  |

Snippet text is noisy (image markdown, nav text); we keep it as-is — truncation is the platform's own cost decision and spec 004's coefficients already fold in markdown overhead. No new coefficients, no calibration round needed (the estimator treats tool text as ordinary text).

### DeepSeek & Qwen structure fixes (found during probing — P0)

- **DeepSeek** (DUAL-SHAPE payload, both live): the 2026-06 shape (`fragments[]` with `type: REQUEST/THINK/RESPONSE/TIP`) is STILL served — confirmed on a real session 2026-08-16; the 2026-08 shape (`content`/`thinking_content` top-level strings, no fragments) was captured by an earlier probe. **Landmine:** a parser that reads only one shape silently zeroes every round (the bug that broke DeepSeek display 2026-08-16 — all rounds showed ↑0/↓0 because `content` was `undefined`). `dsMessageText` reads type-filtered `fragments[]` first (REQUEST for user / RESPONSE for assistant; THINK/TIP excluded), falls back to top-level `content`. Auth: `localStorage.userToken` is now `{"value":"…"}` JSON — parse `.value` (confirmed unchanged on the 2026-08-16 session).
- **Qwen** (2026-08 payload): history lives at `data.chat.messages` (array) — `data.chat.history.messages` is an empty map. Assistant body: `content` + `reasoning_content` + `content_list[]` (phases `thinking_summary` / `web_search` / `answer`). Reasoning/thinking text stays excluded (private reasoning, same as before).

### Zero-coupling

No shared-pipeline changes for per-platform extraction: each adapter's parser returns `toolText` via `HistoryRound`; the pipeline (background) only reads the new field. The adapter-interface change is one optional field — no new flags needed.

### UI

Sidepanel round rows / gauge totals: add tool tokens to the per-round breakdown and the dialogue total. Single bucket labeled 工具/搜索 (tool/search) — no split of input-vs-output in v1 (the invocation text is ~tens of tokens, the snippets are the bulk; one bucket keeps the UI unchanged in shape).

## Implementation Plan

1. `utils/platform-adapter.ts`: add `toolText?: string` to `HistoryRound`
2. `utils/dialogue-record.ts`: add `toolTokens` to `RoundRecord`; update `upsertRound` / `unionRounds` / record builders; legacy-0 fallback
3. `entrypoints/background.ts` `applyHistory` (+ stop-path): estimate `toolText` → `toolTokens`; include in totals
4. Adapters (parser + tests):
   - `adapters/kimi.ts` — extract tool-block text (`contents[].searchResult.base.title+snippet`, `args`)
   - `adapters/qwen.ts` — **fix structure** (`chat.messages`, new message shape) + extract `web_search` phase text
   - `adapters/qianwen.ts` — extract `bar/iframe` sources summaries
   - `adapters/doubao.ts` — extract `search_query_result_block` text
   - `adapters/chatgpt.ts` — extract `code`+`recipient:"web"` node text
   - `adapters/deepseek.ts` — **fix structure** (`content`/`thinking_content`/`search_enabled`; token JSON) — search text unavailable, but the fix restores prompt/answer estimation
5. `adapters/gemini.ts` — DOM `source-title` collection (P1)
6. `utils/messages.ts` / sidepanel `main.ts` — carry and display `toolTokens`
7. `typecheck` → `lint` → `build`; update `specs/acceptance-checklist.md`

## Acceptance Criteria

- [ ] A Kimi search round shows `toolTokens > 0` with text ≈ the search cards' titles+snippets
- [ ] Qwen / Qianwen / Doubao search rounds show `toolTokens > 0` from their history APIs
- [ ] ChatGPT search round shows small `toolTokens` (the `search("…")` call only)
- [ ] DeepSeek rounds show correct prompt/answer estimates again (structure fix) — and `toolTokens = 0` (documented: search text not in history API)
- [ ] Old cloud records without `toolTokens` render as 0, totals unchanged
- [ ] `totalTokens` = Σ(prompt + tool + answer) on the gauge and in the panel

## Open Questions

- [ ] DeepSeek search tokens: only option is SSE-stream capture (MV3 `webRequest` cannot read response bodies; content-script fetch wrapping is clobbered by the page's SDK — AGENTS.md landmine). Out of scope for 005; recorded as a platform limitation. Revisit if DeepSeek starts persisting `search_results`. Note (2026-08-16): the miss only affects the round's INSTANTANEOUS consumption — search content is ephemeral, never enters later context — so the gauge's context-window monitoring stays accurate without it (occupancy model: spec 006).
- [ ] Gemini: auto-opening the source dialog for snippet text is possible (programmatic click) but mutates the user's view — deferred to P1/pending decision.
