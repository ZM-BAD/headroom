import { afterEach, describe, expect, it, vi } from "vitest";

import { chatgptAdapter } from "../chatgpt";
import { kimiAdapter } from "../kimi";

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
