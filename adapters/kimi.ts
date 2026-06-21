import type { PlatformAdapter } from "../utils/platform-adapter";

// Kimi — request CONFIRMED live 2026-06. Kimi migrated OFF the legacy
// /api/chat/{id}/completion/stream REST path to a Connect-RPC (gRPC-gateway)
// send: POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat,
// content-type application/connect+json (its body carries flag/length bytes
// before the `{`, which the background strips before parsing). The prompt lives
// in message.blocks[0].text.content and the dialogue id is the top-level
// `chat_id` — present for sends into an EXISTING chat, ABSENT on the first send
// of a brand-new chat (the server assigns it; the SPA then updates the URL to
// /chat/{id}). So round 1 of a new chat has no request-carried dialogueId and
// gets no per-dialogue Upstash key until round 2 — known gap.
// DOM selectors CONFIRMED live 2026-06: .chat-content-item-assistant wraps a
// .markdown-container > .markdown; .chat-content-item-user carries the prompt.
export const kimiAdapter: PlatformAdapter = {
  platformId: "kimi",
  displayName: "Kimi",
  host: "www.kimi.com",
  completionUrl: "*://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
  matchPattern: "*://www.kimi.com/*",
  contextLimit: 200_000, // approximate (Moonshot long-context); overridable
  parseRequest(body) {
    const b = body as {
      chat_id?: unknown;
      message?: { blocks?: Array<{ text?: { content?: unknown } }> };
    } | null;
    const content = b?.message?.blocks?.[0]?.text?.content;
    const prompt = typeof content === "string" ? content : null;
    const dialogueId = typeof b?.chat_id === "string" ? b.chat_id : null;
    return { prompt, dialogueId };
  },
  // Kimi chat URLs: https://www.kimi.com/chat/<id> (home = "/?chat_enter_method=…").
  dialogueIdFromUrl(url) {
    try {
      return new URL(url).pathname.match(/\/chat\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  },
  answerSelector: '.chat-content-item-assistant [class*="markdown"]',
  userSelector: ".chat-content-item-user",
  conversationSelector: "[role='main'], main",
};
