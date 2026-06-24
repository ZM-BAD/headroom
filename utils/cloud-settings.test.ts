import { describe, expect, it } from "vitest";
import { toCloudSettings, mergeCloudSettings } from "./cloud-settings";
import type { Settings } from "./settings";

function sampleSettings(): Settings {
  return {
    thresholds: { yellow: 0.5, red: 0.7 },
    language: "auto",
    upstash: { url: "https://x.upstash.io", token: "secret" },
    contextLimits: { deepseek: 1_000_000 },
  };
}

describe("toCloudSettings", () => {
  it("copies syncable fields and stamps updatedAt", () => {
    const cloud = toCloudSettings(sampleSettings(), 12345);
    expect(cloud).toEqual({
      thresholds: { yellow: 0.5, red: 0.7 },
      language: "auto",
      contextLimits: { deepseek: 1_000_000 },
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
        updatedAt: 100,
      },
      10,
    );
    expect(merged.thresholds).toEqual({ yellow: 0.6, red: 0.8 });
    expect(merged.language).toBe("zh_CN");
    expect(merged.contextLimits).toEqual({ deepseek: 2_000_000 });
    // credentials survive untouched
    expect(merged.upstash).toEqual({
      url: "https://x.upstash.io",
      token: "secret",
    });
  });

  it("keeps local when cloud is older or equal", () => {
    const local = sampleSettings();
    const merged = mergeCloudSettings(
      local,
      {
        thresholds: { yellow: 0.9, red: 0.99 },
        language: "zh_CN",
        contextLimits: {},
        updatedAt: 5,
      },
      10,
    );
    expect(merged.thresholds).toEqual({ yellow: 0.5, red: 0.7 });
    expect(merged.language).toBe("auto");
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
        updatedAt: 100,
      },
      1,
    );
    expect(local.thresholds).toEqual({ yellow: 0.5, red: 0.7 });
    expect(local.language).toBe("auto");
  });
});
