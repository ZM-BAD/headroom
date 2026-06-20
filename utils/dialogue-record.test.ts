import { describe, expect, it } from "vitest";

import {
  appendRound,
  emptyDialogue,
  MAX_RETAINED_ROUNDS,
  type DialogueRecord,
} from "./dialogue-record";

/**
 * appendRound builds the per-dialogue record persisted to Upstash. Two
 * invariants must hold forever:
 *   1. totalTokens is the true sum across ALL rounds, even after old rounds
 *      are trimmed from the retained array.
 *   2. roundCount is the true round number, not the retained-array length.
 * Trim-but-keep-accurate-totals is the easiest place for a silent accounting
 * bug, so it gets the heaviest coverage below.
 */

const round = (promptTokens: number, answerTokens: number) => ({
  promptTokens,
  answerTokens,
  ts: 1_000,
});

describe("appendRound — first round", () => {
  it("builds a record from null (no prior history)", () => {
    const rec = appendRound(null, "deepseek", "d1", 1_000_000, round(100, 50));
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
    const rec = appendRound(base, "deepseek", "d1", 1_000_000, round(200, 100));
    expect(rec.roundCount).toBe(2);
    expect(rec.totalTokens).toBe(450); // 150 + 300
    expect(rec.rounds).toHaveLength(2);
    expect(rec.rounds[1].n).toBe(2);
  });
});

describe("appendRound — accumulation correctness", () => {
  it("totalTokens is the sum of every round's total, across many rounds", () => {
    let rec = appendRound(null, "p", "d", 100_000, round(10, 20));
    rec = appendRound(rec, "p", "d", 100_000, round(30, 40));
    rec = appendRound(rec, "p", "d", 100_000, round(50, 60));
    // (10+20) + (30+40) + (50+60) = 210
    expect(rec.totalTokens).toBe(210);
    expect(rec.roundCount).toBe(3);
    expect(rec.rounds.map((r) => r.n)).toEqual([1, 2, 3]);
  });
});

describe("appendRound — trim-but-keep-totals (the critical invariant)", () => {
  it("keeps only the last MAX_RETAINED_ROUNDS in the array", () => {
    let rec = appendRound(null, "p", "d", 100_000, round(1, 1));
    // +1 because we started with one round above.
    for (let i = 0; i < MAX_RETAINED_ROUNDS + 5; i++) {
      rec = appendRound(rec, "p", "d", 100_000, round(1, 1));
    }
    expect(rec.rounds.length).toBeLessThanOrEqual(MAX_RETAINED_ROUNDS);
    expect(rec.rounds.length).toBe(MAX_RETAINED_ROUNDS);
  });

  it("keeps roundCount accurate (true count) after trimming", () => {
    let rec = appendRound(null, "p", "d", 100_000, round(1, 1));
    const total = MAX_RETAINED_ROUNDS + 5 + 1; // initial + loop
    for (let i = 0; i < MAX_RETAINED_ROUNDS + 5; i++) {
      rec = appendRound(rec, "p", "d", 100_000, round(1, 1));
    }
    expect(rec.roundCount).toBe(total);
  });

  it("keeps totalTokens accurate (true sum) after trimming", () => {
    // Each round is 1+1=2 tokens. With N rounds the true sum is 2*N, even though
    // only the last MAX_RETAINED_ROUNDS are retained.
    let rec = appendRound(null, "p", "d", 100_000, round(1, 1));
    const rounds = MAX_RETAINED_ROUNDS + 5 + 1;
    for (let i = 0; i < MAX_RETAINED_ROUNDS + 5; i++) {
      rec = appendRound(rec, "p", "d", 100_000, round(1, 1));
    }
    expect(rec.totalTokens).toBe(2 * rounds);
  });
});

describe("appendRound — purity", () => {
  it("does not mutate the input record (returns a new object)", () => {
    const base: DialogueRecord = {
      ...emptyDialogue("p", "d", 100_000),
      roundCount: 1,
      totalTokens: 30,
      rounds: [{ n: 1, promptTokens: 10, answerTokens: 20, total: 30, ts: 1 }],
    };
    const snapshot = JSON.parse(JSON.stringify(base)) as DialogueRecord;
    appendRound(base, "p", "d", 100_000, round(5, 5));
    expect(base).toEqual(snapshot); // input untouched
  });
});
