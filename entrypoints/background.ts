import type {
  HeadroomMessage,
  RoundCompleteMessage,
  UsageState,
} from "../utils/messages";
import { ADAPTERS } from "../adapters";
import { estimateTokens } from "../utils/tokens";
import { appendRound } from "../utils/dialogue-record";
import { dialogueKey, getDialogue, setDialogue } from "../utils/upstash";
import { getSettings } from "../utils/settings";

/**
 * Shared background engine — generic over platform adapters.
 *
 * Round lifecycle (single active conversation assumed for v1):
 *   1. webRequest sees a platform's completion request → parseRequest → store
 *      the prompt + dialogueId as a single pending slot (storage.local).
 *   2. The platform's content script detects the AI reply settled (DOM) and
 *      sends ROUND_COMPLETE with the answer text.
 *   3. We pair the pending prompt with the answer, estimate tokens, do a
 *      read-modify-write of the Upstash dialogue record (if configured), and
 *      broadcast the projected UsageState to the side panel.
 *
 * Upstash is OPTIONAL: without it the gauge still works off a local running
 * tally; with it, per-dialogue history persists across sessions.
 */

const ACTIVE_STATE_KEY = "headroom:active-state";
const PENDING_KEY = "headroom:pending";

const IDLE_STATE: UsageState = {
  platformId: null,
  contextLimit: null,
  totalTokens: 0,
  lastRoundTokens: null,
  roundCount: 0,
};

/** webRequest URL filter built from every adapter's completion match-pattern. */
const URL_FILTER = ADAPTERS.map((a) => a.completionUrl);

/**
 * Dispatch by request host (unique per platform). Avoids per-path matching so
 * variable path segments work (e.g. Kimi's `/api/chat/{id}/completion/stream`).
 */
function adapterForRequest(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return ADAPTERS.find((a) => a.host === host);
}

interface PendingPrompt {
  platformId: string;
  dialogueId: string | null;
  prompt: string;
}

async function loadActiveState(): Promise<UsageState> {
  const raw = await browser.storage.local.get(ACTIVE_STATE_KEY);
  return (raw[ACTIVE_STATE_KEY] as UsageState | undefined) ?? IDLE_STATE;
}

async function saveActiveState(state: UsageState): Promise<void> {
  await browser.storage.local.set({ [ACTIVE_STATE_KEY]: state });
}

async function setPending(p: PendingPrompt): Promise<void> {
  await browser.storage.local.set({ [PENDING_KEY]: p });
}

async function takePending(): Promise<PendingPrompt | null> {
  const raw = await browser.storage.local.get(PENDING_KEY);
  const p = raw[PENDING_KEY] as PendingPrompt | undefined;
  if (p) await browser.storage.local.remove(PENDING_KEY);
  return p ?? null;
}

async function broadcast(state: UsageState): Promise<void> {
  await browser.runtime
    .sendMessage({ type: "STATE_UPDATE", state } satisfies HeadroomMessage)
    .catch(() => {
      // No side panel open (or it's asleep) — nothing to push to.
    });
}

export default defineBackground(() => {
  // Step 1: capture each send's prompt + dialogueId as the pending slot.
  const onBeforeRequest: Parameters<
    typeof browser.webRequest.onBeforeRequest.addListener
  >[0] = (details): undefined => {
    const adapter = adapterForRequest(details.url);
    if (!adapter) return;
    const chunks = details.requestBody?.raw;
    if (!chunks?.length) return;
    let body = "";
    for (const chunk of chunks) {
      if (chunk.bytes) body += new TextDecoder().decode(chunk.bytes);
    }
    let parsed;
    try {
      parsed = adapter.parseRequest(JSON.parse(body), details.url);
    } catch {
      return; // not JSON / unexpected shape — ignore
    }
    void setPending({
      platformId: adapter.platformId,
      dialogueId: parsed.dialogueId,
      prompt: parsed.prompt ?? "",
    });
  };
  browser.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: URL_FILTER },
    ["requestBody"],
  );

  browser.runtime.onMessage.addListener(async (message: HeadroomMessage) => {
    switch (message.type) {
      case "PAGE_READY": {
        // Show platform + context immediately (before any round completes) so
        // the panel isn't blank.
        const adapter = ADAPTERS.find(
          (a) => a.platformId === message.platformId,
        );
        if (adapter) {
          const prev = await loadActiveState();
          // Reset totals when switching platform — otherwise the previous
          // platform's accumulated tokens leak into this one's gauge (H2).
          const switched = prev.platformId !== adapter.platformId;
          const state: UsageState = switched
            ? {
                platformId: adapter.platformId,
                contextLimit: adapter.contextLimit,
                totalTokens: 0,
                lastRoundTokens: null,
                roundCount: 0,
              }
            : {
                ...prev,
                platformId: adapter.platformId,
                contextLimit: adapter.contextLimit,
              };
          await saveActiveState(state);
          await broadcast(state);
        }
        return;
      }
      case "GET_STATE":
        return await loadActiveState();
      case "ROUND_COMPLETE":
        await handleRound(message);
        return;
      case "STATE_UPDATE":
        // Emitted only by this background; ignore any echoed copy.
        return;
    }
  });

  /** Steps 2–3: pair the answer with the pending prompt and record the round. */
  async function handleRound(m: RoundCompleteMessage): Promise<void> {
    const adapter = ADAPTERS.find((a) => a.platformId === m.platformId);
    if (!adapter) return;

    const answerTokens = estimateTokens(m.answerText);
    const pending = await takePending();
    // Prefer the exact request-body prompt; fall back to the DOM-scraped one
    // (platforms whose body can't be parsed, e.g. Gemini).
    const prompt = pending?.prompt || m.promptText || "";
    const dialogueId = pending?.dialogueId ?? m.dialogueId ?? null;
    const promptTokens = estimateTokens(prompt);
    const lastRoundTokens = promptTokens + answerTokens;

    let totalTokens = lastRoundTokens;
    let roundCount = 1;

    // Prefer the per-dialogue Upstash record when we have a dialogueId + creds.
    let recorded = false;
    const creds = (await getSettings()).upstash;
    if (dialogueId && creds.url && creds.token) {
      try {
        const key = dialogueKey(m.platformId, dialogueId);
        const prev = await getDialogue(creds, key);
        const next = appendRound(
          prev,
          m.platformId,
          dialogueId,
          adapter.contextLimit,
          { promptTokens, answerTokens, ts: Date.now() },
        );
        await setDialogue(creds, key, next);
        totalTokens = next.totalTokens;
        roundCount = next.roundCount;
        recorded = true;
      } catch (err) {
        // Upstash read/write failed — fall through to a local tally.
        console.warn("[Headroom] Upstash sync failed, using local tally:", err);
      }
    }
    if (!recorded) {
      // Local running tally by platform. Used when dialogueId is unknown
      // (Gemini's unparseable body, or the first message of a new chat), when
      // Upstash isn't configured, or when an Upstash op failed. Without this a
      // no-dialogueId round would reset the gauge to just that round (H1).
      const prev = await loadActiveState();
      if (prev.platformId === m.platformId) {
        totalTokens = prev.totalTokens + lastRoundTokens;
        roundCount = prev.roundCount + 1;
      }
    }

    const state: UsageState = {
      platformId: m.platformId,
      contextLimit: adapter.contextLimit,
      totalTokens,
      lastRoundTokens,
      roundCount,
    };
    await saveActiveState(state);
    await broadcast(state);
  }
});
