import { ADAPTERS } from "../adapters";

/**
 * Is `url` a supported AI-chat platform page? Used by the background to decide
 * whether the toolbar action is enabled (colored) or disabled (grayed) on a
 * given tab — Headroom only acts on its supported platforms.
 *
 * Host matching mirrors the content script's injection scope: the page host must
 * EXACTLY equal the adapter's matchPattern host. Subdomains are intentionally NOT
 * matched — the content script's MV3 `matches` patterns (bare `*://host/*` without
 * `*.`) do not inject on subdomains, so enabling the action on them would open a
 * panel with no content script to feed it data.
 *
 * Pure + string-in → unit-testable without any browser API.
 */
export function isSupportedPlatformUrl(url: string): boolean {
  return adapterForUrl(url) !== undefined;
}

/**
 * The adapter whose page-host matches `url`, or undefined. Shared by the
 * background (tab-URL → enable/disable action) and (conceptually) the content
 * script's page-host lookup.
 */
export function adapterForUrl(
  url: string,
): (typeof ADAPTERS)[number] | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined; // about:blank, chrome://, malformed — not a platform page
  }
  return ADAPTERS.find((a) => {
    const m = a.matchPattern.match(/^\*:\/\/([^/]+)/);
    const patternHost = m?.[1];
    if (!patternHost) return false;
    return host === patternHost;
  });
}
