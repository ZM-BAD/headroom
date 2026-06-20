import type { PlatformAdapter } from "../utils/platform-adapter";

// Kimi — request CONFIRMED (POST /api/chat/{conversation_id}/completion/stream).
// The dialogue id is the {conversation_id} PATH segment, not in the body.
// No token usage is exposed → estimate only. DOM UNVERIFIED — Kimi uses hashed
// CSS classes that rotate per deploy.
export const kimiAdapter: PlatformAdapter = {
  platformId: "kimi",
  displayName: "Kimi",
  host: "www.kimi.com",
  completionUrl: "*://www.kimi.com/api/chat/*/completion/stream",
  matchPattern: "*://www.kimi.com/*",
  contextLimit: 200_000, // approximate (Moonshot long-context); overridable
  parseRequest(body, url) {
    const b = body as { messages?: Array<{ content?: unknown }> } | null;
    const content = b?.messages?.[0]?.content;
    const prompt = typeof content === "string" ? content : null;
    const m = url.match(/\/api\/chat\/([^/?#]+)\/completion\/stream/);
    return { prompt, dialogueId: m ? m[1] : null };
  },
  answerSelector: '.chat-content-item-assistant [class*="markdown"]',
  userSelector: ".chat-content-item-user",
  conversationSelector: "[role='main'], main",
};
