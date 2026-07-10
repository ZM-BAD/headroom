import { describe, expect, it } from "vitest";

import { parseChatGptHistory } from "../chatgpt";

/**
 * parseChatGptHistory turns a `GET /backend-api/conversation/<id>` response into
 * ascending rounds. Captured live (2026-06): the `mapping` is a tree keyed by
 * node id; a real turn spans SEVERAL nodes — user → assistant
 * (model_editable_context stub, no body) → assistant (text, the real reply). We
 * BFS from each user node and take the FIRST descendant assistant whose
 * content_type is "text". system nodes (is_visually_hidden_from_conversation)
 * have no readable text and are skipped by the content_type check.
 */
describe("parseChatGptHistory", () => {
  it("pairs a user node with its first assistant-text descendant into round 1", () => {
    // Real shape: user → model_editable_context (stub) → assistant text reply.
    const resp = {
      mapping: {
        u1: {
          id: "u1",
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["你好,这是测试"] },
          },
          children: ["a_stub"],
        },
        a_stub: {
          id: "a_stub",
          message: {
            author: { role: "assistant" },
            // model_editable_context stub — NOT "text", must be walked past.
            content: { content_type: "model_editable_context", parts: [] },
          },
          children: ["a1"],
        },
        a1: {
          id: "a1",
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["你好！收到。"] },
            create_time: 1719500000,
          },
          children: [],
        },
      },
    };
    expect(parseChatGptHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1719500000,
        createdAt: 1719500000000,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("orders multiple rounds ASCENDING by assistant create_time (1-based n)", () => {
    // Insertion order is deliberately scrambled; create_time orders the output.
    const resp = {
      mapping: {
        u2: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["Q2"] },
          },
          children: ["a2"],
        },
        a2: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["A2"] },
            create_time: 1719500100,
          },
          children: [],
        },
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["Q1"] },
          },
          children: ["a1"],
        },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["A1"] },
            create_time: 1719500000,
          },
          children: [],
        },
      },
    };
    expect(parseChatGptHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1719500000,
        createdAt: 1719500000000,
        promptText: "Q1",
        answerText: "A1",
      },
      {
        messageId: "a2",
        order: 1719500100,
        createdAt: 1719500100000,
        promptText: "Q2",
        answerText: "A2",
      },
    ]);
  });

  it("concatenates multiple parts in a content node (continued content)", () => {
    const resp = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["p1", "p2"] },
          },
          children: ["a1"],
        },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["part 1", "part 2"] },
            create_time: 1,
          },
          children: [],
        },
      },
    };
    const [round] = parseChatGptHistory(resp);
    expect(round.promptText).toBe("p1\np2");
    expect(round.answerText).toBe("part 1\npart 2");
  });

  it("skips non-string parts (object parts are dropped, not crashed on)", () => {
    const resp = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: [{ ref: "obj" }, "real text", 42],
            },
          },
          children: ["a1"],
        },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["a"] },
            create_time: 1,
          },
          children: [],
        },
      },
    };
    const [round] = parseChatGptHistory(resp);
    expect(round.promptText).toBe("real text");
  });

  it('pairs stopped generation as a round with answerText=""', () => {
    // User with a model_editable_context child but no text reply downstream.
    // The prompt still consumed tokens — count it with empty answerText.
    const resp = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["pending question"] },
          },
          children: ["stub_only"],
        },
        stub_only: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "model_editable_context", parts: [] },
            create_time: 1780272000,
          },
          children: [],
        },
      },
    };
    expect(parseChatGptHistory(resp)).toEqual([
      {
        messageId: "stub_only",
        order: 1780272000,
        createdAt: 1780272000000,
        promptText: "pending question",
        answerText: "",
      },
    ]);
  });

  it("returns [] for empty / missing / malformed mapping", () => {
    expect(parseChatGptHistory({})).toEqual([]);
    expect(parseChatGptHistory({ mapping: {} })).toEqual([]);
    expect(parseChatGptHistory({ mapping: null })).toEqual([]);
    expect(parseChatGptHistory(null)).toEqual([]);
    expect(parseChatGptHistory(undefined)).toEqual([]);
  });
});
