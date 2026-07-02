import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import { DEFAULT_COEFFICIENTS } from "../utils/estimate";

/** DeepSeek `history_messages` fragment (REQUEST / RESPONSE / THINKING / ...). */
interface DsFragment {
  type?: string;
  content?: string;
}
/** DeepSeek `history_messages` message row. */
interface DsMessage {
  message_id?: number;
  parent_id?: number | null;
  role?: string;
  fragments?: DsFragment[];
  /** epoch float seconds (e.g. 1782741816.158). */
  inserted_at?: number;
  /** "FINISHED" for complete messages; absent/other for mid-stop or in-progress. */
  status?: string;
}
/** The GET /api/v0/chat/history_messages response shape (the parts we read). */
interface DsHistoryResponse {
  data?: { biz_data?: { chat_messages?: DsMessage[] } };
}

/** Concatenate the content of every fragment of `type` (newline-joined, trimmed). */
function joinFragments(
  fragments: DsFragment[] | undefined,
  type: string,
): string {
  if (!Array.isArray(fragments)) return "";
  return fragments
    .filter((f) => f?.type === type)
    .map((f) => (typeof f?.content === "string" ? f.content : ""))
    .join("\n")
    .trim();
}

/**
 * Parse a `GET /api/v0/chat/history_messages?chat_session_id=<id>` response into
 * ASCENDING rounds (CONFIRMED shape, 2026-06 Playwright). Each ASSISTANT message
 * with status "FINISHED" is paired with its parent USER (parent_id) → one round.
 * Rounds stay in message_id order (oldest first).
 *
 * Dedup: when multiple ASSISTANT messages share the same parent USER (regenerate),
 * only the one with the highest message_id is kept — that's the latest revision.
 *
 * Incomplete/stopped messages (status != "FINISHED") are skipped entirely — a
 * partial answer after stop isn't a real round; it will be counted when the user
 * continues and the status flips to FINISHED (same message_id → onCompleted →
 * REFRESH_HISTORY → token updated).
 *
 * Returns TEXT only — the platform's own `accumulated_token_usage` is dropped
 * (spec: tokens are always estimated, the platform's count is 004 calibration
 * only). Defensive: a missing/foreign shape → []; never throws.
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
    // Skip incomplete/stopped messages — they aren't real rounds (ROUND-4).
    if (m.status && m.status !== "FINISHED") continue;
    const parentId = m.parent_id;
    if (parentId == null || typeof parentId !== "number") continue;
    const parent = byId.get(parentId);
    if (!parent) continue; // orphan assistant — no user prompt to pair
    const existing = byParent.get(parentId);
    if (existing && (existing.order as number) >= m.message_id) continue;
    byParent.set(parentId, {
      messageId: String(m.message_id),
      order: m.message_id,
      promptText: joinFragments(parent.fragments, "REQUEST"),
      answerText: joinFragments(m.fragments, "RESPONSE"),
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
  matchPattern: "*://chat.deepseek.com/*",
  contextLimit: 1_048_576, // 1M (1 << 20); overridable
  tokenCoefficients: DEFAULT_COEFFICIENTS, // v1 reference (cjk 0.6 / latin 0.5); calibrate in spec 004
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
