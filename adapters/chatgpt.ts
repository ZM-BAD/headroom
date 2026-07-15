import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import { DEFAULT_COEFFICIENTS } from "../utils/estimate";

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
// data-attr-first best-guesses — verify live in DevTools. contextLimit is an
// approximate default (GPT-4o family); overridable in settings later.
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
  contextLimit: 131_072, // 128K (1 << 17); overridable
  tokenCoefficients: DEFAULT_COEFFICIENTS, // v1 default; calibrate in spec 004
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
    content?: { content_type?: string; parts?: unknown[] };
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
  }[] = [];
  for (const node of Object.values(mapping)) {
    if (node?.message?.author?.role !== "user") continue;
    const promptText = joinChatGptParts(node.message?.content?.parts);
    if (!promptText) continue; // empty/hidden user node — skip
    const answer = findFirstAssistantText(mapping, node.children);
    if (answer) {
      staged.push({
        ts: typeof answer.ts === "number" ? answer.ts : 0,
        assistantId: answer.id,
        promptText,
        answerText: answer.text,
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
        });
      }
    }
  }
  // Order rounds chronologically (oldest first) by the reply's create_time.
  staged.sort((a, b) => a.ts - b.ts);
  // messageId = the assistant node's stable id (mapping key, survives across
  // fetches); order = create_time. Display n is assigned post-merge (003).
  return staged.map(({ assistantId, ts, promptText, answerText }) => ({
    messageId: assistantId,
    order: ts,
    promptText,
    answerText,
    // ChatGPT create_time is epoch seconds → ms.
    createdAt: ts > 0 ? ts * 1000 : undefined,
  }));
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
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  return null;
}

/**
 * Like findFirstAssistantText but returns the first assistant node regardless
 * of whether it has text content. Fallback when the user stopped generation
 * and the assistant node exists but has no readable text.
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
      return {
        id,
        ts:
          typeof node.message?.create_time === "number"
            ? node.message.create_time
            : 0,
      };
    }
    if (Array.isArray(node.children)) queue.push(...node.children);
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
