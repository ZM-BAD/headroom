import type { PlatformAdapter } from "../utils/platform-adapter";

// Qwen Chat (chat.qwen.ai) — request CONFIRMED (POST /api/v2/chat/completions
// ?chat_id=<id>). dialogueId = chat_id (URL query). `messages[0].content` may
// be a string OR an array of {type,text} blocks. SSE `usage` is often omitted
// → estimate only.
//
// DOM CONFIRMED live (2026-06): messages are `.qwen-chat-message` with a
// `-user` / `-assistant` suffix; AI reply markdown renders inside
// `.qwen-markdown`. The bare `[class*='message-assistant']` guess also matches
// but the explicit class is more precise and won't catch unrelated elements.
export const qwenAdapter: PlatformAdapter = {
  platformId: "qwen",
  displayName: "Qwen",
  host: "chat.qwen.ai",
  completionUrl: "*://chat.qwen.ai/api/v2/chat/completions*",
  matchPattern: "*://chat.qwen.ai/*",
  contextLimit: 131_072, // ~128K (Qwen3 family); overridable
  // Delete endpoint: CONFIRMED live (2026-06). Real RESTful DELETE:
  // DELETE /api/v2/chats/<id> (id in the URL path, body empty). deleteMethod:
  // "DELETE" disambiguates from GET /api/v2/chats/<id> (view a single chat)
  // and from the send POST /api/v2/chat/completions (singular "chat", so the
  // deleteUrl pattern "chats" doesn't even match it).
  deleteUrl: "*://chat.qwen.ai/api/v2/chats/*",
  deleteMethod: "DELETE",
  parseDelete(_rawBody, url) {
    try {
      const m = new URL(url).pathname.match(/\/api\/v2\/chats\/([^/?#]+)/);
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
  answerSelector: ".qwen-chat-message-assistant .qwen-markdown",
  userSelector: ".qwen-chat-message-user",
  conversationSelector: ".chat-messages, main",
};
