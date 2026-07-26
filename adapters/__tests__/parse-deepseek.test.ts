import { describe, expect, it } from "vitest";

import { parseDeepSeekHistory } from "../deepseek";

/**
 * parseDeepSeekHistory turns a GET /api/v0/chat/history_messages response into
 * ascending rounds. Captured live (2026-06): messages is a flat array; each
 * ASSISTANT links to its parent USER via parent_id; fragments[{type,content}]
 * carry the text. Dedup: multiple assistants for the same parent → keep highest
 * message_id (latest regenerate).
 */
describe("parseDeepSeekHistory", () => {
  it("pairs an assistant with its parent user via REQUEST/RESPONSE fragments", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "你好" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [
                { type: "RESPONSE", content: "你好！有什么可以帮你？" },
              ],
              inserted_at: 1719500000.0,
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([
      {
        messageId: "2",
        order: 2,
        promptText: "你好",
        answerText: "你好！有什么可以帮你？",
        createdAt: 1719500000000,
      },
    ]);
  });

  it("orders rounds ASCENDING by message_id", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 10,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "Q2" }],
            },
            {
              message_id: 20,
              parent_id: 10,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "A2" }],
            },
            {
              message_id: 3,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "Q1" }],
            },
            {
              message_id: 7,
              parent_id: 3,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "A1" }],
            },
          ],
        },
      },
    };
    const rounds = parseDeepSeekHistory(resp);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].promptText).toBe("Q1");
    expect(rounds[1].promptText).toBe("Q2");
  });

  it("dedups by parent_id — keeps highest message_id (latest regenerate)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "question" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "first answer" }],
            },
            {
              message_id: 5,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "regenerated answer" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([
      {
        messageId: "5",
        order: 5,
        promptText: "question",
        answerText: "regenerated answer",
        createdAt: undefined,
      },
    ]);
  });

  it("skips an orphan assistant whose parent user is absent", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 99,
              parent_id: 404,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "orphan" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([]);
  });

  it("skips non-ASSISTANT roles (SYSTEM messages, etc.)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 0,
              role: "SYSTEM",
              fragments: [{ type: "REQUEST", content: "system prompt" }],
            },
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "hello" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "hi" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toHaveLength(1);
  });

  it("joins multiple fragments of the same type with newlines", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [
                { type: "REQUEST", content: "part 1" },
                { type: "REQUEST", content: "part 2" },
              ],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [
                { type: "RESPONSE", content: "answer part 1" },
                { type: "RESPONSE", content: "answer part 2" },
              ],
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round.promptText).toBe("part 1\npart 2");
    expect(round.answerText).toBe("answer part 1\nanswer part 2");
  });

  it("drops non-matching fragment types (THINKING, etc.)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "q" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [
                { type: "THINKING", content: "private reasoning" },
                { type: "RESPONSE", content: "public answer" },
              ],
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round.answerText).toBe("public answer");
  });

  it("converts inserted_at epoch seconds to createdAt milliseconds", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "q" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "a" }],
              inserted_at: 1782741816.158,
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round.createdAt).toBe(1782741816158);
  });

  it("leaves createdAt undefined when inserted_at is absent", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "q" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "a" }],
              // no inserted_at
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round.createdAt).toBeUndefined();
  });

  it("includes stopped/incomplete assistants (status is not checked)", () => {
    // The code intentionally allows non-FINISHED messages — a stopped
    // generation still counts as a round (answerText may be "").
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "long prompt" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "STOPPED",
              fragments: [{ type: "RESPONSE", content: "partial" }],
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round).toBeDefined();
    expect(round.promptText).toBe("long prompt");
    expect(round.answerText).toBe("partial");
  });

  it("returns text only — drops the platform's accumulated_token_usage", () => {
    // Spec: tokens are always estimated, never trusted from the platform.
    // The platform's own token count must not leak into the HistoryRound.
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "p" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              accumulated_token_usage: 999,
              fragments: [{ type: "RESPONSE", content: "a" }],
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round).toEqual({
      messageId: "2",
      order: 2,
      promptText: "p",
      answerText: "a",
    });
    expect(round).not.toHaveProperty("accumulated_token_usage");
  });

  it("returns [] for null / undefined / empty / malformed shapes", () => {
    expect(parseDeepSeekHistory(null)).toEqual([]);
    expect(parseDeepSeekHistory(undefined)).toEqual([]);
    expect(parseDeepSeekHistory({})).toEqual([]);
    expect(parseDeepSeekHistory({ data: {} })).toEqual([]);
    expect(parseDeepSeekHistory({ data: { biz_data: {} } })).toEqual([]);
    expect(
      parseDeepSeekHistory({ data: { biz_data: { chat_messages: null } } }),
    ).toEqual([]);
    expect(
      parseDeepSeekHistory({
        data: { biz_data: { chat_messages: "not-an-array" } },
      }),
    ).toEqual([]);
  });

  it("skips messages without a numeric message_id", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: "string-id",
              role: "USER",
              fragments: [{ type: "REQUEST", content: "q" }],
            },
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "valid user" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "a" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toHaveLength(1);
  });

  it("skips assistants whose parent_id is not a number", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "q" }],
            },
            {
              message_id: 2,
              parent_id: "1",
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "a" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([]);
  });

  it("handles missing / null / empty fragments on individual messages", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              // fragments absent entirely
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              fragments: null,
            },
            {
              message_id: 3,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "q" }],
            },
            {
              message_id: 4,
              parent_id: 3,
              role: "ASSISTANT",
              fragments: [],
            },
          ],
        },
      },
    };
    const rounds = parseDeepSeekHistory(resp);
    expect(rounds).toHaveLength(2);
    // Round 1: both prompt and answer have no fragments → empty strings
    expect(rounds[0].promptText).toBe("");
    expect(rounds[0].answerText).toBe("");
    // Round 2: fragments present → normal
    expect(rounds[1].promptText).toBe("q");
    expect(rounds[1].answerText).toBe("");
  });

  it("trims whitespace from joined fragments", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "  prompt  " }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [
                { type: "RESPONSE", content: "  line1  " },
                { type: "RESPONSE", content: "  line2  " },
              ],
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round.promptText).toBe("prompt");
    // joinFragments joins with "\n" then trims the whole result
    expect(round.answerText).toBe("line1  \n  line2");
  });
});
