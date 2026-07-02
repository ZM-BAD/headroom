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
  unionRounds,
  type DialogueRecord,
} from "../utils/dialogue-record";
import {
  convIndexAfterDelete,
  convIndexAfterSet,
  pickOldestKeys,
  HARD_LIMIT_BYTES,
  SOFT_LIMIT_BYTES,
  CLEANUP_STATE_KEY,
  shouldRunCleanup,
  cleanupStateAfterRun,
  type CleanupState,
  type ConvIndex,
} from "../utils/local-cache";
import {
  dialogueKey,
  getDialogue,
  setDialogue,
  delDialogue,
  kvScan,
  kvDel,
  selectZombieKeys,
} from "../utils/upstash";
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
  dialogueId: null,
  dialogueTitle: null,
  contextLimit: null,
  totalTokens: 0,
  lastRoundTokens: null,
  roundCount: 0,
  rounds: [],
};

/**
 * Latest DOM-scraped conversation title per tab. PAGE_READY / HISTORY_PARSED
 * refresh it; projectForTab reads it when building the gauge's identity. The
 * SW may be evicted (losing this map) — that only delays the title by one
 * PAGE_READY on next open, acceptable for a display-only field.
 */
const tabDialogueTitle = new Map<number, string | null>();

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
// The conv-index ({ [fullKey]: updatedAt }) mirrors which conversations are
// cached locally, so LRU eviction can find the oldest without a full scan.
// Maintained alongside every set/del below.

const CONV_INDEX_KEY = "headroom:conv-index";

async function getConvIndex(): Promise<ConvIndex> {
  const raw = await browser.storage.local.get(CONV_INDEX_KEY);
  return (raw[CONV_INDEX_KEY] as ConvIndex | undefined) ?? {};
}

async function setConvIndex(index: ConvIndex): Promise<void> {
  await browser.storage.local.set({ [CONV_INDEX_KEY]: index });
}

async function getLocalDialogue(key: string): Promise<DialogueRecord | null> {
  const raw = await browser.storage.local.get(key);
  return (raw[key] as DialogueRecord | undefined) ?? null;
}

async function setLocalDialogue(
  key: string,
  record: DialogueRecord,
): Promise<void> {
  await browser.storage.local.set({ [key]: record });
  await setConvIndex(
    convIndexAfterSet(await getConvIndex(), key, record.updatedAt),
  );
}

async function delLocalDialogue(key: string): Promise<void> {
  await browser.storage.local.remove(key);
  await setConvIndex(convIndexAfterDelete(await getConvIndex(), key));
}

/** Total bytes in storage.local (UTF-8 of every JSON value). Cross-browser:
 *  get()-all + TextEncoder rather than Chrome-only `getBytesInUse`, so Firefox
 *  (which lacks getBytesInUse) behaves the same. */
async function localCacheBytes(): Promise<number> {
  const all = await browser.storage.local.get();
  let bytes = 0;
  for (const value of Object.values(all)) {
    bytes += new TextEncoder().encode(JSON.stringify(value)).length;
  }
  return bytes;
}

/** spec 003 LRU: if local usage exceeds SOFT_LIMIT, drop the oldest cached
 *  conversations (by conv-index updatedAt) until under HARD_LIMIT. Local only
 *  — the cloud record survives and is re-fetched on next open. Best-effort:
 *  fire-and-forget after a write; failure just leaves the cache a touch full. */
async function evictLocalCacheIfNeeded(): Promise<void> {
  let bytes = await localCacheBytes();
  if (bytes <= SOFT_LIMIT_BYTES) return;
  let index = await getConvIndex();
  while (bytes > HARD_LIMIT_BYTES) {
    const [oldest] = pickOldestKeys(index, 1);
    if (!oldest) break; // index empty — nothing left to evict
    await browser.storage.local.remove(oldest);
    index = convIndexAfterDelete(index, oldest);
    bytes = await localCacheBytes();
  }
  await setConvIndex(index);
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
  dialogueId: string | null,
  dialogueTitle: string | null,
): UsageState {
  const proj = projectUsage(record);
  return {
    platformId: adapter.platformId,
    dialogueId,
    dialogueTitle,
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
  tabId?: number,
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
  // Cached title from prior PAGE_READY / HISTORY_PARSED (may be stale if the
  // SPA updated document.title after injection). The GET_TITLE query below
  // asks the content script for the current title — light, synchronous, and
  // gives tab-switch instant accuracy without waiting for the 1.5s poll.
  let dialogueTitle =
    tabId != null ? (tabDialogueTitle.get(tabId) ?? null) : null;
  if (tabId != null) {
    try {
      const response = (await browser.tabs.sendMessage(tabId, {
        type: "GET_TITLE",
      } satisfies HeadroomMessage)) as
        | { dialogueTitle?: string | null }
        | undefined;
      if (response?.dialogueTitle) {
        dialogueTitle = response.dialogueTitle;
        tabDialogueTitle.set(tabId, dialogueTitle); // refresh cache
      }
    } catch {
      // content script not injected / context invalidated — keep cached title
    }
  }
  const state = buildState(
    adapter,
    contextLimit,
    record,
    dialogueId,
    dialogueTitle,
  );
  if (opts.broadcast !== false) await broadcast(state);
  return state;
}

export default defineBackground(() => {
  void enableSidePanelOnActionClick();

  // ── Zombie cleanup alarm (spec 003) ─────────────────────────────────
  // 10-min periodic alarm iterates all platforms; for each that has an open
  // home-page tab, sends FETCH_CONVERSATION_LIST to trigger a cleanup run.
  // Falls back to the last-seen list (cached per platform) when no tab is
  // available — best-effort, stale is acceptable for zombie sweeping.
  browser.alarms.create("zombie-cleanup", { periodInMinutes: 10 });
  const lastConversationList = new Map<string, string[]>();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "zombie-cleanup") return;
    void runZombieCleanupFromAlarm(lastConversationList);
  });

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
      void projectForTab(tab?.url ?? change.url, tabId);
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
          // Store the title unconditionally (same as HISTORY_PARSED) — a
          // background-tab load must not clobber the active tab's gauge, but
          // the title must survive so switching to this tab later shows it.
          if (sender?.tab?.id != null) {
            tabDialogueTitle.set(sender.tab.id, message.dialogueTitle);
          }
          if (!(await isTabActive(sender?.tab?.id))) return;
          await projectForTab(message.url, sender?.tab?.id);
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
        case "CONVERSATION_LIST":
          // Home page: diff the live conversation list against cloud keys and
          // DEL orphans (spec 003 zombie cleanup). Fire-and-forget.
          // Cache the list so the alarm fallback can use it when no home-page
          // tab is open.
          lastConversationList.set(message.platformId, message.ids);
          void cleanupZombies(message.platformId, message.ids);
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
   * full history (text only, ascending by message_id). Estimate each round,
   * UNION-merge with the cloud record (spec 003: history wins on conflict,
   * cloud-only rounds from prior opens survive), then persist + broadcast.
   *
   * Order matters (spec 003 "先显示后同步"): write the local cache and broadcast
   * BEFORE the cloud sync so the gauge updates instantly even if Upstash is
   * slow/down. The cloud sync is best-effort — on failure it warns and leaves
   * the next open to reconcile.
   *
   * No-creds degradation: getDialogue returns null when Upstash is unconfigured,
   * so union(null-rounds, history) = history-only — identical to 001's old
   * REPLACE behavior. 001 is thus the no-creds subset of 003, zero regression.
   *
   * Called on open, SPA switch, and after a round finishes (REFRESH_HISTORY).
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

    // 1. Estimate history rounds into RoundRecords (history is the live truth).
    const historyRounds = m.rounds.map((h) => {
      const promptTokens = Math.round(estimateTokens(h.promptText, coeff));
      const answerTokens = Math.round(estimateTokens(h.answerText, coeff));
      // Round at the storage boundary: a token is the smallest unit, so the
      // stored/displayed count must be an integer. estimateTokens stays a
      // precise float so its unit tests + 004 coefficient calibration hold.
      return {
        messageId: h.messageId,
        order: h.order,
        n: 0, // display position — assigned by unionRounds post-merge
        promptTokens,
        answerTokens,
        total: promptTokens + answerTokens,
        createdAt: h.createdAt ?? 0,
      };
    });

    // 2. Read the cloud record (null when unconfigured → history-only path).
    let cloudRecord: DialogueRecord | null = null;
    try {
      cloudRecord = await getDialogue(settings.upstash, key);
    } catch (e) {
      // Don't let a transient cloud read block the local update — proceed with
      // history-only; the next open will retry the union.
      console.warn("[Headroom] cloud read failed for", key, e);
    }

    // 3. Union merge (spec 003 core): history wins on conflict, cloud-only
    //    rounds survive. Rebuild the record through upsertRound so the
    //    running-sum (totalTokens) + true-count (roundCount) invariants hold.
    const mergedRounds = unionRounds(cloudRecord?.rounds ?? [], historyRounds);
    let record = emptyDialogue(adapter.platformId, dialogueId, contextLimit);
    for (const r of mergedRounds) {
      record = upsertRound(
        record,
        adapter.platformId,
        dialogueId,
        contextLimit,
        {
          messageId: r.messageId,
          order: r.order,
          n: r.n,
          promptTokens: r.promptTokens,
          answerTokens: r.answerTokens,
          createdAt: r.createdAt,
        },
      );
    }

    // 4. Show first: persist locally + broadcast (active-tab guarded so a
    //    backgrounded tab doesn't clobber the foreground gauge).
    await setLocalDialogue(key, record);
    // Best-effort LRU eviction (spec 003): a write may push local usage over
    // the soft limit. Fire-and-forget — never block the gauge update below.
    void evictLocalCacheIfNeeded();
    if (tabId != null) tabDialogueTitle.set(tabId, m.dialogueTitle);
    if (await isTabActive(tabId)) {
      await broadcast(
        buildState(adapter, contextLimit, record, dialogueId, m.dialogueTitle),
      );
    }

    // 5. Sync later: best-effort cloud write. Not guarded by active-tab — a
    //    backgrounded tab's rounds must still reach the cloud. Failure warns
    //    and leaves the next open to reconcile; it never blocks the UI.
    try {
      await setDialogue(settings.upstash, key, record);
    } catch (e) {
      console.warn("[Headroom] cloud sync failed for", key, e);
    }
  }

  /**
   * A conversation was deleted on the platform: drop the local record, then
   * best-effort DEL the cloud record (spec 003). No-creds = no-op; failure
   * warns and leaves a zombie key that zombie-cleanup [P1, deferred] sweeps.
   * Either way the active tab is re-projected so the gauge resets to 0.
   */
  async function handleDelete(
    platformId: string,
    dialogueId: string,
  ): Promise<void> {
    const key = dialogueKey(platformId, dialogueId);
    await delLocalDialogue(key);
    try {
      const { upstash: creds } = await getSettings();
      await delDialogue(creds, key);
    } catch (e) {
      // Leaves a zombie key in Upstash; zombie-cleanup (P1) will sweep it.
      console.warn("[Headroom] cloud DEL failed for", key, e);
    }
    try {
      const [active] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      await projectForTab(active?.url, active?.id);
    } catch {
      // Tab query failed (rare) — the record is gone; the next tab event re-projects.
    }
  }

  /**
   * spec 003 zombie cleanup: diff the platform's live conversation list against
   * cloud keys (SCAN) and DEL orphans. Throttled per platform: skip if ran
   * < 5 min ago (shared between home-page trigger and alarm trigger).
   */
  async function cleanupZombies(
    platformId: string,
    liveIds: string[],
  ): Promise<void> {
    const { upstash: creds } = await getSettings();
    if (!creds.url || !creds.token) return; // no cloud → nothing to clean
    const state = await getCleanupState();
    if (!shouldRunCleanup(state, platformId, Date.now())) return;
    try {
      const cloudKeys = await kvScan(creds, `headroom:conv:${platformId}:*`);
      const zombies = selectZombieKeys(cloudKeys, new Set(liveIds), platformId);
      await Promise.all(zombies.map((k) => kvDel(creds, k).catch(() => {})));
      // Stamp successful run for throttle.
      const state = await getCleanupState();
      await setCleanupState(
        cleanupStateAfterRun(state, platformId, Date.now()),
      );
    } catch (e) {
      console.warn("[Headroom] zombie cleanup failed for", platformId, e);
    }
  }

  /**
   * Alarm-triggered zombie cleanup: for each platform, try to send
   * FETCH_CONVERSATION_LIST to an open home-page tab. If no tab is available,
   * fall back to the last-seen conversation list (best-effort).
   */
  async function runZombieCleanupFromAlarm(
    cachedLists: Map<string, string[]>,
  ): Promise<void> {
    for (const adapter of ADAPTERS) {
      if (!adapter.fetchConversationList) continue;
      try {
        const pattern = adapter.matchPattern;
        const tabs = await browser.tabs.query({ url: pattern });
        const tabId = tabs[0]?.id;
        if (tabId != null) {
          // Found an open tab — ask its content script to fetch & ship.
          // The content script sends CONVERSATION_LIST, which triggers
          // cleanupZombies with throttle.
          void browser.tabs
            .sendMessage(tabId, {
              type: "FETCH_CONVERSATION_LIST",
            } satisfies HeadroomMessage)
            .catch(() => {});
        } else {
          // No tab open — use cached list as fallback.
          const cached = cachedLists.get(adapter.platformId);
          if (cached && cached.length > 0) {
            void cleanupZombies(adapter.platformId, cached);
          }
        }
      } catch {
        // tab query or send failed — skip this platform
      }
    }
  }
});

// ── Zombie cleanup throttle storage ──────────────────────────────────

async function getCleanupState(): Promise<CleanupState> {
  const raw = await browser.storage.local.get(CLEANUP_STATE_KEY);
  return (raw[CLEANUP_STATE_KEY] as CleanupState | undefined) ?? {};
}

async function setCleanupState(state: CleanupState): Promise<void> {
  await browser.storage.local.set({ [CLEANUP_STATE_KEY]: state });
}

/** Project the gauge for whatever tab is currently active (SW start / GET_STATE). */
async function getActiveTabState(): Promise<UsageState> {
  let url: string | undefined;
  let tabId: number | undefined;
  try {
    const [active] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    url = active?.url;
    tabId = active?.id;
  } catch {
    // fall through to idle
  }
  return await projectForTab(url, tabId, { broadcast: false });
}

/** Project the gauge for a tab id (onActivated), reading its URL. */
async function projectForTabUrlOf(tabId: number): Promise<void> {
  let url: string | undefined;
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {
    return; // tab gone — nothing to project
  }
  await projectForTab(url, tabId);
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
      // Tab gone or URL unavailable — still disable the action so a stale
      // "enabled" state from a previous platform tab doesn't leak here.
      try {
        await browser.action.disable(tabId);
      } catch {
        // Non-fatal — browser may not support action (Firefox) or tab is gone.
      }
      return;
    }
  }
  // url is undefined for tabs without host-permission — treat as unsupported.
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
    await projectForTab(active.url, active.id);
  } catch {
    // Non-fatal: the onActivated listener will catch up on the next switch.
  }
}
