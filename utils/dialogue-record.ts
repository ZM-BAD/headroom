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
 * Append a round to a (possibly null) record, recomputing totals. Pure — the
 * caller persists via the Upstash client, which stamps `updatedAt`.
 */
/** Cap on retained per-round history in the Upstash record — keeps the JSON
 * payload bounded over long conversations. totalTokens/roundCount stay accurate
 * (running sum + true count) even when older rounds are trimmed from the array.
 * Exported so the trim-invariant test can reference the live value rather than
 * hardcoding a copy that drifts. */
export const MAX_RETAINED_ROUNDS = 200;

export function appendRound(
  record: DialogueRecord | null,
  platform: string,
  dialogueId: string,
  contextLimit: number,
  round: Pick<RoundRecord, "promptTokens" | "answerTokens" | "ts">,
): DialogueRecord {
  const base = record ?? emptyDialogue(platform, dialogueId, contextLimit);
  const n = base.roundCount + 1;
  const total = round.promptTokens + round.answerTokens;
  const rounds = [...base.rounds, { ...round, n, total }];
  return {
    ...base,
    platform,
    dialogueId,
    contextLimit,
    roundCount: n,
    totalTokens: base.totalTokens + total,
    rounds: rounds.slice(-MAX_RETAINED_ROUNDS),
    updatedAt: Date.now(),
  };
}
