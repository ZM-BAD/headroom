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
  /** Search/tool tokens (spec 005): search-result text, opened pages, tool invocations. 0 = no tools this round. */
  toolTokens: number;
  answerTokens: number;
  /** promptTokens + toolTokens + answerTokens. */
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
 * Upsert input — `toolTokens` optional: callers that predate 005 (or a
 * stop-path without tool text) may omit it; it defaults to 0.
 */
export type RoundInput = Pick<
  RoundRecord,
  "messageId" | "order" | "n" | "promptTokens" | "answerTokens" | "createdAt"
> & { toolTokens?: number };

/**
 * Upsert a round (keyed by `n`) into a rounds array — REPLACE if `n` exists,
 * append otherwise. Returns a NEW array (pure). Shared by `upsertRound` (the
 * Upstash record) and the active-state's trimmed display rounds, so both use
 * identical replace-vs-append semantics.
 */
export function upsertRoundInto(
  rounds: RoundRecord[],
  round: RoundInput,
): RoundRecord[] {
  // toolTokens ?? 0 — legacy rounds (pre-005 records) may omit the field.
  const total =
    round.promptTokens + (round.toolTokens ?? 0) + round.answerTokens;
  const idx = rounds.findIndex((r) => r.messageId === round.messageId);
  if (idx >= 0) {
    const copy = rounds.slice();
    copy[idx] = { ...round, toolTokens: round.toolTokens ?? 0, total };
    return copy;
  }
  return [...rounds, { ...round, toolTokens: round.toolTokens ?? 0, total }];
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
    .map((r, i) => ({
      ...r,
      // spec 005: normalize legacy cloud rounds (pre-toolTokens) to 0 so every
      // record written back to Upstash carries the full field set.
      toolTokens: r.toolTokens ?? 0,
      n: i + 1, // display n, ascending by order
    }))
    .slice(-MAX_RETAINED_ROUNDS);
}

/**
 * The TRUE lifetime total after a cloud+history union (spec 003). The merged
 * rounds array is trimmed to MAX_RETAINED_ROUNDS (oldest dropped), so summing
 * it under-counts long dialogues. The cloud record carries the true running
 * total (which survives trimming — the trim-but-keep-totals invariant); this
 * adjusts it for the merge: history WINS on the same messageId (that round's
 * cloud contribution is replaced), brand-new history rounds add theirs,
 * cloud-only rounds keep theirs. For ≤MAX_RETAINED_ROUNDS dialogues the result
 * equals the naive merged-array sum — pure, so callers rebuild the record via
 * upsertRound and then restore this value.
 *
 * Duplicate messageIds within one fetch (pathological — no adapter produces
 * them today): the diff applies ONCE, from the LAST occurrence, matching
 * unionRounds' history-wins-byId-overwrite semantics. Iterating LAST-first
 * keeps the totals consistent with the merged display array.
 *
 * TRIMMED-WINDOW RULE (the case the naive "add every absent round" breaks):
 * `cloudRounds` is the retained window — the newest 200 by `order` — while
 * `cloudTotal` holds the sum of ALL rounds ever upserted, including the
 * trimmed ones (trim-but-keep-totals). A history round absent from the
 * window is therefore ambiguous: it is either a TRIMMED round (already
 * inside cloudTotal — adding it double-counts) or a genuinely NEW round
 * (add it). Discriminators, in order:
 *
 *  1. `cloudTotal > Σ window` proves trimming happened AND its totals are
 *     inside cloudTotal. When they are EQUAL, no trimmed round's total was
 *     ever counted (pre-005-era records were rebuilt from the trimmed array,
 *     losing the trimmed rounds) — every absent round is then new, and
 *     adding it REPAIRS the old record instead of freezing the undercount
 *     forever.
 *  2. Order keys: a round beyond the window max is new by any reading. A tie
 *     AT the max can only be a new round when the platform's order keys are
 *     monotonic (a trimmed round always has the LOWEST orders) — declared by
 *     `monotonicOrder` (default true; Gemini's order is a per-fetch DOM
 *     index, renumbered, so Gemini must not be read that way).
 */
export function mergeLifetimeTotal(
  cloudTotal: number,
  cloudRounds: RoundRecord[],
  historyRounds: RoundRecord[],
  monotonicOrder = true,
): number {
  const byId = new Map(cloudRounds.map((r) => [r.messageId, r]));
  let maxOrder = -Infinity;
  let windowSum = 0;
  for (const r of cloudRounds) {
    maxOrder = Math.max(maxOrder, r.order);
    windowSum += r.total;
  }
  const trimmedCounted = cloudTotal > windowSum;
  const seen = new Set<string>();
  let total = cloudTotal;
  for (let i = historyRounds.length - 1; i >= 0; i--) {
    const h = historyRounds[i];
    if (!h || seen.has(h.messageId)) continue;
    seen.add(h.messageId);
    const c = byId.get(h.messageId);
    if (c) {
      total += h.total - c.total; // history wins on the same messageId
    } else if (
      !trimmedCounted || // no trimming was ever counted → absent = new (repairs old records)
      h.order > maxOrder || // beyond the retained window — new by any reading
      (monotonicOrder && h.order === maxOrder) // tie at max: trimmed rounds have the LOWEST orders
    ) {
      total += h.total; // genuinely new round
    }
    // else: a trimmed round — its total already lives in cloudTotal.
  }
  return total;
}

export function upsertRound(
  record: DialogueRecord | null,
  platformId: string,
  dialogueId: string,
  contextLimit: number,
  round: RoundInput,
): DialogueRecord {
  const base = record ?? emptyDialogue(platformId, dialogueId, contextLimit);
  const total =
    round.promptTokens + (round.toolTokens ?? 0) + round.answerTokens;
  const idx = base.rounds.findIndex((r) => r.messageId === round.messageId);
  // Replace the existing round (same messageId): subtract its old total, add
  // the new one. Keeps the running-sum invariant intact (totalTokens is the
  // true lifetime sum even when older rounds are trimmed out of the array).
  const prev = idx >= 0 ? base.rounds[idx] : undefined;
  const totalTokens = prev
    ? base.totalTokens - prev.total + total
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
  const last = record.rounds[record.rounds.length - 1]!;
  return {
    totalTokens: record.totalTokens,
    roundCount: record.roundCount,
    lastRoundTokens: last.total,
    rounds: record.rounds,
  };
}
