import { describe, expect, it } from "vitest";

import { ADAPTERS } from "../index";
import type { PlatformAdapter } from "../../utils/platform-adapter";

/**
 * parseRequest runs in the background on every platform's send-request body
 * (read via webRequest). Two contracts must hold across ALL adapters:
 *
 *   1. NEVER throw — a malformed/unexpected body must degrade to
 *      {prompt:null, dialogueId:null}, because a throw would silently kill the
 *      webRequest listener's processing for that send (and every later one on
 *      some engines). The background already wraps it in try/catch, but the
 *      function itself should be defensive too.
 *   2. The happy path for each platform matches the request shape confirmed by
 *      reverse-engineering (documented in each adapter's header comment).
 *
 * Selector strings are deliberately NOT asserted here — those are verified by
 * Playwright e2e against live DOMs, not unit tests (jsdom doesn't render real
 * platform pages, so asserting them here would be theatre).
 */

const byId = (id: string): PlatformAdapter =>
  ADAPTERS.find((a) => a.platformId === id)!;

describe("parseRequest — cross-platform robustness contract", () => {
  it.each(ADAPTERS.map((a) => [a.platformId, a] as const))(
    "%s: never throws on null/undefined/empty/garbage input",
    (_id, adapter) => {
      // The background wraps parseRequest in try/catch, but the function must
      // still be defensive: no platform's body shape is guaranteed in the wild.
      expect(() => adapter.parseRequest(null, "")).not.toThrow();
      expect(() => adapter.parseRequest(undefined, "")).not.toThrow();
      expect(() => adapter.parseRequest({}, "")).not.toThrow();
      expect(() => adapter.parseRequest("not an object", "")).not.toThrow();
      expect(() => adapter.parseRequest(123, "")).not.toThrow();
    },
  );

  it.each(ADAPTERS.map((a) => [a.platformId, a] as const))(
    "%s: empty body yields null prompt + null dialogueId",
    (_id, adapter) => {
      const r = adapter.parseRequest({}, "");
      expect(r.prompt).toBeNull();
      expect(r.dialogueId).toBeNull();
    },
  );

  it("every registered adapter has a parseRequest that returns the {prompt, dialogueId} shape", () => {
    for (const a of ADAPTERS) {
      const r = a.parseRequest({}, "");
      expect(r).toHaveProperty("prompt");
      expect(r).toHaveProperty("dialogueId");
    }
  });
});

describe("parseRequest — DeepSeek (body: prompt + chat_session_id)", () => {
  const a = byId("deepseek");
  it("extracts prompt + dialogueId from a normal send", () => {
    expect(
      a.parseRequest({ prompt: "你好", chat_session_id: "s-abc" }, ""),
    ).toEqual({ prompt: "你好", dialogueId: "s-abc" });
  });
  it("returns null dialogueId when chat_session_id is absent", () => {
    expect(a.parseRequest({ prompt: "hi" }, "")).toEqual({
      prompt: "hi",
      dialogueId: null,
    });
  });
  it("returns null prompt when prompt is not a string (e.g. array/obj)", () => {
    // DeepSeek sends a string prompt; a non-string means the shape changed —
    // don't guess, surface as null so the DOM fallback can take over.
    expect(a.parseRequest({ prompt: ["x"], chat_session_id: "s" }, "")).toEqual(
      { prompt: null, dialogueId: "s" },
    );
  });
});

describe("parseRequest — ChatGPT (body: messages[].content.parts + conversation_id)", () => {
  const a = byId("chatgpt");
  it("extracts prompt from messages[0].content.parts[0] + conversation_id", () => {
    const body = {
      messages: [{ content: { parts: ["write a haiku"] } }],
      conversation_id: "conv-1",
    };
    expect(a.parseRequest(body, "")).toEqual({
      prompt: "write a haiku",
      dialogueId: "conv-1",
    });
  });
  it("returns null prompt when parts is empty or non-string", () => {
    expect(
      a.parseRequest({ messages: [{ content: { parts: [] } }] }, ""),
    ).toEqual({ prompt: null, dialogueId: null });
  });
  it("returns null prompt when messages is absent (new conversation, id assigned later)", () => {
    expect(a.parseRequest({ conversation_id: "c" }, "")).toEqual({
      prompt: null,
      dialogueId: "c",
    });
  });
});

describe("parseRequest — Gemini (body unparseable → always null/null)", () => {
  const a = byId("gemini");
  it("returns null/null regardless of body (f.req batchexecute is index-unstable)", () => {
    // Gemini's prompt + answer both come from the DOM; parseRequest is a
    // documented no-op. Pin it so nobody "optimizes" it into fragile parsing.
    expect(a.parseRequest({ anything: "here" }, "")).toEqual({
      prompt: null,
      dialogueId: null,
    });
    expect(a.parseRequest({}, "")).toEqual({ prompt: null, dialogueId: null });
  });
});

describe("parseRequest — Kimi (Connect-RPC: message.blocks[].text.content; chat_id in body)", () => {
  const a = byId("kimi");
  // Live-confirmed 2026-06: Kimi moved off /api/chat/{id}/completion/stream to a
  // gRPC-gateway RPC POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat with a
  // Connect-JSON body. chat_id is in the body for existing chats and ABSENT on
  // the first send of a brand-new chat (server assigns it). Prompt is in
  // message.blocks[0].text.content.
  it("extracts prompt + chat_id from an existing-chat send", () => {
    const body = {
      chat_id: "19ee868c-5412-84f7-8000-094483545d5c",
      scenario: "SCENARIO_K2D5",
      message: {
        role: "user",
        blocks: [{ message_id: "", text: { content: "2" } }],
        scenario: "SCENARIO_K2D5",
      },
      options: { thinking: false, enable_plugin: false },
    };
    expect(a.parseRequest(body, "")).toEqual({
      prompt: "2",
      dialogueId: "19ee868c-5412-84f7-8000-094483545d5c",
    });
  });
  it("returns null dialogueId on the first send of a new chat (chat_id assigned server-side)", () => {
    const body = {
      scenario: "SCENARIO_K2D5",
      message: { blocks: [{ text: { content: "hi" } }] },
    };
    expect(a.parseRequest(body, "")).toEqual({
      prompt: "hi",
      dialogueId: null,
    });
  });
  it("returns null prompt when the text content is not a string", () => {
    const body = {
      chat_id: "c-1",
      message: { blocks: [{ text: { content: { x: 1 } } }] },
    };
    expect(a.parseRequest(body, "")).toEqual({
      prompt: null,
      dialogueId: "c-1",
    });
  });
});

describe("parseRequest — Qwen (body: messages[].content string|array; dialogueId in URL query)", () => {
  const a = byId("qwen");
  const url = "https://chat.qwen.ai/api/v2/chat/completions?chat_id=abc-123";
  it("handles string content", () => {
    expect(a.parseRequest({ messages: [{ content: "hello" }] }, url)).toEqual({
      prompt: "hello",
      dialogueId: "abc-123",
    });
  });
  it("handles array content [{type,text}]", () => {
    const body = {
      messages: [{ content: [{ type: "text", text: "from array" }] }],
    };
    expect(a.parseRequest(body, url)).toEqual({
      prompt: "from array",
      dialogueId: "abc-123",
    });
  });
  it("returns null prompt when array content's first block has no string text", () => {
    const body = { messages: [{ content: [{ type: "image_url" }] }] };
    expect(a.parseRequest(body, url)).toEqual({
      prompt: null,
      dialogueId: "abc-123",
    });
  });
  it("decodes URL-encoded chat_id", () => {
    // %20 → space. decodeURIComponent is in the impl; guard it.
    const u = "https://chat.qwen.ai/api/v2/chat/completions?chat_id=a%20b";
    expect(a.parseRequest({ messages: [{ content: "x" }] }, u)).toEqual({
      prompt: "x",
      dialogueId: "a b",
    });
  });
  it("returns null dialogueId when chat_id query is absent", () => {
    expect(
      a.parseRequest(
        { messages: [{ content: "x" }] },
        "https://chat.qwen.ai/x",
      ),
    ).toEqual({ prompt: "x", dialogueId: null });
  });
});

describe("parseRequest — 通义千问 (body: messages[].content + session_id)", () => {
  const a = byId("qianwen");
  it("extracts prompt from messages[0].content + session_id", () => {
    // Real body confirmed live (2026-06): messages[0].content is a plain
    // string, session_id is the dialogue id.
    expect(
      a.parseRequest(
        { messages: [{ content: "你好" }], session_id: "sess-1" },
        "",
      ),
    ).toEqual({ prompt: "你好", dialogueId: "sess-1" });
  });
  it("returns null dialogueId when session_id is absent", () => {
    expect(a.parseRequest({ messages: [{ content: "hi" }] }, "")).toEqual({
      prompt: "hi",
      dialogueId: null,
    });
  });
  it("returns null prompt when content is not a string", () => {
    expect(
      a.parseRequest({ messages: [{ content: { parts: ["x"] } }] }, ""),
    ).toEqual({ prompt: null, dialogueId: null });
  });
});

describe("parseRequest — 豆包 (body: messages[].content is STRINGIFIED JSON; local_conversation_id)", () => {
  const a = byId("doubao");
  it("parses stringified JSON {text} content + local_conversation_id", () => {
    // Doubao wraps the prompt as JSON inside a string — the trickiest shape.
    const body = {
      messages: [{ content: JSON.stringify({ text: "你好" }) }],
      local_conversation_id: "lc-1",
    };
    expect(a.parseRequest(body, "")).toEqual({
      prompt: "你好",
      dialogueId: "lc-1",
    });
  });
  it("falls back to raw string when content is not valid JSON", () => {
    // Defensive branch: JSON.parse throws → catch → use raw. Without this test
    // a refactor could swallow the fallback into returning null.
    const body = { messages: [{ content: "纯文本非JSON" }] };
    expect(a.parseRequest(body, "")).toEqual({
      prompt: "纯文本非JSON",
      dialogueId: null,
    });
  });
  it("falls back to raw string when parsed JSON has no string text field", () => {
    // {text: 123} — parsed.text is a number, not string → use original raw.
    const body = { messages: [{ content: JSON.stringify({ text: 123 }) }] };
    expect(a.parseRequest(body, "")).toEqual({
      prompt: JSON.stringify({ text: 123 }),
      dialogueId: null,
    });
  });
  it("returns null prompt when content is not a string (e.g. already an object)", () => {
    expect(
      a.parseRequest({ messages: [{ content: { text: "x" } }] }, ""),
    ).toEqual({ prompt: null, dialogueId: null });
  });
});
