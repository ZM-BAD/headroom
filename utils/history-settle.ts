import type { HistoryRound } from "./platform-adapter";

/**
 * Bounded backoff schedule for re-fetching an unsettled history (ms).
 * Measured live on Doubao (2026-07, Playwright): the bot message lands in the
 * IM chain 0–1s+ AFTER the completion request closes — onCompleted+473ms →
 * absent, +948ms → present, with round-to-round jitter. Three retries over
 * 3.5s cover that window with margin; if the history is still unsettled after
 * that (e.g. the user genuinely stopped generation), ship as-is.
 */
export const SETTLE_RETRY_DELAYS_MS = [500, 1000, 2000] as const;

/**
 * Does a fetched history look "settled" — safe to ship? Unsettled = the
 * NEWEST round has an empty answerText, which on an eventually-consistent
 * platform (Doubao's IM chain) means the bot message has not been persisted
 * yet: shipping now would record the round with 0 output tokens until the
 * next trigger re-fetches. Only the newest round is checked — an older empty
 * answer is a historic stopped-generation, not a pending write.
 *
 * Rounds are ascending (oldest first) — every adapter's fetchHistory returns
 * that order. An empty array is settled: nothing was fetched, so there is
 * nothing to wait for (the caller already skips shipping empty results).
 */
export function historySettled(rounds: readonly HistoryRound[]): boolean {
  if (rounds.length === 0) return true;
  return rounds[rounds.length - 1].answerText !== "";
}
