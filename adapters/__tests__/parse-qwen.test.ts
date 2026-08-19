import { describe, expect, it } from "vitest";

import { parseQwenHistory } from "../qwen";

/**
 * parseQwenHistory turns a `GET /api/v2/chats/<id>` response into ascending
 * rounds. CONFIRMED shape, 2026-08 live probe: messages is an ARRAY at
 * data.chat.messages (the 2026-06 object-map shape at
 * data.chat.history.messages is read as a fallback), tree-linked via
 * parentId; each assistant's parentId points at the user it answers. The
 * assistant body is a top-level `content` string plus content_list[] phases —
 * only the "answer" phase is the real reply (the "thinking_summary" phase is
 * private reasoning and is dropped). Web-search text (spec 005) lives in the
 * "web_search" phase's extra.web_search_info[] — joined into toolText.
 */
describe("parseQwenHistory", () => {
  it("pairs an assistant with its parent user (2026-08 array shape), taking only the answer phase", () => {
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "u1", role: "user", content: "你好,这是测试" },
            {
              id: "a1",
              role: "assistant",
              parentId: "u1",
              timestamp: 1719500000,
              content_list: [
                { phase: "thinking_summary", content: "private reasoning" },
                { phase: "answer", content: "你好！收到。" },
              ],
            },
          ],
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1719500000,
        createdAt: 1719500000000,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("drops the thinking_summary phase — only answer phases count", () => {
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "u1", role: "user", content: "q" },
            {
              id: "a1",
              role: "assistant",
              parentId: "u1",
              timestamp: 1,
              content_list: [
                { phase: "thinking_summary", content: "should be dropped 1" },
                { phase: "answer", content: "real part 1" },
                { phase: "thinking_summary", content: "should be dropped 2" },
                { phase: "answer", content: "real part 2" },
              ],
            },
          ],
        },
      },
    };
    const round = parseQwenHistory(resp)[0]!;
    expect(round.answerText).toBe("real part 1\nreal part 2");
  });

  it("extracts web_search result text into toolText (spec 005)", () => {
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "u1", role: "user", content: "q" },
            {
              id: "a1",
              role: "assistant",
              parentId: "u1",
              timestamp: 1,
              content_list: [
                { phase: "thinking_summary", content: "reasoning" },
                {
                  phase: "web_search",
                  extra: {
                    web_search_info: [
                      { title: "BBC 新闻", snippet: "2026年8月14日 头条" },
                      { title: "Reuters", snippet: "breaking news" },
                    ],
                  },
                },
                { phase: "answer", content: "real answer" },
              ],
            },
          ],
        },
      },
    };
    const round = parseQwenHistory(resp)[0]!;
    expect(round.answerText).toBe("real answer");
    expect(round.toolText).toBe(
      "BBC 新闻\n2026年8月14日 头条\nReuters\nbreaking news",
    );
  });

  it("leaves toolText unset when the round had no web_search phase", () => {
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "u1", role: "user", content: "q" },
            {
              id: "a1",
              role: "assistant",
              parentId: "u1",
              timestamp: 1,
              content_list: [{ phase: "answer", content: "a" }],
            },
          ],
        },
      },
    };
    expect(parseQwenHistory(resp)[0]!.toolText).toBeUndefined();
  });

  it("orders multiple rounds ASCENDING by assistant timestamp", () => {
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "u2", role: "user", content: "Q2" },
            {
              id: "a2",
              role: "assistant",
              parentId: "u2",
              timestamp: 1719500100,
              content_list: [{ phase: "answer", content: "A2" }],
            },
            { id: "u1", role: "user", content: "Q1" },
            {
              id: "a1",
              role: "assistant",
              parentId: "u1",
              timestamp: 1719500000,
              content_list: [{ phase: "answer", content: "A1" }],
            },
          ],
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([
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

  it("still reads the 2026-06 object-map fallback shape", () => {
    const resp = {
      data: {
        chat: {
          history: {
            messages: {
              u1: { role: "user", content: "q" },
              a1: {
                role: "assistant",
                parentId: "u1",
                timestamp: 1,
                content_list: [{ phase: "answer", content: "a" }],
              },
            },
          },
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1,
        promptText: "q",
        answerText: "a",
        createdAt: 1000,
      },
    ]);
  });

  it("skips an orphan assistant whose parent user is absent", () => {
    const resp = {
      data: {
        chat: {
          messages: [
            {
              id: "a1",
              role: "assistant",
              parentId: "missing",
              timestamp: 1,
              content_list: [{ phase: "answer", content: "orphan" }],
            },
          ],
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([]);
  });

  it("uses a deterministic fallback messageId when the API omits ids (never the array position)", () => {
    // Foreign shape: no id/message_id on either message. The fallback id must
    // be identical across two fetches of the same round (003 messageId merge),
    // and must NOT contain the array position (which shifts as history grows).
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "p1", role: "user", content: "q" },
            {
              role: "assistant",
              parentId: "p1",
              timestamp: 7,
              content_list: [{ phase: "answer", content: "a" }],
            },
          ],
        },
      },
    };
    const id1 = parseQwenHistory(resp)[0]!.messageId;
    const id2 = parseQwenHistory(resp)[0]!.messageId;
    expect(id1).toBe(id2);
    expect(id1).toBe("qwen:7:p1:2p"); // 2p = djb2("a")
    // A later fetch with the same round one position deeper keeps the SAME id
    // (content-derived tie-breaker — unaffected by position shifts; an
    // array-position counter would drift and unionRounds would duplicate).
    const grown = {
      data: {
        chat: {
          messages: [
            { id: "p0", role: "user", content: "older q" },
            { role: "assistant", parentId: "p0", timestamp: 6 },
            { id: "p1", role: "user", content: "q" },
            {
              role: "assistant",
              parentId: "p1",
              timestamp: 7,
              content_list: [{ phase: "answer", content: "a" }],
            },
          ],
        },
      },
    };
    expect(parseQwenHistory(grown)[1]!.messageId).toBe("qwen:7:p1:2p");
  });

  it("disambiguates fallback messageIds for two assistants sharing timestamp+parent (regenerate)", () => {
    // Foreign shape (no ids): a regenerate produces two assistants with the
    // SAME timestamp AND parent. Without the anti-collision suffix both would
    // get messageId "qwen:7:p1" and unionRounds would silently drop one round.
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "p1", role: "user", content: "q" },
            {
              role: "assistant",
              parentId: "p1",
              timestamp: 7,
              content_list: [{ phase: "answer", content: "first answer" }],
            },
            {
              role: "assistant",
              parentId: "p1",
              timestamp: 7,
              content_list: [
                { phase: "answer", content: "regenerated answer" },
              ],
            },
          ],
        },
      },
    };
    const rounds = parseQwenHistory(resp);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.messageId).toBe("qwen:7:p1:1qbrt4e"); // djb2("first answer")
    expect(rounds[1]!.messageId).toBe("qwen:7:p1:17i7lpe"); // djb2("regenerated answer")
    expect(new Set(rounds.map((r) => r.messageId)).size).toBe(2);
  });

  // NOTE: an assistant with NO answer phase still produces a round with an
  // empty answerText (the prompt survives because it is non-empty). This is the
  // current implementation — it does not skip a thinking-only assistant. Qwen's
  // real API always includes an "answer" phase on a completed turn, so this is
  // defensive; verify against a real failed-turn response in the Playwright pass.
  it("produces an empty-answer round for a thinking-only assistant (prompt survives)", () => {
    const resp = {
      data: {
        chat: {
          messages: [
            { id: "u1", role: "user", content: "q" },
            {
              id: "a1",
              role: "assistant",
              parentId: "u1",
              timestamp: 1,
              // only reasoning, never produced a visible answer
              content_list: [{ phase: "thinking_summary", content: "..." }],
            },
          ],
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1,
        promptText: "q",
        answerText: "",
        createdAt: 1000,
      },
    ]);
  });

  it("returns [] for empty / missing / malformed shapes", () => {
    expect(parseQwenHistory({})).toEqual([]);
    expect(parseQwenHistory({ data: {} })).toEqual([]);
    expect(parseQwenHistory({ data: { chat: {} } })).toEqual([]);
    expect(parseQwenHistory({ data: { chat: { history: {} } } })).toEqual([]);
    expect(
      parseQwenHistory({ data: { chat: { history: { messages: {} } } } }),
    ).toEqual([]);
    expect(parseQwenHistory({ data: { chat: { messages: [] } } })).toEqual([]);
    expect(parseQwenHistory(null)).toEqual([]);
    expect(parseQwenHistory(undefined)).toEqual([]);
  });
});
