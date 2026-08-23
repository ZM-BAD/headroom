import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import type { TokenCoefficients } from "../utils/estimate";

/** Measured against tiktoken o200k_base — exact (spec 004 §4.3; scripts/calibrate-chatgpt.mjs). */
const CHATGPT_COEFFICIENTS: TokenCoefficients = {
  cjk: 0.82,
  kana: 0.78,
  hangul: 0.65,
  cyrillic: 1.77,
  arabic: 1.84,
  latin: 1.29,
};

// ChatGPT — completion CONFIRMED live (2026-07, Playwright): OpenAI moved the
// send to POST /backend-api/f/conversation (SSE; the old /backend-api/conversation
// send path is retired on current cohorts). The SSE closes when the answer
// finishes (reqEnd ≈ DOM stream end — no Doubao-style trailing window), and
// the history API is already settled at onCompleted+200ms (probed +200ms →
// +3000ms, all identical) — no settle retry needed.
//
// History API — CONFIRMED live (2026-06, Playwright):
//   GET https://chatgpt.com/backend-api/conversation/<id> → a `mapping` object
//   (a tree keyed by node id, each node = {id, message, parent, children[]}).
//   A real turn spans SEVERAL nodes: user → assistant(model_editable_context,
//   a context-injection stub with no body) → assistant(text, the real reply).
//   So pairing is NOT "user's child = answer"; we walk the children chain from
//   each user node and take the FIRST assistant whose content.content_type is
//   "text". system nodes (is_visually_hidden_from_conversation) are skipped.
//   Auth needs a Bearer JWT — cookies alone return 404 conversation_inaccessible.
//   The JWT is NOT in localStorage; fetch it from GET /api/auth/session →
//   {accessToken} (NextAuth pattern; DeepSeek-style 踩坑 C). Cookies-only on
//   that session endpoint.
// DOM UNVERIFIED: OpenAI rewrites the DOM constantly, so selectors are
// data-attr-first best-guesses — verify live in DevTools. contextLimit is the
// ChatGPT WEB free-tier instant window (openai.com pricing, 2026-08): Free
// 27K / Go·Plus·Business 54K / Pro 128K — the API's 1.05M does NOT apply to
// chatgpt.com. Tier is not detectable; default to Free, user overrides in
// settings (note rendered under the row).
export const chatgptAdapter: PlatformAdapter = {
  platformId: "chatgpt",
  displayName: "ChatGPT",
  host: "chatgpt.com",
  // The live send endpoint (2026-07). The trailing * tolerates a future query
  // string; it also matches POST /f/conversation/prepare (fires at SEND time),
  // which costs one harmless early refresh per round — history then simply
  // re-ships the pre-round state and the real completion corrects it.
  completionUrl: "*://chatgpt.com/backend-api/f/conversation*",
  // Legacy send path, kept as a second completion trigger for cohorts OpenAI
  // has not migrated to /f/. Also matched by fetchHistory's GET and
  // /conversation/init POST: the GETs are dropped by the completionMethod
  // filter (default POST) — the a6f92a9 feedback-loop fix — and init only
  // adds a redundant refresh at page load.
  continueUrl: "*://chatgpt.com/backend-api/conversation*",
  matchPattern: "*://chatgpt.com/*",
  contextLimit: 27_648, // 27K — ChatGPT web FREE-tier instant window (openai.com pricing 2026-08); overridable
  tokenCoefficients: CHATGPT_COEFFICIENTS, // spec 004 §4.3 calibrated (incl. markdown overhead)
  // Delete endpoint: CONFIRMED live (2026-06). ChatGPT soft-deletes via
  // PATCH /backend-api/conversation/<id> (not a real DELETE) — body is a
  // {is_visible:false} flag, id rides in the URL path. deleteMethod:"PATCH"
  // disambiguates from the send POST that hits the same /backend-api/conversation
  // prefix (send ends at /conversation with no trailing id).
  deleteUrl: "*://chatgpt.com/backend-api/conversation/*",
  deleteMethod: "PATCH",
  parseDelete(_rawBody, url) {
    try {
      const m = new URL(url).pathname.match(
        /\/backend-api\/conversation\/([^/?#]+)/,
      );
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
  // ChatGPT writes the conversation title directly into document.title (no
  // brand suffix). This is the stable source.
  dialogueTitleFromDoc(doc) {
    const raw = doc.title?.trim();
    // "ChatGPT" is the home/new-chat title — not a conversation title.
    if (!raw || raw === "ChatGPT") return null;
    return raw;
  },
  // History API: CONFIRMED live (2026-06, Playwright). GET
  // /backend-api/conversation/<id> → mapping tree. Walk each user node's
  // children chain to its first assistant text node = one round; sort by the
  // assistant's create_time. Needs a Bearer JWT fetched from /api/auth/session.
  async fetchHistory(dialogueId) {
    const token = await readChatGptToken();
    if (!token) return [];
    try {
      const res = await fetch(
        `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(dialogueId)}`,
        {
          credentials: "include",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) return [];
      return parseChatGptHistory(await res.json());
    } catch {
      // network/parse failure — the next open / switch / round-completion re-fetches
      return [];
    }
  },
  // GET /backend-api/conversations?offset=0&limit=28&order=updated → {items,
  // total}. Paginated; fetch all pages until offset ≥ total. Used by zombie
  // cleanup (spec 003).
  async fetchConversationList() {
    const token = await readChatGptToken();
    if (!token) return [];
    try {
      const ids: string[] = [];
      let offset = 0;
      const limit = 28;
      while (true) {
        const res = await fetch(
          `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated&is_archived=false&is_starred=false`,
          {
            credentials: "include",
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (!res.ok) break;
        const json = (await res.json()) as {
          items?: Array<{ id?: string }>;
          total?: number;
        };
        for (const item of json.items ?? []) {
          if (typeof item.id === "string") ids.push(item.id);
        }
        offset += limit;
        if (offset >= (json.total ?? 0)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      return ids;
    } catch {
      return [];
    }
  },
  answerSelector: '[data-message-author-role="assistant"] .markdown',
  userSelector: '[data-message-author-role="user"]',
  conversationSelector: "main",
};

/** A node in the conversation `mapping` tree. */
interface ChatGptNode {
  id?: string;
  message?: {
    author?: { role?: string };
    content?: {
      content_type?: string;
      parts?: unknown[];
      /** The invocation text on `code` nodes (e.g. `search("…")`) — CONFIRMED
       *  live 2026-08-16: code nodes carry `text`, NOT `parts`. */
      text?: string;
    };
    /** "web" on the search-call node (spec 005: content_type "code"). */
    recipient?: string;
    create_time?: number;
  } | null;
  parent?: string | null;
  children?: string[];
}
/** The GET /backend-api/conversation/<id> response shape (the parts we read). */
interface ChatGptConversationResponse {
  mapping?: Record<string, ChatGptNode>;
}

/** The GET /api/auth/session response shape (the part we read). */
interface ChatGptSessionResponse {
  accessToken?: string;
}

/**
 * Read ChatGPT's access JWT. Unlike DeepSeek/Kimi, the token is NOT in
 * localStorage — it is minted by GET /api/auth/session (a NextAuth endpoint),
 * which is cookie-authenticated. Returns null when the session call fails or
 * yields no token (not logged in) → the gauge falls back to incremental capture.
 */
async function readChatGptToken(): Promise<string | null> {
  try {
    const res = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as ChatGptSessionResponse | null;
    return typeof j?.accessToken === "string" ? j.accessToken : null;
  } catch {
    return null;
  }
}

/**
 * Parse a `GET /backend-api/conversation/<id>` response into ASCENDING rounds
 * (CONFIRMED shape, 2026-06 Playwright). `mapping` is a tree keyed by node id;
 * each node has parent/children links. A real turn spans SEVERAL nodes
 * (user → assistant model_editable_context stub → assistant text), so we walk
 * each user node's children chain (BFS, shallow) and take the FIRST descendant
 * assistant whose content.content_type is "text". system nodes and the
 * model_editable_context stub have no readable text and are skipped by the
 * content_type check. Rounds are sorted ascending by the assistant's
 * create_time. Defensive: a missing/foreign shape → []; never throws.
 */
export function parseChatGptHistory(resp: unknown): HistoryRound[] {
  const mapping =
    (resp as ChatGptConversationResponse | null | undefined)?.mapping ?? {};
  if (!mapping || typeof mapping !== "object") return [];
  const staged: {
    ts: number;
    assistantId: string;
    promptText: string;
    answerText: string;
    toolText: string;
  }[] = [];
  for (const node of Object.values(mapping)) {
    if (node?.message?.author?.role !== "user") continue;
    const promptText = joinChatGptParts(node.message?.content?.parts);
    if (!promptText) continue; // empty/hidden user node — skip
    const toolText = findWebSearchCall(mapping, node.children, promptText);
    const answer = findFirstAssistantText(mapping, node.children);
    if (answer) {
      staged.push({
        ts: typeof answer.ts === "number" ? answer.ts : 0,
        assistantId: answer.id,
        promptText,
        answerText: answer.text,
        toolText,
      });
    } else {
      // No text-containing assistant found — user may have stopped
      // generation. Fall back to any assistant child (even empty).
      const any = findFirstAssistantAny(mapping, node.children);
      if (any) {
        staged.push({
          ts: any.ts,
          assistantId: any.id,
          promptText,
          answerText: "",
          toolText,
        });
      }
    }
  }
  // Order rounds chronologically (oldest first) by the reply's create_time.
  staged.sort((a, b) => a.ts - b.ts);
  // messageId = the assistant node's stable id (mapping key, survives across
  // fetches); order = create_time. Display n is assigned post-merge (003).
  return staged.map(
    ({ assistantId, ts, promptText, answerText, toolText }) => ({
      messageId: assistantId,
      order: ts,
      promptText,
      answerText,
      toolText: toolText || undefined,
      // ChatGPT create_time is epoch seconds → ms.
      createdAt: ts > 0 ? ts * 1000 : undefined,
    }),
  );
}

/**
 * Collect the web-search CALL nodes in a turn's children chain (spec 005): the
 * assistant node(s) with `content_type === "code"` and `recipient === "web"`,
 * whose `text` is the generated invocation (`search("…")`). The search RESULT
 * text is not in the conversation API (server-side, verified 2026-08-14) — only
 * the invocation counts. A turn may carry SEVERAL invocations (multi-step
 * browsing) — all are joined. Returns "" when the round had no web search.
 *
 * DEDUP (verified live 2026-08-21): the invocation embeds the FULL prompt —
 * `search("今天杭州的天气怎么样？…")` wraps the user's message verbatim, so
 * counting it as tool text re-counts the prompt (the Input == Search/Tool
 * symptom). A query that is just the prompt (possibly with a search-command
 * prefix like `@网页搜索 `) is dropped — the code node is ARCHIVED but never
 * replayed into later context (behavior probe 2026-08-24: the model cannot
 * read its own search() call on the next turn; spec 006), so the prompt text
 * occupies context exactly once and dropping is the correct accounting. A
 * query the model rewrote/expanded still counts. Literal `\uXXXX` escapes
 * (the live 2026-08-21 code-node shape) are decoded before comparing/counting.
 *
 * TURN BOUNDARY: real mappings are LINEAR chains (user1 → assistant1 → user2 →
 * assistant2 …). A user node CLOSES the current turn — its children belong to
 * the NEXT round. Walking past it misattributes the next turn's search call to
 * this round (and double-counts it on the search turn itself), so the children
 * of user nodes are never enqueued.
 */
function findWebSearchCall(
  mapping: Record<string, ChatGptNode>,
  startChildren: string[] | undefined,
  promptText: string,
): string {
  const queue = [...(startChildren ?? [])];
  const seen = new Set<string>();
  const invocations: string[] = [];
  // Decode the prompt side too: the live 2026-08-21 shape escaped ONLY the
  // code node, but both sides are decoded before compare so a payload that
  // escapes both still dedups (real characters pass through untouched).
  const decodedPrompt = decodeChatGptEscapes(promptText);
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = mapping[id];
    if (!node) continue;
    const msg = node.message;
    if (
      msg?.author?.role === "assistant" &&
      msg.recipient === "web" &&
      msg.content?.content_type === "code"
    ) {
      // Real payload (2026-08-16): the invocation lives in `content.text`
      // (`search("…")`) — `parts` is absent on code nodes.
      const text =
        typeof msg.content.text === "string" ? msg.content.text.trim() : "";
      const partsText = text || joinChatGptParts(msg.content?.parts);
      if (partsText) {
        const decoded = decodeChatGptEscapes(partsText);
        if (!isPromptDuplication(decoded, decodedPrompt)) {
          invocations.push(decoded);
        }
      }
    }
    // Turn boundary — never traverse past a user node into the next turn.
    if (msg?.author?.role !== "user") {
      if (Array.isArray(node.children)) queue.push(...node.children);
    }
  }
  return invocations.join("\n");
}

/**
 * Decode literal `\uXXXX` escape sequences. Live 2026-08-21: the code node's
 * `text` carries ESCAPED unicode (`search("今天…")` with literal
 * backslashes) while user/answer nodes carry real characters — counting the
 * escapes as latin inflates toolTokens ~2–3× (45 vs 17 measured on the same
 * round). Real characters pass through untouched.
 */
function decodeChatGptEscapes(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * True when an invocation is just `search("<query>")` whose query duplicates
 * the round's prompt (optionally with a search-command prefix such as
 * `@网页搜索 `). The prompt is already counted in promptTokens — counting it
 * again as tool text double-counts the round (the Input == Search/Tool
 * symptom). Non-`search()` shapes (e.g. `browse`) are never dropped.
 *
 * The comparison is deliberately EXACT — case/whitespace are NOT normalized.
 * A model-rewritten query must keep counting; only verbatim duplicates are
 * dropped. A near-match that slips through re-counts a few tokens (the old
 * symptom); a fuzzy match that mis-fires would silently under-count real
 * search content. Conservative direction on purpose.
 */
function isPromptDuplication(invocation: string, promptText: string): boolean {
  const q = invocation.match(/^search\("(.*)"\)$/s)?.[1];
  if (q === undefined) return false; // not a plain search() call — keep it
  // Strip a search-command prefix ("@网页搜索 ") from BOTH sides: the user
  // prompt carries it too, so `search("@网页搜索 今天有什么新闻")` with prompt
  // `@网页搜索 今天有什么新闻` is a pure duplication.
  const stripPrefix = (s: string) => s.trim().replace(/^@\S*\s*/, "");
  return stripPrefix(q) === stripPrefix(promptText);
}

/**
 * BFS down the children chain from a user node, returning the text of the
 * first assistant descendant whose content.content_type === "text". The
 * intermediate `model_editable_context` assistant node (no body) is skipped
 * because its content_type is not "text". Returns null if none found.
 */
function findFirstAssistantText(
  mapping: Record<string, ChatGptNode>,
  startChildren: string[] | undefined,
): { ts: number; text: string; id: string } | null {
  const queue = [...(startChildren ?? [])];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = mapping[id];
    if (!node) continue;
    if (node.message?.author?.role === "assistant") {
      const content = node.message?.content;
      if (content?.content_type === "text") {
        const text = joinChatGptParts(content?.parts);
        if (text) {
          return {
            id, // the assistant node's stable mapping key
            ts:
              typeof node.message?.create_time === "number"
                ? node.message.create_time
                : 0,
            text,
          };
        }
      }
      // assistant but not a text node (e.g. model_editable_context) — keep
      // walking ITS children in case the real reply is one more hop down.
    }
    // Turn boundary: a user node closes this turn — its children belong to
    // the next round. Without this, a stopped turn steals the NEXT turn's
    // answer (same cross-turn misattribution as findWebSearchCall).
    if (node.message?.author?.role !== "user") {
      if (Array.isArray(node.children)) queue.push(...node.children);
    }
  }
  return null;
}

/**
 * Like findFirstAssistantText but returns the first REAL assistant node
 * regardless of whether it has text content. Fallback when the user stopped
 * generation and the assistant node exists but has no readable text.
 *
 * The `model_editable_context` stub is NEVER a valid anchor: it is a
 * context-injection marker, not an answer, and its id differs from the answer
 * node's. A fetch landing while the answer was still generating used to anchor
 * the fallback round on the stub — the settled fetch then anchored on the
 * answer id, and unionRounds' cloud-only retention kept BOTH rounds forever
 * (the stub round double-counts the prompt; the Doubao zombie class, spec
 * 003). Skip the stub and keep walking: a real answer node (even with empty
 * parts) anchors the round on the id the settled fetch will use, so the round
 * replaces in place instead of zombifying.
 */
function findFirstAssistantAny(
  mapping: Record<string, ChatGptNode>,
  startChildren: string[] | undefined,
): { ts: number; id: string } | null {
  const queue = [...(startChildren ?? [])];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = mapping[id];
    if (!node) continue;
    if (node.message?.author?.role === "assistant") {
      if (node.message?.content?.content_type === "model_editable_context") {
        // Stub — never a valid round anchor (see above); walk past it.
        if (Array.isArray(node.children)) queue.push(...node.children);
        continue;
      }
      return {
        id,
        ts:
          typeof node.message?.create_time === "number"
            ? node.message.create_time
            : 0,
      };
    }
    // Turn boundary: a user node closes this turn — its children belong to
    // the next round (same rule as findFirstAssistantText).
    if (node.message?.author?.role !== "user") {
      if (Array.isArray(node.children)) queue.push(...node.children);
    }
  }
  return null;
}

/**
 * Join a `content.parts[]` array into a single string. Each part is usually a
 * string; some content types use objects, which we skip. Newline-joined,
 * trimmed.
 */
function joinChatGptParts(parts: unknown[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is string => typeof p === "string")
    .join("\n")
    .trim();
}
