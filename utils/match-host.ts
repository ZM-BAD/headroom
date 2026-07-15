import { ADAPTERS } from "../adapters";

/**
 * Extract the host portion of an adapter's `matchPattern`, e.g.
 * `"*://chat.deepseek.com/*"` → `"chat.deepseek.com"`.
 * Returns null if the pattern is malformed — the caller treats this as
 * "definitely not a match" so the adapter is skipped.
 */
function matchPatternHost(a: (typeof ADAPTERS)[number]): string | null {
  const m = a.matchPattern.match(/^\*:\/\/([^/]+)/);
  if (!m?.[1]) {
    if (import.meta.env.DEV) {
      console.warn("[Headroom] malformed matchPattern:", a.matchPattern);
    }
    return null;
  }
  return m[1];
}

/**
 * Core host → adapter lookup. Matches `hostname` against each adapter's
 * `matchPattern` host exactly — subdomains are intentionally excluded (the
 * MV3 content-script `matches` patterns don't use `*.` wildcards, so the
 * content script is never injected on subdomains; enabling the toolbar
 * action there would open a panel with no content script to feed it data).
 */
export function adapterForHost(
  hostname: string,
): (typeof ADAPTERS)[number] | undefined {
  return ADAPTERS.find((a) => {
    const patternHost = matchPatternHost(a);
    if (!patternHost) return false;
    return hostname === patternHost;
  });
}

/**
 * Is `url` a supported AI-chat platform page? Used by the background to
 * decide whether the toolbar action is enabled (colored) or disabled (grayed)
 * on a given tab.
 *
 * Pure + string-in → unit-testable without any browser API.
 */
export function isSupportedPlatformUrl(url: string): boolean {
  return adapterForUrl(url) !== undefined;
}

/**
 * The adapter whose page-host matches `url`, or undefined. Exact host match
 * only — subdomains are intentionally excluded (see `adapterForHost`).
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
  return adapterForHost(host);
}
