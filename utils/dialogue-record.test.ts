import { describe, expect, it } from "vitest";

import {
  upsertRound,
  upsertRoundInto,
  unionRounds,
  projectUsage,
  emptyDialogue,
  MAX_RETAINED_ROUNDS,
  type DialogueRecord,
  type RoundRecord,
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
  messageId: `m${n}`,
  order: n,
  n,
  promptTokens,
  answerTokens,
  createdAt: 1_000,
});

describe("upsertRound — first round", () => {
  it("builds a record from null (no prior history)", () => {
    const rec = upsertRound(
      null,
      "deepseek",
      "d1",
      1_048_576,
      round(1, 100, 50),
    );
    expect(rec.platformId).toBe("deepseek");
    expect(rec.dialogueId).toBe("d1");
    expect(rec.contextLimit).toBe(1_048_576);
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
      ...emptyDialogue("deepseek", "d1", 1_048_576),
      roundCount: 1,
      totalTokens: 150,
      rounds: [
        {
          messageId: "m1",
          order: 1,
          n: 1,
          promptTokens: 100,
          answerTokens: 50,
          total: 150,
          createdAt: 1,
        },
      ],
    };
    const rec = upsertRound(
      base,
      "deepseek",
      "d1",
      1_048_576,
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
    // Simulates one assistant message settling in burscreatedAt: round 1 emitted with
    // growing token estimates as more text streams in.
    let rec = upsertRound(null, "deepseek", "d1", 1_048_576, round(1, 100, 50));
    rec = upsertRound(rec, "deepseek", "d1", 1_048_576, round(1, 200, 100));
    rec = upsertRound(rec, "deepseek", "d1", 1_048_576, round(1, 300, 150));
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
      rounds: [
        {
          messageId: "m1",
          order: 1,
          n: 1,
          promptTokens: 10,
          answerTokens: 20,
          total: 30,
          createdAt: 1,
        },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(base)) as DialogueRecord;
    upsertRound(base, "p", "d", 100_000, round(2, 5, 5));
    expect(base).toEqual(snapshot); // input untouched
  });
});

describe("upsertRoundInto — array-level replace/append (record + panel)", () => {
  const r = (n: number, promptTokens: number, answerTokens: number) => ({
    messageId: `m${n}`,
    order: n,
    n,
    promptTokens,
    answerTokens,
    createdAt: 1,
  });
  it("appends a new round n", () => {
    const out = upsertRoundInto(
      [
        {
          messageId: "m1",
          order: 1,
          n: 1,
          promptTokens: 10,
          answerTokens: 20,
          total: 30,
          createdAt: 1,
        },
      ],
      r(2, 5, 5),
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ n: 2, total: 10 });
  });
  it("replaces an existing round n (streaming re-emit)", () => {
    const out = upsertRoundInto(
      [
        {
          messageId: "m1",
          order: 1,
          n: 1,
          promptTokens: 10,
          answerTokens: 20,
          total: 30,
          createdAt: 1,
        },
      ],
      r(1, 100, 100),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ n: 1, promptTokens: 100, total: 200 });
  });
  it("does not mutate the input array", () => {
    const base = [
      {
        messageId: "m1",
        order: 1,
        n: 1,
        promptTokens: 1,
        answerTokens: 1,
        total: 2,
        createdAt: 1,
      },
    ];
    const snap = JSON.parse(JSON.stringify(base));
    upsertRoundInto(base, r(1, 9, 9));
    expect(base).toEqual(snap);
  });
});

/**
 * projectUsage is the gauge's read of a DialogueRecord (spec 001 → "仪表盘从
 * DialogueRecord 投影"). It must surface the record's TRUE totals — never
 * re-derive them from the retained rounds array (which is trimmed) — and the
 * last round's total for the "Last:" readout.
 */
describe("projectUsage — gauge projection from a record", () => {
  it("returns zeros + null last round for a null record (new/unseen conversation)", () => {
    const proj = projectUsage(null);
    expect(proj.totalTokens).toBe(0);
    expect(proj.roundCount).toBe(0);
    expect(proj.lastRoundTokens).toBeNull();
    expect(proj.rounds).toEqual([]);
  });

  it("returns zeros for an empty record (no rounds yet)", () => {
    const proj = projectUsage(emptyDialogue("p", "d", 100_000));
    expect(proj.totalTokens).toBe(0);
    expect(proj.roundCount).toBe(0);
    expect(proj.lastRoundTokens).toBeNull();
    expect(proj.rounds).toEqual([]);
  });

  it("projects totalTokens, roundCount, and the last round's total", () => {
    const rec = upsertRound(null, "p", "d", 100_000, {
      n: 1,
      promptTokens: 10,
      answerTokens: 20,
      messageId: "m1",
      order: 1,
      createdAt: 1,
    });
    const r2 = upsertRound(rec, "p", "d", 100_000, {
      n: 2,
      promptTokens: 30,
      answerTokens: 40,
      messageId: "m2",
      order: 2,
      createdAt: 2,
    });
    const proj = projectUsage(r2);
    expect(proj.totalTokens).toBe(100); // (10+20)+(30+40)
    expect(proj.roundCount).toBe(2);
    expect(proj.lastRoundTokens).toBe(70); // round 2 total
  });

  it("reads totalTokens/roundCount from the record — NOT the trimmed array sum", () => {
    // A long conversation: 500 real rounds of 2 tokens each = 1000 lifetime
    // tokens, but only the last 2 rounds are retained in the array.
    const trimmed: DialogueRecord = {
      platformId: "p",
      dialogueId: "d",
      contextLimit: 100_000,
      totalTokens: 1000, // true lifetime sum
      roundCount: 500, // true round count
      rounds: [
        {
          messageId: "m499",
          order: 499,
          n: 499,
          promptTokens: 1,
          answerTokens: 1,
          total: 2,
          createdAt: 499,
        },
        {
          messageId: "m500",
          order: 500,
          n: 500,
          promptTokens: 1,
          answerTokens: 1,
          total: 2,
          createdAt: 500,
        },
      ], // array sum would be only 4 — WRONG for the gauge
      updatedAt: 1,
    };
    const proj = projectUsage(trimmed);
    expect(proj.totalTokens).toBe(1000); // NOT 4
    expect(proj.roundCount).toBe(500); // NOT 2
    expect(proj.lastRoundTokens).toBe(2); // last retained round's total
  });

  /**
   * unionRounds merges cloud-retained rounds with history-derived rounds (by
   * round-n). Invariants that must hold forever (spec 003 union merge):
   *   1. History wins on conflict (same n) — it's the platform's live truth,
   *      re-estimated, so its token count overwrites the cloud's stale value.
   *   2. Cloud-only rounds (n present in cloud but absent from history because
   *      the platform's history pagination truncated them) SURVIVE with their
   *      stored estimate — this is the anti-data-loss guarantee.
   *   3. Result is sorted ascending by n, trimmed to MAX_RETAINED_ROUNDS.
   *   4. Pure: input arrays are not mutated.
   */
  const rr = (
    n: number,
    promptTokens: number,
    answerTokens: number,
  ): RoundRecord => ({
    messageId: `m${n}`,
    order: n,
    n,
    promptTokens,
    answerTokens,
    total: promptTokens + answerTokens,
    createdAt: n * 100,
  });

  describe("unionRounds — empty inputs", () => {
    it("both empty → []", () => {
      expect(unionRounds([], [])).toEqual([]);
    });
    it("cloud empty → history as-is (new conversation first round)", () => {
      const history = [rr(1, 10, 20)];
      expect(unionRounds([], history)).toEqual(history);
    });
    it("history empty → cloud as-is (degenerate but correct)", () => {
      const cloud = [rr(1, 10, 20)];
      expect(unionRounds(cloud, [])).toEqual(cloud);
    });
  });

  describe("unionRounds — conflict resolution (history wins)", () => {
    it("same n → takes history version (re-estimated tokens overwrite cloud)", () => {
      const cloud = [rr(1, 10, 10)]; // total 20
      const history = [rr(1, 50, 50)]; // total 100 — re-estimated, more accurate
      const out = unionRounds(cloud, history);
      expect(out).toHaveLength(1);
      expect(out[0].total).toBe(100); // history won, not 20
    });
  });

  describe("unionRounds — subset cases (the cross-device guarantees)", () => {
    it("history ⊃ cloud (new device opens a long conversation) → = history", () => {
      const cloud = [rr(1, 10, 10)]; // total 20
      const history = [rr(1, 20, 20), rr(2, 30, 30), rr(3, 40, 40)];
      const out = unionRounds(cloud, history);
      expect(out.map((r) => r.n)).toEqual([1, 2, 3]);
      expect(out[0].total).toBe(40); // history won on n=1 (20+20, not cloud's 10+10)
    });
    it("cloud ⊃ history (platform paginated, truncated old rounds) → no loss", () => {
      // Cloud has rounds 1-5 (old, persisted from a prior open). Platform's
      // history API only returns the last 3 (3,4,5) due to pagination. The union
      // must keep cloud's 1,2 and use history's 3,4,5.
      const cloud = [rr(1, 10, 10), rr(2, 20, 20), rr(3, 30, 30)];
      const history = [rr(3, 35, 35), rr(4, 40, 40), rr(5, 50, 50)];
      const out = unionRounds(cloud, history);
      expect(out.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
      expect(out[2].total).toBe(70); // history won on n=3 (35+35, not 30+30)
      expect(out[0].total).toBe(20); // cloud-only round 1 survived
    });
  });

  describe("unionRounds — ordering and gaps", () => {
    it("result is ascending by order (display n reassigned 1..k)", () => {
      const cloud = [rr(5, 1, 1), rr(2, 1, 1)];
      const history = [rr(3, 1, 1), rr(1, 1, 1)];
      const out = unionRounds(cloud, history);
      expect(out.map((r) => r.messageId)).toEqual(["m1", "m2", "m3", "m5"]);
      expect(out.map((r) => r.n)).toEqual([1, 2, 3, 4]); // display n contiguous
    });
    it("does not fill gaps (only the rounds present survive)", () => {
      const cloud = [rr(1, 1, 1)];
      const history = [rr(5, 1, 1)]; // rounds 2,3,4 missing entirely
      const out = unionRounds(cloud, history);
      expect(out.map((r) => r.messageId)).toEqual(["m1", "m5"]); // no fabricated rounds
      expect(out.map((r) => r.n)).toEqual([1, 2]); // display n contiguous
    });
  });

  describe("unionRounds — trim to MAX_RETAINED_ROUNDS", () => {
    it("keeps only the last MAX_RETAINED_ROUNDS (newest by order)", () => {
      // Build cloud with rounds 1..MAX+5; history empty. Union result is trimmed
      // to the last MAX (messageIds m6..m{MAX+5}); display n is reassigned 1..MAX.
      const cloud: RoundRecord[] = [];
      for (let n = 1; n <= MAX_RETAINED_ROUNDS + 5; n++) {
        cloud.push(rr(n, 1, 1));
      }
      const out = unionRounds(cloud, []);
      expect(out).toHaveLength(MAX_RETAINED_ROUNDS);
      expect(out[0].messageId).toBe("m6"); // first 5 dropped
      // n is assigned to the FULL set before slicing, so the retained tail keeps
      // its true position (6..MAX+5) — this is what lets roundCount (= max n)
      // survive trimming.
      expect(out[0].n).toBe(6);
      expect(out[out.length - 1].messageId).toBe(`m${MAX_RETAINED_ROUNDS + 5}`);
      expect(out[out.length - 1].n).toBe(MAX_RETAINED_ROUNDS + 5);
    });
  });

  describe("unionRounds — purity", () => {
    it("does not mutate either input array", () => {
      const cloud = [rr(1, 10, 10)];
      const history = [rr(1, 20, 20), rr(2, 30, 30)];
      const cloudSnap = JSON.parse(JSON.stringify(cloud));
      const historySnap = JSON.parse(JSON.stringify(history));
      unionRounds(cloud, history);
      expect(cloud).toEqual(cloudSnap);
      expect(history).toEqual(historySnap);
    });
  });

  /**
   * C1 REGRESSION: union must merge by a STABLE messageId, not positional n.
   * Real rounds R1..R50 (messageId m1..m50). Device B's platform history
   * TRUNCATES to the recent 30 (R21..R50); the adapter renumbers them to
   * POSITIONAL n=1..30, but their stable messageId (m21..m50) + real order
   * (21..50) survive. Merging by n would collide different real rounds onto the
   * same n and corrupt the totals (proven: 1875 instead of 1275). Merging by
   * messageId keeps all 50 distinct rounds. (Cast through `any` until
   * RoundRecord carries messageId/order natively.)
   */
  describe("unionRounds — C1: merge by stable messageId, not positional n", () => {
    it("truncated history with shifted positional n keeps all rounds via messageId", () => {
      const cloud: RoundRecord[] = Array.from({ length: 50 }, (_, i) => ({
        messageId: `m${i + 1}`,
        order: i + 1,
        n: i + 1,
        promptTokens: i + 1,
        answerTokens: 0,
        total: i + 1,
        createdAt: i + 1,
      }));
      const history: RoundRecord[] = Array.from({ length: 30 }, (_, i) => ({
        messageId: `m${21 + i}`, // STABLE — the real identity
        order: 21 + i, // real chronological order
        n: i + 1, // POSITIONAL — shifted! (real round is 21+i)
        promptTokens: 21 + i,
        answerTokens: 0,
        total: 21 + i,
        createdAt: 21 + i,
      }));
      const out = unionRounds(cloud, history);
      const ids = out
        .map((r) => r.messageId)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 1}`));
      expect(out.reduce((s, r) => s + r.total, 0)).toBe(1275); // Σ(1..50)
    });
  });
});
