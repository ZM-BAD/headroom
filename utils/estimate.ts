/**
 * Token estimation engine (spec 001 core → 004 upgrade). Tokens are always
 * *estimated* from text via a per-script coefficient model — never trusted
 * from the platform:
 *
 *   tokens(text) = Σ over scripts s [ count(text, s) × coeff[s] ]
 *
 * v2 (spec 004): six writing-systems, each with an independent coefficient.
 *   Char-based (counted per character):
 *     - CJK Unified Ideographs   \p{Unified_Ideograph}
 *     - Japanese kana            \p{Hiragana} + \p{Katakana}
 *     - Korean Hangul            \p{Hangul}
 *   Word-based (counted per whitespace-separated word):
 *     - Cyrillic  \p{Cyrillic}
 *     - Arabic    \p{Arabic}
 *     - Latin     everything else (fallback bucket)
 *
 * A word is classified into EXACTLY one word bucket (Cyrillic > Arabic >
 * Latin), and pure-CJK/kana/Hangul characters are NOT double-counted as
 * words — the same guard v1 had for CJK-vs-Latin.
 */

/** Per-platform, per-script token coefficients. Six fields, all required. */
export interface TokenCoefficients {
  /** tokens per CJK character. */
  cjk: number;
  /** tokens per kana (hiragana + katakana) character. */
  kana: number;
  /** tokens per Hangul character. */
  hangul: number;
  /** tokens per Cyrillic word. */
  cyrillic: number;
  /** tokens per Arabic word. */
  arabic: number;
  /** tokens per Latin (and anything else) word. */
  latin: number;
}

/**
 * Placeholder coefficients (spec 004 §5). Used by every adapter until
 * per-platform calibration completes. NOT part of the runtime resolution
 * chain — each adapter's `tokenCoefficients` is required; this constant
 * only serves as the initial value for those fields and for unit tests.
 */
export const DEFAULT_COEFFICIENTS: TokenCoefficients = {
  cjk: 0.6,
  kana: 0.5,
  hangul: 0.5,
  cyrillic: 0.5,
  arabic: 0.5,
  latin: 0.5,
};

// ---- Unicode property-escape regexes (all require `u` flag) ----
// RegExp constructors bypass TS's limited Unicode property-name validation
// (regex literals with \p{…} trigger TS1529 for non-ASCII property names).
// All properties verified at runtime (Node 22+ / Chrome 64+).

const RE_CJK = new RegExp("\\p{Unified_Ideograph}", "u");
const RE_HIRAGANA = new RegExp("\\p{Script=Hiragana}", "u");
const RE_KATAKANA = new RegExp("\\p{Script=Katakana}", "u");
const RE_HANGUL = new RegExp("\\p{Script=Hangul}", "u");
const RE_CYRILLIC = new RegExp("\\p{Script=Cyrillic}", "u");
const RE_ARABIC = new RegExp("\\p{Script=Arabic}", "u");

// ---- character-level classifiers (char-based scripts) ----

function isCJK(ch: string): boolean {
  return RE_CJK.test(ch);
}

function isKana(ch: string): boolean {
  return RE_HIRAGANA.test(ch) || RE_KATAKANA.test(ch);
}

function isHangul(ch: string): boolean {
  return RE_HANGUL.test(ch);
}

function isCyrillic(ch: string): boolean {
  return RE_CYRILLIC.test(ch);
}

function isArabic(ch: string): boolean {
  return RE_ARABIC.test(ch);
}

// ---- public API ----

/**
 * Estimate the token count of `text` under the given coefficients.
 *
 * Char-based scripts (CJK, kana, Hangul): counted per character.
 * Word-based scripts (Cyrillic, Arabic, Latin): counted per whitespace-
 * separated word, each word assigned to at most one bucket.
 *
 * Single-pass: one iteration counts char-based scripts AND classifies
 * word-based scripts on whitespace boundaries. Chinese has no whitespace
 * delimiters, so the old two-pass approach (`split` + `[...tok]`) allocated
 * an array of every single character on long Chinese texts — a GC bomb.
 */
export function estimateTokens(text: string, coeff: TokenCoefficients): number {
  if (!text) return 0;

  let cjkChars = 0;
  let kanaChars = 0;
  let hangulChars = 0;
  let cyrillicWords = 0;
  let arabicWords = 0;
  let latinWords = 0;

  // Word classification state: accumulated across chars between whitespace.
  // Priority: Cyrillic (3) > Arabic (2) > Latin (1) > pure-char-based (0).
  let inWord = false;
  let wordClass = 0;

  for (const ch of text) {
    // Whitespace delimits words — flush the completed word.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (inWord) {
        if (wordClass === 3) cyrillicWords++;
        else if (wordClass === 2) arabicWords++;
        else if (wordClass === 1) latinWords++;
        // wordClass 0: pure CJK/kana/Hangul — already counted per-char
        inWord = false;
        wordClass = 0;
      }
      continue;
    }

    inWord = true;

    // Char-based: count per character, don't upgrade wordClass.
    if (isCJK(ch)) {
      cjkChars++;
      continue;
    }
    if (isKana(ch)) {
      kanaChars++;
      continue;
    }
    if (isHangul(ch)) {
      hangulChars++;
      continue;
    }

    // Word-based: classify the current word (precedence: Cyrillic > Arabic > Latin).
    if (isCyrillic(ch)) {
      wordClass = 3;
    } else if (isArabic(ch)) {
      if (wordClass < 2) wordClass = 2;
    } else {
      if (wordClass < 1) wordClass = 1;
    }
  }

  // Flush the last word (text may not end with whitespace).
  if (inWord) {
    if (wordClass === 3) cyrillicWords++;
    else if (wordClass === 2) arabicWords++;
    else if (wordClass === 1) latinWords++;
  }

  return (
    cjkChars * coeff.cjk +
    kanaChars * coeff.kana +
    hangulChars * coeff.hangul +
    cyrillicWords * coeff.cyrillic +
    arabicWords * coeff.arabic +
    latinWords * coeff.latin
  );
}
