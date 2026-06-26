import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import { DEFAULT_COEFFICIENTS } from "../utils/estimate";

// 通义千问 consumer chat — request CONFIRMED live (2026-06):
//   POST https://chat2.qianwen.com/api/v2/chat?...
//   body: { messages: [{ content: "1+1等于几", ... }], session_id: "...", ... }
// i.e. prompt = messages[0].content (a plain string), dialogueId = session_id.
// The page SPA is served from www.qianwen.com but the send-request goes to
// chat2.qianwen.com (API host ≠ page host, so host_permissions needs both).
//
// History API — CONFIRMED live (2026-06, Playwright):
//   GET https://chat2-api.qianwen.com/api/v1/session/msg/list?session_id=<id>&...
//   data.list[] = rounds (NEW→OLD with forward=false; reverse for ascending).
//   prompt = round.request_messages[].content (mime_type "text/plain");
//   answer = round.response_messages[].content (mime_type "multi_load/iframe",
//            the markdown body — the other mimes are metadata/recommendations).
//   Paginated: page/page_size, data.have_next_page gates the next fetch.
//   Auth = cookies only (credentials:"include"); the clt-acs-*/eo-clt-* signing
//   headers the SPA adds are NOT enforced server-side. `ut` (device id) IS
//   required as a query param — read from cookie `b-user-id`.
//
// DOM CONFIRMED live (2026-06): each message is wrapped in a
// `message-select-wrapper-{question|answer}-<hash>` container (hash rotates
// per build, so match on the prefix). AI reply markdown renders inside
// `.answer-common-card .qk-markdown`; user text sits in `.question-text-card`.
export const qianwenAdapter: PlatformAdapter = {
  platformId: "qianwen",
  displayName: "通义千问",
  // API host (the send-request target); page host is www.qianwen.com.
  host: "chat2.qianwen.com",
  completionUrl: "*://chat2.qianwen.com/api/v2/chat*",
  matchPattern: "*://www.qianwen.com/*",
  contextLimit: 1_048_576, // 1M (1 << 20); overridable
  tokenCoefficients: DEFAULT_COEFFICIENTS, // v1 default; calibrate in spec 004
  // Live-confirmed (2026-06): the `-question`/`-answer` prefix is stable even
  // though the trailing hash (`-oonUAN`) rotates per build.
  // Delete endpoint: CONFIRMED live (2026-06). The delete API rides a
  // DIFFERENT host than send: chat2-api.qianwen.com (send → chat2.qianwen.com).
  // deleteHost declares it so the delete-listener can dispatch. Body is the
  // batch shape {"session_ids":["<id>"]} (array even for a single delete).
  deleteHost: "chat2-api.qianwen.com",
  deleteUrl: "*://chat2-api.qianwen.com/api/v1/session/delete/batch*",
  parseDelete(rawBody) {
    try {
      const b = JSON.parse(rawBody) as { session_ids?: unknown } | null;
      // Batch endpoint: take the first id (we only delete one local record per
      // request; the web app sends a 1-element array for a single-chat delete).
      if (!Array.isArray(b?.session_ids)) return null;
      const first = b!.session_ids[0];
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
  // document.title is the brand "千问 - 阿里旗下全能AI助手" and does NOT carry
  // the conversation title (unlike DeepSeek). The real title lives in the
  // sidebar and in the session/get API, neither reachable from doc alone in a
  // build-stable way, so return null — the panel falls back to dialogueId.
  dialogueTitleFromDoc() {
    return null;
  },
  // History API: CONFIRMED live (2026-06, Playwright). Paginated GET — walk
  // pages until have_next_page is false, then reverse to ascending. Runs in the
  // content script (same-origin → session cookies via credentials:"include").
  async fetchHistory(dialogueId) {
    const ut = readQianwenUt();
    if (!ut) return [];
    // Paginated GET: walk pages until have_next_page is false, accumulating the
    // raw list items; the parse (pure, unit-tested) runs once over the whole set.
    const all: QianwenRound[] = [];
    let page = 1;
    const pageSize = 20;
    try {
      for (;;) {
        const res = await fetch(
          qianwenHistoryUrl(dialogueId, ut, page, pageSize),
          {
            credentials: "include",
            headers: { "content-type": "application/json" },
          },
        );
        if (!res.ok) return [];
        const j = (await res.json()) as QianwenHistoryResponse | null;
        const list = j?.data?.list;
        if (!Array.isArray(list)) return [];
        all.push(...list);
        if (!j?.data?.have_next_page) break;
        page += 1;
        if (page > 50) break; // hard cap (500+ rounds) — defensive, never hit
      }
    } catch {
      // network/parse failure — the next open / switch / round-completion re-fetches
      return [];
    }
    return parseQianwenHistory(all);
  },
  answerSelector: "[class*='message-select-wrapper-answer'] .qk-markdown",
  userSelector:
    "[class*='message-select-wrapper-question'] .question-text-card",
  conversationSelector: ".chat-container-wrapper, [class*='chat-round'], main",
};

/** A single message inside request_messages/response_messages. */
interface QianwenMessage {
  mime_type?: string;
  content?: string;
}
/** One round (a `data.list[]` item) in the msg/list response. */
export interface QianwenRound {
  req_id?: string; // stable per-round request id (union-merge key)
  created_at?: number; // epoch ms (chronological order)
  request_messages?: QianwenMessage[];
  response_messages?: QianwenMessage[];
}
/** The GET .../session/msg/list response shape (the parts we read). */
interface QianwenHistoryResponse {
  data?: {
    have_next_page?: boolean;
    list?: QianwenRound[];
  };
}

/**
 * Concatenate the `content` of every message whose `mime_type` matches
 * (newline-joined, trimmed). For request_messages the prompt is the
 * "text/plain" entry; for response_messages the answer markdown is the
 * "multi_load/iframe" entry — the others (signal/post, bar/progress,
 * paa/iframe recommendations) are metadata we drop.
 */
function joinQianwenContents(
  msgs: QianwenMessage[] | undefined,
  mimeType: string,
): string {
  if (!Array.isArray(msgs)) return "";
  return msgs
    .filter((m) => m?.mime_type === mimeType)
    .map((m) => (typeof m?.content === "string" ? m.content : ""))
    .join("\n")
    .trim();
}

/**
 * Parse the accumulated msg/list `data.list[]` (all pages, any order) into
 * HistoryRound[]. Pure: the HTTP pagination walk lives in fetchHistory; this is
 * the unit-tested half. prompt = request_messages "text/plain"; answer =
 * response_messages "multi_load/iframe" (the rest — signal/post, bar/progress,
 * paa/iframe — are metadata/recommendations, dropped). messageId = the list
 * item's req_id; order = created_at. Defensive: never throws.
 */
export function parseQianwenHistory(
  list: QianwenRound[] | undefined,
): HistoryRound[] {
  if (!Array.isArray(list)) return [];
  const rounds: HistoryRound[] = [];
  for (const round of list) {
    const promptText = joinQianwenContents(
      round?.request_messages,
      "text/plain",
    );
    const answerText = joinQianwenContents(
      round?.response_messages,
      "multi_load/iframe",
    );
    const createdAt =
      typeof round?.created_at === "number" ? round.created_at : 0;
    if (promptText || answerText) {
      rounds.push({
        messageId: round?.req_id || `qwn:${createdAt}`,
        order: createdAt,
        promptText,
        answerText,
      });
    }
  }
  return rounds;
}

/**
 * Read the `ut` (device-tracking id) the SPA puts in every API query string.
 * It is the value of the `b-user-id` cookie (CONFIRMED 2026-06); without it the
 * API returns 400 "Bad Parameter: [ut]". Returns null when absent (logged out)
 * → the gauge falls back to incremental capture.
 */
function readQianwenUt(): string | null {
  try {
    const m = document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("b-user-id="));
    return m ? m.slice("b-user-id=".length) : null;
  } catch {
    return null;
  }
}

/**
 * Build the history-URL with the query-param set the server requires. `ut` is
 * the only non-constant (read from cookie); the rest are fixed client-identity
 * params the SPA always sends. nonce/timestamp are generated per call.
 */
function qianwenHistoryUrl(
  dialogueId: string,
  ut: string,
  page: number,
  pageSize: number,
): string {
  const qs = new URLSearchParams({
    biz_id: "ai_qwen",
    chat_client: "h5",
    device: "pc",
    fr: "pc",
    pr: "qwen",
    ut,
    la: "zh-CN",
    tz: "Asia/Shanghai",
    wv: "2.13.5",
    ve: "2.13.5",
    nonce: Math.random().toString(36).slice(2, 13),
    timestamp: String(Date.now()),
    session_id: dialogueId,
    page_size: String(pageSize),
    page: String(page),
    forward: "false",
    include_pos: "false",
    return_response_messages: "true",
    event_filter: "all",
  });
  return `https://chat2-api.qianwen.com/api/v1/session/msg/list?${qs}`;
}
