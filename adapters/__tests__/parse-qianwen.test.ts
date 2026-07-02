import { describe, expect, it } from "vitest";

import { parseQianwenHistory } from "../qianwen";
import type { QianwenRound } from "../qianwen";

/**
 * parseQianwenHistory is the pure half of qianwen's fetchHistory (the HTTP
 * pagination walk stays in fetchHistory; this turns the accumulated data.list[]
 * into ascending HistoryRound[]). It carries 通义千问's subtlest logic — the
 * multi-mime response filtering (only multi_load/iframe is the answer body; the
 * rest is metadata/recommendations) + the req_id/created_at identity. With no
 * test these rested on a single Playwright observation; this is the standard
 * suite (ascending, mime-drop, empty shape, identity).
 */

/** Build one list item (a round) from its parts. */
const round = (
  req_id: string,
  created_at: number,
  prompt: string,
  answerMimes: { mime_type: string; content: string }[] = [],
): QianwenRound => ({
  req_id,
  created_at,
  request_messages: prompt
    ? [{ mime_type: "text/plain", content: prompt }]
    : [],
  response_messages: answerMimes,
});

describe("parseQianwenHistory — empty / defensive", () => {
  it("undefined list → []", () => {
    expect(parseQianwenHistory(undefined)).toEqual([]);
  });
  it("non-array → []", () => {
    expect(parseQianwenHistory("nope" as unknown as QianwenRound[])).toEqual(
      [],
    );
  });
  it("empty list → []", () => {
    expect(parseQianwenHistory([])).toEqual([]);
  });
});

describe("parseQianwenHistory — pairing + identity", () => {
  it("pairs request text/plain + response multi_load/iframe, emits created_at as order (no sort)", () => {
    // Feed NEW→OLD (API order). The parser does NOT sort — it preserves list
    // order and emits created_at verbatim as the order key; unionRounds sorts
    // by order downstream.
    const list = [
      round("r2", 2000, "Q2", [
        { mime_type: "multi_load/iframe", content: "A2" },
      ]),
      round("r1", 1000, "Q1", [
        { mime_type: "multi_load/iframe", content: "A1" },
      ]),
    ];
    expect(parseQianwenHistory(list)).toEqual([
      {
        messageId: "r2",
        order: 2000,
        createdAt: 2000,
        promptText: "Q2",
        answerText: "A2",
      },
      {
        messageId: "r1",
        order: 1000,
        createdAt: 1000,
        promptText: "Q1",
        answerText: "A1",
      },
    ]);
  });

  it("messageId = req_id; order = created_at", () => {
    const list = [
      round("req-abc-123", 9999, "Q", [
        { mime_type: "multi_load/iframe", content: "A" },
      ]),
    ];
    const out = parseQianwenHistory(list);
    expect(out[0].messageId).toBe("req-abc-123");
    expect(out[0].order).toBe(9999);
  });
});

describe("parseQianwenHistory — mime filtering (the subtle part)", () => {
  it("answer = ONLY multi_load/iframe; signal/post + bar/progress + paa/iframe are dropped", () => {
    // A real response carries the answer body + several metadata mimes.
    const list = [
      round("r1", 1, "Q1", [
        { mime_type: "signal/post", content: "METADATA-SHOULD-DROP" },
        { mime_type: "multi_load/iframe", content: "THE-REAL-ANSWER" },
        { mime_type: "bar/progress", content: "PROGRESS-SHOULD-DROP" },
        { mime_type: "paa/iframe", content: "RECOMMEND-SHOULD-DROP" },
      ]),
    ];
    const out = parseQianwenHistory(list);
    expect(out).toHaveLength(1);
    expect(out[0].answerText).toBe("THE-REAL-ANSWER");
  });

  it("multiple multi_load/iframe blocks are joined", () => {
    const list = [
      round("r1", 1, "Q1", [
        { mime_type: "multi_load/iframe", content: "part-1" },
        { mime_type: "multi_load/iframe", content: "part-2" },
      ]),
    ];
    expect(parseQianwenHistory(list)[0].answerText).toBe("part-1\npart-2");
  });
});

describe("parseQianwenHistory — noise-drop / shape edge", () => {
  it("skips a round with neither prompt nor answer", () => {
    const list = [
      round("r1", 1, "Q1", [{ mime_type: "multi_load/iframe", content: "A1" }]),
      round("r2", 2, "", []), // empty request + empty response
      round("r3", 3, "Q3", [{ mime_type: "multi_load/iframe", content: "A3" }]),
    ];
    const out = parseQianwenHistory(list);
    expect(out.map((r) => r.messageId)).toEqual(["r1", "r3"]);
  });

  it("a round whose response lacks multi_load/iframe still keeps its prompt", () => {
    // e.g. an answer that's only metadata so far — prompt survives, answer "".
    const list = [
      round("r1", 1, "Q1", [{ mime_type: "signal/post", content: "meta" }]),
    ];
    const out = parseQianwenHistory(list);
    expect(out).toHaveLength(1);
    expect(out[0].promptText).toBe("Q1");
    expect(out[0].answerText).toBe("");
  });
});
