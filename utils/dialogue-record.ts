/**
 * Per-dialogue record persisted to Upstash at key
 * `headroom:conv:{platform}:{dialogueId}`. One JSON value per dialogue =
 * fewest round-trips over the HTTPS REST API.
 */

export interface RoundRecord {
  /** 1-based round number within the dialogue. */
  n: number;
  promptTokens: number;
  answerTokens: number;
  /** promptTokens + answerTokens. */
  total: number;
  /** epoch ms */
  ts: number;
}

export interface DialogueRecord {
  platform: string;
  dialogueId: string;
  contextLimit: number;
  /** sum of every round's total. */
  totalTokens: number;
  roundCount: number;
  rounds: RoundRecord[];
  updatedAt: number;
}

export function emptyDialogue(
  platform: string,
  dialogueId: string,
  contextLimit: number,
): DialogueRecord {
  return {
    platform,
    dialogueId,
    contextLimit,
    totalTokens: 0,
    roundCount: 0,
    rounds: [],
    updatedAt: 0,
  };
}

/**
 * Upsert a round (keyed by its 1-based `n`) into a (possibly null) record,
 * recomputing totals. If a round with the same `n` already exists (the same
 * assistant message re-emitting as it streams in >1.5s-gap bursts), its token
 * counts are REPLACED — not appended — so one real round is always counted
 * exactly once. Pure — the caller persists via the Upstash client.
 */
/** Cap on retained per-round history in the Upstash record — keeps the JSON
 * payload bounded over long conversations. totalTokens/roundCount stay accurate
 * (running sum + true count) even when older rounds are trimmed from the array.
 * Exported so the trim-invariant test can reference the live value rather than
 * hardcoding a copy that drifts. */
export const MAX_RETAINED_ROUNDS = 200;

export function upsertRound(
  record: DialogueRecord | null,
  platform: string,
  dialogueId: string,
  contextLimit: number,
  round: Pick<RoundRecord, "n" | "promptTokens" | "answerTokens" | "ts">,
): DialogueRecord {
  const base = record ?? emptyDialogue(platform, dialogueId, contextLimit);
  const total = round.promptTokens + round.answerTokens;
  const idx = base.rounds.findIndex((r) => r.n === round.n);
  let rounds: RoundRecord[];
  let totalTokens: number;
  if (idx >= 0) {
    // Replace the existing round: subtract its old total, add the new one. Keeps
    // the running-sum invariant intact (totalTokens is the true lifetime sum even
    // when older rounds are trimmed out of the retained array).
    const old = base.rounds[idx];
    rounds = base.rounds.slice();
    rounds[idx] = { ...round, total };
    totalTokens = base.totalTokens - old.total + total;
  } else {
    rounds = [...base.rounds, { ...round, total }];
    totalTokens = base.totalTokens + total;
  }
  return {
    ...base,
    platform,
    dialogueId,
    contextLimit,
    // True round count = the highest round number seen (monotonic in `n`),
    // independent of how many rounds are retained.
    roundCount: Math.max(base.roundCount, round.n),
    totalTokens,
    rounds: rounds.slice(-MAX_RETAINED_ROUNDS),
    updatedAt: Date.now(),
  };
}
