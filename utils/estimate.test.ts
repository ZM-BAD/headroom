import { describe, expect, it } from "vitest";
import {
  DEFAULT_COEFFICIENTS,
  estimateTokens,
  type TokenCoefficients,
} from "./estimate";

/** 6-field placeholder coefficients (same as DEFAULT_COEFFICIENTS for now). */
const PLACEHOLDER: TokenCoefficients = { ...DEFAULT_COEFFICIENTS };

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("", PLACEHOLDER)).toBe(0);
  });

  // ---- char-based scripts ----

  it("counts CJK characters per-char (cjk coefficient)", () => {
    // 你好世界 = 4 hanzi
    expect(estimateTokens("你好世界", PLACEHOLDER)).toBeCloseTo(4 * 0.6);
  });

  it("counts hiragana per-char (kana coefficient)", () => {
    // こんにちは = 5 hiragana
    expect(estimateTokens("こんにちは", PLACEHOLDER)).toBeCloseTo(5 * 0.5);
  });

  it("counts katakana per-char (kana coefficient — same bucket as hiragana)", () => {
    // コンニチハ = 5 katakana
    expect(estimateTokens("コンニチハ", PLACEHOLDER)).toBeCloseTo(5 * 0.5);
  });

  it("counts mixed hiragana + katakana together as kana", () => {
    // あイ = 2 kana
    expect(estimateTokens("あイ", PLACEHOLDER)).toBeCloseTo(2 * 0.5);
  });

  it("counts Hangul per-char (hangul coefficient)", () => {
    // 안녕하세요 = 5 hangul
    expect(estimateTokens("안녕하세요", PLACEHOLDER)).toBeCloseTo(5 * 0.5);
  });

  // ---- word-based scripts ----

  it("counts Cyrillic words (cyrillic coefficient)", () => {
    // "Привет мир" = 2 Cyrillic words
    expect(estimateTokens("Привет мир", PLACEHOLDER)).toBeCloseTo(2 * 0.5);
  });

  it("counts Arabic words (arabic coefficient)", () => {
    // "مرحبا بالعالم" = 2 Arabic words
    expect(estimateTokens("مرحبا بالعالم", PLACEHOLDER)).toBeCloseTo(2 * 0.5);
  });

  it("counts Latin per whitespace-separated word (latin coefficient)", () => {
    expect(estimateTokens("hello world", PLACEHOLDER)).toBeCloseTo(2 * 0.5);
  });

  // ---- mixed-script scenarios ----

  it("counts CJK + Hangul independently in mixed text", () => {
    // 日本語 = 3 kanji (CJK), 한국어 = 3 hangul
    expect(estimateTokens("日本語한국어", PLACEHOLDER)).toBeCloseTo(
      3 * 0.6 + 3 * 0.5,
    );
  });

  it("counts CJK + kana + Latin independently in mixed text", () => {
    // "漢字とカタカナhello" = 2 CJK + 5 kana(と+カタカナ) + 1 Latin word(hello)
    expect(estimateTokens("漢字とカタカナhello", PLACEHOLDER)).toBeCloseTo(
      2 * 0.6 + 5 * 0.5 + 1 * 0.5,
    );
  });

  it("counts char-based and word-based scripts independently in mixed text", () => {
    // "Hi 你好" = 1 Latin word (Hi) + 2 CJK (你好)
    expect(estimateTokens("Hi 你好", PLACEHOLDER)).toBeCloseTo(
      1 * 0.5 + 2 * 0.6,
    );
  });

  it("classifies a Cyrillic word even when mixed with Latin characters", () => {
    // "привет123" has Cyrillic chars → Cyrillic word (1), not Latin
    expect(estimateTokens("привет123", PLACEHOLDER)).toBeCloseTo(1 * 0.5);
  });

  it("classifies an Arabic word even when mixed with digits", () => {
    expect(estimateTokens("مرحبا123", PLACEHOLDER)).toBeCloseTo(1 * 0.5);
  });

  it("does not double-count a pure-CJK token as a Latin word", () => {
    expect(estimateTokens("你好", PLACEHOLDER)).toBeCloseTo(2 * 0.6);
  });

  it("does not double-count pure-kana as a word", () => {
    expect(estimateTokens("こんにちは", PLACEHOLDER)).toBeCloseTo(5 * 0.5);
  });

  it("does not double-count pure-Hangul as a word", () => {
    expect(estimateTokens("안녕", PLACEHOLDER)).toBeCloseTo(2 * 0.5);
  });

  it("splits words on any whitespace (tabs, newlines)", () => {
    expect(estimateTokens("a\tb\nc", PLACEHOLDER)).toBeCloseTo(3 * 0.5);
  });

  // ---- edge cases ----

  it("treats digits/punctuation as Latin (fallback bucket)", () => {
    // "123 !!!" → 2 Latin words (no char-based chars)
    expect(estimateTokens("123 !!! abc", PLACEHOLDER)).toBeCloseTo(3 * 0.5);
  });

  it("treats empty/whitespace-only strings as zero", () => {
    expect(estimateTokens("   \t\n  ", PLACEHOLDER)).toBe(0);
  });

  it("is parameterized by per-platform coefficients", () => {
    // A Qwen-like tokenizer: hanzi heavier (0.8 vs 0.6), kana 0.4
    const qwen: TokenCoefficients = {
      cjk: 0.8,
      kana: 0.4,
      hangul: 0.5,
      cyrillic: 0.5,
      arabic: 0.5,
      latin: 0.5,
    };
    // "你好" = 2 CJK
    expect(estimateTokens("你好", qwen)).toBeCloseTo(2 * 0.8);
    // "こんにちは" = 5 kana
    expect(estimateTokens("こんにちは", qwen)).toBeCloseTo(5 * 0.4);
  });

  it("uses all six coefficients independently", () => {
    const custom: TokenCoefficients = {
      cjk: 1,
      kana: 2,
      hangul: 3,
      cyrillic: 4,
      arabic: 5,
      latin: 6,
    };
    // 你 = CJK, あ = kana, 한 = hangul, "д" = Cyrillic, "ع" = Arabic, "a" = Latin
    expect(estimateTokens("你 あ 한 д ع a", custom)).toBeCloseTo(
      1 + 2 + 3 + 4 + 5 + 6,
    );
  });
});
