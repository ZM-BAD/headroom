import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import type { TokenCoefficients } from "../utils/estimate";

/**
 * Measured via ByteDance's open Seed-OSS-36B as proxy — the production
 * tokenizer is closed; Seed-OSS-36B remains the latest open Seed LLM
 * (2026-08), no newer proxy exists (spec 004 §4.3; scripts/calibrate-hf.mjs).
 * Kana is the least trustworthy value (Seed-OSS carries little Japanese).
 */
const DOUBAO_COEFFICIENTS: TokenCoefficients = {
  cjk: 0.67,
  kana: 1.26,
  hangul: 0.8,
  cyrillic: 2.04,
  arabic: 2.3,
  latin: 1.37,
};

// Doubao (豆包) — request CONFIRMED (POST /samantha/chat/completion, aliased
// as /chat/completion). messages[0].content is a STRINGIFIED JSON
// {"text":"..."}. dialogueId = local_conversation_id.
//
// History API — CONFIRMED live (2026-06, Playwright):
//   POST https://www.doubao.com/im/chain/single  (ByteDance IM framing).
//   body: {cmd:3100, uplink_body:{pull_singe_chain_uplink_body:{
//     conversation_id, anchor_index (MAX_SAFE_INT = newest), conversation_type:3,
//     direction:1, limit}}, sequence_id, channel:2, version:"1"}.
//   → downlink_body.pull_singe_chain_downlink_body.messages[] (NEW→OLD).
//   Paginated: walk by lowering anchor_index to the oldest index seen.
//   Auth = cookies only BUT the AGW gateway REQUIRES content-type
//   "application/json; encoding=utf-8" — a plain "application/json" is rejected
//   with status_code 712012002 "不支持编码类型". (Landmine: the gateway keys on
//   the exact media-type string, not just the JSON intent.)
//   Two body shapes coexist:
//   - new (content_type 9999): text in content_block[].content.text_block.text.
//   - old (content_type 1):    text in content (a STRINGIFIED {"text":"..."}).
//   role = user_type: 1 = user, 2 = bot. create_time is a Unix-second string.
//   Pair user→bot by adjacency (IM model: they alternate, oldest-first).
//
// DOM CONFIRMED live (2026-06): Doubao's current build dropped data-testid /
// semantic class names in favor of Tailwind utilities. The stable anchors are:
//   - AI reply markdown renders inside `.md-box-root` (Doubao's markdown
//     renderer root — stable, semantic), regardless of the surrounding
//     Tailwind layout classes.
//   - User message text sits in a `.whitespace-pre-wrap` bubble (a Tailwind
//     utility Doubao reserves for the user bubble; safe enough in-page).
//   - The conversation list root is `[class*="message-list"]` (hash-suffixed).
// Token usage streams in SSE event_type 2010 (VERBOSE) — not read in v1, so
// estimate only.
export const doubaoAdapter: PlatformAdapter = {
  platformId: "doubao",
  displayName: "豆包",
  host: "www.doubao.com",
  completionUrl: "*://www.doubao.com/chat/completion*",
  matchPattern: "*://www.doubao.com/*",
  contextLimit: 262_144, // 256K (1 << 18); overridable
  tokenCoefficients: DOUBAO_COEFFICIENTS, // spec 004 §4.3 calibrated (incl. markdown overhead)
  // Delete endpoint: CONFIRMED live (2026-06). ByteDance IM-protocol style:
  // POST /im/conversation/batch_del_user_conv with a deeply-nested body —
  // uplink_body.batch_delete_user_conversation_uplink_body.conversation_id is
  // a [<id>] array (the cmd/uplink/downlink envelope is ByteDance's IM framing).
  // We pluck the first (and only) id from that nested array.
  deleteUrl: "*://www.doubao.com/im/conversation/batch_del_user_conv*",
  parseDelete(rawBody) {
    try {
      const b = JSON.parse(rawBody) as {
        uplink_body?: {
          batch_delete_user_conversation_uplink_body?: {
            conversation_id?: unknown;
          };
        };
      } | null;
      const ids =
        b?.uplink_body?.batch_delete_user_conversation_uplink_body
          ?.conversation_id;
      if (!Array.isArray(ids)) return null;
      const first = ids[0];
      return typeof first === "string" ? first : null;
    } catch {
      return null;
    }
  },
  dialogueIdFromUrl(url) {
    try {
      return new URL(url).pathname.match(/\/chat\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  },
  // Doubao writes the conversation title into document.title as "<title> - 豆包".
  // Strip the trailing brand. (DeepSeek-style.)
  dialogueTitleFromDoc(doc) {
    const raw = doc.title?.trim();
    if (!raw) return null;
    return raw.replace(/\s*[-—]\s*豆包\s*$/i, "").trim() || null;
  },
  // History API: CONFIRMED live (2026-06, Playwright). POST /im/chain/single
  // (ByteDance IM framing) → messages[] NEW→OLD. Walk pages by lowering
  // anchor_index, reverse to ascending, pair user→bot by adjacency. Cookies
  // + the exact content-type the AGW gateway demands.
  async fetchHistory(dialogueId) {
    const messages: DoubaoMessage[] = [];
    // anchor_index starts at MAX_SAFE_INTEGER (newest); each page lowers it to
    // fetch the next older batch. The cursor decision is in nextDoubaoAnchor
    // (pure, unit-tested) — see M2 fix note there.
    let anchor = Number.MAX_SAFE_INTEGER;
    const pageSize = 20;
    try {
      for (let page = 0; page < 50; page++) {
        // 50 pages × 20 = up to 1000 messages — far beyond any real chat.
        const res = await fetch(
          `https://www.doubao.com/im/chain/single?${DOUBAO_IM_QUERY}`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              // AGW gateway hard-rejects plain "application/json" (712012002).
              "content-type": "application/json; encoding=utf-8",
              "agw-js-conv": "str",
            },
            body: JSON.stringify(
              doubaoHistoryBody(dialogueId, anchor, pageSize),
            ),
          },
        );
        if (!res.ok) return [];
        const j = (await res.json()) as DoubaoHistoryResponse | null;
        const batch =
          j?.downlink_body?.pull_singe_chain_downlink_body?.messages ?? [];
        if (!batch.length) break;
        messages.push(...batch);
        const next = nextDoubaoAnchor(anchor, batch, pageSize);
        if (next === null) break; // short page = reached the head of the chat
        anchor = next;
      }
    } catch {
      // network/parse failure — the next open / switch / round-completion re-fetches
      return [];
    }
    return parseDoubaoHistory(messages);
  },
  // POST /im/chain/recent_conv — ByteDance IM gateway. Needs a JSON body
  // with cmd:3200 + uplink_body (same envelope as fetchHistory). Without
  // the body the gateway returns status_code 712010702 with empty data.
  // Confirmed live (2026-07, Playwright).
  // Used by zombie cleanup (spec 003).
  async fetchConversationList() {
    try {
      const res = await fetch(
        `https://www.doubao.com/im/chain/recent_conv?${DOUBAO_IM_QUERY}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json; encoding=utf-8",
            "agw-js-conv": "str",
          },
          body: JSON.stringify({
            cmd: 3200,
            uplink_body: {
              pull_recent_conv_chain_uplink_body: {
                limit: 20,
                message_count_per_conv: 10,
                api_version: 1,
                conv_version: 0,
                direction: 3,
                option: {
                  not_need_message: true,
                  need_complete_conversation: true,
                  need_coco_conversation: true,
                  need_coco_bot: true,
                  need_pc_pin_chain: true,
                  pc_pin_query_type: 0,
                },
              },
            },
            sequence_id: crypto.randomUUID(),
            channel: 2,
            version: "1",
          }),
        },
      );
      if (!res.ok) {
        console.warn(
          "[Headroom] doubao fetchConversationList HTTP",
          res.status,
        );
        return [];
      }
      const json = await res.json();
      if (json.status_code && json.status_code !== 0) {
        console.warn(
          "[Headroom] doubao fetchConversationList API error",
          json.status_code,
          json.status_desc,
        );
        return [];
      }
      const cells: Array<{
        id?: string;
        conversation?: { conversation_id?: string };
      }> =
        json?.downlink_body?.pull_recent_conv_chain_downlink_body?.cells ?? [];
      return cells
        .map((c) => c.conversation?.conversation_id ?? c.id)
        .filter((id): id is string => typeof id === "string");
    } catch (e) {
      console.warn("[Headroom] doubao fetchConversationList error:", e);
      return [];
    }
  },
  // IM chain is eventually consistent: the bot message lands 0–1s+ after the
  // completion stream closes (measured 2026-07, Playwright: onCompleted+473ms
  // → absent, +948ms → present). Without the settle retry, the round-complete
  // fetch races the write and records the round with 0 output tokens.
  historyNeedsSettleRetry: true,
  answerSelector: ".md-box-root",
  userSelector: "[class*='whitespace-pre-wrap']",
  conversationSelector: "[class*='message-list'], main",
};

/** A content_block element (new content_type 9999 shape). */
interface DoubaoContentBlock {
  content?:
    | string
    | {
        text_block?: { text?: string };
        /**
         * Web-search payload (spec 005): `{summary, queries, results[]}` where
         * each result's `text_card.summary` is the page text the model read.
         * CONFIRMED live 2026-08-14.
         */
        search_query_result_block?: {
          summary?: string;
          queries?: string[];
          results?: Array<{
            text_card?: { summary?: string; title?: string };
          }>;
        };
      };
}
/** A row in the messages array (the fields we read). */
interface DoubaoMessage {
  user_type?: number; // 1 = user, 2 = bot
  content_type?: number; // 1 = old (content is a stringified JSON), 9999 = new
  content?: string; // old shape: '{"text":"..."}'
  content_block?: DoubaoContentBlock[]; // new shape
  create_time?: string; // Unix-second string
  index_in_conv?: string; // monotonic per-conversation index (pagination cursor)
}
/** The POST /im/chain/single response shape (the parts we read). */
interface DoubaoHistoryResponse {
  downlink_body?: {
    pull_singe_chain_downlink_body?: { messages?: DoubaoMessage[] };
  };
}

/**
 * The query-string the ByteDance AGW gateway expects (device identity params
 * the SPA always sends). The values are constants for the web client.
 */
const DOUBAO_IM_QUERY =
  "version_code=20800&language=zh&device_platform=web&aid=497858&real_aid=497858&pc_version=3.23.10&region=CN&sys_region=CN&samantha_web=1&web_platform=browser&use-olympus-account=1";

/** Build the ByteDance IM uplink envelope for a history pull. */
function doubaoHistoryBody(
  dialogueId: string,
  anchorIndex: number,
  limit: number,
): Record<string, unknown> {
  return {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: dialogueId,
        anchor_index: anchorIndex,
        conversation_type: 3,
        direction: 1,
        limit,
        ext: {},
        filter: { index_list: [] },
        evaluate_ab_params: "",
        evaluate_common_params: "",
      },
    },
    sequence_id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    channel: 2,
    version: "1",
  };
}

/**
 * Extract the readable text from one Doubao message, handling BOTH body shapes:
 * - new (content_type 9999): content_block[].content.text_block.text
 * - old (content_type 1):    content parsed as JSON → .text
 * Returns "" when neither yields text (e.g. a control/system message).
 */
function doubaoMessageText(m: DoubaoMessage): string {
  // New shape first (content_block with a nested text_block.text).
  if (Array.isArray(m.content_block)) {
    const parts: string[] = [];
    for (const b of m.content_block) {
      const c = b?.content;
      if (
        c &&
        typeof c === "object" &&
        typeof c.text_block?.text === "string"
      ) {
        parts.push(c.text_block.text);
      } else if (typeof c === "string") {
        // Some builds nest a stringified JSON here too.
        const parsed = tryParseJson<{ text?: string }>(c);
        if (parsed?.text) parts.push(parsed.text);
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }
  // Old shape: content is a stringified {"text":"..."}.
  if (typeof m.content === "string" && m.content) {
    const parsed = tryParseJson<{ text?: string }>(m.content);
    if (typeof parsed?.text === "string") return parsed.text.trim();
  }
  return "";
}

/** Safe JSON.parse that returns null on any failure (never throws). */
function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Extract the web-search text from a Doubao message (spec 005): every
 * `search_query_result_block` carries the search queries plus per-result
 * `text_card.summary` — the page text injected into the model's context.
 * Joined newline-separated (summary only — `text_card.title` exists in the
 * payload but is NOT emitted; the summary is the page text the model reads,
 * spec 005). Empty for messages without a search block.
 */
function doubaoMessageToolText(m: DoubaoMessage): string {
  if (!Array.isArray(m.content_block)) return "";
  const parts: string[] = [];
  for (const b of m.content_block) {
    const block = b?.content;
    if (!block || typeof block === "string") continue;
    const search = block.search_query_result_block;
    if (!search) continue;
    for (const q of search.queries ?? []) {
      if (typeof q === "string" && q.trim()) parts.push(q.trim());
    }
    for (const r of search.results ?? []) {
      const summary = r?.text_card?.summary;
      if (typeof summary === "string" && summary.trim()) {
        parts.push(summary.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

/**
 * Parse the accumulated messages (NEW→OLD) into ASCENDING rounds (CONFIRMED
 * shape, 2026-06 Playwright). Doubao is an IM model: user (user_type 1) and
 * bot (user_type 2) ALTERNATE, so we walk the time-ascending list and pair each
 * user with the immediately-following bot. Reverse first (API returns NEW→OLD).
 * Drops messages with no extractable text. Defensive: never throws.
 */
export function parseDoubaoHistory(messages: DoubaoMessage[]): HistoryRound[] {
  if (!Array.isArray(messages)) return [];
  // Attach parsed text + time + the stable per-message index, drop empty.
  // Keep a bot row that carries ONLY a search block (text "" but toolText
  // present): the search ran and consumed tokens even if the answer failed
  // or was interrupted — dropping it would silently lose the search cost.
  const enriched = messages
    .map((m) => ({
      userType: m.user_type,
      text: doubaoMessageText(m),
      toolText: doubaoMessageToolText(m),
      ts: Number(m.create_time) || 0,
      idx: Number(m.index_in_conv) || 0,
    }))
    .filter((m) => m.text || m.toolText);
  enriched.sort((a, b) => a.ts - b.ts); // ascending (oldest first)
  // Pair each user (1) with EVERY bot row that follows until the next user
  // row. A search round often streams TWO bot messages — the search card
  // first, the text answer after (IM shape). Binding the round to the FIRST
  // bot row would silently drop the real answer (and the answer row would
  // never be consumed); merging every bot row between two user rows keeps
  // both answerText and toolText, ordered by the LAST bot's create_time.
  const rounds: HistoryRound[] = [];
  for (let i = 0; i < enriched.length; i++) {
    const user = enriched[i];
    if (!user || user.userType !== 1) continue;
    // messageId = the USER message's index_in_conv (fall back to its
    // create_time when absent/invalid). The user message is the round's
    // stable anchor: it exists from send time, while the bot message lands
    // asynchronously (0–1s+ after the completion stream closes — measured
    // live 2026-07). Keying on the bot's id gave the same real round TWO
    // ids across fetches (answerless db:u<arrayPos> → answered db:<botIdx>);
    // 003's union-merge retained both as a zombie round, double-counting
    // the prompt forever. One anchor, one id.
    const messageId = `db:u${user.idx > 0 ? user.idx : "t" + user.ts}`;
    const promptText = user.text;
    const bots: { text: string; toolText: string; ts: number }[] = [];
    for (let j = i + 1; j < enriched.length; j++) {
      const cand = enriched[j];
      if (!cand) continue;
      if (cand.userType === 1) break; // next user closes the round
      if (cand.userType === 2) bots.push(cand);
    }
    if (bots.length) {
      // order = the LAST bot's create_time. Display n is assigned post-merge (003).
      const last = bots[bots.length - 1]!;
      rounds.push({
        messageId,
        order: last.ts,
        promptText,
        // Join non-empty parts — a search-only bot row contributes "" here
        // but its toolText below still counts.
        answerText: bots
          .map((b) => b.text)
          .filter(Boolean)
          .join("\n"),
        toolText:
          bots
            .map((b) => b.toolText)
            .filter(Boolean)
            .join("\n") || undefined,
        // doubao create_time is epoch seconds → ms.
        createdAt: last.ts > 0 ? last.ts * 1000 : undefined,
      });
    } else {
      // No bot reply follows this user (yet): either the write hasn't
      // settled (the content script retries — utils/history-settle.ts) or
      // the user stopped generation. Count the round with answerText="" —
      // the prompt still consumed tokens. Same messageId either way, so a
      // later fetch that finds the bot replaces this round in-place.
      rounds.push({
        messageId,
        order: user.ts,
        promptText,
        answerText: "",
        createdAt: user.ts > 0 ? user.ts * 1000 : undefined,
      });
    }
  }
  return rounds;
}

/**
 * Decide the next pagination anchor after a fetched batch, or null to stop.
 * Pure (no I/O) — unit-tested; fetchHistory's loop calls this. The M2 fix lives
 * here: a batch with NO finite `index_in_conv` must NOT abort the walk. The old
 * inline `oldest >= anchor → break` set oldest=anchor when nothing finite was
 * lower, then broke — silently truncating a long chat to its first page on a
 * single malformed row. Now the only "reached the head" terminator is the
 * short-page signal; a full page with no usable index advances the anchor by
 * the batch size so paging continues (bounded by the caller's page cap).
 */
export function nextDoubaoAnchor(
  anchor: number,
  batch: ReadonlyArray<{ index_in_conv?: unknown }>,
  pageSize: number,
): number | null {
  // Short page = reached the head of the conversation.
  if (batch.length < pageSize) return null;
  // Advance to the oldest finite index in the batch, if it makes progress.
  let oldest = anchor;
  let foundProgress = false;
  for (const m of batch) {
    const idx = Number(m?.index_in_conv);
    if (Number.isFinite(idx) && idx < oldest) {
      oldest = idx;
      foundProgress = true;
    }
  }
  if (foundProgress) return oldest;
  // No usable index (or no progress) — advance by batch size so a malformed
  // page can't truncate the walk. Never returns the same anchor (would loop).
  return Math.max(0, anchor - batch.length);
}
