import type { PlatformAdapter } from "../utils/platform-adapter";

/**
 * DeepSeek adapter.
 *
 * Request shape: CONFIRMED from a real cURL — POST /api/v0/chat/completion,
 * JSON body with `prompt` (user text) + `chat_session_id` (dialogue id) +
 * `model_type`. Mode detection is dropped (both 快速/专家 are 1M context), so
 * only prompt + dialogueId are extracted.
 *
 * DOM selectors: UNVERIFIED — tune in DevTools. DeepSeek renders assistant
 * replies as `.ds-markdown` (the "ds-" design-system prefix is stable in
 * practice, but verify). The round-watcher only needs `answerSelector` to be
 * right; `conversationSelector` is a fallback the watcher ignores if absent.
 */
export const deepseekAdapter: PlatformAdapter = {
  platformId: "deepseek",
  displayName: "DeepSeek",
  host: "chat.deepseek.com",
  completionUrl: "*://chat.deepseek.com/api/v0/chat/completion",
  matchPattern: "*://chat.deepseek.com/*",
  contextLimit: 1_000_000,
  parseRequest(body) {
    const b = body as { prompt?: unknown; chat_session_id?: unknown } | null;
    return {
      prompt: typeof b?.prompt === "string" ? b.prompt : null,
      dialogueId:
        typeof b?.chat_session_id === "string" ? b.chat_session_id : null,
    };
  },
  answerSelector: ".ds-assistant-message-main-content",
  conversationSelector: 'div[class*="message-list"], main',
};
