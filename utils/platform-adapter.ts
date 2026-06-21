/**
 * Platform adapter — everything platform-specific lives here. Adding a platform
 * = add `adapters/<platform>.ts` + its content script + an entry in `ADAPTERS`
 * (adapters/index.ts) + its host in `wxt.config.ts host_permissions`. The
 * background engine and the DOM round-watcher are generic over this.
 *
 * `parseRequest` runs in the background (it reads the webRequest body). The
 * DOM selectors run in the platform's content script via the round-watcher.
 */
export interface ParsedRequest {
  /** The user's prompt text, if extractable from the send-request body. */
  prompt: string | null;
  /** Conversation/dialogue/session id, if the body carries one. */
  dialogueId: string | null;
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
   * Parse the send-request body (and URL, for platforms that carry the
   * dialogue id in the path/query rather than the body, e.g. Kimi). Must never
   * throw — return nulls on a bad/unparseable shape.
   */
  parseRequest(body: unknown, url: string): ParsedRequest;
  /**
   * Extract the dialogue id from a platform chat URL (pathname regex). The
   * background uses it to detect when the user starts / switches a conversation
   * WITHIN the same platform (an SPA route change — no page reload, so PAGE_READY
   * doesn't re-fire) so the gauge can reset instead of showing the prior
   * conversation's tally. Returns null on the home / new-chat URL.
   */
  dialogueIdFromUrl?(url: string): string | null;
  /** DOM selector for a single AI/assistant message (content-script side). */
  answerSelector: string;
  /** DOM selector for a single user message (optional; DOM prompt fallback). */
  userSelector?: string;
  /** DOM selector for the conversation container (best-effort; watcher falls back to body). */
  conversationSelector: string;
}
