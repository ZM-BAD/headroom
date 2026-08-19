import { describe, expect, it } from "vitest";

import { unionRounds, type RoundRecord } from "../../utils/dialogue-record";
import type { HistoryRound } from "../../utils/platform-adapter";
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

  it("extracts the web-search call node (content_type code + recipient web) into toolText (spec 005)", () => {
    // Real search turn: user → code node (recipient "web", the search call) →
    // assistant text reply. The RESULT text is server-side (not in the
    // conversation API) — only the invocation counts.
    // CONFIRMED live 2026-08-16: the invocation text lives in `content.text`
    // (`search("…")`) — code nodes have NO `parts` array.
    const resp = {
      mapping: {
        u1: {
          id: "u1",
          message: {
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: ["@网页搜索 今天有什么新闻"],
            },
          },
          children: ["w1"],
        },
        w1: {
          id: "w1",
          message: {
            author: { role: "assistant" },
            recipient: "web",
            content: {
              content_type: "code",
              text: 'search("@网页搜索 今天有什么新闻")',
            },
            create_time: 1719500000,
          },
          children: ["a1"],
        },
        a1: {
          id: "a1",
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["这是回答。"] },
            create_time: 1719500001,
          },
          children: [],
        },
      },
    };
    const round = parseChatGptHistory(resp)[0]!;
    expect(round.answerText).toBe("这是回答。");
    expect(round.toolText).toBe('search("@网页搜索 今天有什么新闻")');
  });

  it("falls back to content.parts when content.text is absent (legacy shape)", () => {
    const resp = {
      mapping: {
        u1: {
          id: "u1",
          message: {
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: ["@网页搜索 今天有什么新闻"],
            },
          },
          children: ["w1"],
        },
        w1: {
          id: "w1",
          message: {
            author: { role: "assistant" },
            recipient: "web",
            content: {
              content_type: "code",
              parts: ['search("@网页搜索 今天有什么新闻")'],
            },
            create_time: 1719500000,
          },
          children: ["a1"],
        },
        a1: {
          id: "a1",
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["这是回答。"] },
            create_time: 1719500001,
          },
          children: [],
        },
      },
    };
    const round = parseChatGptHistory(resp)[0]!;
    expect(round.toolText).toBe('search("@网页搜索 今天有什么新闻")');
  });

  it("leaves toolText unset when the turn had no web-search call", () => {
    const resp = {
      mapping: {
        u1: {
          id: "u1",
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["你好"] },
          },
          children: ["a1"],
        },
        a1: {
          id: "a1",
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["你好！"] },
            create_time: 1719500000,
          },
          children: [],
        },
      },
    };
    expect(parseChatGptHistory(resp)[0]!.toolText).toBeUndefined();
  });

  it("stops at the turn boundary — a prior turn never picks up a later turn's search call", () => {
    // Real mappings are LINEAR chains (user1 → assistant1 → user2 → assistant2…).
    // A walk that descends past the next user node misattributes turn 2's
    // search call to turn 1 — and double-counts it on turn 2 itself.
    const resp = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["先随便聊聊"] },
          },
          children: ["a1"],
        },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["好的"] },
            create_time: 1719500000,
          },
          children: ["u2"],
        },
        u2: {
          message: {
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: ["@网页搜索 今天有什么新闻"],
            },
          },
          children: ["w2"],
        },
        w2: {
          message: {
            author: { role: "assistant" },
            recipient: "web",
            content: {
              content_type: "code",
              text: 'search("@网页搜索 今天有什么新闻")',
            },
            create_time: 1719500001,
          },
          children: ["a2"],
        },
        a2: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["这是回答。"] },
            create_time: 1719500002,
          },
          children: [],
        },
      },
    };
    const rounds = parseChatGptHistory(resp);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.toolText).toBeUndefined(); // turn 1 never saw the search
    expect(rounds[1]!.toolText).toBe('search("@网页搜索 今天有什么新闻")');
  });

  it("joins MULTIPLE search invocations within one turn (multi-step browsing)", () => {
    const resp = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["@网页搜索 A 和 B"] },
          },
          children: ["w1"],
        },
        w1: {
          message: {
            author: { role: "assistant" },
            recipient: "web",
            content: { content_type: "code", text: 'search("A")' },
            create_time: 1719500000,
          },
          children: ["w2"],
        },
        w2: {
          message: {
            author: { role: "assistant" },
            recipient: "web",
            content: { content_type: "code", text: 'search("B")' },
            create_time: 1719500001,
          },
          children: ["a1"],
        },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["综合结果"] },
            create_time: 1719500002,
          },
          children: [],
        },
      },
    };
    expect(parseChatGptHistory(resp)[0]!.toolText).toBe(
      'search("A")\nsearch("B")',
    );
  });

  it("does not steal the NEXT turn's answer when this turn was stopped", () => {
    // Turn 1 was stopped before any answer node mounted — only the
    // model_editable_context stub exists. It must NOT pick up turn 2's
    // answer: with the stub-skip fix it produces NO round at all (a stub is
    // not a valid anchor — see the two-fetch zombie test), and turn 2 pairs
    // normally with its own answer.
    const resp = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["被停止的问题"] },
          },
          children: ["stub1"],
        },
        stub1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "model_editable_context", parts: [] },
            create_time: 1719500000,
          },
          children: ["u2"],
        },
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
      },
    };
    const rounds = parseChatGptHistory(resp);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.promptText).toBe("Q2");
    expect(rounds[0]!.answerText).toBe("A2");
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
    const round = parseChatGptHistory(resp)[0]!;
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
    const round = parseChatGptHistory(resp)[0]!;
    expect(round.promptText).toBe("real text");
  });

  it("drops a turn whose only assistant is the model_editable_context stub", () => {
    // The stub is a context-injection marker, never a real answer. Anchoring
    // a fallback round on it created a PERMANENT zombie once the real answer
    // landed (different id; unionRounds' cloud-only retention kept both —
    // see the two-fetch regression test below). A stopped generation's
    // partial answer is counted by the DOM stop-path instead; a turn whose
    // answer node EXISTS but is empty still produces a round (the anchor is
    // the answer id, so it replaces in place once text lands).
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
    expect(parseChatGptHistory(resp)).toEqual([]);
  });

  it("never anchors a round on the model_editable_context stub (zombie across fetches)", () => {
    // A fetch landing while the answer is still generating sees ONLY the stub
    // (user → model_editable_context, no answer node yet). Anchoring the
    // fallback round on the stub id created a SECOND round once the real
    // answer landed (different id) — unionRounds' cloud-only retention kept
    // the stub round forever, double-counting the prompt (the Doubao zombie
    // class, spec 003). Mid-generation fetches must emit NO round for the
    // turn; the settled fetch's answer-anchored round is the only one.
    const midGen = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["q"] },
          },
          children: ["stub1"],
        },
        stub1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "model_editable_context", parts: [] },
            create_time: 1719500000,
          },
          children: [],
        },
      },
    };
    const settled = {
      mapping: {
        u1: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["q"] },
          },
          children: ["stub1"],
        },
        stub1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "model_editable_context", parts: [] },
            create_time: 1719500000,
          },
          children: ["a1"],
        },
        a1: {
          message: {
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["A"] },
            create_time: 1719500001,
          },
          children: [],
        },
      },
    };
    const rec = (r: HistoryRound, n: number): RoundRecord => ({
      messageId: r.messageId,
      order: r.order,
      n,
      promptTokens: 10,
      toolTokens: 0,
      answerTokens: r.answerText ? 100 : 0,
      total: 10 + (r.answerText ? 100 : 0),
      createdAt: r.createdAt ?? 0,
    });
    const cloud = parseChatGptHistory(midGen).map(rec); // what a mid-gen fetch shipped
    const history = parseChatGptHistory(settled).map(rec); // the settled view
    expect(cloud).toHaveLength(0); // no stub-anchored round ever enters the record
    const merged = unionRounds(cloud, history);
    expect(merged).toHaveLength(1); // one round — no zombie
    expect(merged[0]!.answerTokens).toBe(100);
    expect(merged.reduce((s, r) => s + r.promptTokens, 0)).toBe(10); // counted once
  });

  it("returns [] for empty / missing / malformed mapping", () => {
    expect(parseChatGptHistory({})).toEqual([]);
    expect(parseChatGptHistory({ mapping: {} })).toEqual([]);
    expect(parseChatGptHistory({ mapping: null })).toEqual([]);
    expect(parseChatGptHistory(null)).toEqual([]);
    expect(parseChatGptHistory(undefined)).toEqual([]);
  });
});
