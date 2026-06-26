import type { HistoryRound, PlatformAdapter } from "../utils/platform-adapter";
import { DEFAULT_COEFFICIENTS } from "../utils/estimate";

// Gemini — the ONLY platform without a usable history API (investigated live
// 2026-06). Every Gemini RPC folds into POST /_/BardChatUi/data/batchexecute?
// rpcids=<name> with a nested-array `f.req` body — Google's internal RPC
// serialization (position-based, index-unstable, reshuffled at Google's
// discretion). Unlike DeepSeek/Kimi/ChatGPT's structured JSON, it cannot be
// parsed reliably, so there is no history-authoritative path here. BOTH prompt
// + answer therefore come from the DOM. This is a KNOWN, deliberate fallback,
// not a gap to close later — it is the only option.
//
// The DOM selectors use Gemini's WEB-COMPONENT custom-element TAG NAMES
// (<chat-window>, <model-response>, <user-query>), NOT hashed CSS classes.
// CONFIRMED live (2026-06): <chat-window> is present in the DOM; <user-query>
// and <model-response> appear one-per-turn inside it. Custom-element tag names
// are part of Gemini's component API contract and are far more stable than the
// Tailwind classes on other platforms — the original "all selectors unverified"
// caveat only ever applied to class-based selectors, which we don't use.
// Within <user-query> the prompt text lives in `.query-text-line` (NOT the
// element's textContent — that also captures a visually-hidden "你说"
// screen-reader label that prefixes every prompt). Within <model-response> the
// reply lives in `.markdown`. (Landmine: spec 001 踩坑 B — <chat-window> uses
// an <infinite-scroller> that virtualizes. A moderate chat (10 rounds, verified
// live 2026-06) mounts fully; only an exceptionally long chat truncates to the
// scrolled-in portion. We read what's mounted and accept the truncation — the
// union-merge in 003 still counts earlier rounds the engine has already seen.)
export const geminiAdapter: PlatformAdapter = {
  platformId: "gemini",
  displayName: "Gemini",
  host: "gemini.google.com",
  completionUrl:
    "*://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  matchPattern: "*://gemini.google.com/*",
  contextLimit: 1_048_576, // 1M (1 << 20); overridable
  tokenCoefficients: DEFAULT_COEFFICIENTS, // v1 default; calibrate in spec 004
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
  // Gemini writes the conversation title into document.title as
  // "<title> - Google Gemini" (CONFIRMED live 2026-06: a real conversation
  // showed "Git 分支集成与工作流流派 - Google Gemini"). The home / new-chat
  // page stays the bare "Google Gemini" with no conversation title. Strip the
  // trailing brand; return null when only the bare brand remains or the title
  // IS the bare brand (DeepSeek-style).
  dialogueTitleFromDoc(doc) {
    const raw = doc.title?.trim();
    if (!raw) return null;
    // Bare home-page brand — no conversation title to extract.
    if (/^google\s+gemini$/i.test(raw)) return null;
    return raw.replace(/\s*[-–—]\s*Google\s+Gemini\s*$/i, "").trim() || null;
  },
  // History: DOM-ONLY fallback (no history API — see file header). Reads the
  // currently-mounted turns from <chat-window> and pairs each <user-query> with
  // the <model-response> that follows it. Runs in the content script, reading
  // document directly (dialogueId is unused — the page IS the conversation).
  //
  // SPA-SWITCH RACE (verified live 2026-06): switching conversations via the
  // sidebar changes the URL + title within ~300ms but the <chat-window> DOM
  // lags — there is a ~300-900ms window where the new conversation's id is in
  // the URL but ZERO turns are mounted (the old ones were cleared, the new ones
  // not yet rendered). Because the content script's URL poll fires immediately
  // on change, fetchHistory can land in that gap and read 0 turns → returns []
  // → no HISTORY_PARSED → the panel briefly shows the PRIOR conversation's
  // tally. Other platforms dodge this (their history API returns complete data
  // regardless of DOM render state); Gemini can't, being DOM-only. So when the
  // chat-window exists but no turns are mounted, we retry a few times before
  // giving up — absorbing the render gap. A genuinely empty conversation (home
  // page / new chat with no messages) has no <chat-window> user-query at all
  // and is reached only via the home page, which has no dialogue id, so
  // fetchHistory isn't called there.
  async fetchHistory(_dialogueId) {
    try {
      return await readGeminiHistoryWithRetry(document);
    } catch {
      // DOM read failure — the next open / switch / round-completion re-reads
      return [];
    }
  },
  answerSelector: "model-response .markdown",
  userSelector: "user-query .query-text-line",
  conversationSelector: "chat-window",
};

/** A DOM turn already reduced to its kind + readable text (input to pairing). */
export interface GeminiTurn {
  kind: "user" | "model";
  text: string;
  /** The turn-wrapper <div id="<16-hex>"> ancestor (user turns only) — Gemini's
   *  stable per-turn identity (verified stable across reload, build-independent),
   *  used as the union-merge key. */
  wrapperId?: string;
}

/**
 * Read the mounted conversation DOM into ASCENDING rounds. Gemini renders turns
 * as a flat sequence of <user-query> and <model-response> custom elements inside
 * <chat-window>; we walk them in document order and pair each user query with
 * the next model response. The prompt text lives in `.query-text-line` inside
 * <user-query> (NOT element.textContent — that also captures a
 * `cdk-visually-hidden` screen-reader label "你说" that prefixes every prompt,
 * confirmed live 2026-06). The reply markdown lives in `.markdown` inside
 * <model-response>.
 *
 * CAVEAT (spec 001 踩坑 B): <chat-window> uses an <infinite-scroller> that
 * virtualizes very long chats. In practice a moderate conversation (10 rounds)
 * mounts fully; only an exceptionally long chat truncates to the scrolled-in
 * portion (verified live 2026-06). This therefore MAY under-count a very long
 * chat on first open. The 003 union-merge still preserves earlier rounds the
 * engine counted on a prior open, so the round count is monotonic across opens.
 * This is the accepted cost of Gemini having no parseable history API.
 * Defensive: never throws.
 */
function parseGeminiDom(doc: Document): HistoryRound[] {
  const root = doc.querySelector("chat-window");
  if (!root) return [];
  // querySelectorAll returns elements in DOCUMENT order; collect the readable
  // turns (DOM-read) and defer the user→model pairing to pairGeminiTurns
  // (pure logic, unit-tested).
  const turns: GeminiTurn[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (tag === "user-query") {
      // Read the prompt from .query-text-line, NOT textContent — the latter
      // also grabs the visually-hidden "你说" screen-reader label.
      const text = el.querySelector(".query-text-line")?.textContent?.trim();
      if (text) {
        // Walk up to the turn-wrapper <div id="<16-hex>"> — Gemini's stable
        // per-turn identity (the union-merge key), distinct from Angular's
        // build-rotating _ngcontent-ng-c… hashes.
        let wrapperId: string | undefined;
        let p: Element | null = el;
        for (let k = 0; k < 6 && p; k++) {
          if (p.tagName === "DIV" && /^[0-9a-f]{16}$/.test(p.id || "")) {
            wrapperId = p.id;
            break;
          }
          p = p.parentElement;
        }
        turns.push({ kind: "user", text, wrapperId });
      }
    } else if (tag === "model-response") {
      const text = el.querySelector(".markdown")?.textContent?.trim();
      if (text) turns.push({ kind: "model", text });
    }
  }
  return pairGeminiTurns(turns);
}

/**
 * Read the chat-window DOM, retrying briefly when it is mid-render (empty).
 * During an SPA conversation switch Gemini clears the old turns and mounts the
 * new ones ~300-900ms later; an immediate read in that gap returns []. We
 * distinguish "mid-render" (chat-window present, zero turns) from "done" by
 * the presence of <chat-window>: if it exists but parseGeminiDom yielded
 * nothing, the new conversation's DOM probably hasn't mounted yet → wait and
 * retry. Bounded retries so a genuinely broken page can't hang us.
 */
async function readGeminiHistoryWithRetry(
  doc: Document,
  retries = 4,
  delayMs = 250,
): Promise<HistoryRound[]> {
  for (let attempt = 0; ; attempt++) {
    const rounds = parseGeminiDom(doc);
    // Got turns → done. Also stop if there's no <chat-window> at all (not on a
    // conversation page) or we're out of retries — return whatever we have.
    const hasChatWindow = !!doc.querySelector("chat-window");
    if (rounds.length > 0 || !hasChatWindow || attempt >= retries) {
      return rounds;
    }
    // Empty chat-window mid-switch — wait for the SPA to mount the new turns.
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * Pair a document-order list of Gemini turns into ASCENDING rounds. Each
 * <user-query> is paired with the IMMEDIATELY-FOLLOWING <model-response> (if
 * any). Split out from parseGeminiDom so the pairing logic is unit-testable
 * without a DOM (vitest runs in node). A trailing user with no reply still
 * produces a round (answerText:"") — a just-sent prompt mid-reply.
 */
export function pairGeminiTurns(turns: GeminiTurn[]): HistoryRound[] {
  if (!Array.isArray(turns)) return [];
  const rounds: HistoryRound[] = [];
  let order = 0;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].kind !== "user") continue;
    const promptText = turns[i].text;
    let answerText = "";
    if (i + 1 < turns.length && turns[i + 1].kind === "model") {
      answerText = turns[i + 1].text;
    }
    if (promptText || answerText) {
      order++;
      // messageId = the turn-wrapper's stable hex id (fallback to a positional
      // id only if the wrapper couldn't be read); order = DOM sequence
      // (chronological). Display n is assigned post-merge (003).
      rounds.push({
        messageId: turns[i].wrapperId || `gemini:${order}`,
        order,
        promptText,
        answerText,
      });
    }
  }
  return rounds;
}
