import { describe, expect, it, vi, type Mock } from "vitest";
import {
  toCloudSettings,
  mergeCloudSettings,
  pullCloudSettings,
  type CloudSettings,
} from "./cloud-settings";
import type { Settings } from "./settings";

function sampleSettings(): Settings {
  return {
    thresholds: { yellow: 0.5, red: 0.7 },
    language: "auto",
    upstash: { url: "https://x.upstash.io", token: "secret" },
    contextLimits: { deepseek: 1_048_576 },
    tokenCoefficients: {},
    updatedAt: 10,
  };
}

describe("toCloudSettings", () => {
  it("copies syncable fields and stamps updatedAt", () => {
    const local = sampleSettings();
    local.tokenCoefficients = { deepseek: { cjk: 0.8 } };
    const cloud = toCloudSettings(local, 12345);
    expect(cloud).toEqual({
      thresholds: { yellow: 0.5, red: 0.7 },
      language: "auto",
      contextLimits: { deepseek: 1_048_576 },
      tokenCoefficients: { deepseek: { cjk: 0.8 } },
      updatedAt: 12345,
    });
  });

  it("never carries credentials into the cloud shape", () => {
    const cloud = toCloudSettings(sampleSettings(), 1) as unknown as Record<
      string,
      unknown
    >;
    expect(cloud.upstash).toBeUndefined();
    const json = JSON.stringify(cloud);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("upstash");
  });

  it("carries tokenCoefficients without credentials", () => {
    const local = sampleSettings();
    local.tokenCoefficients = { deepseek: { cjk: 0.8 } };
    const cloud = toCloudSettings(local, 1);
    expect(cloud.tokenCoefficients).toEqual({ deepseek: { cjk: 0.8 } });
    // tokenCoefficients does NOT contain upstash creds (same separator as other fields)
    const json = JSON.stringify(cloud);
    expect(json).not.toContain("secret");
  });
});

describe("mergeCloudSettings (last-write-wins by updatedAt)", () => {
  it("adopts cloud fields when cloud is newer, keeps local credentials", () => {
    const local = sampleSettings();
    const merged = mergeCloudSettings(local, {
      thresholds: { yellow: 0.6, red: 0.8 },
      language: "zh_CN",
      contextLimits: { deepseek: 2_000_000 },
      tokenCoefficients: { deepseek: { kana: 0.4 } },
      updatedAt: 100,
    });
    expect(merged.thresholds).toEqual({ yellow: 0.6, red: 0.8 });
    expect(merged.language).toBe("zh_CN");
    expect(merged.contextLimits).toEqual({ deepseek: 2_000_000 });
    expect(merged.tokenCoefficients).toEqual({ deepseek: { kana: 0.4 } });
    // credentials survive untouched
    expect(merged.upstash).toEqual({
      url: "https://x.upstash.io",
      token: "secret",
    });
  });

  it("adopting stamps updatedAt with the cloud's timestamp (idempotent re-pull)", () => {
    const local = sampleSettings();
    const merged = mergeCloudSettings(local, {
      thresholds: { yellow: 0.6, red: 0.8 },
      language: "en",
      contextLimits: {},
      tokenCoefficients: {},
      updatedAt: 100,
    });
    // Without this, every subsequent pull would re-adopt the same snapshot.
    expect(merged.updatedAt).toBe(100);
  });

  it("keeps local when cloud is older or equal", () => {
    const local = sampleSettings();
    local.tokenCoefficients = { deepseek: { cjk: 0.6 } };
    const merged = mergeCloudSettings(local, {
      thresholds: { yellow: 0.9, red: 0.99 },
      language: "zh_CN",
      contextLimits: {},
      tokenCoefficients: { deepseek: { cjk: 0.9 } },
      updatedAt: 5,
    });
    expect(merged.thresholds).toEqual({ yellow: 0.5, red: 0.7 });
    expect(merged.language).toBe("auto");
    expect(merged.tokenCoefficients).toEqual({ deepseek: { cjk: 0.6 } });
    expect(merged.updatedAt).toBe(10);
  });

  it("keeps local when cloud is null", () => {
    const local = sampleSettings();
    expect(mergeCloudSettings(local, null)).toEqual(local);
  });

  it("does not mutate the input local settings", () => {
    const local = sampleSettings();
    mergeCloudSettings(local, {
      thresholds: { yellow: 0.6, red: 0.8 },
      language: "en",
      contextLimits: {},
      tokenCoefficients: {},
      updatedAt: 100,
    });
    expect(local.thresholds).toEqual({ yellow: 0.5, red: 0.7 });
    expect(local.language).toBe("auto");
    expect(local.updatedAt).toBe(10);
  });
});

describe("pullCloudSettings (spec 003 settings pull orchestration)", () => {
  function sampleCloud(updatedAt: number): CloudSettings {
    return {
      thresholds: { yellow: 0.6, red: 0.8 },
      language: "zh_CN",
      contextLimits: { deepseek: 2_000_000 },
      tokenCoefficients: { deepseek: { kana: 0.4 } },
      updatedAt,
    };
  }

  /** fetch mock whose GET returns `result` (the raw Redis string or null). */
  function mockFetch(result: string | null): Mock {
    const mock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result }),
    }));
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  it("reports no-creds without touching the network when creds are absent", async () => {
    const mock = mockFetch(null);
    const local = sampleSettings();
    local.upstash = { url: "", token: "" };
    expect(await pullCloudSettings(local)).toEqual({ outcome: "no-creds" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("reports not-newer when the cloud has no settings record", async () => {
    mockFetch(null);
    expect(await pullCloudSettings(sampleSettings())).toEqual({
      outcome: "not-newer",
    });
  });

  it("reports not-newer when the cloud snapshot is not newer than local", async () => {
    mockFetch(JSON.stringify(sampleCloud(5))); // local updatedAt = 10
    expect(await pullCloudSettings(sampleSettings())).toEqual({
      outcome: "not-newer",
    });
  });

  it("returns the merged settings when the cloud snapshot is newer", async () => {
    mockFetch(JSON.stringify(sampleCloud(100)));
    const res = await pullCloudSettings(sampleSettings());
    expect(res.outcome).toBe("adopted");
    if (res.outcome !== "adopted") return; // narrow for TS
    expect(res.settings.language).toBe("zh_CN");
    expect(res.settings.thresholds).toEqual({ yellow: 0.6, red: 0.8 });
    expect(res.settings.updatedAt).toBe(100);
    // credentials survive untouched
    expect(res.settings.upstash).toEqual({
      url: "https://x.upstash.io",
      token: "secret",
    });
  });

  it("reports error (never throws) when the fetch fails", async () => {
    const mock = vi.fn(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    await expect(pullCloudSettings(sampleSettings())).resolves.toEqual({
      outcome: "error",
    });
  });
});
