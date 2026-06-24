import type {
  HeadroomMessage,
  HistoryParsedMessage,
  UsageState,
} from "../utils/messages";
import type { PlatformAdapter } from "../utils/platform-adapter";
import { ADAPTERS } from "../adapters";
import { DEFAULT_COEFFICIENTS, estimateTokens } from "../utils/estimate";
import {
  emptyDialogue,
  projectUsage,
  upsertRound,
  type DialogueRecord,
} from "../utils/dialogue-record";
import { dialogueKey } from "../utils/upstash";
import { getSettings, type Settings } from "../utils/settings";
import { adapterForUrl, isSupportedPlatformUrl } from "../utils/match-host";

/**
 * Background engine — the 001 LOCAL layer, generic over platform adapters.
 *
 * The gauge projects from a per-conversation DialogueRecord stored in
 * browser.storage.local at `headroom:conv:{platform}:{dialogueId}`. That record
 * is the SINGLE local source of truth — and it is built ENTIRELY from the
 * platform's history API (adapter.fetchHistory), which returns every message's
 * stable `message_id`. The DOM is never used for round identity: DeepSeek's
 * virtual list keeps only visible messages in the DOM, so the DOM count is
 * unreliable (it was the "round 4 modifies round 2" bug).
 *
 * Round lifecycle (history is the SOLE authority):
 *   - Open / SPA switch / round-finished all trigger the SAME path: the content
 *     script fetches the full history → HISTORY_PARSED → the background
 *     REPLACES the record with the message_id-ordered, token-estimated view.
 *   - "Round finished" is detected at the ROOT CAUSE — the streaming completion
 *     response closing (webRequest onCompleted; onErrorOccurred = user stop).
 *     The new round is already in history at that moment (verified, no lag), so
 *     a fresh history fetch picks it up with its real message_id. This makes
 *     regenerate correct too (a re-answer gets a new message_id under the same
 *     parent; history reflects the current state, no over-count).
 *
 * Upstash is OPTIONAL and 003's concern. This layer never touches the cloud —
 * the gauge works purely off the local record. (The 002 transport module sits
 * unused here, to be wired by 003's reconciliation.) The delete listener keeps
 * the local gauge accurate when a conversation is deleted on the platform.
 */

/**
 * Cap on rounds shipped to the panel for the per-round breakdown. The local
 * record keeps MAX_RETAINED_ROUNDS; the wire payload is trimmed for display.
 */
const DISPLAY_ROUNDS = 50;

const IDLE_STATE: UsageState = {
  platformId: null,
  contextLimit: null,
  totalTokens: 0,
  lastRoundTokens: null,
  roundCount: 0,
  rounds: [],
};

/** webRequest URL filter built from every adapter's completion match-pattern. */
const URL_FILTER = ADAPTERS.map((a) => a.completionUrl);

/**
 * Dispatch by request host (unique per platform). Host-based dispatch survives
 * path migrations: Kimi, e.g., moved its send from /api/chat/{id}/completion/
 * stream to /apiv2/...ChatService/Chat, and only each adapter's completionUrl
 * filter needs to track the exact path.
 */
function adapterForRequest(url: string): PlatformAdapter | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return ADAPTERS.find((a) => a.host === host);
}

// --- local per-conversation record store (the gauge's source of truth) ---

async function getLocalDialogue(key: string): Promise<DialogueRecord | null> {
  const raw = await browser.storage.local.get(key);
  return (raw[key] as DialogueRecord | undefined) ?? null;
}

async function setLocalDialogue(
  key: string,
  record: DialogueRecord,
): Promise<void> {
  await browser.storage.local.set({ [key]: record });
}

async function delLocalDialogue(key: string): Promise<void> {
  await browser.storage.local.remove(key);
}

async function broadcast(state: UsageState): Promise<void> {
  await browser.runtime
    .sendMessage({ type: "STATE_UPDATE", state } satisfies HeadroomMessage)
    .catch(() => {
      // No side panel open (or it's asleep) — nothing to push to.
    });
}

/**
 * The context limit for a platform: the user's override (a valid positive
 * number from settings) over the adapter's auto-detected default.
 */
function effectiveLimit(settings: Settings, adapter: PlatformAdapter): number {
  const override = settings.contextLimits[adapter.platformId];
  return typeof override === "number" &&
    Number.isFinite(override) &&
    override > 0
    ? override
    : adapter.contextLimit;
}

async function isTabActive(tabId: number | undefined): Promise<boolean> {
  if (tabId == null) return false;
  try {
    const [active] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    return active?.id === tabId;
  } catch {
    return false;
  }
}

/** Build the wire UsageState from a projected record + platform context. */
function buildState(
  adapter: PlatformAdapter,
  contextLimit: number,
  record: DialogueRecord | null,
): UsageState {
  const proj = projectUsage(record);
  return {
    platformId: adapter.platformId,
    contextLimit,
    totalTokens: proj.totalTokens,
    lastRoundTokens: proj.lastRoundTokens,
    roundCount: proj.roundCount,
    rounds: proj.rounds.slice(-DISPLAY_ROUNDS),
  };
}

/**
 * Project the gauge for the conversation on `url`, and (unless `broadcast` is
 * false) push it to an open panel. The active conversation's identity is the
 * URL-derived dialogue id; a conversation with no local record yet projects to
 * zeros (platform + context still shown). Non-platform URL → idle.
 */
async function projectForTab(
  url: string | undefined,
  opts: { broadcast?: boolean } = {},
): Promise<UsageState> {
  const adapter = url ? adapterForUrl(url) : undefined;
  if (!adapter || !url) {
    if (opts.broadcast !== false) await broadcast(IDLE_STATE);
    return IDLE_STATE;
  }
  const settings = await getSettings();
  const contextLimit = effectiveLimit(settings, adapter);
  const dialogueId = adapter.dialogueIdFromUrl?.(url) ?? null;
  const key = dialogueId ? dialogueKey(adapter.platformId, dialogueId) : null;
  const record = key ? await getLocalDialogue(key) : null;
  const state = buildState(adapter, contextLimit, record);
  if (opts.broadcast !== false) await broadcast(state);
  return state;
}

export default defineBackground(() => {
  void enableSidePanelOnActionClick();

  // Gray out the toolbar action on non-platform tabs so Headroom is only
  // clickable where it can do something. The gauge (projectForTab) follows the
  // active tab's platform + conversation independently of this scoping.
  browser.tabs.onActivated.addListener((info) => {
    void applyPanelScope(info.tabId, {
      windowId: info.windowId,
      isActive: true,
    });
    void projectForTabUrlOf(info.tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === "complete") {
      void applyPanelScope(tabId, {
        urlHint: tab?.url ?? change.url,
        windowId: tab?.windowId,
        isActive: tab?.active === true,
      });
    }
    // An SPA route change on the ACTIVE tab (start / switch a chat within a
    // platform) changes its URL without reloading — re-project so the gauge
    // resets to the new conversation's record. (PAGE_READY does NOT re-fire on
    // an SPA route change.)
    if (change.url && tab?.active) {
      void projectForTab(tab?.url ?? change.url);
    }
  });
  // Best-effort initial project for the already-active tab when the service
  // worker (re)starts — covers install/enable/browser-restart.
  void syncActiveTab();

  // ROOT-CAUSE finish detection: the streaming completion response CLOSING
  // (onCompleted) = the model FINISHED this round. The new round is already in
  // history at that instant (verified, no lag), so we just tell the tab's
  // content script to re-fetch history (REFRESH_HISTORY) → it ships
  // HISTORY_PARSED → applyHistory REPLACES the record with the
  // message_id-authoritative view. User stop / network abort (onErrorOccurred)
  // is treated the same — history reflects whatever answer persisted.
  const finishRound = (url: string, tabId: number): void => {
    const adapter = adapterForRequest(url);
    if (!adapter || tabId < 0) return; // <0 ⇒ service-worker / non-tab request
    void handleStreamComplete(tabId);
  };
  browser.webRequest.onCompleted.addListener(
    (d) => finishRound(d.url, d.tabId),
    { urls: URL_FILTER },
  );
  browser.webRequest.onErrorOccurred.addListener(
    (d) => finishRound(d.url, d.tabId),
    { urls: URL_FILTER },
  );

  // Delete interception (003 owns cross-device delete-sync; here we only keep
  // the LOCAL gauge accurate). When a platform's "delete conversation" request
  // fires, drop the local record and re-project the active tab so the gauge
  // resets. Only adapters that declare `deleteUrl` participate. Endpoints were
  // captured live per platform in 2026-06; each adapter pins its own
  // method/body shape. The listener matches by `deleteMethod` (default POST) to
  // avoid firing on non-delete requests that share the URL prefix (ChatGPT
  // POSTs /backend-api/conversation to send, PATCHes to delete; Qwen GETs
  // /api/v2/chats/<id> to view, DELETEs to remove).
  const DELETE_URL_FILTER = ADAPTERS.map((a) => a.deleteUrl).filter(
    (u): u is string => typeof u === "string",
  );
  if (DELETE_URL_FILTER.length > 0) {
    browser.webRequest.onBeforeRequest.addListener(
      (details): undefined => {
        let host: string;
        try {
          host = new URL(details.url).hostname;
        } catch {
          return;
        }
        // Delete requests may ride a different host than send (通义千问:
        // chat2.qianwen.com send, chat2-api.qianwen.com delete) — match on
        // deleteHost ?? host, not the send-only adapterForRequest.
        const adapter = ADAPTERS.find((a) => (a.deleteHost ?? a.host) === host);
        if (!adapter?.parseDelete || !adapter.deleteUrl) return;
        const expectedMethod = adapter.deleteMethod ?? "POST";
        if (details.method !== expectedMethod) return;
        const chunks = details.requestBody?.raw;
        let rawBody = "";
        if (chunks?.length) {
          for (const chunk of chunks) {
            if (chunk.bytes) rawBody += new TextDecoder().decode(chunk.bytes);
          }
        }
        let dialogueId: string | null;
        try {
          dialogueId = adapter.parseDelete(rawBody, details.url);
        } catch {
          return;
        }
        if (!dialogueId) return;
        void handleDelete(adapter.platformId, dialogueId);
      },
      { urls: DELETE_URL_FILTER },
      ["requestBody"],
    );
  }

  browser.runtime.onMessage.addListener(
    async (
      message: HeadroomMessage,
      sender,
    ): Promise<UsageState | undefined> => {
      switch (message.type) {
        case "PAGE_READY": {
          // Only project if the page that loaded is the active tab — a
          // background-tab load must not clobber the active tab's gauge.
          if (!(await isTabActive(sender?.tab?.id))) return;
          await projectForTab(message.url);
          return;
        }
        case "GET_STATE":
          // The panel is asking — derive from the active tab and return (no
          // broadcast: the panel renders the response directly).
          return await getActiveTabState();
        case "HISTORY_PARSED":
          await applyHistory(message, sender?.tab?.id);
          return;
        case "STATE_UPDATE":
          // Emitted only by this background; ignore any echoed copy.
          return;
      }
    },
  );

  /**
   * The SSE completion stream closed (model finished this round). A brief
   * settle covers the rare race where onCompleted fires a hair before the round
   * is committed to history (verified: the round is in history at ~0ms, so
   * 200ms is pure insurance). Then tell the tab's content script to re-fetch
   * history (REFRESH_HISTORY) — it ships HISTORY_PARSED, which applyHistory
   * REPLACES the record with. No DOM reading, no prompt/answer pairing here:
   * history is the sole authority for round identity + tokens.
   */
  async function handleStreamComplete(tabId: number): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "REFRESH_HISTORY",
      } satisfies HeadroomMessage);
    } catch {
      // content script gone / tab closed — nothing to refresh
    }
  }

  /**
   * History is the SOLE authority: the content script fetched the conversation's
   * full history (text only, ascending by message_id). Estimate each round and
   * REPLACE the local record — any locally-guessed or stale round (or a
   * regenerated answer that got a new message_id) is dropped; history defines
   * the canonical set. Called on open, SPA switch, and after a round finishes
   * (REFRESH_HISTORY).
   */
  async function applyHistory(
    m: HistoryParsedMessage,
    tabId?: number,
  ): Promise<void> {
    const adapter = ADAPTERS.find((a) => a.platformId === m.platformId);
    if (!adapter) return;
    const dialogueId = adapter.dialogueIdFromUrl?.(m.url) ?? null;
    if (!dialogueId) return;

    const coeff = adapter.tokenCoefficients ?? DEFAULT_COEFFICIENTS;
    const settings = await getSettings();
    const contextLimit = effectiveLimit(settings, adapter);
    const key = dialogueKey(adapter.platformId, dialogueId);
    // REPLACE: build fresh from history. Don't merge — history is canonical.
    let record = emptyDialogue(adapter.platformId, dialogueId, contextLimit);
    for (const h of m.rounds) {
      record = upsertRound(
        record,
        adapter.platformId,
        dialogueId,
        contextLimit,
        {
          n: h.n,
          // Round at the storage boundary: a token is the smallest unit, so the
          // stored/displayed count must be an integer. estimateTokens stays a
          // precise float so its unit tests + 004 coefficient calibration hold.
          promptTokens: Math.round(estimateTokens(h.promptText, coeff)),
          answerTokens: Math.round(estimateTokens(h.answerText, coeff)),
          ts: 0, // history rounds carry no per-round ts; ordering is by n
        },
      );
    }
    await setLocalDialogue(key, record);

    if (!(await isTabActive(tabId))) return; // backgrounded tab — don't clobber
    await broadcast(buildState(adapter, contextLimit, record));
  }

  /**
   * A conversation was deleted on the platform: drop its local record (the
   * cloud DEL is 003's concern) and re-project the active tab so a deleted
   * conversation's gauge resets to 0.
   */
  async function handleDelete(
    platformId: string,
    dialogueId: string,
  ): Promise<void> {
    await delLocalDialogue(dialogueKey(platformId, dialogueId));
    try {
      const [active] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      await projectForTab(active?.url);
    } catch {
      // Tab query failed (rare) — the record is gone; the next tab event re-projects.
    }
  }
});

/** Project the gauge for whatever tab is currently active (SW start / GET_STATE). */
async function getActiveTabState(): Promise<UsageState> {
  let url: string | undefined;
  try {
    const [active] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    url = active?.url;
  } catch {
    // fall through to idle
  }
  return await projectForTab(url, { broadcast: false });
}

/** Project the gauge for a tab id (onActivated), reading its URL. */
async function projectForTabUrlOf(tabId: number): Promise<void> {
  let url: string | undefined;
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {
    return; // tab gone — nothing to project
  }
  await projectForTab(url);
}

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

/** Sync the action state + project the gauge for the currently active tab. */
async function syncActiveTab(): Promise<void> {
  try {
    const [active] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!active?.id) return;
    await applyPanelScope(active.id, {
      urlHint: active.url,
      windowId: active.windowId,
      isActive: true,
    });
    await projectForTab(active.url);
  } catch {
    // Non-fatal: the onActivated listener will catch up on the next switch.
  }
}
