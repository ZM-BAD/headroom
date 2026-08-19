import { describe, expect, it } from "vitest";

import { parseDeepSeekHistory } from "../deepseek";

/**
 * parseDeepSeekHistory turns a GET /api/v0/chat/history_messages response into
 * ascending rounds. DeepSeek A/B-rolls TWO payload shapes (both live):
 *  - 2026-06 fragments[] shape — text in fragments[{type,content}]
 *    (REQUEST/THINK/RESPONSE/TIP); confirmed on a real session 2026-08-16.
 *  - 2026-08 top-level `content` shape.
 * The parser must read both (fragments preferred, content as fallback).
 * Dedup: multiple assistants for the same parent → keep highest message_id
 * (latest regenerate).
 */
describe("parseDeepSeekHistory", () => {
  it("legacy fragments[] shape (live 2026-08-16): REQUEST→prompt, RESPONSE→answer, THINK/TIP dropped", () => {
    // Real capture from a DeepSeek session — the 2026-06 shape DeepSeek still
    // serves alongside the newer top-level `content` shape (A/B rollout). The
    // parser must not read only `content` — that silently zeroes every round.
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              parent_id: null,
              role: "USER",
              status: "FINISHED",
              search_enabled: true,
              fragments: [
                {
                  id: 1,
                  type: "REQUEST",
                  content: "炒股的话，需要了解哪些金融词汇？",
                },
              ],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              search_enabled: true,
              fragments: [
                {
                  id: 2,
                  type: "THINK",
                  content: "private reasoning — must NOT count",
                },
                { id: 3, type: "RESPONSE", content: "需要了解A股、蓝筹股…" },
                { id: 4, type: "TIP", content: "UI metadata — must NOT count" },
              ],
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([
      {
        messageId: "2",
        order: 2,
        promptText: "炒股的话，需要了解哪些金融词汇？",
        answerText: "需要了解A股、蓝筹股…",
        createdAt: undefined,
      },
    ]);
  });

  it("prefers fragments[] over content when both are present (dual-shape safety)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              content: "fallback content must not win",
              fragments: [{ type: "REQUEST", content: "fragments win" }],
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "fallback answer must not win",
              fragments: [{ type: "RESPONSE", content: "fragments answer" }],
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
    expect(round.promptText).toBe("fragments win");
    expect(round.answerText).toBe("fragments answer");
  });

  it("joins MULTIPLE RESPONSE fragments with newlines (fragments[] shape)", () => {
    // The fragments[]-join path (live 2026-06 shape) — same-type fragments
    // concatenate with "\n" inside dsMessageText. Regression guard: the
    // rewritten test file dropped direct coverage of this join.
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
                { type: "RESPONSE", content: "第一段" },
                { type: "RESPONSE", content: "第二段" },
              ],
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
    expect(round.answerText).toBe("第一段\n第二段");
  });

  it("pairs an assistant with its parent user via REQUEST/RESPONSE fragments", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              content: "你好",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "你好！有什么可以帮你？",
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
              content: "Q2",
            },
            {
              message_id: 20,
              parent_id: 10,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "A2",
            },
            {
              message_id: 3,
              role: "USER",
              content: "Q1",
            },
            {
              message_id: 7,
              parent_id: 3,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "A1",
            },
          ],
        },
      },
    };
    const rounds = parseDeepSeekHistory(resp);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.promptText).toBe("Q1");
    expect(rounds[1]!.promptText).toBe("Q2");
  });

  it("dedups by parent_id — keeps highest message_id (latest regenerate)", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              content: "question",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "first answer",
            },
            {
              message_id: 5,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "regenerated answer",
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
              content: "orphan",
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
              content: "system prompt",
            },
            {
              message_id: 1,
              role: "USER",
              content: "hello",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "hi",
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toHaveLength(1);
  });

  it("takes the message text from the top-level content string", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              content: "part 1\npart 2",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "answer part 1\nanswer part 2",
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
    expect(round.promptText).toBe("part 1\npart 2");
    expect(round.answerText).toBe("answer part 1\nanswer part 2");
  });

  it("drops thinking_content — only the public content counts", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              content: "q",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "public answer",
              thinking_content: "private reasoning",
              search_enabled: "true",
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
    expect(round.answerText).toBe("public answer");
    // Search text is NOT in the history API (spec 005) — never estimated.
    expect(round.toolText).toBeUndefined();
  });

  it("converts inserted_at epoch seconds to createdAt milliseconds", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              content: "q",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "a",
              inserted_at: 1782741816.158,
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
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
              content: "q",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "a",
              // no inserted_at
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
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
              content: "long prompt",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "STOPPED",
              content: "partial",
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
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
              content: "p",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              accumulated_token_usage: 999,
              content: "a",
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
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
              content: "q",
            },
            {
              message_id: 1,
              role: "USER",
              content: "valid user",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "a",
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
              content: "q",
            },
            {
              message_id: 2,
              parent_id: "1",
              role: "ASSISTANT",
              status: "FINISHED",
              content: "a",
            },
          ],
        },
      },
    };
    expect(parseDeepSeekHistory(resp)).toEqual([]);
  });

  it("handles missing / null / empty content on individual messages", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              // content absent entirely
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              content: null,
            },
            {
              message_id: 3,
              role: "USER",
              content: "q",
            },
            {
              message_id: 4,
              parent_id: 3,
              role: "ASSISTANT",
              content: "",
            },
          ],
        },
      },
    };
    const rounds = parseDeepSeekHistory(resp);
    expect(rounds).toHaveLength(2);
    // Round 1: both prompt and answer have no content → empty strings
    expect(rounds[0]!.promptText).toBe("");
    expect(rounds[0]!.answerText).toBe("");
    // Round 2: content present → normal
    expect(rounds[1]!.promptText).toBe("q");
    expect(rounds[1]!.answerText).toBe("");
  });

  it("trims whitespace from the content string", () => {
    const resp = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              role: "USER",
              content: "  prompt  ",
            },
            {
              message_id: 2,
              parent_id: 1,
              role: "ASSISTANT",
              status: "FINISHED",
              content: "  line1  \n  line2  ",
            },
          ],
        },
      },
    };
    const round = parseDeepSeekHistory(resp)[0]!;
    expect(round.promptText).toBe("prompt");
    expect(round.answerText).toBe("line1  \n  line2");
  });
});
