import { afterEach, describe, expect, it, vi } from "vitest";

import { chatgptAdapter } from "../chatgpt";
import { deepseekAdapter } from "../deepseek";
import { doubaoAdapter } from "../doubao";
import { geminiAdapter } from "../gemini";
import { kimiAdapter } from "../kimi";
import { qianwenAdapter } from "../qianwen";
import { qwenAdapter } from "../qwen";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchConversationList — destructive-cleanup contract", () => {
  it("ChatGPT returns complete=false when a later page fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ accessToken: "jwt" }))
      .mockResolvedValueOnce(response({ items: [{ id: "chat-1" }], total: 56 }))
      .mockResolvedValueOnce(response({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatgptAdapter.fetchConversationList?.()).resolves.toEqual({
      ids: ["chat-1"],
      complete: false,
    });
  });

  it("Kimi returns complete=false when a later token page fails", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "access_token" ? "eyJ.test.token" : null,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({ chats: [{ id: "chat-1" }], nextPageToken: "next" }),
      )
      .mockResolvedValueOnce(response({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(kimiAdapter.fetchConversationList?.()).resolves.toEqual({
      ids: ["chat-1"],
      complete: false,
    });
  });
});

describe("fetchConversationList — complete snapshots", () => {
  it("DeepSeek trusts only an explicit no-more-pages response", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "userToken" ? JSON.stringify({ value: "token" }) : null,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        data: {
          biz_data: {
            chat_sessions: [{ id: "chat-1" }],
            has_more: false,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(deepseekAdapter.fetchConversationList?.()).resolves.toEqual({
      ids: ["chat-1"],
      complete: true,
    });
  });

  it("Doubao never treats the recent-20 endpoint as complete", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        status_code: 0,
        downlink_body: {
          pull_recent_conv_chain_downlink_body: {
            cells: [{ id: "chat-1" }],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(doubaoAdapter.fetchConversationList?.()).resolves.toEqual({
      ids: ["chat-1"],
      complete: false,
    });
  });

  it("Gemini never treats the virtualized DOM sidebar as complete", async () => {
    vi.stubGlobal("document", {
      querySelectorAll: () => [{ getAttribute: () => "/app/abcdef1234567890" }],
    });

    await expect(geminiAdapter.fetchConversationList?.()).resolves.toEqual({
      ids: ["abcdef1234567890"],
      complete: false,
    });
  });

  it("Qwen reports complete after an empty terminal page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ data: [{ id: "chat-1" }] }))
      .mockResolvedValueOnce(response({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(qwenAdapter.fetchConversationList?.()).resolves.toEqual({
      ids: ["chat-1"],
      complete: true,
    });
  });

  it("Qianwen reports complete only after the token stream ends", async () => {
    vi.stubGlobal("document", { cookie: "b-user-id=device-1" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({ success: true, data: [{ id: "chat-1" }], next_token: "" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(qianwenAdapter.fetchConversationList?.()).resolves.toEqual({
      ids: ["chat-1"],
      complete: true,
    });
  });
});
