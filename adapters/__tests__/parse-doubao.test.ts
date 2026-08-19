import { describe, expect, it } from "vitest";

import { unionRounds, type RoundRecord } from "../../utils/dialogue-record";
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
        messageId: "db:ut1719500000",
        order: 1719500001,
        createdAt: 1719500001000,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("extracts search_query_result_block text into toolText (spec 005)", () => {
    const messages = [
      {
        user_type: 2,
        content_type: 9999,
        content_block: [
          {
            content: {
              search_query_result_block: {
                summary: "搜索 2 个关键词,参考 3 篇资料",
                queries: ["今日新闻", "全球头条"],
                results: [
                  { text_card: { summary: "美联储维持利率不变 2026-08-14" } },
                  { text_card: { summary: "A股三大指数收涨" } },
                ],
              },
            },
          },
          { content: { text_block: { text: "the answer" } } },
        ],
        create_time: "1719500001",
        index_in_conv: "1",
      },
      {
        user_type: 1,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "the prompt" } } }],
        create_time: "1719500000",
        index_in_conv: "0",
      },
    ];
    const round = parseDoubaoHistory(messages)[0]!;
    expect(round.answerText).toBe("the answer");
    expect(round.toolText).toBe(
      "今日新闻\n全球头条\n美联储维持利率不变 2026-08-14\nA股三大指数收涨",
    );
  });

  it("leaves toolText unset when the bot message has no search block", () => {
    const messages = [
      {
        user_type: 2,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "the answer" } } }],
        create_time: "1719500001",
        index_in_conv: "1",
      },
      {
        user_type: 1,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "the prompt" } } }],
        create_time: "1719500000",
        index_in_conv: "0",
      },
    ];
    expect(parseDoubaoHistory(messages)[0]!.toolText).toBeUndefined();
  });

  it("keeps a search-only bot row (no answer text) — search tokens still count", () => {
    // The search ran but the answer failed/interrupted: the bot message has a
    // search_query_result_block and NO text_block. The round must keep the
    // toolText (answerText stays empty) instead of being dropped entirely.
    const messages = [
      {
        user_type: 2,
        content_type: 9999,
        content_block: [
          {
            content: {
              search_query_result_block: {
                queries: ["今日新闻"],
                results: [{ text_card: { summary: "搜索到的重要新闻" } }],
              },
            },
          },
        ],
        create_time: "1719500001",
        index_in_conv: "1",
      },
      {
        user_type: 1,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "the prompt" } } }],
        create_time: "1719500000",
        index_in_conv: "0",
      },
    ];
    const round = parseDoubaoHistory(messages)[0]!;
    expect(round.answerText).toBe("");
    expect(round.toolText).toBe("今日新闻\n搜索到的重要新闻");
  });

  it("merges the search card and the answer into ONE round when sent as separate bot messages", () => {
    // IM streaming shape: the search card streams first, the text answer
    // follows as its own bot message. Binding the round to the FIRST bot row
    // would drop the real answer — every bot row between two users belongs
    // to the round, ordered by the LAST bot's create_time.
    const messages = [
      {
        user_type: 2,
        content_type: 9999,
        content_block: [
          {
            content: {
              search_query_result_block: {
                queries: ["今日新闻"],
                results: [{ text_card: { summary: "搜索到的重要新闻" } }],
              },
            },
          },
        ],
        create_time: "1719500001",
        index_in_conv: "1",
      },
      {
        user_type: 2,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "the answer" } } }],
        create_time: "1719500002",
        index_in_conv: "2",
      },
      {
        user_type: 1,
        content_type: 9999,
        content_block: [{ content: { text_block: { text: "the prompt" } } }],
        create_time: "1719500000",
        index_in_conv: "0",
      },
    ];
    const round = parseDoubaoHistory(messages)[0]!;
    expect(round.answerText).toBe("the answer");
    expect(round.toolText).toBe("今日新闻\n搜索到的重要新闻");
    expect(round.order).toBe(1719500002); // the LAST bot's create_time
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
        messageId: "db:ut100",
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
        messageId: "db:ut100",
        order: 101,
        createdAt: 101000,
        promptText: "Q1 old",
        answerText: "A1 old",
      },
      {
        messageId: "db:ut200",
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
        messageId: "db:ut100",
        order: 101,
        createdAt: 101000,
        promptText: "Q1",
        answerText: "A1",
      },
      {
        messageId: "db:ut200",
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
        messageId: "db:ut100",
        order: 100,
        createdAt: 100000,
        promptText: "Q1 abandoned",
        answerText: "",
      },
      {
        messageId: "db:ut101",
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
    const round = parseDoubaoHistory(messages)[0]!;
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
        messageId: "db:ut100",
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

/**
 * Round identity is anchored on the USER message — the zombie-round
 * regression. Doubao's IM chain persists the bot message 0–1s+ AFTER the
 * completion stream closes (measured live 2026-07). A fetch inside that
 * window sees the round answerless; keying the round by the BOT's id gave
 * the same real round two ids across fetches (answerless vs answered), and
 * 003's union-merge retained both — double-counting the prompt forever.
 * Message shapes below are the RAW capture from that live session
 * (conversation 38435127649220610, texts truncated).
 */
describe("parseDoubaoHistory — user-anchored round identity", () => {
  const USER = {
    user_type: 1,
    content_type: 9999,
    index_in_conv: "1",
    create_time: "1784123722",
    content_block: [
      { content: { text_block: { text: "用三句话介绍一下长城的历史" } } },
    ],
  };
  const BOT = {
    user_type: 2,
    content_type: 9999,
    index_in_conv: "2",
    create_time: "1784123723",
    content_block: [
      { content: { text_block: { text: "1. 长城的修筑始于春秋战国时期…" } } },
    ],
  };

  it("keys the round identically whether or not the bot message has landed", () => {
    const raceState = parseDoubaoHistory([USER]); // the +473ms probe state
    const settled = parseDoubaoHistory([BOT, USER]); // the +948ms state (NEW→OLD)
    expect(raceState).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(raceState[0]!.answerText).toBe("");
    expect(settled[0]!.answerText).not.toBe("");
    // Same real-world round ⇒ same id — the user's index_in_conv, never
    // the bot's id and never an array position.
    expect(raceState[0]!.messageId).toBe("db:u1");
    expect(settled[0]!.messageId).toBe("db:u1");
  });

  it("union-merge collapses race-state and settled-state into ONE round (no zombie)", () => {
    const rec = (
      r: ReturnType<typeof parseDoubaoHistory>[number],
      n: number,
    ): RoundRecord => ({
      messageId: r.messageId,
      order: r.order,
      n,
      promptTokens: 10,
      toolTokens: 0,
      answerTokens: r.answerText ? 100 : 0,
      total: 10 + (r.answerText ? 100 : 0),
      createdAt: r.createdAt ?? 0,
    });
    const cloud = parseDoubaoHistory([USER]).map(rec); // what a lost race shipped
    const history = parseDoubaoHistory([BOT, USER]).map(rec); // corrected fetch
    const merged = unionRounds(cloud, history);
    expect(merged).toHaveLength(1);
    // "history WINS": the real output overwrites the raced 0.
    expect(merged[0]!.answerTokens).toBe(100);
    expect(merged.reduce((s, r) => s + r.promptTokens, 0)).toBe(10);
  });
});
