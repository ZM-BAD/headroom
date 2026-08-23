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

  it("extracts web-search tool blocks into toolText, drops think/stage (spec 005)", () => {
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
            {
              tool: {
                name: "web_search",
                args: '{"queries":["今日新闻"]}',
                contents: [
                  {
                    searchResult: {
                      base: {
                        title: "网易新闻",
                        snippet: "今日头条 2026-08-14",
                      },
                    },
                  },
                ],
              },
            },
            { stage: { content: "thinking marker" } },
            { text: { content: "the answer" } },
          ],
        },
      ],
    };
    const round = parseKimiHistory(resp)[0]!;
    expect(round.promptText).toBe("the prompt");
    expect(round.answerText).toBe("the answer");
    // tool block: args.queries + result title + snippet — the text the model read.
    expect(round.toolText).toBe(
      '{"queries":["今日新闻"]}\n网易新闻\n今日头条 2026-08-14',
    );
  });

  it("parses the K3-era block sequence — multiStage/stage/think drop, spaced-query args join (live 2026-08-21)", () => {
    // Live ListMessages shape after the K3 web rewrite: blocks carry NO `type`
    // field — the parser keys on the content field (`text`/`tool`). The NEW
    // `multiStage` block (thinking marker) must drop like think/stage. The
    // model-generated query DIFFERS from the prompt — counted as tool text
    // (no ChatGPT-style duplication; Kimi rewrites the query, verified live).
    const resp = {
      messages: [
        {
          id: "u1",
          role: "user",
          createTime: "2026-08-20T17:25:10Z",
          blocks: [
            { text: { content: "今天杭州的天气怎么样？请联网搜索最新预报" } },
          ],
        },
        {
          id: "a1",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-08-20T17:25:21Z",
          blocks: [
            {
              multiStage: {
                stages: [
                  {
                    name: "STAGE_NAME_THINKING",
                    createTime: "2026-08-20T17:25:20Z",
                    status: "STAGE_STATUS_END",
                  },
                ],
              },
            },
            { stage: { name: "STAGE_NAME_THINKING" } },
            { think: { content: "private reasoning" } },
            {
              tool: {
                name: "web_search",
                args: '{"queries": ["杭州天气 2026年8月21日 预报"]}',
                contents: [
                  {
                    searchResult: {
                      base: {
                        title: "杭州天气预报15天查询",
                        siteName: "中国天气网",
                        snippet: "今天 08/21 小雨转阴 32/25℃",
                      },
                    },
                  },
                ],
              },
            },
            { think: { content: "more reasoning" } },
            { text: { content: "杭州今天小雨转阴，32/25℃。" } },
          ],
        },
      ],
    };
    const round = parseKimiHistory(resp)[0]!;
    expect(round.promptText).toBe("今天杭州的天气怎么样？请联网搜索最新预报");
    expect(round.answerText).toBe("杭州今天小雨转阴，32/25℃。");
    expect(round.toolText).toBe(
      '{"queries": ["杭州天气 2026年8月21日 预报"]}\n杭州天气预报15天查询\n今天 08/21 小雨转阴 32/25℃',
    );
  });

  it("leaves toolText unset when the round has no tool block", () => {
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
          blocks: [{ text: { content: "the answer" } }],
        },
      ],
    };
    const round = parseKimiHistory(resp)[0]!;
    expect(round.toolText).toBeUndefined();
  });

  it("merges a tool-only assistant's search text into the paired round (same parent)", () => {
    // The tree holds a text assistant (the reply) AND a tool-only assistant
    // (the search ran but that attempt produced no text). The search text
    // must not be dropped just because the parent is already paired.
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
          blocks: [{ text: { content: "the answer" } }],
        },
        {
          id: "a2",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:01Z",
          blocks: [
            {
              tool: {
                name: "web_search",
                contents: [
                  {
                    searchResult: {
                      base: { title: "搜索标题", snippet: "搜索摘要" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const rounds = parseKimiHistory(resp);
    expect(rounds).toHaveLength(1); // same parent → ONE round
    expect(rounds[0]!.answerText).toBe("the answer");
    expect(rounds[0]!.toolText).toBe("搜索标题\n搜索摘要");
  });

  it("joins MULTIPLE tool-only assistants' search text into the paired round (multi-step search)", () => {
    // Multi-step browsing: two sequential web searches within one turn — each
    // search round-trip is its own assistant message, all sharing the same
    // parent user. Spec 005: ALL invocations within one turn are joined.
    // Regression: the `!target.toolText` guard silently dropped the second
    // (and later) tool-only assistant's search text.
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
          createTime: "2026-06-01T00:00:03Z",
          blocks: [{ text: { content: "the answer" } }],
        },
        {
          id: "a2",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:02Z",
          blocks: [
            {
              tool: {
                name: "web_search",
                contents: [
                  {
                    searchResult: {
                      base: { title: "第一轮搜索", snippet: "第一轮摘要" },
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "a3",
          role: "assistant",
          parentId: "u1",
          createTime: "2026-06-01T00:00:01Z",
          blocks: [
            {
              tool: {
                name: "web_search",
                contents: [
                  {
                    searchResult: {
                      base: { title: "第二轮搜索", snippet: "第二轮摘要" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const rounds = parseKimiHistory(resp);
    expect(rounds).toHaveLength(1); // same parent → ONE round
    expect(rounds[0]!.answerText).toBe("the answer");
    expect(rounds[0]!.toolText).toBe(
      "第一轮搜索\n第一轮摘要\n第二轮搜索\n第二轮摘要",
    );
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
    const round = parseKimiHistory(resp)[0]!;
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

  it('pairs a failed assistant (no text) as a round with answerText="" when the user didn\'t retry', () => {
    // User stopped generation — the assistant has no text block but the prompt
    // still consumed tokens. Count it as a round with answerTokens=0.
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
          // stopped/failed: only empty id blocks, no text
          blocks: [{ id: {} }, { id: {} }],
        },
      ],
    };
    expect(parseKimiHistory(resp)).toEqual([
      {
        messageId: "a1_failed",
        order: 1780272000000,
        createdAt: 1780272000000,
        promptText: "Q1",
        answerText: "",
      },
    ]);
  });

  it("counts both the failed attempt and the retry when the user resends", () => {
    // First attempt failed (OVERLOADED), user retried with same prompt via a
    // new user message. Both consumed tokens — count both rounds.
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
        messageId: "a1_failed",
        order: 1780272000000,
        createdAt: 1780272000000,
        promptText: "Q1",
        answerText: "",
      },
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
