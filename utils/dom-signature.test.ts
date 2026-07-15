import { describe, expect, it } from "vitest";

import { answerStreamSignature } from "./dom-signature";

/**
 * The DOM-poll detector's change signature. Regression for the Gemini
 * partial-scrape bug (2026-07, measured live): <model-response> mounts at
 * stream START, so the element COUNT stabilises immediately while text keeps
 * streaming in — a count-only signature fired the fetch at 180 of 983 chars
 * and never re-fired. The signature must therefore distinguish states the
 * count-only detector conflated.
 */
describe("answerStreamSignature", () => {
  it("distinguishes a still-streaming answer from the finished one (same count)", () => {
    // The two live-captured states the old detector treated as identical:
    expect(answerStreamSignature(2, 180)).not.toBe(
      answerStreamSignature(2, 983),
    );
  });

  it("is stable when nothing changes (debounce must not re-arm)", () => {
    expect(answerStreamSignature(2, 983)).toBe(answerStreamSignature(2, 983));
  });

  it("distinguishes a new answer element mounting (count change)", () => {
    expect(answerStreamSignature(1, 11)).not.toBe(answerStreamSignature(2, 48));
  });

  it("does not collide across count/length boundaries", () => {
    // "1" + "21:..." must not equal "12" + "1:..." — the separator matters.
    expect(answerStreamSignature(1, 21)).not.toBe(answerStreamSignature(12, 1));
  });
});
