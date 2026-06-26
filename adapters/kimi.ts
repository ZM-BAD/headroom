import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import { DEFAULT_COEFFICIENTS } from "../utils/estimate";

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
//
// History API — CONFIRMED live (2026-06, Playwright):
//   POST https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages
//   body: {chat_id, page_size:200} → {messages:[...]} (array, NEW→OLD). The
//   server returns the WHOLE conversation in one shot — there is NO pagination
//   field on the response (no nextPageToken / hasMore), so a single request
//   suffices (same as DeepSeek; verified against a multi-round chat 2026-06).
//   Tree-linked via parentId: each assistant's parentId → the user it answers.
//   The body is in blocks[]; only blocks with a `text` field carry reply/prompt
//   content — `think`/`tool`/`stage` blocks are reasoning/search and dropped.
//   Auth = Bearer JWT read from localStorage.access_token (DeepSeek-style 踩坑 C).
//   NOTE: a failed assistant (e.g. REASON_COMPLETION_OVERLOADED) has only an
//   `exception` block, no `text` → skip it; the user re-sent, so the retry's
//   assistant still pairs with a later sibling via parentId.
// DOM selectors CONFIRMED live 2026-06: .chat-content-item-assistant wraps a
// .markdown-container > .markdown; .chat-content-item-user carries the prompt.
export const kimiAdapter: PlatformAdapter = {
  platformId: "kimi",
  displayName: "Kimi",
  host: "www.kimi.com",
  completionUrl: "*://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
  matchPattern: "*://www.kimi.com/*",
  contextLimit: 262_144, // 256K (1 << 18); overridable
  tokenCoefficients: DEFAULT_COEFFICIENTS, // v1 default; calibrate in spec 004
  // Delete endpoint: CONFIRMED live (2026-06). Same gRPC-Gateway style as
  // send: POST /apiv2/kimi.chat.v1.ChatService/DeleteChat, body {"chat_id":"<id>"}
  // (singular — the dialogue id field is the same name as in the send body).
  deleteUrl: "*://www.kimi.com/apiv2/kimi.chat.v1.ChatService/DeleteChat",
  parseDelete(rawBody) {
    try {
      const b = JSON.parse(rawBody) as { chat_id?: unknown } | null;
      return typeof b?.chat_id === "string" ? b.chat_id : null;
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
  // Kimi writes the conversation title into document.title as "<title> - Kimi".
  // This is the stable source (DeepSeek-style) — strip the trailing brand.
  dialogueTitleFromDoc(doc) {
    const raw = doc.title?.trim();
    if (!raw) return null;
    return raw.replace(/\s*[-—]\s*Kimi\s*$/i, "").trim() || null;
  },
  // History API: CONFIRMED live (2026-06, Playwright). POST
  // /apiv2/.../ChatService/ListMessages → messages[] (tree-linked, NEW→OLD).
  // Pair each assistant (that has a text block) with its parent user, sort
  // ascending by createTime. Cookies + Bearer JWT (localStorage.access_token).
  async fetchHistory(dialogueId) {
    const token = readKimiToken();
    if (!token) return [];
    try {
      const res = await fetch(
        "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ chat_id: dialogueId, page_size: 200 }),
        },
      );
      if (!res.ok) return [];
      return parseKimiHistory(await res.json());
    } catch {
      // network/parse failure — the next open / switch / round-completion re-fetches
      return [];
    }
  },
  answerSelector: '.chat-content-item-assistant [class*="markdown"]',
  userSelector: ".chat-content-item-user",
  conversationSelector: "[role='main'], main",
};

/** A content block — only the variants we inspect. */
interface KimiBlock {
  text?: { content?: string };
}
/** A row in the ListMessages `messages` array. */
interface KimiMessage {
  id?: string;
  role?: string;
  parentId?: string;
  createTime?: string;
  blocks?: KimiBlock[];
}
/** The ListMessages response shape (the parts we read). */
interface KimiHistoryResponse {
  messages?: KimiMessage[];
}

/**
 * Read Kimi's access JWT from the page's localStorage (`access_token` key, a
 * bare JWT string — captured 2026-06). Content scripts share the page's
 * localStorage. Returns null when absent (not logged in) → the gauge falls
 * back to incremental capture.
 */
function readKimiToken(): string | null {
  try {
    const raw = localStorage.getItem("access_token");
    return raw && raw.startsWith("eyJ") ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Parse a `POST .../ChatService/ListMessages` response into ASCENDING rounds
 * (CONFIRMED shape, 2026-06 Playwright). `messages` is an array (NEW→OLD),
 * tree-linked via parentId: each assistant's parentId points at the user it
 * answers → that pair = one round. A message's body is in blocks[]; only blocks
 * with a `text` field carry readable content — `think`/`tool`/`stage` blocks
 * are reasoning/search and are dropped. A failed assistant (no text block,
 * e.g. REASON_COMPLETION_OVERLOADED) is skipped; its retry pairs with a later
 * sibling. Rounds are sorted ascending by createTime. Defensive: a missing/
 * foreign shape → []; never throws.
 */
export function parseKimiHistory(resp: unknown): HistoryRound[] {
  const messages =
    (resp as KimiHistoryResponse | null | undefined)?.messages ?? [];
  if (!Array.isArray(messages)) return [];
  // Index messages by id for parentId lookups.
  const byId = new Map<string, KimiMessage>();
  for (const m of messages) {
    if (m && typeof m.id === "string") byId.set(m.id, m);
  }
  const staged: {
    ts: string;
    assistantId: string;
    promptText: string;
    answerText: string;
  }[] = [];
  for (const m of messages) {
    if (m?.role !== "assistant") continue;
    const answerText = joinKimiTextBlocks(m.blocks);
    if (!answerText) continue; // no text block (failed/retracted) — skip
    if (typeof m.id !== "string") continue; // no stable identity — skip
    const parent =
      typeof m.parentId === "string" ? byId.get(m.parentId) : undefined;
    if (!parent) continue; // orphan assistant (no user prompt to pair) — skip
    const promptText = joinKimiTextBlocks(parent.blocks);
    staged.push({
      ts: typeof m.createTime === "string" ? m.createTime : "",
      assistantId: m.id,
      promptText,
      answerText,
    });
  }
  // Order rounds chronologically (oldest first). createTime is an ISO-8601
  // string → lexicographic compare = chronological.
  staged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  // messageId = the assistant message's stable id; order = createTime epoch ms.
  return staged.map(({ assistantId, ts, promptText, answerText }) => ({
    messageId: assistantId,
    order: Date.parse(ts) || 0,
    promptText,
    answerText,
  }));
}

/**
 * Concatenate the `content` of every block that has a `text` field
 * (newline-joined, trimmed). For a user message this is the prompt; for an
 * assistant message this is the real reply — the `think`/`tool`/`stage` blocks
 * (reasoning, web-search results, thinking markers) have no `text` field and
 * are excluded by construction.
 */
function joinKimiTextBlocks(blocks: KimiBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && typeof b.text?.content === "string")
    .map((b) => b.text!.content!)
    .join("\n")
    .trim();
}
