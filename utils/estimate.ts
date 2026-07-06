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

/** A character that belongs to ANY char-based script (not word-classified). */
function isCharBased(ch: string): boolean {
  return isCJK(ch) || isKana(ch) || isHangul(ch);
}

// ---- word-level classifiers (word-based scripts) ----

/**
 * Classify a non-empty whitespace-separated token into exactly one word
 * bucket. Priority: Cyrillic > Arabic > Latin. A word composed entirely of
 * char-based characters (CJK/kana/Hangul) returns null — those are already
 * counted per-character and must not be double-counted.
 */
function wordBucket(chars: string[]): "cyrillic" | "arabic" | "latin" | null {
  let hasCyrillic = false;
  let hasArabic = false;
  let hasWordBased = false;

  for (const ch of chars) {
    if (isCyrillic(ch)) hasCyrillic = true;
    else if (isArabic(ch)) hasArabic = true;
    else if (!isCharBased(ch)) hasWordBased = true;
  }

  if (hasCyrillic) return "cyrillic";
  if (hasArabic) return "arabic";
  if (hasWordBased) return "latin";
  return null; // pure CJK/kana/Hangul token — already counted per-char
}

// ---- public API ----

/**
 * Estimate the token count of `text` under the given coefficients.
 *
 * Char-based scripts (CJK, kana, Hangul): counted per character.
 * Word-based scripts (Cyrillic, Arabic, Latin): counted per whitespace-
 * separated word, each word assigned to at most one bucket.
 */
export function estimateTokens(text: string, coeff: TokenCoefficients): number {
  if (!text) return 0;

  // ---- pass 1: char-based scripts (per-character) ----
  let cjkChars = 0;
  let kanaChars = 0;
  let hangulChars = 0;

  for (const ch of text) {
    if (isCJK(ch)) cjkChars++;
    else if (isKana(ch)) kanaChars++;
    else if (isHangul(ch)) hangulChars++;
  }

  // ---- pass 2: word-based scripts (per whitespace-separated token) ----
  let cyrillicWords = 0;
  let arabicWords = 0;
  let latinWords = 0;

  const tokens = text.split(/\s+/);
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    const chars = [...tok];
    const bucket = wordBucket(chars);
    switch (bucket) {
      case "cyrillic":
        cyrillicWords++;
        break;
      case "arabic":
        arabicWords++;
        break;
      case "latin":
        latinWords++;
        break;
      // null: pure char-based token → already counted, skip
    }
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
