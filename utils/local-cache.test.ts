import { describe, expect, it } from "vitest";
import {
  convIndexAfterDelete,
  convIndexAfterSet,
  pickOldestKeys,
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
