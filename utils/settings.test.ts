import { describe, expect, it, vi, beforeEach } from "vitest";

// Settings module imports ADAPTERS, which import from adapters/ — those
// imports resolve fine in node (no browser API). The only browser API
// touchpoint is browser.storage.local.{get,set}, mocked below.

const mockGet = vi.fn();
const mockSet = vi.fn();

vi.stubGlobal("browser", {
  storage: { local: { get: mockGet, set: mockSet } },
});

import {
  DEFAULT_SETTINGS,
  defaultContextLimits,
  getSettings,
  saveSettings,
  STORAGE_KEY,
} from "./settings";
import type { ContextLimits, Settings } from "./settings";

beforeEach(() => {
  vi.restoreAllMocks();
  mockGet.mockReset();
  mockSet.mockReset();
});

// ============================================================================
// defaultContextLimits
// ============================================================================

describe("defaultContextLimits", () => {
  it("returns an entry for every registered adapter", () => {
    const limits = defaultContextLimits();
    expect(Object.keys(limits).length).toBeGreaterThanOrEqual(7);
  });

  it("every value is a positive finite number", () => {
    const limits = defaultContextLimits();
    for (const [id, val] of Object.entries(limits)) {
      expect(typeof val, `contextLimit for ${id}`).toBe("number");
      expect(Number.isFinite(val), `contextLimit for ${id} is finite`).toBe(
        true,
      );
      expect(val, `contextLimit for ${id} > 0`).toBeGreaterThan(0);
    }
  });

  it("includes known platform ids", () => {
    const limits = defaultContextLimits();
    expect(limits).toHaveProperty("deepseek");
    expect(limits).toHaveProperty("chatgpt");
    expect(limits).toHaveProperty("gemini");
  });
});

// ============================================================================
// getSettings
// ============================================================================

describe("getSettings", () => {
  it("returns defaults when nothing is stored", async () => {
    mockGet.mockResolvedValue({});
    const s = await getSettings();
    expect(s.thresholds).toEqual(DEFAULT_SETTINGS.thresholds);
    expect(s.language).toBe("auto");
    expect(s.upstash).toEqual({ url: "", token: "" });
    expect(s.contextLimits).toEqual(defaultContextLimits());
  });

  it("returns defaults when the stored value is undefined", async () => {
    mockGet.mockResolvedValue({ [STORAGE_KEY]: undefined });
    const s = await getSettings();
    expect(s.thresholds).toEqual(DEFAULT_SETTINGS.thresholds);
  });

  it("overlays stored thresholds over defaults", async () => {
    mockGet.mockResolvedValue({
      [STORAGE_KEY]: { thresholds: { yellow: 40, red: 80 } },
    });
    const s = await getSettings();
    expect(s.thresholds.yellow).toBe(40);
    expect(s.thresholds.red).toBe(80);
  });

  it("falls back to default for a missing threshold field", async () => {
    mockGet.mockResolvedValue({
      [STORAGE_KEY]: { thresholds: { yellow: 40 } },
    });
    const s = await getSettings();
    expect(s.thresholds.yellow).toBe(40);
    expect(s.thresholds.red).toBe(DEFAULT_SETTINGS.thresholds.red);
  });

  it("reads a stored language override", async () => {
    mockGet.mockResolvedValue({
      [STORAGE_KEY]: { language: "zh_CN" },
    });
    const s = await getSettings();
    expect(s.language).toBe("zh_CN");
  });

  it("falls back to 'auto' for a missing language", async () => {
    mockGet.mockResolvedValue({
      [STORAGE_KEY]: {},
    });
    const s = await getSettings();
    expect(s.language).toBe("auto");
  });

  it("reads stored Upstash credentials", async () => {
    mockGet.mockResolvedValue({
      [STORAGE_KEY]: {
        upstash: { url: "https://example.upstash.io", token: "abc123" },
      },
    });
    const s = await getSettings();
    expect(s.upstash.url).toBe("https://example.upstash.io");
    expect(s.upstash.token).toBe("abc123");
  });

  it("falls back to empty creds when stored upstash is missing fields", async () => {
    mockGet.mockResolvedValue({
      [STORAGE_KEY]: { upstash: { url: "https://x.io" } },
    });
    const s = await getSettings();
    expect(s.upstash.url).toBe("https://x.io");
    expect(s.upstash.token).toBe("");
  });

  it("falls back to empty creds when stored upstash is absent", async () => {
    mockGet.mockResolvedValue({ [STORAGE_KEY]: {} });
    const s = await getSettings();
    expect(s.upstash).toEqual({ url: "", token: "" });
  });

  describe("contextLimits merging", () => {
    it("starts from adapter defaults when nothing is stored", async () => {
      mockGet.mockResolvedValue({});
      const s = await getSettings();
      expect(s.contextLimits).toEqual(defaultContextLimits());
    });

    it("overlays a valid stored override on top of defaults", async () => {
      mockGet.mockResolvedValue({
        [STORAGE_KEY]: { contextLimits: { deepseek: 999_999 } },
      });
      const s = await getSettings();
      expect(s.contextLimits.deepseek).toBe(999_999);
      // Other adapters still carry their defaults.
      expect(s.contextLimits.chatgpt).toBe(defaultContextLimits().chatgpt);
    });

    it("filters out non-number values (corrupt entry)", async () => {
      mockGet.mockResolvedValue({
        [STORAGE_KEY]: {
          contextLimits: { deepseek: "large" as unknown as number },
        },
      });
      const s = await getSettings();
      // Corrupt string dropped — falls back to adapter default.
      expect(s.contextLimits.deepseek).toBe(defaultContextLimits().deepseek);
    });

    it("filters out NaN", async () => {
      mockGet.mockResolvedValue({
        [STORAGE_KEY]: { contextLimits: { deepseek: NaN } },
      });
      const s = await getSettings();
      expect(s.contextLimits.deepseek).toBe(defaultContextLimits().deepseek);
    });

    it("filters out Infinity", async () => {
      mockGet.mockResolvedValue({
        [STORAGE_KEY]: { contextLimits: { deepseek: Infinity } },
      });
      const s = await getSettings();
      expect(s.contextLimits.deepseek).toBe(defaultContextLimits().deepseek);
    });

    it("filters out zero and negative values", async () => {
      mockGet.mockResolvedValue({
        [STORAGE_KEY]: { contextLimits: { deepseek: 0, chatgpt: -1 } },
      });
      const s = await getSettings();
      expect(s.contextLimits.deepseek).toBe(defaultContextLimits().deepseek);
      expect(s.contextLimits.chatgpt).toBe(defaultContextLimits().chatgpt);
    });

    it("filters out non-object contextLimits", async () => {
      mockGet.mockResolvedValue({
        [STORAGE_KEY]: { contextLimits: "nope" },
      });
      const s = await getSettings();
      expect(s.contextLimits).toEqual(defaultContextLimits());
    });

    it("passes through unknown platform ids from stored overrides", async () => {
      // Harmless — the override sits in the map but no adapter uses it.
      // The merge starts from defaults (known ids) then overlays whatever
      // valid numbers the user stored, including ids for platforms that
      // may have been removed or renamed.
      mockGet.mockResolvedValue({
        [STORAGE_KEY]: { contextLimits: { unknown_platform: 5000 } },
      });
      const s = await getSettings();
      expect((s.contextLimits as ContextLimits).unknown_platform).toBe(5000);
    });
  });
});

// ============================================================================
// saveSettings
// ============================================================================

describe("saveSettings", () => {
  it("writes the full settings object under the settings key", async () => {
    mockSet.mockResolvedValue(undefined);
    const settings: Settings = {
      thresholds: { yellow: 30, red: 60 },
      language: "ja",
      upstash: { url: "https://u.upstash.io", token: "tok" },
      contextLimits: { deepseek: 500_000 },
    };
    await saveSettings(settings);
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ [STORAGE_KEY]: settings });
  });

  it("overwrites the entire settings object (no merge)", async () => {
    mockSet.mockResolvedValue(undefined);
    const partial: Settings = {
      thresholds: { yellow: 10, red: 20 },
      language: "auto",
      upstash: { url: "", token: "" },
      contextLimits: {},
    };
    await saveSettings(partial);
    const arg = mockSet.mock.calls[0][0] as Record<string, unknown>;
    const stored = arg[STORAGE_KEY] as Settings;
    expect(stored.thresholds).toEqual({ yellow: 10, red: 20 });
    expect(stored.language).toBe("auto");
  });
});
