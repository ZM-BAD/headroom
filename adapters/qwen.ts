import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import type { TokenCoefficients } from "../utils/estimate";

/** Measured against Qwen3.6-27B — closest open sibling of web Qwen 3.7 (spec 004 §4.3; scripts/calibrate-hf.mjs). */
const QWEN_COEFFICIENTS: TokenCoefficients = {
  cjk: 0.6,
  kana: 0.51,
  hangul: 0.54,
  cyrillic: 1.77,
  arabic: 1.71,
  latin: 1.35,
};

// Qwen Chat (chat.qwen.ai) — request CONFIRMED (POST /api/v2/chat/completions
// ?chat_id=<id>). dialogueId = chat_id (URL query). `messages[0].content` may
// be a string OR an array of {type,text} blocks. SSE `usage` is often omitted
// → estimate only.
//
// History API — CONFIRMED live (2026-08, Playwright; CHANGED from 2026-06):
//   GET https://chat.qwen.ai/api/v2/chats/<id> → data.chat.messages, an ARRAY
//   (the 2026-06 shape data.chat.history.messages — an object map — is now an
//   empty map; parse reads both, array preferred). Tree-linked via
//   parentId/childrenIds: each assistant's parentId points at the user message
//   it answers → that pair = one round. The assistant body is a top-level
//   `content` string plus `content_list[]` (phases "thinking_summary",
//   "web_search", "answer"); only the "answer" phase is the real reply (drop
//   the reasoning). Web-search text (spec 005): the "web_search" phase's
//   `extra.web_search_info[]` carries {title, snippet} per result — the text
//   injected into the model's context — joined into toolText. The phase's
//   `usage` object (server token counts) stays dropped (spec: estimate only).
//   Auth = cookies only.
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
  tokenCoefficients: QWEN_COEFFICIENTS, // spec 004 §4.3 calibrated (incl. markdown overhead)
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
      return m ? (m[1] ?? null) : null;
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
  /** Carries `web_search_info[]` ({title,snippet}) for the "web_search" phase (spec 005). */
  extra?: {
    web_search_info?: Array<{ title?: string; snippet?: string }>;
  };
}
/** A row in the messages array (2026-08) / object map (2026-06). */
interface QwenMessage {
  id?: string;
  message_id?: string;
  role?: string;
  content?: string;
  parentId?: string | null;
  timestamp?: number;
  content_list?: QwenContentPhase[];
}
/** The GET /api/v2/chats/<id> response shape (the parts we read). */
interface QwenChatResponse {
  data?: {
    chat?: {
      /** 2026-08 shape: array of messages. */
      messages?: QwenMessage[];
      /** 2026-06 shape: object map keyed by message id (now empty; kept for tolerance). */
      history?: { messages?: Record<string, QwenMessage> };
    };
  };
}

/**
 * Parse a `GET /api/v2/chats/<id>` response into ASCENDING rounds (CONFIRMED
 * shape, 2026-08 Playwright — messages is now an ARRAY at data.chat.messages;
 * the 2026-06 object-map shape at data.chat.history.messages is read as a
 * fallback). Each assistant's parentId points at the user message it answers →
 * that pair is one round. The assistant body is a top-level `content` string
 * plus content_list[] phases ("thinking_summary" + "web_search" + "answer") —
 * we take ONLY the "answer" phase (the reasoning is dropped; spec: estimate the
 * real reply only). Web-search text (spec 005) comes from the "web_search"
 * phase's extra.web_search_info[] — title + snippet per result, joined into
 * toolText. Rounds are sorted ascending by the assistant's timestamp.
 * Returns TEXT only — the platform's own `usage.total_tokens` is dropped (spec:
 * tokens are always estimated, the platform's count is 004 calibration only).
 * Defensive: a missing/foreign shape → []; never throws.
 */
export function parseQwenHistory(resp: unknown): HistoryRound[] {
  const chat = (resp as QwenChatResponse | null | undefined)?.data?.chat;
  // 2026-08 array shape first; fall back to the 2026-06 object map.
  const messages: QwenMessage[] | Record<string, QwenMessage> | undefined =
    chat?.messages;
  let asArray: QwenMessage[] | undefined;
  if (Array.isArray(messages)) {
    // A present-but-EMPTY array only wins over the map when the map is also
    // empty — a populated map must not be discarded by an empty sibling.
    const map = chat?.history?.messages;
    const mapContent =
      map && typeof map === "object" && Object.keys(map).length > 0;
    asArray = messages.length > 0 || !mapContent ? messages : undefined;
  }
  if (!asArray) {
    const map = chat?.history?.messages;
    if (map && typeof map === "object") {
      // The 2026-06 map is keyed by message id — stamp the key back onto each
      // row so the parent lookup below works uniformly.
      asArray = Object.entries(map)
        .map(([key, m]) =>
          m && typeof m === "object"
            ? ({ ...m, id: m.id ?? m.message_id ?? key } as QwenMessage)
            : undefined,
        )
        .filter((m): m is QwenMessage => !!m);
    }
  }
  if (!asArray) return [];
  // Index by stable id for O(1) parent lookups (asArray.find would be O(n²)).
  const byId = new Map<string, QwenMessage>();
  for (const m of asArray) {
    const id = m && (m.id ?? m.message_id);
    if (id && typeof id === "string") byId.set(id, m);
  }
  // Build rounds keyed by the stable message id (the object-map key) with a
  // temp timestamp for ordering.
  const staged: {
    ts: number;
    assistantId: string;
    promptText: string;
    answerText: string;
    toolText: string;
  }[] = [];
  for (const m of asArray) {
    if (m?.role !== "assistant") continue;
    const parentId = typeof m.parentId === "string" ? m.parentId : undefined;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!parent) continue; // orphan assistant (no user prompt to pair) — skip
    const answerText =
      joinQwenAnswerPhases(m.content_list) || qwenTrim(m.content);
    staged.push({
      ts: typeof m.timestamp === "number" ? m.timestamp : 0,
      // Fallback id (real API always sends `id`; fires only on a foreign
      // shape): timestamp + parent + content hash. The hash tie-breaker is
      // STABLE across fetches (same answer → same id — 003 merge key
      // invariant) AND unique for regenerates (different answer → different
      // id — no unionRounds dedup collision). An array-position counter
      // would satisfy uniqueness but drift across fetches, silently
      // duplicating rounds on every union merge. Defensive caveat: two
      // identical answers at the same ts+parent — or two empty answers
      // (hash("") = 0) — collide. Acceptable: the real API always sends
      // `id`, so this path only fires on foreign shapes.
      assistantId:
        (m.id ?? m.message_id) ||
        `qwen:${m.timestamp ?? 0}:${parentId ?? "orphan"}:${qwenContentHash(answerText)}`,
      promptText:
        typeof parent.content === "string" ? parent.content.trim() : "",
      answerText,
      toolText: joinQwenWebSearchText(m.content_list),
    });
  }
  // Order rounds chronologically (oldest first); messageId = the map key, order
  // = the assistant's timestamp. Display n is assigned post-merge (003).
  staged.sort((a, b) => a.ts - b.ts);
  return staged.map(
    ({ assistantId, ts, promptText, answerText, toolText }) => ({
      messageId: assistantId,
      order: ts,
      promptText,
      answerText,
      toolText: toolText || undefined,
      // Qwen timestamp is epoch seconds → ms.
      createdAt: ts > 0 ? ts * 1000 : undefined,
    }),
  );
}

/** Trim a string to null-able — fallback for Qwen's direct `content` string. */
/** Small stable content hash (djb2) for the fallback messageId tie-breaker —
 *  same text → same hash across fetches; different text → different hash. */
function qwenContentHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function qwenTrim(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
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

/**
 * Join the web-search phase's result text (spec 005): the "web_search" phase
 * carries `extra.web_search_info[]` — the per-result {title, snippet} the model
 * reads. Each result becomes "title\nsnippet" (newline-joined). Empty when the
 * round had no search.
 */
function joinQwenWebSearchText(phases: QwenContentPhase[] | undefined): string {
  if (!Array.isArray(phases)) return "";
  const parts: string[] = [];
  for (const p of phases) {
    if (p?.phase !== "web_search") continue;
    for (const info of p.extra?.web_search_info ?? []) {
      const title = typeof info?.title === "string" ? info.title.trim() : "";
      const snippet =
        typeof info?.snippet === "string" ? info.snippet.trim() : "";
      const block = [title, snippet].filter(Boolean).join("\n");
      if (block) parts.push(block);
    }
  }
  return parts.join("\n").trim();
}
