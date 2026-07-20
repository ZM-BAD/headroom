/**
 * Per-dialogue record persisted to Upstash at key
 * `headroom:conv:{platform}:{dialogueId}`. One JSON value per dialogue =
 * fewest round-trips over the HTTPS REST API.
 */

export interface RoundRecord {
  /** Stable platform identity for this round (spec 003 union-merge key). */
  messageId: string;
  /** Chronological order key (ascending = oldest first); display `n` is derived from this post-merge. */
  order: number;
  /** 1-based DISPLAY position within the dialogue (assigned post-merge, ascending by `order`). Not a merge key. */
  n: number;
  promptTokens: number;
  answerTokens: number;
  /** promptTokens + answerTokens. */
  total: number;
  /** Wall-clock epoch ms when this round was created on the platform. */
  createdAt: number;
}

export interface DialogueRecord {
  platformId: string;
  dialogueId: string;
  contextLimit: number;
  /** sum of every round's total. */
  totalTokens: number;
  roundCount: number;
  rounds: RoundRecord[];
  updatedAt: number;
}

export function emptyDialogue(
  platformId: string,
  dialogueId: string,
  contextLimit: number,
): DialogueRecord {
  return {
    platformId,
    dialogueId,
    contextLimit,
    totalTokens: 0,
    roundCount: 0,
    rounds: [],
    updatedAt: 0,
  };
}

/** Cap on retained per-round history in the Upstash record — keeps the JSON
 * payload bounded over long conversations. totalTokens/roundCount stay accurate
 * (running sum + true count) even when older rounds are trimmed from the array.
 * Exported so the trim-invariant test can reference the live value rather than
 * hardcoding a copy that drifts. */
export const MAX_RETAINED_ROUNDS = 200;

/**
 * Upsert a round (keyed by `n`) into a rounds array — REPLACE if `n` exists,
 * append otherwise. Returns a NEW array (pure). Shared by `upsertRound` (the
 * Upstash record) and the active-state's trimmed display rounds, so both use
 * identical replace-vs-append semantics.
 */
export function upsertRoundInto(
  rounds: RoundRecord[],
  round: Pick<
    RoundRecord,
    "messageId" | "order" | "n" | "promptTokens" | "answerTokens" | "createdAt"
  >,
): RoundRecord[] {
  const total = round.promptTokens + round.answerTokens;
  const idx = rounds.findIndex((r) => r.messageId === round.messageId);
  if (idx >= 0) {
    const copy = rounds.slice();
    copy[idx] = { ...round, total };
    return copy;
  }
  return [...rounds, { ...round, total }];
}

/**
 * Merge cloud-retained rounds with history-derived rounds, keyed by stable
 * `messageId` (spec 003 union merge). Array-level pure function — does NOT
 * touch totalTokens/roundCount; the caller rebuilds those by feeding the
 * result through upsertRound (which recomputes the running-sum invariant).
 *
 * Conflict rule: history WINS. History is the platform's live truth, freshly
 * re-estimated, so its token count overwrites the cloud's stale value for the
 * same messageId.
 *
 * Survival rule: cloud-only rounds (messageId present in cloud but absent from
 * history because the platform's history API paginated/truncated them) are
 * RETAINED with their stored estimate — the anti-data-loss guarantee.
 *
 * Why messageId, not positional n: positional `n` is "this fetch's array
 * index", not a stable identity — when the platform's returned round set
 * changes (truncation / pagination-walk failure / single-message delete /
 * regenerate), positional n shifts and merges different real rounds onto the
 * same n, silently corrupting totals. messageId is the platform's stable
 * per-round id, so the same real round keys the same across fetches.
 *
 * Result is ascending by `order`, display `n` reassigned 1..k, trimmed to
 * MAX_RETAINED_ROUNDS. Pure: neither input array is mutated.
 */
export function unionRounds(
  cloud: RoundRecord[],
  history: RoundRecord[],
): RoundRecord[] {
  const byId = new Map<string, RoundRecord>();
  // Cloud first (lower priority), then history overwrites on same messageId.
  for (const r of cloud) byId.set(r.messageId, r);
  for (const r of history) byId.set(r.messageId, r);
  return [...byId.values()]
    .sort((a, b) => a.order - b.order)
    .map((r, i) => ({ ...r, n: i + 1 })) // display n, ascending by order
    .slice(-MAX_RETAINED_ROUNDS);
}

export function upsertRound(
  record: DialogueRecord | null,
  platformId: string,
  dialogueId: string,
  contextLimit: number,
  round: Pick<
    RoundRecord,
    "messageId" | "order" | "n" | "promptTokens" | "answerTokens" | "createdAt"
  >,
): DialogueRecord {
  const base = record ?? emptyDialogue(platformId, dialogueId, contextLimit);
  const total = round.promptTokens + round.answerTokens;
  const idx = base.rounds.findIndex((r) => r.messageId === round.messageId);
  // Replace the existing round (same messageId): subtract its old total, add
  // the new one. Keeps the running-sum invariant intact (totalTokens is the
  // true lifetime sum even when older rounds are trimmed out of the array).
  const totalTokens =
    idx >= 0
      ? base.totalTokens - base.rounds[idx].total + total
      : base.totalTokens + total;
  const rounds = upsertRoundInto(base.rounds, round).slice(
    -MAX_RETAINED_ROUNDS,
  );
  return {
    ...base,
    platformId,
    dialogueId,
    contextLimit,
    // True round count = the highest display n seen (monotonic), independent of
    // how many rounds are retained.
    roundCount: Math.max(base.roundCount, round.n),
    totalTokens,
    rounds,
    updatedAt: Date.now(),
  };
}

/**
 * The gauge's read of a DialogueRecord (spec 001 → "仪表盘从 DialogueRecord
 * 投影": 累计=totalTokens, 轮次=roundCount, 最近轮=rounds[last].total). This is
 * the SINGLE local source of truth for the side panel — there is no parallel
 * running tally.
 *
 * Reads `totalTokens` / `roundCount` straight off the record (the true lifetime
 * values) — it must NOT re-sum the retained `rounds[]`, which is trimmed and
 * would under-count (the trim-but-keep-totals invariant). Pure; the caller
 * (background) wraps this into the wire `UsageState` with platformId/contextLimit.
 */
export interface UsageProjection {
  totalTokens: number;
  roundCount: number;
  /** The last round's total (`rounds[last].total`), or null if no rounds yet. */
  lastRoundTokens: number | null;
  /** The retained rounds (already bounded by MAX_RETAINED_ROUNDS). */
  rounds: RoundRecord[];
}

export function projectUsage(record: DialogueRecord | null): UsageProjection {
  if (!record || record.rounds.length === 0) {
    return {
      totalTokens: record?.totalTokens ?? 0,
      roundCount: record?.roundCount ?? 0,
      lastRoundTokens: null,
      rounds: [],
    };
  }
  const last = record.rounds[record.rounds.length - 1];
  return {
    totalTokens: record.totalTokens,
    roundCount: record.roundCount,
    lastRoundTokens: last.total,
    rounds: record.rounds,
  };
}
