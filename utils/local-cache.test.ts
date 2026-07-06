import { describe, expect, it } from "vitest";
import {
  CLEANUP_THROTTLE_MS,
  cleanupStateAfterRun,
  convIndexAfterDelete,
  convIndexAfterSet,
  pickOldestKeys,
  shouldRunCleanup,
  type CleanupState,
  type ConvIndex,
} from "./local-cache";

describe("convIndexAfterSet", () => {
  it("adds a new key", () => {
    const idx: ConvIndex = { a: 1 };
    expect(convIndexAfterSet(idx, "b", 2)).toEqual({ a: 1, b: 2 });
  });

  it("overwrites an existing key's updatedAt", () => {
    expect(convIndexAfterSet({ a: 1 }, "a", 9)).toEqual({ a: 9 });
  });

  it("does not mutate the input (pure)", () => {
    const idx: ConvIndex = { a: 1 };
    convIndexAfterSet(idx, "b", 2);
    expect(idx).toEqual({ a: 1 });
  });
});

describe("convIndexAfterDelete", () => {
  it("removes the key", () => {
    expect(convIndexAfterDelete({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });

  it("is a no-op when the key is absent", () => {
    expect(convIndexAfterDelete({ a: 1 }, "z")).toEqual({ a: 1 });
  });

  it("does not mutate the input (pure)", () => {
    const idx: ConvIndex = { a: 1, b: 2 };
    convIndexAfterDelete(idx, "a");
    expect(idx).toEqual({ a: 1, b: 2 });
  });
});

describe("pickOldestKeys", () => {
  it("returns keys ordered by updatedAt ascending", () => {
    expect(pickOldestKeys({ new: 30, old: 10, mid: 20 }, 2)).toEqual([
      "old",
      "mid",
    ]);
  });

  it("returns all keys (oldest-first) when count exceeds size", () => {
    expect(pickOldestKeys({ a: 3, b: 1, c: 2 }, 10)).toEqual(["b", "c", "a"]);
  });

  it("returns [] for count 0", () => {
    expect(pickOldestKeys({ a: 1 }, 0)).toEqual([]);
  });

  it("returns [] for an empty index", () => {
    expect(pickOldestKeys({}, 5)).toEqual([]);
  });

  it("breaks updatedAt ties by key, ascending (deterministic)", () => {
    expect(pickOldestKeys({ z: 5, a: 5, m: 5 }, 3)).toEqual(["a", "m", "z"]);
  });
});

describe("shouldRunCleanup (zombie-cleanup throttle)", () => {
  const NOW = 1_000_000;

  it("runs when the platform has never been cleaned (absent key)", () => {
    expect(shouldRunCleanup({}, "deepseek", NOW)).toBe(true);
  });

  it("runs when last cleanup is older than the throttle window", () => {
    const state: CleanupState = {
      deepseek: NOW - CLEANUP_THROTTLE_MS - 1,
    };
    expect(shouldRunCleanup(state, "deepseek", NOW)).toBe(true);
  });

  it("runs when last cleanup is exactly at the throttle boundary", () => {
    const state: CleanupState = {
      deepseek: NOW - CLEANUP_THROTTLE_MS,
    };
    expect(shouldRunCleanup(state, "deepseek", NOW)).toBe(true);
  });

  it("is throttled when last cleanup is more recent than the throttle window", () => {
    const state: CleanupState = {
      deepseek: NOW - CLEANUP_THROTTLE_MS + 1,
    };
    expect(shouldRunCleanup(state, "deepseek", NOW)).toBe(false);
  });

  it("throttles per-platform independent of other platforms", () => {
    const state: CleanupState = {
      deepseek: NOW - 10_000, // recent — throttled
      chatgpt: NOW - CLEANUP_THROTTLE_MS - 1, // old — runs
    };
    expect(shouldRunCleanup(state, "deepseek", NOW)).toBe(false);
    expect(shouldRunCleanup(state, "chatgpt", NOW)).toBe(true);
  });

  it("does not mutate the input state (pure)", () => {
    const state: CleanupState = { deepseek: NOW };
    shouldRunCleanup(state, "deepseek", NOW);
    expect(state).toEqual({ deepseek: NOW });
  });
});

describe("cleanupStateAfterRun", () => {
  const NOW = 2_000_000;

  it("stamps a new platform into an empty state", () => {
    expect(cleanupStateAfterRun({}, "deepseek", NOW)).toEqual({
      deepseek: NOW,
    });
  });

  it("updates the timestamp for an existing platform", () => {
    const state: CleanupState = { deepseek: 1_000_000 };
    expect(cleanupStateAfterRun(state, "deepseek", NOW)).toEqual({
      deepseek: NOW,
    });
  });

  it("preserves other platforms' timestamps", () => {
    const state: CleanupState = { deepseek: 1_000_000, chatgpt: 500_000 };
    expect(cleanupStateAfterRun(state, "deepseek", NOW)).toEqual({
      deepseek: NOW,
      chatgpt: 500_000,
    });
  });

  it("does not mutate the input state (pure)", () => {
    const state: CleanupState = { deepseek: 1_000_000 };
    cleanupStateAfterRun(state, "deepseek", NOW);
    expect(state).toEqual({ deepseek: 1_000_000 });
  });
});
