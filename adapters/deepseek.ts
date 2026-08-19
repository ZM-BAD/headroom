import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import type { TokenCoefficients } from "../utils/estimate";

/** Measured against the open DeepSeek-V4-Flash tokenizer — exact (spec 004 §4.3; scripts/calibrate-hf.mjs). */
const DEEPSEEK_COEFFICIENTS: TokenCoefficients = {
  cjk: 0.61,
  kana: 0.73,
  hangul: 0.77,
  cyrillic: 2.1,
  arabic: 2.15,
  latin: 1.32,
};

/**
 * DeepSeek `history_messages` message row. DeepSeek A/B-rolls TWO payload
 * shapes (both captured live, 2026-06 Playwright + 2026-08-14 probe):
 *   - 2026-06 (STILL SERVED — confirmed on a real session 2026-08-16):
 *     text lives in `fragments[]` ({type: REQUEST|THINK|RESPONSE|TIP});
 *     there is NO top-level `content`.
 *   - 2026-08: content moved to top-level string fields (`content`,
 *     `thinking_content`); `fragments` absent.
 * The parser must read BOTH (fragments preferred, content as fallback).
 * `search_enabled` / `search_status` / `search_results` describe web-search
 * rounds — but `search_results` is null in both WIP and FINISHED states
 * (verified 2026-08-14): the search text exists only in the SSE completion
 * stream, which MV3 webRequest cannot read. So search tokens are NOT countable
 * for DeepSeek (spec 005).
 */
interface DsMessage {
  message_id?: number;
  parent_id?: number | null;
  role?: string;
  /** User prompt / assistant answer text (2026-08 shape — replaces fragments[].content). */
  content?: string;
  /** Private reasoning — deliberately excluded from the estimate (like Qwen's thinking_summary). */
  thinking_content?: string;
  /** "true" when this round's send had web search enabled. */
  search_enabled?: string | boolean;
  /** Always null post-finish — search text is stream-only (spec 005 limitation). */
  search_results?: unknown;
  /** Text fragments (2026-06 shape — still served in the wild): REQUEST = user
   *  text, RESPONSE = assistant answer, THINK = private reasoning (excluded),
   *  TIP = UI metadata (excluded). */
  fragments?: DsFragment[];
  /** epoch float seconds (e.g. 1782741816.158). */
  inserted_at?: number;
  /** "FINISHED" for complete messages; absent/other for mid-stop or in-progress. */
  status?: string;
}

/** A text fragment in the 2026-06 `fragments[]` shape. */
interface DsFragment {
  type?: string;
  content?: string;
}
/** The GET /api/v0/chat/history_messages response shape (the parts we read). */
interface DsHistoryResponse {
  data?: { biz_data?: { chat_messages?: DsMessage[] } };
}

/**
 * DeepSeek message text. DeepSeek A/B-rolls two payload shapes (both live —
 * fragments[] 2026-06 confirmed again 2026-08-16, top-level content 2026-08):
 * prefer the type-filtered `fragments[]` (REQUEST for user / RESPONSE for
 * assistant; THINK/TIP are reasoning/metadata and stay excluded), fall back to
 * the top-level `content` string. Empty when neither shape carries text.
 */
function dsMessageText(m: DsMessage | undefined, type: string): string {
  if (Array.isArray(m?.fragments)) {
    const joined = m.fragments
      .filter((f) => f?.type === type)
      .map((f) => (typeof f?.content === "string" ? f.content : ""))
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  // 2026-08 shape: the whole message text rides one top-level string.
  return typeof m?.content === "string" ? m.content.trim() : "";
}

/**
 * Parse a `GET /api/v0/chat/history_messages?chat_session_id=<id>` response into
 * ASCENDING rounds (DUAL SHAPE — DeepSeek A/B-rolls fragments[] 2026-06 and
 * top-level `content` 2026-08; see DsMessage, both captured live). Each ASSISTANT message
 * is paired with its parent USER (parent_id) → one round. Status is NOT filtered —
 * stopped/incomplete generations still count (the user's prompt consumed tokens,
 * and the dedup below ensures a retry replaces the earlier attempt).
 * Rounds stay in message_id order (oldest first).
 *
 * Dedup: when multiple ASSISTANT messages share the same parent USER (regenerate),
 * only the one with the highest message_id is kept — that's the latest revision.
 *
 * Returns TEXT only — the platform's own `accumulated_token_usage` is dropped
 * (spec: tokens are always estimated, the platform's count is 004 calibration
 * only). Search text is NOT returned (not in the history API — spec 005).
 * Defensive: a missing/foreign shape → []; never throws.
 */
export function parseDeepSeekHistory(resp: unknown): HistoryRound[] {
  const messages =
    (resp as DsHistoryResponse | null | undefined)?.data?.biz_data
      ?.chat_messages ?? [];
  if (!Array.isArray(messages)) return [];
  const byId = new Map<number, DsMessage>();
  for (const m of messages) {
    if (m && typeof m.message_id === "number") byId.set(m.message_id, m);
  }
  // Build candidate rounds, deduped by parent_id → keep highest message_id.
  // messageId = the assistant's stable message_id (cross-fetch merge key);
  // order = message_id (monotonic per conversation = chronological).
  const byParent = new Map<number, HistoryRound>();
  for (const m of messages) {
    if (m?.role !== "ASSISTANT") continue;
    if (typeof m.message_id !== "number") continue;
    // Allow incomplete/stopped messages — stopped generation still counts as a
    // round (answerText may be ""). The dedup below prefers higher message_id,
    // so a retry always wins over a stopped attempt for the same parent.
    const parentId = m.parent_id;
    if (parentId == null || typeof parentId !== "number") continue;
    const parent = byId.get(parentId);
    if (!parent) continue; // orphan assistant — no user prompt to pair
    const existing = byParent.get(parentId);
    if (existing && (existing.order as number) >= m.message_id) continue;
    byParent.set(parentId, {
      messageId: String(m.message_id),
      order: m.message_id,
      promptText: dsMessageText(parent, "REQUEST"),
      answerText: dsMessageText(m, "RESPONSE"),
      createdAt:
        typeof m.inserted_at === "number"
          ? Math.round(m.inserted_at * 1000)
          : undefined,
    });
  }
  return [...byParent.values()].sort((a, b) => a.order - b.order);
}

/**
 * Read DeepSeek's session Bearer token from the page's localStorage (key
 * `userToken`, JSON `{value}`-wrapped — captured 2026-06). Content scripts share
 * the page's localStorage. Returns null when absent (not logged in) → history
 * fetches return INVALID_TOKEN and the gauge falls back to incremental capture.
 */
function readDsUserToken(): string | null {
  try {
    const raw = localStorage.getItem("userToken");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed?.value === "string" ? parsed.value : null;
  } catch {
    return null;
  }
}

/**
 * The headers DeepSeek's web app sends on its API calls (captured 2026-06). The
 * Bearer token is the auth (without it the API returns code 40003
 * INVALID_TOKEN); the x-client-* are metadata the app includes.
 */
function dsApiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-client-platform": "web",
    "x-client-bundle-id": "com.deepseek.chat",
    // Version pins — update if DeepSeek bumps them and the API rejects stale.
    "x-app-version": "2.0.0",
    "x-client-version": "2.0.0",
    "x-client-locale": navigator.language.replace("-", "_"),
    "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
  };
}

/**
 * DeepSeek adapter.
 *
 * completionUrl: POST /api/v0/chat/completion — the SSE streaming completion
 * (content-type text/event-stream). webRequest onCompleted on it = the model
 * finished this round (the root-cause finish signal; spec 001 踩坑 A).
 *
 * fetchHistory: GET /api/v0/chat/history_messages?chat_session_id=<id> — the
 * sole authority for round identity (message_id) + the text we estimate tokens
 * from. Needs the Bearer token from localStorage.userToken + x-client-* headers
 * (踩坑 C). Returns every message in one shot, no pagination (踩坑 D).
 *
 * DOM selectors: unused by the history-authoritative core; retained as a
 * fallback for platforms without a history API.
 */
export const deepseekAdapter: PlatformAdapter = {
  platformId: "deepseek",
  displayName: "DeepSeek",
  host: "chat.deepseek.com",
  completionUrl: "*://chat.deepseek.com/api/v0/chat/completion",
  // Confirmed live (2026-07, Playwright): clicking "stop generating" sends a
  // SEPARATE POST /api/v0/chat/stop_stream (not an abort of the completion
  // request). The SSE stream closes normally afterward → onCompleted fires on
  // completionUrl, not onErrorOccurred. Without this stopUrl, Headroom has no
  // way to know the user stopped and can't retry with backoff (001-17).
  stopUrl: "*://chat.deepseek.com/api/v0/chat/stop_stream",
  // Confirmed live (2026-07, Playwright): "continue generating" sends
  // POST /api/v0/chat/continue (separate endpoint from /completion).
  // Completion behaves identically to /completion — when the stream closes
  // the continued answer is in history, same messageId, round count unchanged.
  continueUrl: "*://chat.deepseek.com/api/v0/chat/continue*",
  matchPattern: "*://chat.deepseek.com/*",
  contextLimit: 1_048_576, // 1M (1 << 20); overridable
  tokenCoefficients: DEEPSEEK_COEFFICIENTS, // spec 004 §4.3 calibrated (incl. markdown overhead)
  // Delete endpoint: CONFIRMED live (2026-06, Playwright → delete a throwaway
  // chat). POST /api/v0/chat_session/delete with body {"chat_session_id":"<id>"}
  // — singular string field (NOT the batch array that reverse-eng projects
  // guessed). Same api/v0 prefix as completion. Not in DeepSeek's stateless
  // official API; the web-app internal contract can change without notice.
  deleteUrl: "*://chat.deepseek.com/api/v0/chat_session/delete",
  parseDelete(rawBody) {
    try {
      const b = JSON.parse(rawBody) as {
        chat_session_id?: unknown;
      } | null;
      return typeof b?.chat_session_id === "string" ? b.chat_session_id : null;
    } catch {
      return null;
    }
  },
  // DeepSeek chat URLs: https://chat.deepseek.com/a/chat/s/<id> (home = "/").
  dialogueIdFromUrl(url) {
    try {
      return (
        new URL(url).pathname.match(/\/a\/chat\/s\/([^/?#]+)/)?.[1] ?? null
      );
    } catch {
      return null;
    }
  },
  // DeepSeek writes the conversation title into the browser tab title
  // (document.title), updated by the SPA on open/rename. This is the most
  // stable source — hashed CSS classes on the header/sidebar shift between
  // builds, but document.title is the OS-level tab label the platform keeps
  // correct. Strip a trailing " - DeepSeek" brand suffix if present.
  dialogueTitleFromDoc(doc) {
    const raw = doc.title?.trim();
    if (!raw) return null;
    return raw.replace(/\s*[-—]\s*DeepSeek\s*$/i, "").trim() || null;
  },
  // History API: CONFIRMED live (2026-06 Playwright). GET
  // /api/v0/chat/history_messages?chat_session_id=<id> → chat_messages[] (USER/
  // ASSISTANT paired by parent_id, fragments[].content = text). Runs in the
  // content script (same-origin → session cookies included). DeepSeek also
  // returns accumulated_token_usage per message; we DROP it (spec: estimate).
  async fetchHistory(dialogueId) {
    const token = readDsUserToken();
    try {
      const res = await fetch(
        `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(dialogueId)}`,
        {
          credentials: "include",
          headers: token ? dsApiHeaders(token) : {},
        },
      );
      if (!res.ok) return [];
      return parseDeepSeekHistory(await res.json());
    } catch {
      // network/parse failure — the next open / switch / round-completion re-fetches
      return [];
    }
  },
  // GET /api/v0/chat_session/fetch_page?lte_cursor.pinned=false → chat_sessions[]
  // (id = dialogue UUID). Used by zombie cleanup (spec 003) to diff live
  // conversations against cloud keys. Runs in content script (same-origin).
  async fetchConversationList() {
    const token = readDsUserToken();
    try {
      const url =
        "https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false";
      const res = await fetch(url, {
        credentials: "include",
        headers: token ? dsApiHeaders(token) : {},
      });
      if (!res.ok) return [];
      const json = await res.json();
      const sessions: Array<{ id?: string }> =
        json?.data?.biz_data?.chat_sessions ?? [];
      return sessions
        .map((s) => s.id)
        .filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  },
  answerSelector: ".ds-assistant-message-main-content",
  conversationSelector: 'div[class*="message-list"], main',
};
