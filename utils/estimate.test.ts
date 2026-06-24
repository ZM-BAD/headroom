import { describe, expect, it } from "vitest";
import { estimateTokens, type TokenCoefficients } from "./estimate";

/** DeepSeek v1 reference coefficients (cjk ≈ 0.6/字, latin ≈ 0.5/词). */
const DEEPSEEK: TokenCoefficients = { cjk: 0.6, latin: 0.5 };

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("", DEEPSEEK)).toBe(0);
  });

  it("counts CJK characters per-char (cjk coefficient)", () => {
    // 你好世界 = 4 hanzi, 0 Latin words
    expect(estimateTokens("你好世界", DEEPSEEK)).toBeCloseTo(4 * 0.6);
  });

  it("counts Latin per whitespace-separated word (latin coefficient)", () => {
    expect(estimateTokens("hello world", DEEPSEEK)).toBeCloseTo(2 * 0.5);
  });

  it("splits words on any whitespace (tabs, newlines)", () => {
    expect(estimateTokens("a\tb\nc", DEEPSEEK)).toBeCloseTo(3 * 0.5);
  });

  it("counts CJK chars and Latin words independently in mixed text", () => {
    // "Hi 你好": 2 hanzi (你,好) + 1 Latin word (Hi)
    expect(estimateTokens("Hi 你好", DEEPSEEK)).toBeCloseTo(2 * 0.6 + 1 * 0.5);
  });

  it("does not double-count a pure-CJK token as a Latin word", () => {
    expect(estimateTokens("你好", DEEPSEEK)).toBeCloseTo(2 * 0.6);
  });

  it("treats digits/punctuation as Latin (v1: non-CJK scripts fall into the Latin bucket)", () => {
    // "123 !!! abc" → 3 non-CJK tokens
    expect(estimateTokens("123 !!! abc", DEEPSEEK)).toBeCloseTo(3 * 0.5);
  });

  it("is parameterized by the platform coefficients", () => {
    // A Qwen-like tokenizer weighs hanzi heavier (0.8 vs 0.6)
    const qwen: TokenCoefficients = { cjk: 0.8, latin: 0.5 };
    expect(estimateTokens("你好", qwen)).toBeCloseTo(2 * 0.8);
  });
});
