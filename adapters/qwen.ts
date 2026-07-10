import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import { DEFAULT_COEFFICIENTS } from "../utils/estimate";

// Qwen Chat (chat.qwen.ai) — request CONFIRMED (POST /api/v2/chat/completions
// ?chat_id=<id>). dialogueId = chat_id (URL query). `messages[0].content` may
// be a string OR an array of {type,text} blocks. SSE `usage` is often omitted
// → estimate only.
//
// History API — CONFIRMED live (2026-06, Playwright):
//   GET https://chat.qwen.ai/api/v2/chats/<id> → data.chat.history.messages,
//   an OBJECT MAP keyed by message id (not an array). Tree-linked via
//   parentId/childrenIds: each assistant's parentId points at the user message
//   it answers → that pair = one round. The assistant body lives in
//   content_list[], split into phases ("thinking_summary" + "answer"); only the
//   "answer" phase is the real reply (drop the reasoning). Auth = cookies only.
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
  contextLimit: 1_048_576, // 1M (1 << 20); overridable
  tokenCoefficients: DEFAULT_COEFFICIENTS, // v1 default; calibrate in spec 004
  // Delete endpoint: CONFIRMED live (2026-06). Real RESTful DELETE:
  // DELETE /api/v2/chats/<id> (id in the URL path, body empty). deleteMethod:
  // "DELETE" disambiguates from GET /api/v2/chats/<id> (view a single chat)
  // and from the send POST /api/v2/chat/completions (singular "chat", so the
  // deleteUrl pattern "chats" doesn't even match it).
  deleteUrl: "*://chat.qwen.ai/api/v2/chats/*",
  deleteMethod: "DELETE",
  parseDelete(_rawBody, url) {
    try {
      const m = new URL(url).pathname.match(/\/api\/v2\/chats\/([^/?#]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  },
  dialogueIdFromUrl(url) {
    try {
      return new URL(url).pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  },
  // document.title is the brand "Qwen Studio" and does NOT carry the
  // conversation title. The real title lives in GET /api/v2/chats/<id> →
  // data.title, but that is an API value, not reachable from the doc in a
  // build-stable way, so return null — the panel falls back to dialogueId.
  // Qwen doesn't put the conversation title in document.title — read it from
  // the sidebar's active chat link (.chat-item-drag-active, the highlighted row).
  dialogueTitleFromDoc(doc) {
    const el = doc.querySelector<HTMLElement>(".chat-item-drag-active");
    const text = el?.textContent?.trim();
    return text || null;
  },
  // History API: CONFIRMED live (2026-06, Playwright). GET /api/v2/chats/<id>
  // → data.chat.history.messages (an object map, tree-linked). Pair each
  // assistant with its parent user, take the "answer" phase, sort ascending by
  // assistant timestamp. Cookies-only auth. Runs in the content script
  // (same-origin → session cookies via credentials:"include").
  async fetchHistory(dialogueId) {
    try {
      const res = await fetch(
        `https://chat.qwen.ai/api/v2/chats/${encodeURIComponent(dialogueId)}`,
        { credentials: "include", headers: { source: "web" } },
      );
      if (!res.ok) return [];
      return parseQwenHistory(await res.json());
    } catch {
      // network/parse failure — the next open / switch / round-completion re-fetches
      return [];
    }
  },
  // GET /api/v2/chats/?page=1&exclude_project=true → {data:[{id,title}]}.
  // Cookie-based auth. Page-based pagination; stops when data is empty.
  async fetchConversationList() {
    try {
      const ids: string[] = [];
      let page = 1;
      while (true) {
        const res = await fetch(
          `https://chat.qwen.ai/api/v2/chats/?page=${page}&exclude_project=true`,
          { credentials: "include" },
        );
        if (!res.ok) break;
        const json = (await res.json()) as {
          success?: boolean;
          data?: Array<{ id?: string }>;
        };
        const data = json.data ?? [];
        for (const c of data) {
          if (typeof c.id === "string") ids.push(c.id);
        }
        if (data.length === 0) break;
        page++;
        await new Promise((r) => setTimeout(r, 300));
      }
      return ids;
    } catch {
      return [];
    }
  },
  answerSelector: ".qwen-chat-message-assistant .qwen-markdown",
  userSelector: ".qwen-chat-message-user",
  conversationSelector: ".chat-messages, main",
};

/** A single content phase in an assistant message's content_list. */
interface QwenContentPhase {
  phase?: string;
  content?: string;
}
/** A row in the messages object map. */
interface QwenMessage {
  role?: string;
  content?: string;
  parentId?: string | null;
  timestamp?: number;
  content_list?: QwenContentPhase[];
}
/** The GET /api/v2/chats/<id> response shape (the parts we read). */
interface QwenChatResponse {
  data?: { chat?: { history?: { messages?: Record<string, QwenMessage> } } };
}

/**
 * Parse a `GET /api/v2/chats/<id>` response into ASCENDING rounds (CONFIRMED
 * shape, 2026-06 Playwright). `messages` is an object map keyed by message id,
 * tree-linked via parentId/childrenIds; each assistant's parentId points at the
 * user message it answers → that pair is one round. The assistant body is in
 * content_list[], split into phases ("thinking_summary" + "answer") — we take
 * ONLY the "answer" phase (the reasoning is dropped; spec: estimate the real
 * reply only). Rounds are sorted ascending by the assistant's timestamp.
 * Returns TEXT only — the platform's own `usage.total_tokens` is dropped (spec:
 * tokens are always estimated, the platform's count is 004 calibration only).
 * Defensive: a missing/foreign shape → []; never throws.
 */
export function parseQwenHistory(resp: unknown): HistoryRound[] {
  const messages =
    (resp as QwenChatResponse | null | undefined)?.data?.chat?.history
      ?.messages ?? {};
  if (!messages || typeof messages !== "object") return [];
  // Build rounds keyed by the stable message id (the object-map key) with a
  // temp timestamp for ordering.
  const staged: {
    ts: number;
    assistantId: string;
    promptText: string;
    answerText: string;
  }[] = [];
  for (const [key, m] of Object.entries(messages)) {
    if (m?.role !== "assistant") continue;
    const parent =
      typeof m.parentId === "string" ? messages[m.parentId] : undefined;
    if (!parent) continue; // orphan assistant (no user prompt to pair) — skip
    staged.push({
      ts: typeof m.timestamp === "number" ? m.timestamp : 0,
      assistantId: key,
      promptText:
        typeof parent.content === "string" ? parent.content.trim() : "",
      answerText: joinQwenAnswerPhases(m.content_list),
    });
  }
  // Order rounds chronologically (oldest first); messageId = the map key, order
  // = the assistant's timestamp. Display n is assigned post-merge (003).
  staged.sort((a, b) => a.ts - b.ts);
  return staged.map(({ assistantId, ts, promptText, answerText }) => ({
    messageId: assistantId,
    order: ts,
    promptText,
    answerText,
    // Qwen timestamp is epoch seconds → ms.
    createdAt: ts > 0 ? ts * 1000 : undefined,
  }));
}

/**
 * Concatenate the `content` of every content_list phase whose `phase` is
 * "answer" (newline-joined, trimmed). The "thinking_summary" phase is the
 * model's private reasoning and is deliberately excluded — only the visible
 * reply counts toward the user's context.
 */
function joinQwenAnswerPhases(phases: QwenContentPhase[] | undefined): string {
  if (!Array.isArray(phases)) return "";
  return phases
    .filter((p) => p?.phase === "answer")
    .map((p) => (typeof p?.content === "string" ? p.content : ""))
    .join("\n")
    .trim();
}
