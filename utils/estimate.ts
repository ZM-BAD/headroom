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

/**
 * Resolve the effective token coefficients for a platform: user override
 * takes precedence, then the adapter default. Pure — the caller supplies
 * adapter + settings and gets back a complete TokenCoefficients.
 */
export function resolveCoefficients(
  adapter: { platformId: string; tokenCoefficients: TokenCoefficients },
  settings: { tokenCoefficients?: Record<string, Partial<TokenCoefficients>> },
): TokenCoefficients {
  const overrides = settings.tokenCoefficients?.[adapter.platformId];
  if (!overrides) return adapter.tokenCoefficients;
  return {
    cjk: overrides.cjk ?? adapter.tokenCoefficients.cjk,
    kana: overrides.kana ?? adapter.tokenCoefficients.kana,
    hangul: overrides.hangul ?? adapter.tokenCoefficients.hangul,
    cyrillic: overrides.cyrillic ?? adapter.tokenCoefficients.cyrillic,
    arabic: overrides.arabic ?? adapter.tokenCoefficients.arabic,
    latin: overrides.latin ?? adapter.tokenCoefficients.latin,
  };
}

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
const RE_DIGIT = new RegExp("\\p{N}", "u");

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

/**
 * Any Unicode digit (\p{N} — includes full-width digits). NOTE: \p{N} also
 * matches Nl/No (U+3007 〇, ½, ², ①, Roman numerals) — they land in the
 * digit bucket, not CJK; magnitudes are tiny and the BPE side splits them
 * similarly, so this is accepted.
 */
function isDigit(ch: string): boolean {
  // ASCII fast path: \d{0-9} dominates real text; the regex stays for
  // full-width digits (\p{N}).
  return (ch >= "0" && ch <= "9") || RE_DIGIT.test(ch);
}

// ---- public API ----

/**
 * Estimate the token count of `text` under the given coefficients.
 *
 * Char-based scripts (CJK, kana, Hangul): counted per character.
 * Word-based scripts (Cyrillic, Arabic, Latin): counted per whitespace-
 * separated word, each word assigned to at most one bucket.
 *
 * Sub-word heuristic (added 2026-08-17, spec 006): DIGIT RUNS are counted
 * per `\p{N}{1,3}` chunk instead of as one word. BPE tokenizers split digit
 * strings into 1–3-digit tokens (Kimi's pat_str literally carries
 * `\p{N}{1,3}`; Qwen/DeepSeek tokenizers behave the same), so a dense
 * numeric/date string like "2026年8月11日" was measured as ONE latin word
 * (~1.4 tokens) while the real tokenizer emits ~4–5 — a 20–45% systematic
 * UNDERESTIMATE on tool text (search snippets, dates, stats) measured in
 * spec 006 calibration. Chunked counting fixes the largest source of that
 * bias without touching the 6-bucket structure. Deliberate approximation:
 * a digit run does NOT split the surrounding word ("qwen3.6-27b" = 1 word +
 * 3 chunks, BPE emits ~5) — the heuristic targets dense numeric text, and
 * splitting letters would over-correct prose. Don't "fix" it into a
 * regression without re-running scripts/calibrate-tool-text.mjs.
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

  // Digit-run state: consecutive \p{N} characters form one run, counted as
  // ceil(len/3) sub-words (BPE \p{N}{1,3}) — flushed on any non-digit char.
  let digitRun = 0;

  const flushDigitRun = (): void => {
    if (digitRun > 0) {
      latinWords += Math.ceil(digitRun / 3);
      digitRun = 0;
    }
  };

  for (const ch of text) {
    // Whitespace delimits words — flush the completed word + digit run.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      flushDigitRun();
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

    // Digit runs: counted per \p{N}{1,3} chunk, NOT as part of a word
    // (spec 006 — word-level counting underestimates dense numeric text).
    if (isDigit(ch)) {
      digitRun++;
      continue;
    }
    flushDigitRun();

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

  // Flush the last word + digit run (text may not end with whitespace).
  flushDigitRun();
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
