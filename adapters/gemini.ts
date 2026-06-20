import type { PlatformAdapter } from "../utils/platform-adapter";

// Gemini — the request body is a nested-array `f.req` batchexecute payload,
// position-based and index-unstable: IMPRACTICAL to parse reliably. So
// parseRequest returns nulls and BOTH prompt + answer come from the DOM
// (userSelector + answerSelector). No token usage is exposed to the web
// client → estimate only. ALL selectors UNVERIFIED — Gemini's classes are
// auto-generated and unstable.
export const geminiAdapter: PlatformAdapter = {
  platformId: "gemini",
  displayName: "Gemini",
  host: "gemini.google.com",
  completionUrl:
    "*://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  matchPattern: "*://gemini.google.com/*",
  contextLimit: 1_000_000,
  parseRequest() {
    return { prompt: null, dialogueId: null };
  },
  answerSelector: "model-response .markdown",
  userSelector: "user-query",
  conversationSelector: "chat-window",
};
