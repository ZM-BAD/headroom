import type { TokenCoefficients } from "./estimate";

/**
 * Platform adapter — everything platform-specific lives here. Adding a platform
 * = add `adapters/<platform>.ts` + its content script + an entry in `ADAPTERS`
 * (adapters/index.ts) + its host in `wxt.config.ts host_permissions`. The
 * background engine and the content script are generic over this. The content
 * script fetches the conversation history (adapter.fetchHistory) on open /
 * switch / round-completion (REFRESH_HISTORY from the background); the DOM
 * selectors below are a fallback, unused by the history-authoritative core.
 *
 * ⚠️  ZERO-COUPLING RULE (see AGENTS.md § "Adapter zero-coupling rule"):
 * A bug fix for one platform MUST NOT change the behaviour of any other.
 * Use optional fields on this interface (with sensible defaults) to carry
 * platform-specific policy. Never hardcode a platform's quirk in the shared
 * pipeline (background.ts / platform.content.ts). The 7 AI platforms are
 * independent companies — what's true for all of them today may not be true
 * for one of them tomorrow.
 */
/**
 * One historical round reconstructed from a platform's history API
 * (`fetchHistory` — a 001 primitive; 003 reuses it under union orchestration).
 * Text only — tokens are estimated by the caller; the platform's own token
 * counts (if any) are ignored per spec ("token 永远估算").
 */
export interface HistoryRound {
  /** Stable platform identity for this round — the spec 003 union-merge key. */
  messageId: string;
  /** Chronological order key (ascending = oldest first). Display `n` is derived post-merge, NOT set here. */
  order: number;
  promptText: string;
  answerText: string;
  /** Wall-clock epoch ms when this round was created on the platform. Optional — DOM-only platforms may omit (defaults to 0). */
  createdAt?: number;
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
  /**
   * HTTP method the completion/continue requests use. Defaults to "POST".
   * Only this method will trigger finishRound → REFRESH_HISTORY; other
   * methods matching completionUrl are ignored (e.g. ChatGPT's fetchHistory
   * GET hits the same URL pattern and must not trigger completion).
   */
  completionMethod?: string;
  /**
   * webRequest match-pattern for the platform's "stop generating" request, if
   * the platform uses a dedicated endpoint (e.g. DeepSeek POST
   * /api/v0/chat/stop_stream). Absent ⇒ stop is handled by onErrorOccurred on
   * completionUrl (aborted fetch), which may not fire on all platforms. When
   * set, onCompleted on this URL triggers a retry-based history fetch (spec
   * 001-17: the partial answer may take longer to land in history after stop).
   */
  stopUrl?: string;
  /**
   * webRequest match-pattern for the platform's "continue generating" request,
   * if the platform uses a dedicated endpoint (e.g. DeepSeek POST
   * /api/v0/chat/continue). Absent ⇒ the platform resumes via completionUrl
   * itself. When set, onCompleted on this URL triggers the same normal history
   * fetch as completionUrl — the round's messageId is unchanged, so
   * applyHistory replaces it with updated token counts (round count unchanged,
   * token count updated, cloud synced).
   */
  continueUrl?: string;
  /** Content-script match pattern, e.g. "*://chat.deepseek.com/*". */
  matchPattern: string;
  /** Context window limit in tokens. */
  contextLimit: number;
  /**
   * Per-platform token-estimation coefficients (spec 004 — six writing
   * systems, all required). Every adapter must provide its own set; the
   * runtime resolution chain is user override → adapter default, with no
   * third-tier global fallback.
   */
  tokenCoefficients: TokenCoefficients;
  /**
   * Extract the dialogue id from a platform chat URL (pathname regex). The
   * background uses it to detect when the user starts / switches a conversation
   * WITHIN the same platform (an SPA route change — no page reload, so PAGE_READY
   * doesn't re-fire) so the gauge can reset instead of showing the prior
   * conversation's tally. Returns null on the home / new-chat URL.
   */
  dialogueIdFromUrl?(url: string): string | null;
  /**
   * Extract the conversation's human-readable title from the page DOM (content
   * script side). Read from wherever the platform renders the chat title (header
   * / sidebar active item). The side panel shows it alongside the dialogueId to
   * build the "this gauge = this conversation" mental model (spec 001). Runs
   * in the content script on open / SPA switch; null when no title element is
   * present yet (the panel falls back to the dialogueId only).
   */
  dialogueTitleFromDoc?(doc: Document): string | null;
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
   * Fetch the full message history of a conversation. A 001 primitive (used
   * for 001's "open = full recompute"); 003 reuses it and adds union merge on
   * top. Runs in the CONTENT SCRIPT (same-origin to the platform, so session
   * cookies are included) and returns ASCENDING rounds, text only — the caller
   * estimates tokens. Absent ⇒ no history parse on open (the gauge stays empty
   * for that platform). Must never throw — return [] on any failure.
   */
  fetchHistory?(dialogueId: string): Promise<HistoryRound[]>;
  /**
   * Fetch the list of ALL conversation ids for this platform (the home-page
   * sidebar). Used by zombie cleanup (spec 003): ids still in Upstash but no
   * longer on the platform (deleted elsewhere, e.g. mobile) get cloud-DELed.
   * Runs in the CONTENT SCRIPT (same-origin). Absent ⇒ zombie cleanup is
   * skipped for this platform. Must never throw — return [] on failure.
   */
  fetchConversationList?(): Promise<string[]>;
  /**
   * When true, the content script's 1.5s poll watches for new DOM elements
   * matching answerSelector as a fallback completion detector. Needed by
   * platforms whose webRequest onCompleted does not reliably fire for the
   * streaming completion endpoint (Gemini — DOM-only, no history API).
   * Defaults to false.
   */
  needsDomPollDetection?: boolean;
  /**
   * When true, the platform's history store is eventually consistent: the
   * bot message lands 0–1s+ AFTER the completion request closes (measured
   * live on Doubao's IM chain, 2026-07: onCompleted+473ms → bot absent,
   * +948ms → present). The content script then re-fetches with bounded
   * backoff while the newest round's answer is empty (see
   * utils/history-settle.ts) instead of shipping a 0-output-token round.
   * Defaults to false — platforms that persist synchronously never retry.
   */
  historyNeedsSettleRetry?: boolean;
  /** DOM selector for a single AI/assistant message (content-script side). */
  answerSelector: string;
  /** DOM selector for a single user message (optional; DOM prompt fallback). */
  userSelector?: string;
  /** DOM selector for the conversation container (best-effort; watcher falls back to body). */
  conversationSelector: string;
}
