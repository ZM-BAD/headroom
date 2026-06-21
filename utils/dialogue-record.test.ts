import { describe, expect, it } from "vitest";

import {
  upsertRound,
  upsertRoundInto,
  emptyDialogue,
  MAX_RETAINED_ROUNDS,
  type DialogueRecord,
} from "./dialogue-record";

/**
 * upsertRound builds the per-dialogue record persisted to Upstash. Invariants
 * that must hold forever:
 *   1. totalTokens is the true sum across ALL rounds, even after old rounds are
 *      trimmed AND after a round is replaced (re-emitted mid-stream).
 *   2. roundCount is the true round number (max n), not the retained-array
 *      length.
 *   3. Re-emitting the SAME round (same n, e.g. a streamed answer settling in
 *      >1.5s-gap bursts) REPLACES that round — never appends a duplicate. This
 *      is the fix for the over-counting bug.
 */

const round = (n: number, promptTokens: number, answerTokens: number) => ({
  n,
  promptTokens,
  answerTokens,
  ts: 1_000,
});

describe("upsertRound — first round", () => {
  it("builds a record from null (no prior history)", () => {
    const rec = upsertRound(
      null,
      "deepseek",
      "d1",
      1_000_000,
      round(1, 100, 50),
    );
    expect(rec.platform).toBe("deepseek");
    expect(rec.dialogueId).toBe("d1");
    expect(rec.contextLimit).toBe(1_000_000);
    expect(rec.roundCount).toBe(1);
    expect(rec.totalTokens).toBe(150);
    expect(rec.rounds).toHaveLength(1);
    expect(rec.rounds[0]).toMatchObject({
      n: 1,
      promptTokens: 100,
      answerTokens: 50,
      total: 150,
    });
  });

  it("uses an existing record as the base when non-null", () => {
    const base: DialogueRecord = {
      ...emptyDialogue("deepseek", "d1", 1_000_000),
      roundCount: 1,
      totalTokens: 150,
      rounds: [
        { n: 1, promptTokens: 100, answerTokens: 50, total: 150, ts: 1 },
      ],
    };
    const rec = upsertRound(
      base,
      "deepseek",
      "d1",
      1_000_000,
      round(2, 200, 100),
    );
    expect(rec.roundCount).toBe(2);
    expect(rec.totalTokens).toBe(450); // 150 + 300
    expect(rec.rounds).toHaveLength(2);
    expect(rec.rounds[1].n).toBe(2);
  });
});

describe("upsertRound — accumulation correctness", () => {
  it("totalTokens is the sum of every round's total, across many rounds", () => {
    let rec = upsertRound(null, "p", "d", 100_000, round(1, 10, 20));
    rec = upsertRound(rec, "p", "d", 100_000, round(2, 30, 40));
    rec = upsertRound(rec, "p", "d", 100_000, round(3, 50, 60));
    // (10+20) + (30+40) + (50+60) = 210
    expect(rec.totalTokens).toBe(210);
    expect(rec.roundCount).toBe(3);
    expect(rec.rounds.map((r) => r.n)).toEqual([1, 2, 3]);
  });
});

describe("upsertRound — re-emit dedup (the over-count fix)", () => {
  it("re-emitting the SAME n REPLACES the round, never appends", () => {
    // Simulates one assistant message settling in bursts: round 1 emitted with
    // growing token estimates as more text streams in.
    let rec = upsertRound(null, "deepseek", "d1", 1_000_000, round(1, 100, 50));
    rec = upsertRound(rec, "deepseek", "d1", 1_000_000, round(1, 200, 100));
    rec = upsertRound(rec, "deepseek", "d1", 1_000_000, round(1, 300, 150));
    expect(rec.rounds).toHaveLength(1); // still ONE round, not three
    expect(rec.roundCount).toBe(1);
    expect(rec.totalTokens).toBe(450); // latest (300+150), NOT 150+300+450
    expect(rec.rounds[0]).toMatchObject({ n: 1, total: 450 });
  });

  it("re-emitting an older round re-runs its total correctly mid-history", () => {
    let rec = upsertRound(null, "p", "d", 100_000, round(1, 10, 10)); // 20
    rec = upsertRound(rec, "p", "d", 100_000, round(2, 20, 20)); // 40
    // round 1 re-emits with a corrected estimate (5+5=10 instead of 20):
    rec = upsertRound(rec, "p", "d", 100_000, round(1, 5, 5));
    expect(rec.roundCount).toBe(2);
    expect(rec.rounds).toHaveLength(2);
    expect(rec.totalTokens).toBe(50); // (5+5) + (20+20) — round 1 replaced
    expect(rec.rounds[0]).toMatchObject({ n: 1, total: 10 });
    expect(rec.rounds[1]).toMatchObject({ n: 2, total: 40 });
  });
});

describe("upsertRound — trim-but-keep-totals (the critical invariant)", () => {
  it("keeps only the last MAX_RETAINED_ROUNDS in the array", () => {
    let rec = upsertRound(null, "p", "d", 100_000, round(1, 1, 1));
    for (let n = 2; n <= MAX_RETAINED_ROUNDS + 6; n++) {
      rec = upsertRound(rec, "p", "d", 100_000, round(n, 1, 1));
    }
    expect(rec.rounds.length).toBeLessThanOrEqual(MAX_RETAINED_ROUNDS);
    expect(rec.rounds.length).toBe(MAX_RETAINED_ROUNDS);
  });

  it("keeps roundCount accurate (true max n) after trimming", () => {
    let rec = upsertRound(null, "p", "d", 100_000, round(1, 1, 1));
    const last = MAX_RETAINED_ROUNDS + 6;
    for (let n = 2; n <= last; n++) {
      rec = upsertRound(rec, "p", "d", 100_000, round(n, 1, 1));
    }
    expect(rec.roundCount).toBe(last);
  });

  it("keeps totalTokens accurate (true sum) after trimming", () => {
    // Each round is 1+1=2 tokens. With N rounds the true sum is 2*N, even though
    // only the last MAX_RETAINED_ROUNDS are retained.
    let rec = upsertRound(null, "p", "d", 100_000, round(1, 1, 1));
    const last = MAX_RETAINED_ROUNDS + 6;
    for (let n = 2; n <= last; n++) {
      rec = upsertRound(rec, "p", "d", 100_000, round(n, 1, 1));
    }
    expect(rec.totalTokens).toBe(2 * last);
  });
});

describe("upsertRound — purity", () => {
  it("does not mutate the input record (returns a new object)", () => {
    const base: DialogueRecord = {
      ...emptyDialogue("p", "d", 100_000),
      roundCount: 1,
      totalTokens: 30,
      rounds: [{ n: 1, promptTokens: 10, answerTokens: 20, total: 30, ts: 1 }],
    };
    const snapshot = JSON.parse(JSON.stringify(base)) as DialogueRecord;
    upsertRound(base, "p", "d", 100_000, round(2, 5, 5));
    expect(base).toEqual(snapshot); // input untouched
  });
});

describe("upsertRoundInto — array-level replace/append (record + panel)", () => {
  const r = (n: number, promptTokens: number, answerTokens: number) => ({
    n,
    promptTokens,
    answerTokens,
    ts: 1,
  });
  it("appends a new round n", () => {
    const out = upsertRoundInto(
      [{ n: 1, promptTokens: 10, answerTokens: 20, total: 30, ts: 1 }],
      r(2, 5, 5),
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ n: 2, total: 10 });
  });
  it("replaces an existing round n (streaming re-emit)", () => {
    const out = upsertRoundInto(
      [{ n: 1, promptTokens: 10, answerTokens: 20, total: 30, ts: 1 }],
      r(1, 100, 100),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ n: 1, promptTokens: 100, total: 200 });
  });
  it("does not mutate the input array", () => {
    const base = [{ n: 1, promptTokens: 1, answerTokens: 1, total: 2, ts: 1 }];
    const snap = JSON.parse(JSON.stringify(base));
    upsertRoundInto(base, r(1, 9, 9));
    expect(base).toEqual(snap);
  });
});
