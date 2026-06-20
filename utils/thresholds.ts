/**
 * Warning-threshold model + level computation. Shared by the side panel and
 * (Phase 2+) the background so both agree on colors.
 *
 * Two boundaries → three zones:
 *   green  (安全/safe)     : ratio < yellow
 *   yellow (中度/moderate) : yellow ≤ ratio < red
 *   red    (紧张/tight)    : ratio ≥ red
 */

export interface Thresholds {
  /** ratio ≥ this turns the bar yellow (default 0.5 = 50%) */
  yellow: number;
  /** ratio ≥ this turns the bar red (default 0.7 = 70%) */
  red: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { yellow: 0.5, red: 0.7 };

export type Level = "idle" | "green" | "yellow" | "red";

export function levelFromRatio(ratio: number, t: Thresholds): Level {
  if (ratio >= t.red) return "red";
  if (ratio >= t.yellow) return "yellow";
  return "green";
}

/** Integer percent (0–100) → ratio (0–1), clamped. */
export function pctToRatio(pct: number): number {
  return Math.min(1, Math.max(0, pct / 100));
}
