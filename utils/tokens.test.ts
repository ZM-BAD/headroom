import { describe, expect, it } from "vitest";

import { estimateTokens } from "./tokens";

/**
 * estimateTokens drives the side-panel gauge value, so a wrong estimate shows a
 * wrong percentage with no crash — the most insidious kind of bug. These cases
 * pin the CJK≈1/char and latin≈4chars/token heuristic and its boundaries.
 */
describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("treats pure ASCII as ≈4 chars/token (rounds)", () => {
    // "hello world" = 11 chars (incl. space) → round(11 / 4) = round(2.75) = 3
    expect(estimateTokens("hello world")).toBe(3);
    // exact multiple → no rounding drift
    expect(estimateTokens("abcd")).toBe(1); // 4/4
    expect(estimateTokens("abcdefgh")).toBe(2); // 8/4
  });

  it("counts CJK ideographs as 1 token each", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("字")).toBe(1);
  });

  it("counts CJK punctuation + kana + full-width as CJK (1 token each)", () => {
    // U+3000–U+30FF (CJK punctuation, hiragana, katakana)
    expect(estimateTokens("こんにちは")).toBe(5); // hiragana
    // U+FF00–U+FFEF (fullwidth forms) — 。 is U+3002, ！ is U+FF01
    expect(estimateTokens("你好！")).toBe(3); // 2 ideographs + 1 fullwidth
  });

  it("mixes CJK and ASCII, summing each group separately", () => {
    // "你好abc": CJK 2 + ASCII 3 → round(2 + 3/4) = round(2.75) = 3
    expect(estimateTokens("你好abc")).toBe(3);
    // "ab你好": same char set, order-independent → 3
    expect(estimateTokens("ab你好")).toBe(3);
  });

  it("counts emoji as non-CJK (≈4 chars/token per code point)", () => {
    // 😀 is U+1F600 — outside all three CJK ranges, so it lands in "other".
    // A lone emoji → round(1/4) = round(0.25) = 0. This documents that the
    // heuristic UNDERCOUNTS emoji (one emoji is really ≥1 token); accepted for v1.
    expect(estimateTokens("😀")).toBe(0);
  });

  it("is monotonic: longer text (same script) never yields fewer tokens", () => {
    const a = estimateTokens("hello");
    const b = estimateTokens("hello world!");
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
