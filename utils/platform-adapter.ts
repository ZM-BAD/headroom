import type { TokenCoefficients } from "./estimate";

/**
 * Platform adapter — everything platform-specific lives here. Adding a platform
 * = add `adapters/<platform>.ts` + its content script + an entry in `ADAPTERS`
 * (adapters/index.ts) + its host in `wxt.config.ts host_permissions`. The
 * background engine and the content script are generic over this. The content
 * script fetches the conversation history (adapter.fetchHistory) on open /
 * switch / round-completion (REFRESH_HISTORY from the background); the DOM
 * selectors below are a fallback, unused by the history-authoritative core.
 */
/**
 * One historical round reconstructed from a platform's history API (spec 003's
 * `fetchHistory`, used here for 001's "open = full recompute"). Text only —
 * tokens are estimated by the caller; the platform's own token counts (if any)
 * are ignored per spec ("token 永远估算").
 */
export interface HistoryRound {
  /** 1-based round number, ascending (oldest first). */
  n: number;
  promptText: string;
  answerText: string;
}

export interface PlatformAdapter {
  platformId: string;
  displayName: string;
  /** Host the send-request goes to (also used for host-based dispatch), e.g. "chat.deepseek.com". */
  host: string;
  /**
   * webRequest match-pattern for the send request (full URL; `*` allowed for a
   * variable path segment or a trailing glob), e.g.
   * "*://chat.deepseek.com/api/v0/chat/completion" or
   * "*://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat".
   */
  completionUrl: string;
  /** Content-script match pattern, e.g. "*://chat.deepseek.com/*". */
  matchPattern: string;
  /** Context window limit in tokens. */
  contextLimit: number;
  /**
   * Per-platform token-estimation coefficients (spec 001 估算引擎). Absent ⇒
   * the v1 reference `DEFAULT_COEFFICIENTS`; each adapter overrides with its
   * own calibrated values in spec 004. Callers resolve via
   * `adapter.tokenCoefficients ?? DEFAULT_COEFFICIENTS`.
   */
  tokenCoefficients?: TokenCoefficients;
  /**
   * Extract the dialogue id from a platform chat URL (pathname regex). The
   * background uses it to detect when the user starts / switches a conversation
   * WITHIN the same platform (an SPA route change — no page reload, so PAGE_READY
   * doesn't re-fire) so the gauge can reset instead of showing the prior
   * conversation's tally. Returns null on the home / new-chat URL.
   */
  dialogueIdFromUrl?(url: string): string | null;
  /**
   * webRequest match-pattern for the platform's "delete conversation"
   * request, if known. When absent, delete-sync is skipped for this platform
   * (no error). Capture it from the web app: DevTools → Network, delete a
   * throwaway chat, copy the request URL.
   */
  deleteUrl?: string;
  /**
   * Host the delete-request goes to, when it differs from `host` (e.g. 通义千问
   * sends chat to chat2.qianwen.com but deletes via chat2-api.qianwen.com).
   * Absent ⇒ delete-request host == `host`. Only the delete-listener consults
   * this; send dispatch always uses `host`.
   */
  deleteHost?: string;
  /**
   * HTTP method the delete-request uses, to disambiguate when `deleteUrl` also
   * matches non-delete requests on the same path prefix (ChatGPT's
   * /backend-api/conversation gets POSTed to send, PATCHed to delete; Qwen's
   * /api/v2/chats/<id> is DELETE'd to delete but GET'd to view). Defaults to
   * "POST". The delete-listener checks `details.method === deleteMethod` before
   * calling parseDelete.
   */
  deleteMethod?: string;
  /**
   * Extract the dialogue id from a delete request. `rawBody` is the request
   * body as a raw string — parse it per platform (JSON.parse for most, or
   * decode a form-encoded body like Gemini's `f.req=`); the URL is also passed
   * for platforms that carry the id in the path (ChatGPT, Qwen). Must never
   * throw — return null on a bad/unparseable shape. Only invoked when
   * `deleteUrl` is set and matched AND `deleteMethod` matches.
   */
  parseDelete?(rawBody: string, url: string): string | null;
  /**
   * Fetch the full message history of a conversation (spec 003 `fetchHistory`,
   * used here for 001's "open = full recompute"). Runs in the CONTENT SCRIPT
   * (same-origin to the platform, so session cookies are included) and returns
   * ASCENDING rounds, text only — the caller estimates tokens. Absent ⇒ no
   * history parse on open (the gauge starts empty, fills incrementally).
   * Must never throw — return [] on any failure.
   */
  fetchHistory?(dialogueId: string): Promise<HistoryRound[]>;
  /** DOM selector for a single AI/assistant message (content-script side). */
  answerSelector: string;
  /** DOM selector for a single user message (optional; DOM prompt fallback). */
  userSelector?: string;
  /** DOM selector for the conversation container (best-effort; watcher falls back to body). */
  conversationSelector: string;
}
