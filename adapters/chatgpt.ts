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
  parseRequest(body) {
    const b = body as {
      messages?: Array<{ content?: { parts?: unknown[] } }>;
      conversation_id?: unknown;
    } | null;
    const parts = b?.messages?.[0]?.content?.parts;
    const prompt =
      Array.isArray(parts) && typeof parts[0] === "string" ? parts[0] : null;
    return {
      prompt,
      dialogueId:
        typeof b?.conversation_id === "string" ? b.conversation_id : null,
    };
  },
  answerSelector: '[data-message-author-role="assistant"] .markdown',
  userSelector: '[data-message-author-role="user"]',
  conversationSelector: "main",
};
