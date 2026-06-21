import type {
  HeadroomMessage,
  RoundCompleteMessage,
  UsageState,
} from "../utils/messages";
import type { PlatformAdapter } from "../utils/platform-adapter";
import { ADAPTERS } from "../adapters";
import { estimateTokens } from "../utils/tokens";
import { upsertRound } from "../utils/dialogue-record";
import { tallyLocalRound, type LastRound } from "../utils/tally";
import { dialogueKey, getDialogue, setDialogue } from "../utils/upstash";
import { getSettings, type Settings } from "../utils/settings";
import { adapterForUrl, isSupportedPlatformUrl } from "../utils/match-host";

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
/**
 * Last round seen (platformId + roundId + tokens). Lets the local-tally
 * fallback de-dupe a round that re-emits as it streams — mirroring the upsert
 * the Upstash path does, so the gauge doesn't over-count even without Upstash.
 */
const LAST_ROUND_KEY = "headroom:last-round";

const IDLE_STATE: UsageState = {
  platformId: null,
  contextLimit: null,
  totalTokens: 0,
  lastRoundTokens: null,
  roundCount: 0,
  dialogueId: null,
};

/** webRequest URL filter built from every adapter's completion match-pattern. */
const URL_FILTER = ADAPTERS.map((a) => a.completionUrl);

/**
 * Dispatch by request host (unique per platform). Host-based dispatch survives
 * path migrations: Kimi, e.g., moved its send from /api/chat/{id}/completion/
 * stream to /apiv2/...ChatService/Chat, and only each adapter's completionUrl
 * filter needs to track the exact path.
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

async function getLastRound(): Promise<LastRound | null> {
  const raw = await browser.storage.local.get(LAST_ROUND_KEY);
  return (raw[LAST_ROUND_KEY] as LastRound | undefined) ?? null;
}

async function setLastRound(r: LastRound): Promise<void> {
  await browser.storage.local.set({ [LAST_ROUND_KEY]: r });
}

async function broadcast(state: UsageState): Promise<void> {
  await browser.runtime
    .sendMessage({ type: "STATE_UPDATE", state } satisfies HeadroomMessage)
    .catch(() => {
      // No side panel open (or it's asleep) — nothing to push to.
    });
}

/**
 * The context limit to use for a platform: the user's override (when it's a
 * valid positive number from settings) over the adapter's auto-detected default.
 */
function effectiveLimit(settings: Settings, adapter: PlatformAdapter): number {
  const override = settings.contextLimits[adapter.platformId];
  return typeof override === "number" &&
    Number.isFinite(override) &&
    override > 0
    ? override
    : adapter.contextLimit;
}

/**
 * Set the active state's platform + context limit to `adapter` — resetting the
 * running tally when the platform changes (don't mix one platform's tokens into
 * another's gauge) — then persist, broadcast to any open panel, and return it.
 * Shared by PAGE_READY (page load), GET_STATE (panel open), and tab activation,
 * so the panel always reflects the current tab's platform. The context limit
 * honors any user override from settings.
 */
async function applyPlatformToActiveState(
  adapter: PlatformAdapter,
  urlDialogueId: string | null = null,
): Promise<UsageState> {
  const settings = await getSettings();
  const contextLimit = effectiveLimit(settings, adapter);
  const prev = await loadActiveState();
  // Reset the tally when the platform OR the conversation (dialogueId) changes.
  // Starting / switching a chat within the same platform is an SPA route change
  // (no PAGE_READY), so without the dialogueId check the gauge would keep the
  // prior conversation's tally — the "new chat doesn't reset to 0" bug.
  const switched =
    prev.platformId !== adapter.platformId || prev.dialogueId !== urlDialogueId;
  const state: UsageState = switched
    ? {
        platformId: adapter.platformId,
        contextLimit,
        dialogueId: urlDialogueId,
        totalTokens: 0,
        lastRoundTokens: null,
        roundCount: 0,
      }
    : {
        ...prev,
        platformId: adapter.platformId,
        contextLimit,
        dialogueId: urlDialogueId,
      };
  await saveActiveState(state);
  await broadcast(state);
  return state;
}

/**
 * Sync the active state to the currently-active tab's platform and return it,
 * so the side panel always reflects the tab the user is on (model name +
 * context length). Returns the stored state unchanged when the active tab isn't
 * a supported platform.
 */
async function syncActiveStateToActiveTab(): Promise<UsageState> {
  let url: string | undefined;
  try {
    const [active] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    url = active?.url;
  } catch {
    // Tab query failed (rare) — fall back to the stored state.
  }
  const adapter = url ? adapterForUrl(url) : undefined;
  if (adapter && url) {
    return await applyPlatformToActiveState(
      adapter,
      adapter.dialogueIdFromUrl?.(url) ?? null,
    );
  }
  return await loadActiveState();
}

export default defineBackground(() => {
  void enableSidePanelOnActionClick();

  // Gray out the toolbar action on non-platform tabs so Headroom is only
  // clickable where it can actually do something. The action is enabled
  // per-tab (content scripts already only run on platform pages, but the icon
  // is global by default). We sync on tab activation + navigation; a full
  // reload of a platform tab also re-fires PAGE_READY, but that carries no
  // tabId, so the tab listeners are the source of truth for icon state.
  browser.tabs.onActivated.addListener((info) => {
    void applyPanelScope(info.tabId, {
      windowId: info.windowId,
      isActive: true,
    });
    // Keep the stored active state (+ any open panel) in step with the tab the
    // user just switched to, so the model name + context length follow the
    // active tab. onActivated is always the active tab → safe to sync here.
    void syncActiveStateToActiveTab();
  });
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    // Re-scope on navigations (URL change) + load-complete; skip title/favicon
    // churn. `tab.url` is readable for the 7 platform hosts (host_permissions)
    // and undefined elsewhere — applyPanelScope re-derives from it.
    if (change.url || change.status === "complete") {
      void applyPanelScope(tabId, {
        urlHint: tab?.url ?? change.url,
        windowId: tab?.windowId,
        isActive: tab?.active === true,
      });
    }
    // An SPA route change on the ACTIVE tab (start new chat / switch history
    // chat / navigate within the platform) changes its URL without reloading →
    // PAGE_READY won't re-fire, so re-derive the dialogue id here and reset the
    // gauge when the conversation changes.
    if (change.url && tab?.active) {
      void syncActiveStateToActiveTab();
    }
  });
  // Best-effort initial sync for already-open tabs when the service worker
  // (re)starts — covers install/enable/browser-restart without waiting for the
  // user to switch tabs.
  void syncActiveTab();

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
      // Not clean JSON: some platforms transport-frame the body — Kimi's
      // Connect-RPC envelope prefixes flag/length bytes before the `{`, so the
      // direct parse above throws even on a valid send. Retry on the outermost
      // {...} slice; bail if that's unparseable too.
      const start = body.indexOf("{");
      const end = body.lastIndexOf("}");
      if (start < 0 || end <= start) return;
      try {
        parsed = adapter.parseRequest(
          JSON.parse(body.slice(start, end + 1)),
          details.url,
        );
      } catch {
        return; // genuinely foreign shape — ignore
      }
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
          const dialogueId = adapter.dialogueIdFromUrl?.(message.url) ?? null;
          await applyPlatformToActiveState(adapter, dialogueId);
        }
        return;
      }
      case "GET_STATE":
        // Derive the platform from the active tab so opening the panel always
        // shows the current model + context length, even before any round fires.
        return await syncActiveStateToActiveTab();
      case "ROUND_COMPLETE":
        await handleRound(message);
        return;
      case "STATE_UPDATE":
        // Emitted only by this background; ignore any echoed copy.
        return;
    }
  });

  /**
   * Steps 2–3: pair the answer with the pending prompt and record the round.
   * Panel-independent: runs on every ROUND_COMPLETE whether or not the side
   * panel is open, so the tally in storage.local + Upstash accumulates even
   * with the panel closed — opening it later just GET_STATEs the accumulated
   * value.
   */
  async function handleRound(m: RoundCompleteMessage): Promise<void> {
    const adapter = ADAPTERS.find((a) => a.platformId === m.platformId);
    if (!adapter) return;

    // The conversation the gauge is currently displaying (tracked from the tab
    // URL by the sync paths). handleRound only updates the tally — it must NOT
    // change which conversation is shown, so it preserves prev.dialogueId.
    const prev = await loadActiveState();

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
    const settings = await getSettings();
    const creds = settings.upstash;
    const contextLimit = effectiveLimit(settings, adapter);
    if (dialogueId && creds.url && creds.token) {
      try {
        const key = dialogueKey(m.platformId, dialogueId);
        const prev = await getDialogue(creds, key);
        const next = upsertRound(prev, m.platformId, dialogueId, contextLimit, {
          n: m.roundId,
          promptTokens,
          answerTokens,
          ts: Date.now(),
        });
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
      const last = await getLastRound();
      // round.dialogueId is the URL-tracked ACTIVE conversation (prev.dialogueId),
      // NOT the request-body id — so two chats' round 1 (same roundId, different
      // conversation) don't dedup against each other (the C1 cross-conversation
      // mis-count).
      const tallied = tallyLocalRound(prev, last, {
        platformId: m.platformId,
        dialogueId: prev.dialogueId,
        roundId: m.roundId,
        tokens: lastRoundTokens,
      });
      totalTokens = tallied.totalTokens;
      roundCount = tallied.roundCount;
      await setLastRound({
        platformId: m.platformId,
        dialogueId: prev.dialogueId,
        roundId: m.roundId,
        tokens: lastRoundTokens,
      });
    }

    // Re-read before writing: if the active conversation changed while this
    // round was being processed (user started/switched a chat during the awaits
    // above), DON'T clobber the new state with this round's tally — it belongs
    // to a conversation the user already left. Guards the read-modify-write race
    // on storage.local (H1); the round is still persisted in Upstash if that
    // path ran, just not painted onto a gauge that's moved on.
    const current = await loadActiveState();
    if (
      current.platformId !== m.platformId ||
      current.dialogueId !== prev.dialogueId
    ) {
      return;
    }
    const state: UsageState = {
      platformId: m.platformId,
      contextLimit,
      dialogueId: prev.dialogueId,
      totalTokens,
      lastRoundTokens,
      roundCount,
    };
    await saveActiveState(state);
    await broadcast(state);
  }
});

async function enableSidePanelOnActionClick(): Promise<void> {
  if (!browser.sidePanel) return;
  try {
    await browser.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true,
    });
  } catch (error) {
    console.error("[Headroom] failed to set side panel behavior:", error);
  }
}

/**
 * Scope Headroom's toolbar action AND side panel to platform tabs only.
 *
 * The side panel is kept PURELY GLOBAL: we never call per-tab setOptions. The
 * manifest side_panel default (enabled + sidepanel.html) already makes the
 * panel openable on click as a GLOBAL panel. This is deliberate —
 * sidePanel.close({ windowId }) ONLY closes a GLOBAL panel, so if we made
 * platform panels tab-specific (via setOptions), the auto-close below would
 * silently no-op (that was the previous bug: Kimi's panel was tab-specific, so
 * close({windowId}) couldn't dismiss it on switch to Bilibili).
 *
 * On a platform tab: action enabled (colored, clickable); the global panel is
 * openable. On a non-platform tab: action disabled (grayed) AND the global
 * panel is force-closed via close({ windowId }) — Chrome 141+, we target ≥149.
 * Trade-off: the panel does NOT auto-reopen when returning to a platform tab
 * (auto-open is blocked by Chrome's user-gesture rule on sidePanel.open); the
 * user clicks the icon again. Also, with no per-tab setOptions the panel stays
 * in Chrome's side-panel dropdown on non-platform sites — accepted, since the
 * action icon is disabled there and it auto-closes on switch.
 *
 * Counting is NOT gated by any of this — the content script + handleRound run
 * on every platform page whether or not the panel is open (see handleRound).
 *
 * Platform detection needs NO `tabs` permission: `Tab.url` is populated for
 * any tab whose URL matches a host_permission (all 7 platforms are listed) and
 * is undefined for everything else (Bilibili, etc.) — read as "not supported".
 */
async function applyPanelScope(
  tabId: number,
  opts: { urlHint?: string; windowId?: number; isActive?: boolean } = {},
): Promise<void> {
  let url = opts.urlHint;
  if (!url) {
    try {
      url = (await browser.tabs.get(tabId)).url;
    } catch {
      return; // tab gone — nothing to scope
    }
  }
  const supported = url ? isSupportedPlatformUrl(url) : false;

  try {
    if (supported) await browser.action.enable(tabId);
    else await browser.action.disable(tabId);
  } catch {
    // Some contexts (Firefox without action, dev oddities) — non-fatal.
  }

  // Chrome/Edge only. Firefox has no browser.sidePanel (uses sidebar_action,
  // which is global and can't be scoped — acceptable per the playbook). Force-
  // close the global panel ONLY for the active tab — onUpdated also fires for
  // background tabs (e.g. a Bilibili tab finishing its load while you're on
  // DeepSeek), and closing on those would dismiss the panel you're looking at.
  if (
    browser.sidePanel &&
    !supported &&
    opts.windowId != null &&
    opts.isActive
  ) {
    const close = (
      browser.sidePanel as {
        close?: (o: { windowId: number }) => Promise<void>;
      }
    ).close;
    if (close) {
      try {
        await close({ windowId: opts.windowId });
      } catch (e) {
        console.warn("[Headroom] sidePanel.close failed:", e);
      }
    } else {
      console.warn("[Headroom] sidePanel.close unavailable (Chrome <141?)");
    }
  }
}

/** Sync the action state for whatever tab is currently active. */
async function syncActiveTab(): Promise<void> {
  try {
    const [active] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (active?.id) {
      await applyPanelScope(active.id, {
        urlHint: active.url,
        windowId: active.windowId,
        isActive: true,
      });
    }
  } catch {
    // Non-fatal: the onActivated listener will catch up on the next switch.
  }
}
