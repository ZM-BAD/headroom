import { describe, expect, it } from "vitest";

import { parseDoubaoHistory } from "../doubao";

/**
 * parseDoubaoHistory turns a ByteDance IM `messages[]` array (NEW→OLD) into
 * ascending rounds. Captured live (2026-06): Doubao is an IM model — user
 * (user_type 1) and bot (user_type 2) ALTERNATE; we walk the time-ascending list
 * and pair each user with the immediately-following bot. Two body shapes
 * coexist: new (content_type 9999, text in content_block[].content.text_block)
 * and old (content_type 1, content is a stringified {"text":"..."}).
 */
describe("parseDoubaoHistory", () => {
  it("pairs a user + the following bot (NEW content_type 9999 shape) into round 1", () => {
    const messages = [
      // NEW→OLD order from the API; the parse sorts ascending by create_time.
      {
        user_type: 2,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "你好！收到。" } } }],
        create_time: "1719500001",
        index_in_conv: "1",
      },
      {
        user_type: 1,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "你好,这是测试" } } }],
        create_time: "1719500000",
        index_in_conv: "0",
      },
    ];
    expect(parseDoubaoHistory(messages)).toEqual([
      {
        messageId: "db:1",
        order: 1719500001,
        createdAt: 1719500001000,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("reads the OLD content_type 1 shape (stringified {text})", () => {
    const messages = [
      {
        user_type: 1,
        content_type: 1,
        content: JSON.stringify({ text: "old user prompt" }),
        create_time: "100",
        index_in_conv: "0",
      },
      {
        user_type: 2,
        content_type: 1,
        content: JSON.stringify({ text: "old bot reply" }),
        create_time: "101",
        index_in_conv: "1",
      },
    ];
    expect(parseDoubaoHistory(messages)).toEqual([
      {
        messageId: "db:1",
        order: 101,
        createdAt: 101000,
        promptText: "old user prompt",
        answerText: "old bot reply",
      },
    ]);
  });

  it("handles both shapes coexisting in one conversation", () => {
    const messages = [
      // Round 2 uses the new shape; round 1 (older) uses the legacy shape.
      {
        user_type: 1,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "Q2 new" } } }],
        create_time: "200",
      },
      {
        user_type: 2,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "A2 new" } } }],
        create_time: "201",
      },
      {
        user_type: 1,
        content_type: 1,
        content: JSON.stringify({ text: "Q1 old" }),
        create_time: "100",
      },
      {
        user_type: 2,
        content_type: 1,
        content: JSON.stringify({ text: "A1 old" }),
        create_time: "101",
      },
    ];
    expect(parseDoubaoHistory(messages)).toEqual([
      {
        messageId: "db:t101",
        order: 101,
        createdAt: 101000,
        promptText: "Q1 old",
        answerText: "A1 old",
      },
      {
        messageId: "db:t201",
        order: 201,
        createdAt: 201000,
        promptText: "Q2 new",
        answerText: "A2 new",
      },
    ]);
  });

  it("orders multiple rounds ASCENDING (oldest first), 1-based n", () => {
    const messages = [
      {
        user_type: 2,
        content_type: 1,
        content: '{"text":"A2"}',
        create_time: "201",
      },
      {
        user_type: 1,
        content_type: 1,
        content: '{"text":"Q2"}',
        create_time: "200",
      },
      {
        user_type: 2,
        content_type: 1,
        content: '{"text":"A1"}',
        create_time: "101",
      },
      {
        user_type: 1,
        content_type: 1,
        content: '{"text":"Q1"}',
        create_time: "100",
      },
    ];
    expect(parseDoubaoHistory(messages)).toEqual([
      {
        messageId: "db:t101",
        order: 101,
        createdAt: 101000,
        promptText: "Q1",
        answerText: "A1",
      },
      {
        messageId: "db:t201",
        order: 201,
        createdAt: 201000,
        promptText: "Q2",
        answerText: "A2",
      },
    ]);
  });

  it('pairs unpaired user with answerText="" when no bot follows', () => {
    // user → user (no bot between) → bot. The first user has no reply —
    // count it with answerText="" (stopped/abandoned). The second user pairs
    // normally with the bot.
    const messages = [
      {
        user_type: 1,
        content_type: 1,
        content: '{"text":"Q1 abandoned"}',
        create_time: "100",
      },
      {
        user_type: 1,
        content_type: 1,
        content: '{"text":"Q2 real"}',
        create_time: "101",
      },
      {
        user_type: 2,
        content_type: 1,
        content: '{"text":"A2"}',
        create_time: "102",
      },
    ];
    expect(parseDoubaoHistory(messages)).toEqual([
      {
        messageId: "db:u0",
        order: 100,
        createdAt: 100000,
        promptText: "Q1 abandoned",
        answerText: "",
      },
      {
        messageId: "db:t102",
        order: 102,
        createdAt: 102000,
        promptText: "Q2 real",
        answerText: "A2",
      },
    ]);
  });

  it("concatenates multiple content_blocks in the new shape", () => {
    const messages = [
      {
        user_type: 2,
        content_type: 9999,
        content_block: [
          { content: { text_block: { text: "part 1" } } },
          { content: { text_block: { text: "part 2" } } },
        ],
        create_time: "101",
      },
      {
        user_type: 1,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "q" } } }],
        create_time: "100",
      },
    ];
    const [round] = parseDoubaoHistory(messages);
    expect(round.answerText).toBe("part 1\npart 2");
  });

  it("drops messages with no extractable text (system/control rows)", () => {
    const messages = [
      {
        user_type: 99, // a control role, not 1 or 2
        content_type: 1,
        content: '{"text":"should be ignored"}',
        create_time: "50",
      },
      {
        user_type: 1,
        content_type: 1,
        content: '{"text":"real q"}',
        create_time: "100",
      },
      {
        user_type: 2,
        content_type: 1,
        content: '{"text":"real a"}',
        create_time: "101",
      },
    ];
    expect(parseDoubaoHistory(messages)).toEqual([
      {
        messageId: "db:t101",
        order: 101,
        createdAt: 101000,
        promptText: "real q",
        answerText: "real a",
      },
    ]);
  });

  it("returns [] for empty / missing / malformed input", () => {
    expect(parseDoubaoHistory([])).toEqual([]);
    expect(parseDoubaoHistory(undefined as unknown as never[])).toEqual([]);
    expect(parseDoubaoHistory({} as unknown as never[])).toEqual([]);
  });
});
