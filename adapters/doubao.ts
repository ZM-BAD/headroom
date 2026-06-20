import type { PlatformAdapter } from "../utils/platform-adapter";

// Doubao (豆包) — request CONFIRMED (POST /samantha/chat/completion, aliased
// as /chat/completion). messages[0].content is a STRINGIFIED JSON
// {"text":"..."}. dialogueId = local_conversation_id.
//
// DOM CONFIRMED live (2026-06): Doubao's current build dropped data-testid /
// semantic class names in favor of Tailwind utilities. The stable anchors are:
//   - AI reply markdown renders inside `.md-box-root` (Doubao's markdown
//     renderer root — stable, semantic), regardless of the surrounding
//     Tailwind layout classes.
//   - User message text sits in a `.whitespace-pre-wrap` bubble (a Tailwind
//     utility Doubao reserves for the user bubble; safe enough in-page).
//   - The conversation list root is `[class*="message-list"]` (hash-suffixed).
// Token usage streams in SSE event_type 2010 (VERBOSE) — not read in v1, so
// estimate only.
export const doubaoAdapter: PlatformAdapter = {
  platformId: "doubao",
  displayName: "豆包",
  host: "www.doubao.com",
  completionUrl: "*://www.doubao.com/chat/completion*",
  matchPattern: "*://www.doubao.com/*",
  contextLimit: 256_000, // approximate (Doubao Pro family); overridable
  parseRequest(body) {
    const b = body as {
      messages?: Array<{ content?: unknown }>;
      local_conversation_id?: unknown;
    } | null;
    const raw = b?.messages?.[0]?.content;
    let prompt: string | null = null;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as { text?: unknown };
        prompt = typeof parsed.text === "string" ? parsed.text : raw;
      } catch {
        prompt = raw; // not JSON — use as-is
      }
    }
    return {
      prompt,
      dialogueId:
        typeof b?.local_conversation_id === "string"
          ? b.local_conversation_id
          : null,
    };
  },
  answerSelector: ".md-box-root",
  userSelector: "[class*='whitespace-pre-wrap']",
  conversationSelector: "[class*='message-list'], main",
};
