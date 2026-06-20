import { describe, expect, it } from "vitest";

import { ADAPTERS } from "../adapters";
import { adapterForUrl, isSupportedPlatformUrl } from "./match-host";

/**
 * isSupportedPlatformUrl decides whether the toolbar action is enabled
 * (colored) or disabled (grayed) on a tab. A wrong answer means either the icon
 * is wrongly grayed on a real platform page, or wrongly clickable somewhere
 * Headroom can't help. These pin both sides for every supported platform.
 */

// Build the full set of platform page hosts from the adapter registry, so this
// test stays correct when a platform is added/removed without hand-editing.
const PLATFORM_HOSTS = ADAPTERS.map((a) => {
  const m = a.matchPattern.match(/^\*:\/\/([^/]+)/);
  return m?.[1] ?? "";
}).filter(Boolean);

describe("isSupportedPlatformUrl — every registered platform host", () => {
  it.each(PLATFORM_HOSTS)("returns true for https://%s/...", (host) => {
    expect(isSupportedPlatformUrl(`https://${host}/`)).toBe(true);
    expect(isSupportedPlatformUrl(`https://${host}/some/chat/path`)).toBe(true);
  });

  it.each(PLATFORM_HOSTS)("returns true for a subdomain of %s", (host) => {
    // m.chat.deepseek.com should match the deepseek pattern (suffix match).
    expect(isSupportedPlatformUrl(`https://m.${host}/`)).toBe(true);
  });
});

describe("isSupportedPlatformUrl — non-platform URLs return false", () => {
  it.each([
    ["google.com", "https://google.com/"],
    ["github", "https://github.com/user/repo"],
    ["a near-miss host", "https://chat.deepseek.com.evil.com/"],
    ["localhost", "http://localhost:3000/"],
  ])("returns false for %s", (_label, url) => {
    expect(isSupportedPlatformUrl(url)).toBe(false);
  });

  it("returns false for browser-internal URLs (no http host)", () => {
    expect(isSupportedPlatformUrl("about:blank")).toBe(false);
    expect(isSupportedPlatformUrl("chrome://extensions/")).toBe(false);
    expect(isSupportedPlatformUrl("chrome://newtab")).toBe(false);
  });

  it("returns false for malformed/empty input", () => {
    expect(isSupportedPlatformUrl("")).toBe(false);
    expect(isSupportedPlatformUrl("not a url")).toBe(false);
  });
});

describe("adapterForUrl", () => {
  it("returns the matching adapter for a platform URL", () => {
    const a = adapterForUrl("https://chat.deepseek.com/a/chat/s/123");
    expect(a?.platformId).toBe("deepseek");
  });

  it("returns undefined for a non-platform URL", () => {
    expect(adapterForUrl("https://example.com/")).toBeUndefined();
  });

  it("returns undefined for an unparseable URL", () => {
    expect(adapterForUrl("about:blank")).toBeUndefined();
    expect(adapterForUrl("")).toBeUndefined();
  });
});
