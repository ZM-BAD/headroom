import { describe, expect, it } from "vitest";

import { parseKimiHistory } from "../kimi";

/**
 * parseKimiHistory turns a `POST .../ChatService/ListMessages` response into
 * ascending rounds. Captured live (2026-06): messages[] is an array tree-linked
 * via parentId; each assistant's parentId points at the user it answers. The
 * body is in blocks[] — only blocks with a `text` field carry readable content;
 * `think`/`tool`/`stage` blocks (reasoning/search) have no `text` and are
 * dropped. A failed assistant (no text block, e.g. OVERLOADED) is skipped; its
 * retry pairs with a later sibling.
 */
describe("parseKimiHistory", () => {
  it("pairs an assistant with its parent user into round 1", () => {
    const resp = {
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [{ text: { content: "你好,这是测试" } }],
        },
        {
          id: "a1",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:00Z",
          blocks: [{ text: { content: "你好！收到。" } }],
        },
      ],
    };
    expect(parseKimiHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1780272000000,
        createdAt: 1780272000000,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("drops think/tool/stage blocks — only text blocks count (reasoning excluded)", () => {
    const resp = {
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [{ text: { content: "the prompt" } }],
        },
        {
          id: "a1",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:00Z",
          blocks: [
            { think: { content: "private reasoning" } },
            { tool: { content: "search results" } },
            { stage: { content: "thinking marker" } },
            { text: { content: "the answer" } },
          ],
        },
      ],
    };
    const [round] = parseKimiHistory(resp);
    expect(round.promptText).toBe("the prompt");
    expect(round.answerText).toBe("the answer");
  });

  it("concatenates multiple text blocks (continued answer)", () => {
    const resp = {
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [{ text: { content: "p" } }],
        },
        {
          id: "a1",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:00Z",
          blocks: [
            { text: { content: "part 1" } },
            { text: { content: "part 2" } },
          ],
        },
      ],
    };
    const [round] = parseKimiHistory(resp);
    expect(round.answerText).toBe("part 1\npart 2");
  });

  it("orders multiple rounds ASCENDING by createTime (1-based n)", () => {
    const resp = {
      messages: [
        {
          id: "u2",
          role: "user",
          blocks: [{ text: { content: "Q2" } }],
        },
        {
          id: "a2",
          role: "assistant",
          parentId: "u2",
          createTime: "2026-06-02T00:00:00Z",
          blocks: [{ text: { content: "A2" } }],
        },
        {
          id: "u1",
          role: "user",
          blocks: [{ text: { content: "Q1" } }],
        },
        {
          id: "a1",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:00Z",
          blocks: [{ text: { content: "A1" } }],
        },
      ],
    };
    expect(parseKimiHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1780272000000,
        createdAt: 1780272000000,
        promptText: "Q1",
        answerText: "A1",
      },
      {
        messageId: "a2",
        order: 1780358400000,
        createdAt: 1780358400000,
        promptText: "Q2",
        answerText: "A2",
      },
    ]);
  });

  it("skips a failed assistant (exception/no text block) and pairs its retry", () => {
    // First assistant attempt failed (OVERLOADED → only an exception block);
    // the user re-sent and the retry (a1b) succeeds. The failed assistant is
    // skipped (no text); the retry pairs with its own parent user.
    const resp = {
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [{ text: { content: "Q1" } }],
        },
        {
          id: "a1_failed",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:00Z",
          // failed assistant: only an exception block, no text → skipped
          blocks: [{ exception: { reason: "REASON_COMPLETION_OVERLOADED" } }],
        },
        {
          id: "u1_retry",
          role: "user",
          blocks: [{ text: { content: "Q1" } }],
        },
        {
          id: "a1_retry",
          role: "assistant",
          parentId: "u1_retry",
          createTime: "2026-06-01T00:00:10Z",
          blocks: [{ text: { content: "A1 retry" } }],
        },
      ],
    };
    expect(parseKimiHistory(resp)).toEqual([
      {
        messageId: "a1_retry",
        order: 1780272010000,
        createdAt: 1780272010000,
        promptText: "Q1",
        answerText: "A1 retry",
      },
    ]);
  });

  it("skips an orphan assistant whose parent user is absent", () => {
    const resp = {
      messages: [
        {
          id: "a1",
          role: "assistant",
          parentId: "missing",
          createTime: "2026-06-01T00:00:00Z",
          blocks: [{ text: { content: "orphan answer" } }],
        },
      ],
    };
    expect(parseKimiHistory(resp)).toEqual([]);
  });

  it("returns [] for empty / missing / malformed messages", () => {
    expect(parseKimiHistory({})).toEqual([]);
    expect(parseKimiHistory({ messages: [] })).toEqual([]);
    expect(parseKimiHistory({ messages: null })).toEqual([]);
    expect(parseKimiHistory(null)).toEqual([]);
    expect(parseKimiHistory(undefined)).toEqual([]);
  });
});
