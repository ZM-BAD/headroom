import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import { DEFAULT_COEFFICIENTS } from "../utils/estimate";

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
  tokenCoefficients: DEFAULT_COEFFICIENTS, // v1 default; calibrate in spec 004
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
 * Parse the accumulated messages (NEW→OLD) into ASCENDING rounds (CONFIRMED
 * shape, 2026-06 Playwright). Doubao is an IM model: user (user_type 1) and
 * bot (user_type 2) ALTERNATE, so we walk the time-ascending list and pair each
 * user with the immediately-following bot. Reverse first (API returns NEW→OLD).
 * Drops messages with no extractable text. Defensive: never throws.
 */
export function parseDoubaoHistory(messages: DoubaoMessage[]): HistoryRound[] {
  if (!Array.isArray(messages)) return [];
  // Attach parsed text + time + the stable per-message index, drop empty.
  const enriched = messages
    .map((m) => ({
      userType: m.user_type,
      text: doubaoMessageText(m),
      ts: Number(m.create_time) || 0,
      idx: Number(m.index_in_conv) || 0,
    }))
    .filter((m) => m.text);
  enriched.sort((a, b) => a.ts - b.ts); // ascending (oldest first)
  // Pair each user (1) with the next bot (2) that follows it.
  const rounds: HistoryRound[] = [];
  for (let i = 0; i < enriched.length; i++) {
    if (enriched[i].userType !== 1) continue;
    const promptText = enriched[i].text;
    let answer: { text: string; ts: number; idx: number } | undefined;
    for (let j = i + 1; j < enriched.length; j++) {
      if (enriched[j].userType === 2) {
        answer = enriched[j];
        break;
      }
      // stop looking if we hit the next user before finding a bot
      if (enriched[j].userType === 1) break;
    }
    if (answer) {
      // messageId = the bot's index_in_conv (stable monotonic per conversation);
      // fall back to its create_time when index_in_conv is absent/invalid (the
      // M2 edge) so malformed rows still get a unique, stable id instead of all
      // colliding on `db:0`. order = the bot's create_time. Display n is
      // assigned post-merge (003).
      rounds.push({
        messageId: `db:${answer.idx > 0 ? answer.idx : "t" + answer.ts}`,
        order: answer.ts,
        promptText,
        answerText: answer.text,
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
