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
  // Delete endpoint: CONFIRMED live (2026-06). ByteDance IM-protocol style:
  // POST /im/conversation/batch_del_user_conv with a deeply-nested body —
  // uplink_body.batch_delete_user_conversation_uplink_body.conversation_id is
  // a [<id>] array (the cmd/uplink/downlink envelope is ByteDance's IM framing).
  // We pluck the first (and only) id from that nested array.
  deleteUrl: "*://www.doubao.com/im/conversation/batch_del_user_conv*",
  parseDelete(rawBody) {
    try {
      const b = JSON.parse(rawBody) as {
        uplink_body?: {
          batch_delete_user_conversation_uplink_body?: {
            conversation_id?: unknown;
          };
        };
      } | null;
      const ids =
        b?.uplink_body?.batch_delete_user_conversation_uplink_body
          ?.conversation_id;
      if (!Array.isArray(ids)) return null;
      const first = ids[0];
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
  answerSelector: ".md-box-root",
  userSelector: "[class*='whitespace-pre-wrap']",
  conversationSelector: "[class*='message-list'], main",
};
