import { describe, expect, it } from "vitest";

import type { HistoryRound } from "./platform-adapter";
import { historySettled, SETTLE_RETRY_DELAYS_MS } from "./history-settle";

const round = (answerText: string, n: number): HistoryRound => ({
  messageId: `db:${n}`,
  order: n,
  promptText: `prompt ${n}`,
  answerText,
});

describe("historySettled", () => {
  it("settled when the newest round has a non-empty answer", () => {
    expect(historySettled([round("answer", 1)])).toBe(true);
  });

  it("unsettled when the newest round's answer is empty (bot message not yet persisted)", () => {
    // The Doubao race: user message lands instantly, bot message lands
    // 0–1s+ after the completion stream closes. Fetching in that window
    // yields a newest round with answerText="" → must retry, not ship.
    expect(historySettled([round("", 1)])).toBe(false);
    expect(historySettled([round("answer", 1), round("", 2)])).toBe(false);
  });

  it("settled for an empty rounds array (fetch error / empty conversation — nothing to wait for)", () => {
    expect(historySettled([])).toBe(true);
  });

  it("settled when only an OLDER round has an empty answer (historic stopped-generation must not block)", () => {
    expect(historySettled([round("", 1), round("answer", 2)])).toBe(true);
  });
});

describe("SETTLE_RETRY_DELAYS_MS", () => {
  it("is a bounded, ascending backoff schedule", () => {
    expect(SETTLE_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(SETTLE_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < SETTLE_RETRY_DELAYS_MS.length; i++) {
      expect(SETTLE_RETRY_DELAYS_MS[i]).toBeGreaterThanOrEqual(
        SETTLE_RETRY_DELAYS_MS[i - 1],
      );
    }
  });
});
