import { describe, expect, it } from "vitest";

import { parseQwenHistory } from "../qwen";

/**
 * parseQwenHistory turns a `GET /api/v2/chats/<id>` response into ascending
 * rounds. Captured live (2026-06): messages is an OBJECT MAP (keyed by message
 * id), tree-linked via parentId/childrenIds; each assistant's parentId points at
 * the user it answers. The assistant body is in content_list[], split into
 * phases — only the "answer" phase is the real reply (the "thinking_summary"
 * phase is private reasoning and is dropped).
 */
describe("parseQwenHistory", () => {
  it("pairs an assistant with its parent user, taking only the answer phase", () => {
    const resp = {
      data: {
        chat: {
          history: {
            messages: {
              u1: { role: "user", content: "你好,这是测试" },
              a1: {
                role: "assistant",
                parentId: "u1",
                timestamp: 1719500000,
                content_list: [
                  { phase: "thinking_summary", content: "private reasoning" },
                  { phase: "answer", content: "你好！收到。" },
                ],
              },
            },
          },
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1719500000,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("drops the thinking_summary phase — only answer phases count", () => {
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
                content_list: [
                  { phase: "thinking_summary", content: "should be dropped 1" },
                  { phase: "answer", content: "real part 1" },
                  { phase: "thinking_summary", content: "should be dropped 2" },
                  { phase: "answer", content: "real part 2" },
                ],
              },
            },
          },
        },
      },
    };
    const [round] = parseQwenHistory(resp);
    expect(round.answerText).toBe("real part 1\nreal part 2");
  });

  it("orders multiple rounds ASCENDING by assistant timestamp (1-based n)", () => {
    const resp = {
      data: {
        chat: {
          history: {
            messages: {
              u2: { role: "user", content: "Q2" },
              a2: {
                role: "assistant",
                parentId: "u2",
                timestamp: 1719500100,
                content_list: [{ phase: "answer", content: "A2" }],
              },
              u1: { role: "user", content: "Q1" },
              a1: {
                role: "assistant",
                parentId: "u1",
                timestamp: 1719500000,
                content_list: [{ phase: "answer", content: "A1" }],
              },
            },
          },
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([
      {
        messageId: "a1",
        order: 1719500000,
        promptText: "Q1",
        answerText: "A1",
      },
      {
        messageId: "a2",
        order: 1719500100,
        promptText: "Q2",
        answerText: "A2",
      },
    ]);
  });

  it("skips an orphan assistant whose parent user is absent", () => {
    const resp = {
      data: {
        chat: {
          history: {
            messages: {
              a1: {
                role: "assistant",
                parentId: "missing",
                timestamp: 1,
                content_list: [{ phase: "answer", content: "orphan" }],
              },
            },
          },
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([]);
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
          history: {
            messages: {
              u1: { role: "user", content: "q" },
              a1: {
                role: "assistant",
                parentId: "u1",
                timestamp: 1,
                // only reasoning, never produced a visible answer
                content_list: [{ phase: "thinking_summary", content: "..." }],
              },
            },
          },
        },
      },
    };
    expect(parseQwenHistory(resp)).toEqual([
      { messageId: "a1", order: 1, promptText: "q", answerText: "" },
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
    expect(parseQwenHistory(null)).toEqual([]);
    expect(parseQwenHistory(undefined)).toEqual([]);
  });
});
