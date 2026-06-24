import type { PlatformAdapter } from "../utils/platform-adapter";

// 通义千问 consumer chat — request CONFIRMED live (2026-06):
//   POST https://chat2.qianwen.com/api/v2/chat?...
//   body: { messages: [{ content: "1+1等于几", ... }], session_id: "...", ... }
// i.e. prompt = messages[0].content (a plain string), dialogueId = session_id.
// The page SPA is served from www.qianwen.com but the send-request goes to
// chat2.qianwen.com (API host ≠ page host, so host_permissions needs both).
//
// DOM CONFIRMED live (2026-06): each message is wrapped in a
// `message-select-wrapper-{question|answer}-<hash>` container (hash rotates
// per build, so match on the prefix). AI reply markdown renders inside
// `.answer-common-card .qk-markdown`; user text sits in `.question-text-card`.
export const qianwenAdapter: PlatformAdapter = {
  platformId: "qianwen",
  displayName: "通义千问",
  // API host (the send-request target); page host is www.qianwen.com.
  host: "chat2.qianwen.com",
  completionUrl: "*://chat2.qianwen.com/api/v2/chat*",
  matchPattern: "*://www.qianwen.com/*",
  contextLimit: 131_072, // ~128K; overridable
  // Live-confirmed (2026-06): the `-question`/`-answer` prefix is stable even
  // though the trailing hash (`-oonUAN`) rotates per build.
  // Delete endpoint: CONFIRMED live (2026-06). The delete API rides a
  // DIFFERENT host than send: chat2-api.qianwen.com (send → chat2.qianwen.com).
  // deleteHost declares it so the delete-listener can dispatch. Body is the
  // batch shape {"session_ids":["<id>"]} (array even for a single delete).
  deleteHost: "chat2-api.qianwen.com",
  deleteUrl: "*://chat2-api.qianwen.com/api/v1/session/delete/batch*",
  parseDelete(rawBody) {
    try {
      const b = JSON.parse(rawBody) as { session_ids?: unknown } | null;
      // Batch endpoint: take the first id (we only delete one local record per
      // request; the web app sends a 1-element array for a single-chat delete).
      if (!Array.isArray(b?.session_ids)) return null;
      const first = b!.session_ids[0];
      return typeof first === "string" ? first : null;
    } catch {
      return null;
    }
  },
  dialogueIdFromUrl(url) {
    try {
      return new URL(url).pathname.match(/\/chat\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  },
  answerSelector: "[class*='message-select-wrapper-answer'] .qk-markdown",
  userSelector:
    "[class*='message-select-wrapper-question'] .question-text-card",
  conversationSelector: ".chat-container-wrapper, [class*='chat-round'], main",
};
