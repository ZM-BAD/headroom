import type { HeadroomMessage } from "../utils/messages";
import type { PlatformAdapter } from "../utils/platform-adapter";
import { ADAPTERS } from "../adapters";
import { watchRounds } from "../utils/round-watcher";

/**
 * The ONE content script for every supported platform. WXT injects it on any
 * adapter's matchPattern; it finds its adapter by hostname, announces
 * PAGE_READY, and watches for round completion.
 *
 * Adding a platform needs NO new content-script file — only an adapter in
 * ADAPTERS + a host_permissions entry. (Some platforms serve the page on a
 * different host than their API, e.g. Tongyi — dispatch is by the page host
 * extracted from the adapter's matchPattern, not the API `host`.)
 */
export default defineContentScript({
  matches: ADAPTERS.map((a) => a.matchPattern),
  main() {
    const adapter = adapterForPage();
    if (!adapter) return;
    browser.runtime
      .sendMessage({
        type: "PAGE_READY",
        platformId: adapter.platformId,
        url: location.href,
      } satisfies HeadroomMessage)
      .catch(() => {
        // Background service worker may be asleep on first load; ignore.
      });
    watchRounds(adapter, (answerText, promptText) => {
      browser.runtime
        .sendMessage({
          type: "ROUND_COMPLETE",
          platformId: adapter.platformId,
          dialogueId: null,
          answerText,
          ...(promptText ? { promptText } : {}),
        } satisfies HeadroomMessage)
        .catch(() => {
          // Background service worker may be asleep; ignore.
        });
    });
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
