import { describe, expect, it } from "vitest";

import {
  DEFAULT_THRESHOLDS,
  levelFromRatio,
  pctToRatio,
  type Thresholds,
} from "./thresholds";

/**
 * levelFromRatio decides the warning color (green/yellow/red) shown to the
 * user. The spec pins the default boundaries at 50% / 70%, and off-by-one on a
 * boundary flips the wrong color — so these pin every edge exactly.
 */
describe("levelFromRatio", () => {
  const t: Thresholds = { yellow: 0.5, red: 0.7 };

  it("is green just below the yellow threshold", () => {
    expect(levelFromRatio(0, t)).toBe("green");
    expect(levelFromRatio(0.49, t)).toBe("green");
  });

  it("turns yellow AT the yellow threshold (inclusive lower bound)", () => {
    expect(levelFromRatio(0.5, t)).toBe("yellow");
  });

  it("stays yellow between yellow and red", () => {
    expect(levelFromRatio(0.6, t)).toBe("yellow");
    expect(levelFromRatio(0.69, t)).toBe("yellow");
  });

  it("turns red AT the red threshold (inclusive lower bound)", () => {
    expect(levelFromRatio(0.7, t)).toBe("red");
  });

  it("is red at full context (100%)", () => {
    expect(levelFromRatio(1, t)).toBe("red");
  });

  it("respects custom thresholds, not the hardcoded defaults", () => {
    const strict: Thresholds = { yellow: 0.3, red: 0.6 };
    expect(levelFromRatio(0.35, strict)).toBe("yellow"); // would be green by default
    expect(levelFromRatio(0.55, strict)).toBe("yellow");
    expect(levelFromRatio(0.6, strict)).toBe("red");
  });

  it("has yellow < red in the shipped defaults", () => {
    // Guard against a config typo that would invert the zones.
    expect(DEFAULT_THRESHOLDS.yellow).toBeLessThan(DEFAULT_THRESHOLDS.red);
  });
});

describe("pctToRatio", () => {
  it("converts percent to ratio", () => {
    expect(pctToRatio(50)).toBe(0.5);
    expect(pctToRatio(100)).toBe(1);
  });

  it("clamps above 100% to 1", () => {
    expect(pctToRatio(150)).toBe(1);
    expect(pctToRatio(1000)).toBe(1);
  });

  it("clamps below 0% to 0", () => {
    expect(pctToRatio(-10)).toBe(0);
  });
});
