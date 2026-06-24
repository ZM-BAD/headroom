import type { HeadroomMessage, HistoryParsedMessage } from "../utils/messages";
import type { PlatformAdapter } from "../utils/platform-adapter";
import { ADAPTERS } from "../adapters";

/**
 * The ONE content script for every supported platform. WXT injects it on any
 * adapter's matchPattern; it finds its adapter by hostname, then fetches the
 * conversation's full history (adapter.fetchHistory — the platform's history
 * API, the SOLE authority for round identity via stable `message_id`) and ships
 * it as HISTORY_PARSED. Three triggers:
 *   - PAGE_READY (open / reload),
 *   - SPA conversation switch (URL-change poll),
 *   - REFRESH_HISTORY (the background detected the SSE completion stream closed
 *     = the model finished this round; the new round is already in history).
 *
 * It reads NOTHING from the DOM for round identity — DeepSeek's virtual list
 * keeps only visible messages in the DOM, so the DOM count is unreliable. The
 * history API returns every message regardless of the virtual list.
 */
export default defineContentScript({
  matches: ADAPTERS.map((a) => a.matchPattern),
  main(ctx) {
    const adapter = adapterForPage();
    if (!adapter) return;

    const send = (msg: HeadroomMessage): void => {
      // try/catch (not just .catch): after the extension is reloaded, the OLD
      // content script's context is invalidated and `browser.runtime` throws
      // SYNCHRONOUSLY — the promise's .catch never runs. ctx.setInterval stops
      // the poll on invalidation, but an in-flight call can still race.
      try {
        void browser.runtime.sendMessage(msg).catch(() => {});
      } catch {
        // Context invalidated — ctx.setInterval will stop the poll shortly.
      }
    };

    const sendPageReady = (): void =>
      send({
        type: "PAGE_READY",
        platformId: adapter.platformId,
        url: location.href,
      });

    // Fetch the conversation's full history (text + message_id-ordered rounds)
    // and ship it. No-op when the adapter has no fetchHistory or the URL has no
    // dialogue id (e.g. the home page). The background REPLACES the record with
    // this authoritative view.
    const fetchAndShipHistory = async (): Promise<void> => {
      if (!adapter.fetchHistory) return;
      const dialogueId = adapter.dialogueIdFromUrl?.(location.href) ?? null;
      if (!dialogueId) return;
      try {
        const rounds = await adapter.fetchHistory(dialogueId);
        if (rounds.length === 0) return;
        send({
          type: "HISTORY_PARSED",
          platformId: adapter.platformId,
          url: location.href,
          rounds,
        } satisfies HistoryParsedMessage);
      } catch {
        // fetch failed — the next trigger (open / switch / round-complete) re-fetches
      }
    };

    // Background asks us to re-fetch history when the SSE completion stream
    // closes (a round finished). The new round is already in history by then.
    browser.runtime.onMessage.addListener((message: HeadroomMessage) => {
      if (message.type === "REFRESH_HISTORY") void fetchAndShipHistory();
    });

    // Initial load.
    sendPageReady();
    void fetchAndShipHistory();

    // SPA conversation switches change the URL WITHOUT reloading (DeepSeek is a
    // React SPA), so PAGE_READY doesn't re-fire. Poll the URL lightly and, when
    // the conversation changes, re-announce + re-fetch its history. Use the
    // content-script CONTEXT's interval (not window.setInterval) so it
    // AUTO-CLEARS when the context is invalidated (extension reload) — otherwise
    // the dead context throws "Extension context invalidated" every tick.
    let lastHref = location.href;
    ctx.setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      sendPageReady();
      void fetchAndShipHistory();
    }, 1500);
  },
});

/** Match location.hostname against each adapter's matchPattern host. */
function adapterForPage(): PlatformAdapter | undefined {
  return ADAPTERS.find((a) => {
    const m = a.matchPattern.match(/^\*:\/\/([^/]+)/);
    const host = m?.[1];
    if (!host) return false;
    return location.hostname === host || location.hostname.endsWith(`.${host}`);
  });
}
