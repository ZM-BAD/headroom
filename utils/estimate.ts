/**
 * Token estimation engine (spec 001 core). Tokens are always *estimated* from
 * text via a per-script coefficient model — never trusted from the platform:
 *
 *   tokens(text) = Σ over scripts s [ count(text, s) × coeff(s, platform) ]
 *
 * The coefficient is platform-specific (each adapter provides its own; see
 * spec 001 -> "Token 估算引擎"). v1 supports two scripts:
 *   - CJK (Chinese hanzi): counted per character.
 *   - Latin (English etc.): counted per whitespace-separated word.
 * Every other script (Cyrillic, Arabic, Japanese kana, ...) falls into the
 * Latin bucket for v1; per-script coefficients arrive in spec 004.
 */

/** Per-platform, per-script token coefficients. Provided by each adapter. */
export interface TokenCoefficients {
  /** tokens per CJK character. */
  cjk: number;
  /** tokens per Latin word. */
  latin: number;
}

/**
 * v1 reference coefficients (DeepSeek: cjk ≈ 0.6/字, latin ≈ 0.5/词). Every
 * adapter starts here; spec 004 calibrates per-platform tokenizer differences
 * (e.g. Qwen/GPT weigh hanzi heavier). Placeholder values — not measured.
 */
export const DEFAULT_COEFFICIENTS: TokenCoefficients = { cjk: 0.6, latin: 0.5 };

/** CJK Unified Ideographs (v1: modern Chinese; kana / other scripts -> Latin). */
const CJK = /[一-鿿]/u;

function isCJK(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * Estimate the token count of `text` under the given platform coefficients.
 * CJK characters are counted per-char; every whitespace-separated token that
 * contains at least one non-CJK character counts as one Latin word — so a
 * pure-CJK token is not double-counted, and a mixed token counts both ways.
 */
export function estimateTokens(text: string, coeff: TokenCoefficients): number {
  if (!text) return 0;
  let cjkChars = 0;
  for (const ch of text) {
    if (isCJK(ch)) cjkChars++;
  }
  const latinWords = text
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && [...tok].some((c) => !isCJK(c))).length;
  return cjkChars * coeff.cjk + latinWords * coeff.latin;
}
