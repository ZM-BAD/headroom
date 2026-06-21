import type { UsageState } from "./messages";

/**
 * The last round the LOCAL tally saw — used to de-dupe a round that re-emits as
 * it streams (mirrors the Upstash upsert). Carries `dialogueId` so a round from
 * a DIFFERENT conversation (same platform, same roundId — e.g. round 1 of chat A
 * vs round 1 of chat B) does NOT dedup against it. That was the cross-conversation
 * mis-count bug (C1).
 */
export interface LastRound {
  platformId: string;
  dialogueId: string | null;
  roundId: number;
  tokens: number;
}

export interface LocalRound {
  platformId: string;
  dialogueId: string | null;
  roundId: number;
  tokens: number;
}

/**
 * Pure local-tally computation (no browser API) for the no-Upstash / null-
 * dialogueId fallback. Extracted from the background so it's unit-testable.
 *
 * - prev.platformId !== round.platformId (idle or a different platform): fresh
 *   count — the round is the first on this platform.
 * - Re-emit (same platform + dialogue + roundId — the same assistant message
 *   settling again mid-stream): REPLACE the round's tokens, keep the count.
 * - Otherwise (a genuinely new round in the same conversation): accumulate.
 *
 * `round.dialogueId` is the URL-tracked ACTIVE conversation (not the request-
 * body id, which is null for Gemini / Kimi's first send), so distinct chats are
 * isolated even when their roundIds collide.
 */
export function tallyLocalRound(
  prev: UsageState,
  last: LastRound | null,
  round: LocalRound,
): { totalTokens: number; roundCount: number } {
  if (prev.platformId !== round.platformId) {
    return { totalTokens: round.tokens, roundCount: 1 };
  }
  const isReemit =
    last !== null &&
    last.platformId === round.platformId &&
    last.dialogueId === round.dialogueId &&
    last.roundId === round.roundId;
  if (isReemit) {
    return {
      totalTokens: prev.totalTokens - last!.tokens + round.tokens,
      roundCount: prev.roundCount,
    };
  }
  return {
    totalTokens: prev.totalTokens + round.tokens,
    roundCount: prev.roundCount + 1,
  };
}
