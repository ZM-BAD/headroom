import { describe, expect, it } from "vitest";

import { parseDeepSeekHistory } from "../deepseek";

/**
 * parseDeepSeekHistory turns a `GET /api/v0/chat/history_messages` response
 * into ascending rounds. Captured from a real response (2026-06): messages
 * live at `data.biz_data.chat_messages[]`, each with role USER/ASSISTANT,
 * message_id + parent_id pairing, and `fragments[].content` carrying the text.
 *
 * Spec stance: the platform's own `accumulated_token_usage` is IGNORED here —
 * we return text only and the caller estimates tokens.
 */
describe("parseDeepSeekHistory", () => {
  it("pairs a USER + its ASSISTANT child into round 1", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
              role: "USER",
              status: "FINISHED",
              fragments: [{ type: "REQUEST", content: "你好,这是测试" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              accumulated_token_usage: 285,
              fragments: [{ type: "RESPONSE", content: "你好！收到。" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([
      {
        messageId: "2",
        order: 2,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("orders multiple rounds ASCENDING (oldest first), 1-based n", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "Q1" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              fragments: [{ type: "RESPONSE", content: "A1" }],
            },
            {
              message_id: 3,
              parent_id: null,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "Q2" }],
            },
            {
              message_id: 4,
              parent_id: 3,
              role: "ASSISTANT",
              fragments: [{ type: "RESPONSE", content: "A2" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([
      { messageId: "2", order: 2, promptText: "Q1", answerText: "A1" },
      { messageId: "4", order: 4, promptText: "Q2", answerText: "A2" },
    ]);
  });

  it("returns text only — drops the platform's accumulated_token_usage", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
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

  it("picks the REQUEST fragment for the prompt, RESPONSE for the answer (ignores THINKING/other)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
              role: "USER",
              fragments: [
                { type: "REQUEST", content: "the prompt" },
                { type: "OTHER", content: "noise" },
              ],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              fragments: [
                { type: "THINKING", content: "reasoning" },
                { type: "RESPONSE", content: "the answer" },
              ],
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round.promptText).toBe("the prompt");
    expect(round.answerText).toBe("the answer");
  });

  it("concatenates multiple RESPONSE fragments (continued answer)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "p" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              fragments: [
                { type: "RESPONSE", content: "part 1" },
                { type: "RESPONSE", content: "part 2" },
              ],
            },
          ],
        },
      },
    };
    const [round] = parseDeepSeekHistory(resp);
    expect(round.answerText).toBe("part 1\npart 2");
  });

  it("returns [] for empty / missing / malformed chat_messages", () => {
    expect(parseDeepSeekHistory({})).toEqual([]);
    expect(parseDeepSeekHistory({ data: {} })).toEqual([]);
    expect(parseDeepSeekHistory({ data: { biz_data: {} } })).toEqual([]);
    expect(
      parseDeepSeekHistory({ data: { biz_data: { chat_messages: [] } } }),
    ).toEqual([]);
  });

  it("skips an assistant whose parent USER is absent (orphan)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 9,
              parent_id: 999,
              role: "ASSISTANT",
              fragments: [{ type: "RESPONSE", content: "a" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([]);
  });

  it("dedup by parent USER — keeps only the highest message_id (regenerate)", () => {
    // When a SAME parent USER has multiple ASSISTANT children (direct retry
    // without intermediate regenerate USER), only the highest message_id wins.
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "hello" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "old answer" }],
            },
            {
              message_id: 3,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              fragments: [{ type: "RESPONSE", content: "new answer" }],
            },
          ],
        },
      },
    };
    const rounds = parseDeepSeekHistory(resp);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].messageId).toBe("3"); // highest message_id wins
    expect(rounds[0].answerText).toBe("new answer");
  });

  it("skips non-FINISHED ASSISTANT (stopped mid-generation)", () => {
    // A message stopped mid-generation should NOT count as a round.
    // When the user continues, it flips to FINISHED → counted then.
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
              role: "USER",
              fragments: [{ type: "REQUEST", content: "long question" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "CANCELLED",
              fragments: [{ type: "RESPONSE", content: "partial a" }],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([]);
  });
});
