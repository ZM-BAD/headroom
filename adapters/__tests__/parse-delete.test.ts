import { describe, expect, it } from "vitest";

import { ADAPTERS } from "../index";
import type { PlatformAdapter } from "../../utils/platform-adapter";

/**
 * parseDelete runs in the background on a platform's "delete conversation"
 * request (raw body string + URL, read via webRequest). Contract:
 *
 *   1. NEVER throw — a malformed/unexpected input must degrade to null, because
 *      a throw would silently kill the delete-listener's processing for that
 *      delete. The background wraps it in try/catch, but the function itself
 *      must be defensive too.
 *   2. ONLY adapters that declare `deleteUrl` are expected to implement
 *      parseDelete; for the rest, delete-sync is opt-out and parseDelete is
 *      never called.
 *
 * Endpoint paths + body shapes were captured LIVE per platform (2026-06,
 * Playwright → delete a throwaway chat → grab the request); the happy-path
 * assertions here pin each adapter's claimed shape, so a silent web-app change
 * is caught as a test failure rather than a dropped delete-sync.
 */

const withDelete = ADAPTERS.filter((a) => typeof a.deleteUrl === "string");
const byId = (id: string): PlatformAdapter =>
  ADAPTERS.find((a) => a.platformId === id)!;

describe("parseDelete — cross-adapter contract (only those that declare deleteUrl)", () => {
  if (withDelete.length === 0) {
    // Guard against silently shipping zero delete-link coverage: if every
    // adapter drops deleteUrl, this whole feature is inert and the test below
    // would vacuously pass.
    it("at least one adapter declares deleteUrl (delete-link is wired)", () => {
      throw new Error(
        "No adapter declares deleteUrl — delete-link is dead code",
      );
    });
    return;
  }

  it.each(withDelete.map((a) => [a.platformId, a] as const))(
    "%s: never throws on garbage rawBody / empty URL input",
    (_id, adapter) => {
      const parse = adapter.parseDelete!;
      // rawBody is now a string — exercise the string garbage cases.
      expect(() => parse("", "")).not.toThrow();
      expect(() => parse("not json", "")).not.toThrow();
      expect(() => parse("{", "")).not.toThrow();
      expect(() => parse("{}", "")).not.toThrow();
      expect(() => parse('{"unrelated":"field"}', "")).not.toThrow();
      expect(() => parse("null", "")).not.toThrow();
    },
  );

  it.each(withDelete.map((a) => [a.platformId, a] as const))(
    "%s: returns null (not throws) on input with no recognizable id",
    (_id, adapter) => {
      expect(adapter.parseDelete!("", "")).toBeNull();
      expect(adapter.parseDelete!("{}", "")).toBeNull();
      expect(adapter.parseDelete!('{"foo":"bar"}', "")).toBeNull();
    },
  );
});

describe("parseDelete — DeepSeek", () => {
  const a = byId("deepseek");
  it("deleteUrl pins the live-confirmed chat_session/delete endpoint", () => {
    expect(a.deleteUrl).toBe(
      "*://chat.deepseek.com/api/v0/chat_session/delete",
    );
  });
  it("extracts the id from the singular {chat_session_id} shape", () => {
    expect(a.parseDelete!('{"chat_session_id":"s-abc"}', "")).toBe("s-abc");
  });
  it("returns null when chat_session_id is the wrong type", () => {
    expect(a.parseDelete!('{"chat_session_id":42}', "")).toBeNull();
    expect(a.parseDelete!('{"chat_session_id":["x"]}', "")).toBeNull();
  });
  it("returns null when chat_session_id is absent", () => {
    expect(a.parseDelete!("{}", "")).toBeNull();
    expect(a.parseDelete!('{"other":"x"}', "")).toBeNull();
  });
});

describe("parseDelete — ChatGPT (PATCH, id in URL path)", () => {
  const a = byId("chatgpt");
  it("deleteUrl + deleteMethod pin the live-confirmed soft-delete", () => {
    expect(a.deleteUrl).toBe("*://chatgpt.com/backend-api/conversation/*");
    expect(a.deleteMethod).toBe("PATCH");
  });
  it("extracts the id from /backend-api/conversation/<id>", () => {
    expect(
      a.parseDelete!(
        "",
        "https://chatgpt.com/backend-api/conversation/abc-123-xyz",
      ),
    ).toBe("abc-123-xyz");
  });
  it("returns null when the URL has no trailing id (e.g. the send POST)", () => {
    expect(
      a.parseDelete!("", "https://chatgpt.com/backend-api/conversation"),
    ).toBeNull();
  });
  it("returns null on a malformed URL", () => {
    expect(a.parseDelete!("", "not-a-url")).toBeNull();
  });
});

describe("parseDelete — Gemini (POST batchexecute, RPC GzXR5e, c_ prefix)", () => {
  const a = byId("gemini");
  it("deleteUrl pins the batchexecute endpoint (all Gemini RPCs share it)", () => {
    expect(a.deleteUrl).toBe(
      "*://gemini.google.com/_/BardChatUi/data/batchexecute*",
    );
  });
  it("extracts the id (c_ prefix stripped) from the GzXR5e delete RPC", () => {
    // Real captured body: f.req=[[["GzXR5e","[\"c_078dbd7089ab640b\"]",null,"generic"]]]&at=...
    const body =
      "f.req=" +
      encodeURIComponent(
        '[[["GzXR5e","[\\"c_078dbd7089ab640b\\"]",null,"generic"]]]',
      ) +
      "&at=TOKEN";
    expect(a.parseDelete!(body, "")).toBe("078dbd7089ab640b");
  });
  it("returns null for a non-delete RPC on the same batchexecute endpoint", () => {
    // The send/list RPCs (e.g. ESY5D, aPya6c) also hit batchexecute — they must
    // not be mistaken for deletes.
    const body =
      "f.req=" +
      encodeURIComponent(
        '[[["ESY5D","[[[\\"bard_activity_enabled\\"]]]",null,"generic"]]]',
      ) +
      "&at=TOKEN";
    expect(a.parseDelete!(body, "")).toBeNull();
  });
  it("returns null when body has no f.req field", () => {
    expect(a.parseDelete!("at=TOKEN&other=x", "")).toBeNull();
  });
  it("returns null when the c_ payload is malformed", () => {
    const body =
      "f.req=" + encodeURIComponent('[[["GzXR5e","not-json",null,"generic"]]]');
    expect(a.parseDelete!(body, "")).toBeNull();
  });
});

describe("parseDelete — Kimi (POST, body {chat_id})", () => {
  const a = byId("kimi");
  it("deleteUrl pins the live-confirmed DeleteChat endpoint", () => {
    expect(a.deleteUrl).toBe(
      "*://www.kimi.com/apiv2/kimi.chat.v1.ChatService/DeleteChat",
    );
  });
  it("extracts the id from {chat_id}", () => {
    expect(a.parseDelete!('{"chat_id":"k-123"}', "")).toBe("k-123");
  });
  it("returns null when chat_id is absent or wrong-typed", () => {
    expect(a.parseDelete!("{}", "")).toBeNull();
    expect(a.parseDelete!('{"chat_id":42}', "")).toBeNull();
  });
});

describe("parseDelete — Qwen (DELETE, id in URL path)", () => {
  const a = byId("qwen");
  it("deleteUrl + deleteMethod pin the live-confirmed RESTful delete", () => {
    expect(a.deleteUrl).toBe("*://chat.qwen.ai/api/v2/chats/*");
    expect(a.deleteMethod).toBe("DELETE");
  });
  it("extracts the id from /api/v2/chats/<id>", () => {
    expect(a.parseDelete!("", "https://chat.qwen.ai/api/v2/chats/q-abc")).toBe(
      "q-abc",
    );
  });
  it("returns null when the URL has no trailing id", () => {
    expect(a.parseDelete!("", "https://chat.qwen.ai/api/v2/chats/")).toBeNull();
  });
});

describe("parseDelete — 通义千问 (POST, deleteHost chat2-api, body {session_ids:[]})", () => {
  const a = byId("qianwen");
  it("deleteHost + deleteUrl pin the live-confirmed batch-delete endpoint", () => {
    expect(a.deleteHost).toBe("chat2-api.qianwen.com");
    expect(a.deleteUrl).toBe(
      "*://chat2-api.qianwen.com/api/v1/session/delete/batch*",
    );
  });
  it("extracts the FIRST id from the {session_ids:[...]} batch array", () => {
    expect(a.parseDelete!('{"session_ids":["s-1","s-2"]}', "")).toBe("s-1");
  });
  it("extracts the id from a single-element batch (the common case)", () => {
    expect(a.parseDelete!('{"session_ids":["s-only"]}', "")).toBe("s-only");
  });
  it("returns null when session_ids is empty or absent", () => {
    expect(a.parseDelete!('{"session_ids":[]}', "")).toBeNull();
    expect(a.parseDelete!("{}", "")).toBeNull();
  });
  it("returns null when session_ids[0] is not a string", () => {
    expect(a.parseDelete!('{"session_ids":[42]}', "")).toBeNull();
  });
});

describe("parseDelete — 豆包 (POST, deeply-nested uplink_body)", () => {
  const a = byId("doubao");
  it("deleteUrl pins the live-confirmed batch_del_user_conv endpoint", () => {
    expect(a.deleteUrl).toBe(
      "*://www.doubao.com/im/conversation/batch_del_user_conv*",
    );
  });
  it("extracts the id from the 3-level-nested conversation_id array", () => {
    // Real captured shape — the uplink/downlink envelope is ByteDance IM framing.
    const body = JSON.stringify({
      cmd: 4171,
      uplink_body: {
        batch_delete_user_conversation_uplink_body: {
          conversation_id: ["38431998739665154"],
          delete_all: false,
          conversation_type: 3,
        },
      },
      sequence_id: "x",
      channel: 2,
      version: "1",
    });
    expect(a.parseDelete!(body, "")).toBe("38431998739665154");
  });
  it("returns null when the nested conversation_id is absent", () => {
    expect(a.parseDelete!("{}", "")).toBeNull();
    expect(a.parseDelete!('{"uplink_body":{}}', "")).toBeNull();
    expect(
      a.parseDelete!(
        '{"uplink_body":{"batch_delete_user_conversation_uplink_body":{}}}',
        "",
      ),
    ).toBeNull();
  });
  it("returns null when the nested conversation_id is an empty array", () => {
    expect(
      a.parseDelete!(
        '{"uplink_body":{"batch_delete_user_conversation_uplink_body":{"conversation_id":[]}}}',
        "",
      ),
    ).toBeNull();
  });
});
