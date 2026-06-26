import { describe, expect, it } from "vitest";

import { nextDoubaoAnchor } from "../doubao";

/**
 * nextDoubaoAnchor is the pure pagination-cursor decision extracted from
 * fetchHistory (the HTTP loop stays there; this decides "next anchor or stop").
 * It exists to lock the M2 fix: a batch with NO finite index_in_conv must NOT
 * abort the walk (the old `oldest >= anchor → break` truncated history to the
 * first page on a single malformed row). The short-page signal is the only true
 * "reached the head" terminator.
 */

/** Build a batch of N messages whose index_in_conv values are given (or absent). */
const batch = (indices: (number | undefined)[]) =>
  indices.map((idx) => ({
    index_in_conv: idx === undefined ? undefined : String(idx),
  }));

describe("nextDoubaoAnchor — short page (reached the head)", () => {
  it("batch smaller than pageSize → null (stop)", () => {
    expect(nextDoubaoAnchor(200, batch([5, 4, 3]), 20)).toBeNull();
  });
  it("empty batch → null (stop)", () => {
    expect(nextDoubaoAnchor(200, batch([]), 20)).toBeNull();
  });
});

describe("nextDoubaoAnchor — normal advance", () => {
  it("full page with descending indices → the oldest (smallest) index", () => {
    const idx = Array.from({ length: 20 }, (_, i) => 100 - i); // 100..81
    expect(nextDoubaoAnchor(200, batch(idx), 20)).toBe(81);
  });
  it("advances even when the oldest index is just below the anchor", () => {
    expect(nextDoubaoAnchor(50, batch([49, 48, 47, 46]), 4)).toBe(46);
  });
});

describe("nextDoubaoAnchor — M2: malformed batch (no finite index)", () => {
  it("full page with NO index_in_conv → advances by batch.length, NOT stop", () => {
    // The old code set oldest=anchor (nothing finite lower) → oldest>=anchor →
    // break, truncating to page 1. The fix advances so paging continues.
    const noIdx = batch(Array.from({ length: 20 }, () => undefined));
    expect(nextDoubaoAnchor(200, noIdx, 20)).toBe(180); // 200 - 20
  });
  it("full page with non-numeric index_in_conv → advances by batch.length", () => {
    const junk = Array.from({ length: 20 }, () => ({
      index_in_conv: "not-a-number",
    }));
    expect(nextDoubaoAnchor(500, junk, 20)).toBe(480);
  });
  it("never returns the SAME anchor (would loop forever) on a full page", () => {
    // Indices all >= anchor (no progress) — must still advance, not return anchor.
    const noProgress = batch(Array.from({ length: 20 }, () => 999));
    const next = nextDoubaoAnchor(200, noProgress, 20);
    expect(next).not.toBeNull();
    expect(next).toBeLessThan(200);
  });
});
