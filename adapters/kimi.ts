import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import type { TokenCoefficients } from "../utils/estimate";

/**
 * Measured against Kimi's open tiktoken vocab — exact (spec 004 §4.3;
 * scripts/calibrate-hf.mjs). Web default is K3 since 2026-07-16, and K3's
 * open weights ship the byte-identical vocab file the coefficients were
 * fitted on (md5-verified 2026-08-20). Kimi pre-tokenizes [\p{Han}]+
 * separately, so Chinese is ultra-cheap while non-Latin words run
 * ~2.8 tok/word.
 */
const KIMI_COEFFICIENTS: TokenCoefficients = {
  cjk: 0.57,
  kana: 0.84,
  hangul: 0.97,
  cyrillic: 2.78,
  arabic: 2.78,
  latin: 1.3,
};

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
//   body: {chat_id, page_size} → {messages:[...]} (array, NEW→OLD). The
//   server returns the WHOLE conversation in one shot — there is NO pagination
//   field on the response (no nextPageToken / hasMore), so a single request
//   suffices (same as DeepSeek; verified against a multi-round chat 2026-06).
//   Tree-linked via parentId: each assistant's parentId → the user it answers.
//   The body is in blocks[]; blocks with a `text` field carry reply/prompt
//   content — `think`/`stage` blocks are reasoning and dropped, but `tool`
//   blocks ARE counted into toolText (spec 005: args + searchResult title/
//   snippet via joinKimiToolBlocks).
//   Auth = Bearer JWT read from localStorage.access_token (DeepSeek-style 踩坑 C).
//   NOTE: a failed assistant (e.g. REASON_COMPLETION_OVERLOADED) has only an
//   `exception` block, no `text` → skip it; the user re-sent, so the retry's
//   assistant still pairs with a later sibling via parentId.
// DOM selectors CONFIRMED live 2026-06: .chat-content-item-assistant wraps a
// .markdown-container > .markdown; .chat-content-item-user carries the prompt.
// Kimi uses a tree structure: every conversation has one system root node,
// so the message count is always odd (1 + 2N for N rounds). A round has
// 3–5 messages after counting think/tool blocks, so 100 rounds easily exceed
// 300–500 messages. The ListMessages API has no pagination — it returns
// everything in one shot — so page_size must be large enough to cover the
// longest realistic conversation. 9999 is effectively "unlimited."
const HISTORY_PAGE_SIZE = 9999;

export const kimiAdapter: PlatformAdapter = {
  platformId: "kimi",
  displayName: "Kimi",
  host: "www.kimi.com",
  completionUrl: "*://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
  matchPattern: "*://www.kimi.com/*",
  contextLimit: 1_048_576, // 1M — K3 default (2026-07-16) (1 << 20); overridable
  tokenCoefficients: KIMI_COEFFICIENTS, // spec 004 §4.3 calibrated (incl. markdown overhead)
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
          body: JSON.stringify({
            chat_id: dialogueId,
            page_size: HISTORY_PAGE_SIZE,
          }),
        },
      );
      if (!res.ok) return [];
      return parseKimiHistory(await res.json());
    } catch {
      // network/parse failure — the next open / switch / round-completion re-fetches
      return [];
    }
  },
  // POST /apiv2/kimi.chat.v1.ChatService/ListChats → {chats, nextPageToken}.
  // Token-based pagination. Used by zombie cleanup (spec 003).
  async fetchConversationList() {
    const token = readKimiToken();
    if (!token) return [];
    try {
      const ids: string[] = [];
      let pageToken = "";
      while (true) {
        const res = await fetch(
          "https://www.kimi.com/apiv2/kimi.chat.v1.ChatService/ListChats",
          {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(pageToken ? { page_token: pageToken } : {}),
          },
        );
        if (!res.ok) break;
        const json = (await res.json()) as {
          chats?: Array<{ id?: string }>;
          nextPageToken?: string;
        };
        for (const c of json.chats ?? []) {
          if (typeof c.id === "string") ids.push(c.id);
        }
        pageToken = json.nextPageToken ?? "";
        if (!pageToken) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      return ids;
    } catch {
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
  /**
   * Tool-call block (spec 005): web_search carries `args` (queries JSON) and
   * `contents[].searchResult.base.{title,snippet}` — the search-result text
   * injected into the model's context. CONFIRMED live 2026-08-14.
   */
  tool?: {
    name?: string;
    args?: string;
    contents?: Array<{
      searchResult?: { base?: { title?: string; snippet?: string } };
    }>;
  };
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
 * answers → that pair = one round. A message's body is in blocks[]; blocks
 * with a `text` field carry the reply/prompt; `tool` blocks carry the
 * web-search results (spec 005) which we join into toolText. `think`/`stage`
 * blocks are reasoning/markers and are dropped. A failed assistant (no text
 * block, e.g. REASON_COMPLETION_OVERLOADED) is skipped; its retry pairs with a
 * later sibling. Rounds are sorted ascending by createTime. Defensive: a
 * missing/foreign shape → []; never throws.
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
    parentId: string;
    promptText: string;
    answerText: string;
    toolText: string;
  }[] = [];
  // Track which user ids have a text-containing assistant → those are paired.
  const pairedUsers = new Set<string>();
  for (const m of messages) {
    if (m?.role !== "assistant") continue;
    if (typeof m.id !== "string") continue;
    const answerText = joinKimiTextBlocks(m.blocks);
    if (!answerText) continue; // no text → handle in second pass
    const parent =
      typeof m.parentId === "string" ? byId.get(m.parentId) : undefined;
    if (!parent) continue;
    pairedUsers.add(parent.id!);
    staged.push({
      ts: typeof m.createTime === "string" ? m.createTime : "",
      assistantId: m.id,
      parentId: parent.id!,
      promptText: joinKimiTextBlocks(parent.blocks),
      answerText,
      toolText: joinKimiToolBlocks(m.blocks),
    });
  }
  // Second pass: assistants without text whose parent user was NOT paired
  // by a text-containing assistant. This covers user-stopped-generation where
  // the model produced no content — the user's prompt still counts as a round
  // (answerTokens = 0). A tool-only assistant whose parent IS paired (the
  // text reply exists elsewhere in the tree) still contributes its search
  // text: merge it into that parent's round instead of dropping it.
  for (const m of messages) {
    if (m?.role !== "assistant") continue;
    if (typeof m.id !== "string") continue;
    if (joinKimiTextBlocks(m.blocks)) continue; // already handled above
    const parentId = typeof m.parentId === "string" ? m.parentId : undefined;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) continue;
    const toolText = joinKimiToolBlocks(m.blocks);
    if (pairedUsers.has(parentId)) {
      if (toolText) {
        // Multi-step browsing runs several sequential searches within one
        // turn — each round-trip is its own assistant message, all sharing
        // the same parent. Spec 005: ALL invocations in one turn are joined
        // into that round's toolText. Corner: in a regenerate tree the OLD
        // attempt's tool messages share the parent too, so the old search
        // text rides the newest revision's round — a deliberate
        // approximation (the API exposes no attempt scope); a drop would be
        // worse than the misattribution.
        const target = staged.find((s) => s.parentId === parentId);
        if (target) {
          target.toolText = target.toolText
            ? `${target.toolText}\n${toolText}`
            : toolText;
        }
      }
      continue;
    }
    // Unpaired user — this assistant is the only reply, even if empty.
    staged.push({
      ts: typeof m.createTime === "string" ? m.createTime : "",
      assistantId: m.id,
      parentId,
      promptText: joinKimiTextBlocks(parent.blocks),
      answerText: "",
      toolText,
    });
  }
  // Order rounds chronologically (oldest first). createTime is an ISO-8601
  // string → lexicographic compare = chronological.
  staged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  // messageId = the assistant message's stable id; order = createTime epoch ms.
  return staged.map(({ assistantId, ts, promptText, answerText, toolText }) => {
    const createdAt = Date.parse(ts) || 0;
    return {
      messageId: assistantId,
      order: createdAt,
      promptText,
      answerText,
      toolText: toolText || undefined,
      createdAt,
    };
  });
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

/**
 * Join a tool block's text (spec 005): the search invocation (`args.queries`)
 * plus every result's `title` + `snippet` — the text the model actually read.
 * The invocation text is model-generated (output side); the results are
 * injected context (input side). Both ride one toolText bucket (spec 005 — the
 * invocation is ~tens of tokens, the snippets are the bulk). Empty when the
 * round had no tool call.
 */
function joinKimiToolBlocks(blocks: KimiBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    const tool = b?.tool;
    if (!tool) continue;
    if (typeof tool.args === "string" && tool.args.trim()) {
      parts.push(tool.args.trim());
    }
    for (const c of tool.contents ?? []) {
      const base = c?.searchResult?.base;
      if (!base) continue;
      const title = typeof base.title === "string" ? base.title.trim() : "";
      const snippet =
        typeof base.snippet === "string" ? base.snippet.trim() : "";
      const block = [title, snippet].filter(Boolean).join("\n");
      if (block) parts.push(block);
    }
  }
  return parts.join("\n").trim();
}
