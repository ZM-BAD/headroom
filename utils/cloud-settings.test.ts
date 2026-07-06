import { describe, expect, it } from "vitest";
import { toCloudSettings, mergeCloudSettings } from "./cloud-settings";
import type { Settings } from "./settings";

function sampleSettings(): Settings {
  return {
    thresholds: { yellow: 0.5, red: 0.7 },
    language: "auto",
    upstash: { url: "https://x.upstash.io", token: "secret" },
    contextLimits: { deepseek: 1_048_576 },
    tokenCoefficients: {},
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
    const merged = mergeCloudSettings(
      local,
      {
        thresholds: { yellow: 0.6, red: 0.8 },
        language: "zh_CN",
        contextLimits: { deepseek: 2_000_000 },
        tokenCoefficients: { deepseek: { kana: 0.4 } },
        updatedAt: 100,
      },
      10,
    );
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

  it("keeps local when cloud is older or equal", () => {
    const local = sampleSettings();
    local.tokenCoefficients = { deepseek: { cjk: 0.6 } };
    const merged = mergeCloudSettings(
      local,
      {
        thresholds: { yellow: 0.9, red: 0.99 },
        language: "zh_CN",
        contextLimits: {},
        tokenCoefficients: { deepseek: { cjk: 0.9 } },
        updatedAt: 5,
      },
      10,
    );
    expect(merged.thresholds).toEqual({ yellow: 0.5, red: 0.7 });
    expect(merged.language).toBe("auto");
    expect(merged.tokenCoefficients).toEqual({ deepseek: { cjk: 0.6 } });
  });

  it("keeps local when cloud is null", () => {
    const local = sampleSettings();
    expect(mergeCloudSettings(local, null, 10)).toEqual(local);
  });

  it("does not mutate the input local settings", () => {
    const local = sampleSettings();
    mergeCloudSettings(
      local,
      {
        thresholds: { yellow: 0.6, red: 0.8 },
        language: "en",
        contextLimits: {},
        tokenCoefficients: {},
        updatedAt: 100,
      },
      1,
    );
    expect(local.thresholds).toEqual({ yellow: 0.5, red: 0.7 });
    expect(local.language).toBe("auto");
  });
});
