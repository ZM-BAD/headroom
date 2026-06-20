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
  parseRequest(body, url) {
    const b = body as { messages?: Array<{ content?: unknown }> } | null;
    const content = b?.messages?.[0]?.content;
    let prompt: string | null = null;
    if (typeof content === "string") {
      prompt = content;
    } else if (Array.isArray(content) && content[0]) {
      const text = (content[0] as { text?: unknown }).text;
      if (typeof text === "string") prompt = text;
    }
    const m = url.match(/[?&]chat_id=([^&#]+)/);
    return { prompt, dialogueId: m ? decodeURIComponent(m[1]) : null };
  },
  answerSelector: ".qwen-chat-message-assistant .qwen-markdown",
  userSelector: ".qwen-chat-message-user",
  conversationSelector: ".chat-messages, main",
};
