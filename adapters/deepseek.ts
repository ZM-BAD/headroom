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
 * is paired with its parent USER (parent_id) → one round; rounds stay in message
 * order (oldest first, 1-based n). Returns TEXT only — the platform's own
 * `accumulated_token_usage` is dropped (spec: tokens are always estimated, the
 * platform's count is 004 calibration only). Defensive: a missing/foreign shape
 * → []; never throws.
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
  const rounds: HistoryRound[] = [];
  for (const m of messages) {
    if (m?.role !== "ASSISTANT") continue;
    const parent =
      m.parent_id != null && typeof m.parent_id === "number"
        ? byId.get(m.parent_id)
        : undefined;
    if (!parent) continue; // orphan assistant (no user prompt to pair) — skip
    rounds.push({
      n: 0,
      promptText: joinFragments(parent.fragments, "REQUEST"),
      answerText: joinFragments(m.fragments, "RESPONSE"),
    });
  }
  rounds.forEach((r, i) => (r.n = i + 1));
  return rounds;
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
  contextLimit: 1_000_000,
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
  answerSelector: ".ds-assistant-message-main-content",
  conversationSelector: 'div[class*="message-list"], main',
};
