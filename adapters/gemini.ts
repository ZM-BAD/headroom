import type { PlatformAdapter } from "../utils/platform-adapter";

// Gemini — the request body is a nested-array `f.req` batchexecute payload,
// position-based and index-unstable: IMPRACTICAL to parse reliably. So BOTH
// prompt + answer come from the DOM (userSelector + answerSelector). No token
// usage is exposed to the web client → estimate only. ALL selectors UNVERIFIED
// — Gemini's classes are auto-generated and unstable.
export const geminiAdapter: PlatformAdapter = {
  platformId: "gemini",
  displayName: "Gemini",
  host: "gemini.google.com",
  completionUrl:
    "*://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  matchPattern: "*://gemini.google.com/*",
  contextLimit: 1_000_000,
  // Delete endpoint: CONFIRMED live (2026-06). Gemini folds EVERY RPC
  // (send/list/delete) into POST /_/BardChatUi/data/batchexecute, so the
  // deleteUrl pattern matches all Gemini traffic. Disambiguation happens in
  // parseDelete: only the delete RPC "GzXR5e" carries a conversation id — its
  // payload is the string '["c_<id>"]' (the c_ prefix is Gemini-internal).
  // Strip the prefix so the id matches dialogueIdFromUrl (which is bare).
  deleteUrl: "*://gemini.google.com/_/BardChatUi/data/batchexecute*",
  parseDelete(rawBody) {
    // body is form-encoded: f.req=<urlencoded JSON>&at=... — find f.req, peel
    // off the leading "f.req=" and URL-decode the value.
    const match = rawBody.match(/(?:^|&)f\.req=([^&]+)/);
    if (!match) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    // Shape: [[["<rpcName>","<payload-json-string>",null,"generic"], ...]]
    let outer: unknown;
    try {
      outer = JSON.parse(decoded);
    } catch {
      return null;
    }
    if (!Array.isArray(outer) || !Array.isArray(outer[0])) return null;
    for (const entry of outer[0] as unknown[]) {
      if (!Array.isArray(entry)) continue;
      const [rpc, payload] = entry as [unknown, unknown];
      if (rpc !== "GzXR5e") continue;
      if (typeof payload !== "string") continue;
      // payload is itself a JSON string like '["c_<id>"]'.
      let inner: unknown;
      try {
        inner = JSON.parse(payload);
      } catch {
        continue;
      }
      const first = Array.isArray(inner) ? inner[0] : undefined;
      if (typeof first !== "string") return null;
      // Strip the "c_" prefix Gemini prepends to conversation ids in the wire
      // format; dialogueIdFromUrl returns the bare id.
      return first.startsWith("c_") ? first.slice(2) : first;
    }
    return null;
  },
  // Gemini chat URLs: https://gemini.google.com/app/<id> (home = "/app", no id).
  dialogueIdFromUrl(url) {
    try {
      return new URL(url).pathname.match(/\/app\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  },
  answerSelector: "model-response .markdown",
  userSelector: "user-query",
  conversationSelector: "chat-window",
};
