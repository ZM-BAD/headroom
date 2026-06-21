import { describe, expect, it } from "vitest";

import { tallyLocalRound, type LastRound } from "./tally";
import type { UsageState } from "./messages";

const state = (over: Partial<UsageState> = {}): UsageState => ({
  platformId: null,
  contextLimit: null,
  totalTokens: 0,
  lastRoundTokens: null,
  roundCount: 0,
  dialogueId: null,
  title: null,
  rounds: [],
  ...over,
});

const last = (over: Partial<LastRound> = {}): LastRound => ({
  platformId: "p",
  dialogueId: "d",
  roundId: 1,
  tokens: 0,
  ...over,
});

describe("tallyLocalRound", () => {
  it("fresh count when prev is a different platform (first round here)", () => {
    const r = tallyLocalRound(state({ platformId: null }), null, {
      platformId: "deepseek",
      dialogueId: "A",
      roundId: 1,
      tokens: 100,
    });
    expect(r).toEqual({ totalTokens: 100, roundCount: 1 });
  });

  it("accumulates a new round in the same conversation", () => {
    const r = tallyLocalRound(
      state({
        platformId: "deepseek",
        dialogueId: "A",
        totalTokens: 100,
        roundCount: 1,
      }),
      last({
        platformId: "deepseek",
        dialogueId: "A",
        roundId: 1,
        tokens: 100,
      }),
      { platformId: "deepseek", dialogueId: "A", roundId: 2, tokens: 50 },
    );
    expect(r).toEqual({ totalTokens: 150, roundCount: 2 });
  });

  it("REPLACES tokens on a re-emit (same platform+dialogue+roundId, mid-stream)", () => {
    const r = tallyLocalRound(
      state({
        platformId: "deepseek",
        dialogueId: "A",
        totalTokens: 100,
        roundCount: 1,
      }),
      last({
        platformId: "deepseek",
        dialogueId: "A",
        roundId: 1,
        tokens: 100,
      }),
      { platformId: "deepseek", dialogueId: "A", roundId: 1, tokens: 120 },
    );
    // 100 - 100 (old) + 120 (new) — not 100 + 120
    expect(r).toEqual({ totalTokens: 120, roundCount: 1 });
  });

  it("C1: round 1 of chat B does NOT dedup against chat A's round 1 (same platform+roundId, different dialogue)", () => {
    // prev was reset to 0 when the user switched to chat B.
    const prev = state({
      platformId: "deepseek",
      dialogueId: "B",
      totalTokens: 0,
      roundCount: 0,
    });
    // `last` is still chat A's round 1 — same platform, same roundId 1, but a
    // different conversation. The bug was treating this as a re-emit.
    const lastA = last({
      platformId: "deepseek",
      dialogueId: "A",
      roundId: 1,
      tokens: 100,
    });
    const r = tallyLocalRound(prev, lastA, {
      platformId: "deepseek",
      dialogueId: "B",
      roundId: 1,
      tokens: 30,
    });
    // NOT (0 - 100 + 30 = -70); a fresh accumulate instead.
    expect(r).toEqual({ totalTokens: 30, roundCount: 1 });
  });

  it("fresh count when switching platform mid-session", () => {
    const r = tallyLocalRound(
      state({
        platformId: "deepseek",
        dialogueId: "A",
        totalTokens: 999,
        roundCount: 9,
      }),
      null,
      { platformId: "kimi", dialogueId: "B", roundId: 1, tokens: 10 },
    );
    expect(r).toEqual({ totalTokens: 10, roundCount: 1 });
  });
});
