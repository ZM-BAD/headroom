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
  parseRequest(body) {
    const b = body as {
      messages?: Array<{ content?: unknown }>;
      session_id?: unknown;
    } | null;
    const content = b?.messages?.[0]?.content;
    return {
      prompt: typeof content === "string" ? content : null,
      dialogueId: typeof b?.session_id === "string" ? b.session_id : null,
    };
  },
  // Live-confirmed (2026-06): the `-question`/`-answer` prefix is stable even
  // though the trailing hash (`-oonUAN`) rotates per build.
  answerSelector: "[class*='message-select-wrapper-answer'] .qk-markdown",
  userSelector:
    "[class*='message-select-wrapper-question'] .question-text-card",
  conversationSelector: ".chat-container-wrapper, [class*='chat-round'], main",
};
