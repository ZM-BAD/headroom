import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import type { TokenCoefficients } from "../utils/estimate";
import { joinToolResultText } from "../utils/tool-result-text";

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
// History API — DUAL-SHAPE, both live (2026-06 and 2026-10+ cohorts):
//   GET https://chatgpt.com/backend-api/conversation/<id> → a `mapping` object
//   (a tree keyed by node id, each node = {id, message, parent, children[]}).
//   OLD turn chain: user → assistant(model_editable_context, a
//   context-injection stub with no body) → assistant(text, the real reply).
//   NEW (2026-10+) chain: user → assistant(recipient "web.run", empty parts,
//   a tool marker) → role:"tool" result node(s) carrying
//   metadata.search_result_groups → assistant(thoughts) →
//   assistant(reasoning_recap) → assistant(recipient "all", text, the answer).
//   So pairing is NOT "user's child = answer"; we BFS from each user node and
//   take the FIRST real answer node (assistant + content_type "text" +
//   recipient "all"/absent). Every marker/stub (model_editable_context,
//   web.run, thoughts, reasoning_recap) is skipped — a marker id differs from
//   the settled answer id, and unionRounds' cloud-only retention would keep
//   both rounds forever (the zombie class, spec 003).
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
  // History API: DUAL-SHAPE, both live (2026-06 + 2026-10+ cohorts). GET
  // /backend-api/conversation/<id> → mapping tree. Pair each user node with a
  // real answer node (assistant + recipient all/absent + not a reasoning/stub
  // marker), preferring current_node's active branch; collect OLD code-node
  // invocations + NEW role:"tool" result title/snippet along that answer's
  // path. Sort by the answer's create_time. Needs a Bearer JWT fetched from
  // /api/auth/session.
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

/** One result entry inside a tool node's `metadata.search_result_groups`. */
interface ChatGptSearchResultEntry {
  type?: string;
  url?: string;
  title?: string;
  snippet?: string;
}
/** One domain group inside `metadata.search_result_groups` (NEW 2026-10+ shape). */
interface ChatGptSearchResultGroup {
  type?: string;
  domain?: string;
  entries?: ChatGptSearchResultEntry[];
}
/** The message metadata fields the parser reads. */
interface ChatGptMessageMetadata {
  /** Present on `role: "tool"` result nodes (NEW shape). */
  search_result_groups?: ChatGptSearchResultGroup[];
  /** Not read; documents the live tool-marker shape. */
  tool_icons?: string[];
}

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
    /** Tool marker recipient (`"web"` / `"web.run"` / connector name); "all"
     *  on normal messages. */
    recipient?: string;
    create_time?: number;
    metadata?: ChatGptMessageMetadata | null;
  } | null;
  parent?: string | null;
  children?: string[];
}
/** The GET /backend-api/conversation/<id> response shape (the parts we read). */
interface ChatGptConversationResponse {
  mapping?: Record<string, ChatGptNode>;
  /** The live branch tip; abandoned regenerate branches remain in `mapping`. */
  current_node?: string;
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
 * (DUAL-SHAPE: OLD 2026-06 + NEW 2026-10+, both confirmed live in Playwright).
 * `mapping` is a tree keyed by node id. Each user turn is paired with a REAL
 * answer node (assistant + recipient "all"/absent + not a reasoning/stub
 * marker). When `current_node` is present the active branch wins — abandoned
 * regenerate branches remain in `mapping` but are ignored; without it we fall
 * back to BFS first-match (old cohorts/tests). Tool text is collected only
 * from the node chain leading to the chosen answer. Rounds are sorted ascending
 * by the answer's create_time. Defensive: a missing/foreign shape → []; never
 * throws.
 */
export function parseChatGptHistory(resp: unknown): HistoryRound[] {
  const response = resp as ChatGptConversationResponse | null | undefined;
  const mapping = response?.mapping ?? {};
  if (!mapping || typeof mapping !== "object") return [];
  const activePath = buildChatGptActivePath(mapping, response?.current_node);
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
    // Prefer the active branch when current_node is present. Within it any real
    // answer node is a valid anchor — text, multimodal, or an empty text node
    // (stopped/mid-generation). Without current_node, fall back to the first
    // text answer, then the first real answer. No anchor ⇒ no round: never
    // anchor on a tool marker, thoughts, reasoning_recap, or
    // model_editable_context.
    const answer =
      (activePath
        ? findFirstAnswerNode(mapping, node.children, false, activePath)
        : null) ??
      findFirstAnswerNode(mapping, node.children, true) ??
      findFirstAnswerNode(mapping, node.children, false);
    if (!answer) continue;
    const toolText = collectChatGptToolInfo(mapping, answer.path, promptText);
    staged.push({
      ts: answer.ts,
      assistantId: answer.id,
      promptText,
      answerText: answer.text,
      toolText,
    });
  }
  // Order rounds chronologically (oldest first) by the reply's create_time.
  staged.sort((a, b) => a.ts - b.ts);
  // messageId = the answer node's stable id (mapping key, survives across
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
 * Collect a turn's tool text along the chosen answer path (spec 005).
 *
 * NEW shape (2026-10+, live 2026-11-08): `role: "tool"` result nodes carry
 * `metadata.search_result_groups[].entries[]` with `title` + `snippet` (~1 KB
 * each). Only the tool node's TOP-LEVEL metadata is read — the final answer
 * node repeats the turn's aggregate, and `inline_cot_expandable_content`
 * carries a different aggregate; reading either double-counts.
 *
 * OLD shape (≤2026-08): assistant nodes with a non-"all" recipient and
 * `content_type === "code"` carry the invocation in `content.text`
 * (`search("…")`); prompt-duplicate invocations are dropped (2026-08-21).
 *
 * Generic best effort: any other `role: "tool"` node falls back to non-empty
 * `content.text`/`parts`; any assistant tool-call marker with text counts as
 * an invocation. This covers connector envelopes until a payload sample lands.
 *
 * The walk is PATH-SCOPED (not descendant-wide), so an abandoned regenerate
 * branch never contributes tool text. Result text is never prompt-deduped —
 * only invocation text is.
 */
function collectChatGptToolInfo(
  mapping: Record<string, ChatGptNode>,
  turnPath: string[],
  promptText: string,
): string {
  const chunks: string[] = [];
  // Decode the prompt side too: the live 2026-08-21 shape escaped ONLY the
  // code node, but both sides are decoded before compare so a payload that
  // escapes both still dedups (real characters pass through untouched).
  const decodedPrompt = decodeChatGptEscapes(promptText);
  for (const id of turnPath) {
    const msg = mapping[id]?.message;
    if (!msg) continue;
    const role = msg.author?.role;
    if (role === "tool") {
      chunks.push(...chatGptToolResultChunks(msg));
      continue;
    }
    if (role !== "assistant") continue;
    // "all"/absent = answer/context node. Never read its metadata: the answer
    // node aggregates the turn's search results (double-count).
    if (msg.recipient == null || msg.recipient === "all") continue;
    // Private reasoning is not tool text.
    const contentType = msg.content?.content_type;
    if (
      contentType === "thoughts" ||
      contentType === "reasoning_recap" ||
      contentType === "model_editable_context"
    ) {
      continue;
    }
    // Tool-call marker. The OLD code node carries `content.text`; NEW web.run
    // markers are empty. Generic connectors may use either.
    const text =
      (typeof msg.content?.text === "string" ? msg.content.text.trim() : "") ||
      joinChatGptParts(msg.content?.parts);
    if (!text) continue;
    const decoded = decodeChatGptEscapes(text);
    if (!isPromptDuplication(decoded, decodedPrompt)) chunks.push(decoded);
  }
  return chunks.join("\n");
}

/**
 * Result text from one `role: "tool"` message. Prefer the NEW shape's
 * `metadata.search_result_groups` entries (`title + "\n" + snippet`); fall
 * back to the generic tool envelope (`content.text` / string parts) when the
 * groups are absent or produce no text. Defensive: a malformed metadata shape
 * yields no chunks, never throws.
 */
function chatGptToolResultChunks(
  message: NonNullable<ChatGptNode["message"]>,
): string[] {
  const chunks: string[] = [];
  const groups = message.metadata?.search_result_groups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const entries = group.entries;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        // Result text can carry literal `\uXXXX` escapes too (same server
        // serialization quirk as the old code node) — decode before counting.
        const title =
          typeof entry.title === "string"
            ? decodeChatGptEscapes(entry.title.trim())
            : "";
        const snippet =
          typeof entry.snippet === "string"
            ? decodeChatGptEscapes(entry.snippet.trim())
            : "";
        const chunk = joinToolResultText(title, snippet);
        if (chunk) chunks.push(chunk);
      }
    }
  }
  if (chunks.length > 0) return chunks;
  // Connector/tool envelope with no search-result metadata (best effort).
  const text =
    typeof message.content?.text === "string"
      ? decodeChatGptEscapes(message.content.text.trim())
      : "";
  const fallback =
    text || decodeChatGptEscapes(joinChatGptParts(message.content?.parts));
  return fallback ? [fallback] : [];
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
 * BFS down the user node's children chain, returning the first REAL answer node
 * (see `isChatGptAnswerCandidate`). When `activePath` is provided, only nodes on
 * the current branch are eligible.
 *
 * One predicate replaces the old split between findFirstAssistantText and
 * findFirstAssistantAny. Every non-answer assistant is skipped: the OLD
 * `model_editable_context` stub, the NEW `web.run` tool marker, `thoughts`,
 * and `reasoning_recap`. This is the zombie guard — a marker's id differs from
 * the settled answer node's id, and unionRounds' cloud-only retention would
 * keep both forever (spec 003). A real answer node with empty parts (text or
 * multimodal) IS a valid anchor (`requireText=false`); the settled fetch
 * replaces it in place.
 *
 * `path` is the node-id chain from the user's child down to the anchor
 * (inclusive), reconstructed from BFS cameFrom. Tool text is collected from
 * this path only, so an abandoned regenerate branch is never counted.
 */
function findFirstAnswerNode(
  mapping: Record<string, ChatGptNode>,
  startChildren: string[] | undefined,
  requireText: boolean,
  activePath?: Set<string>,
): { ts: number; text: string; id: string; path: string[] } | null {
  const queue = [...(startChildren ?? [])];
  const seen = new Set<string>();
  const cameFrom = new Map<string, string | null>();
  for (const id of queue) cameFrom.set(id, null);
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = mapping[id];
    if (!node) continue;
    const msg = node.message;
    if (isChatGptAnswerCandidate(msg) && (!activePath || activePath.has(id))) {
      const isText = msg?.content?.content_type === "text";
      const text = isText ? joinChatGptParts(msg?.content?.parts) : "";
      if (!requireText || (isText && text)) {
        return {
          id, // the answer node's stable mapping key
          ts: typeof msg?.create_time === "number" ? msg.create_time : 0,
          text,
          path: buildChatGptPath(id, cameFrom),
        };
      }
    }
    // Turn boundary: a user node closes this turn — its children belong to
    // the next round. Never enqueue them.
    if (msg?.author?.role !== "user" && Array.isArray(node.children)) {
      for (const child of node.children) {
        queue.push(child);
        if (!cameFrom.has(child)) cameFrom.set(child, id);
      }
    }
  }
  return null;
}

/**
 * A real answer anchor: `assistant` + normal recipient ("all"/absent),
 * excluding the known non-answer content types. Text, multimodal
 * (image/canvas), and empty answer nodes all qualify; `requireText` decides
 * whether the caller needs readable text.
 */
function isChatGptAnswerCandidate(message: ChatGptNode["message"]): boolean {
  if (message?.author?.role !== "assistant") return false;
  if (message.recipient != null && message.recipient !== "all") return false;
  const contentType = message.content?.content_type;
  return (
    contentType !== "model_editable_context" &&
    contentType !== "thoughts" &&
    contentType !== "reasoning_recap"
  );
}

/**
 * Build the active branch from `current_node` back to the root. ChatGPT keeps
 * abandoned regenerate branches in `mapping`; only this chain is live. Returns
 * undefined when the response has no current_node (older cohorts / synthetic
 * fixtures) so callers fall back to BFS first-match.
 */
function buildChatGptActivePath(
  mapping: Record<string, ChatGptNode>,
  currentNode: unknown,
): Set<string> | undefined {
  if (typeof currentNode !== "string" || !currentNode) return undefined;
  const path = new Set<string>();
  let cur: string | undefined = currentNode;
  while (cur && !path.has(cur)) {
    path.add(cur);
    cur = mapping[cur]?.parent ?? undefined;
  }
  return path;
}

/** Reconstruct the BFS path `[firstChild … anchor]` from `cameFrom`. */
function buildChatGptPath(
  id: string,
  cameFrom: Map<string, string | null>,
): string[] {
  const path: string[] = [];
  let cur: string | null | undefined = id;
  while (cur != null) {
    path.push(cur);
    cur = cameFrom.get(cur) ?? null;
  }
  return path.reverse();
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
