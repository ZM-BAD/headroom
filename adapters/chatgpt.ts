import type { PlatformAdapter } from "../utils/platform-adapter";

// ChatGPT — request shape CONFIRMED (POST /backend-api/conversation, SSE).
// DOM UNVERIFIED: OpenAI rewrites the DOM constantly, so selectors are
// data-attr-first best-guesses — verify live in DevTools. contextLimit is an
// approximate default (GPT-4o family); overridable in settings later.
export const chatgptAdapter: PlatformAdapter = {
  platformId: "chatgpt",
  displayName: "ChatGPT",
  host: "chatgpt.com",
  completionUrl: "*://chatgpt.com/backend-api/conversation",
  matchPattern: "*://chatgpt.com/*",
  contextLimit: 128_000,
  // Delete endpoint: CONFIRMED live (2026-06). ChatGPT soft-deletes via
  // PATCH /backend-api/conversation/<id> (not a real DELETE) — body is a
  // {is_visible:false} flag, id rides in the URL path. deleteMethod:"PATCH"
  // disambiguates from the send POST that hits the same /backend-api/conversation
  // prefix (send ends at /conversation with no trailing id).
  deleteUrl: "*://chatgpt.com/backend-api/conversation/*",
  deleteMethod: "PATCH",
  parseDelete(_rawBody, url) {
    try {
      const m = new URL(url).pathname.match(
        /\/backend-api\/conversation\/([^/?#]+)/,
      );
      return m ? m[1] : null;
    } catch {
      return null;
    }
  },
  dialogueIdFromUrl(url) {
    try {
      return new URL(url).pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  },
  answerSelector: '[data-message-author-role="assistant"] .markdown',
  userSelector: '[data-message-author-role="user"]',
  conversationSelector: "main",
};
