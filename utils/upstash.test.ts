import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import {
  kvDel,
  kvGet,
  kvSet,
  kvScan,
  selectZombieKeys,
  getDialogue,
  setDialogue,
  delDialogue,
  dialogueKey,
  SETTINGS_KEY,
  type UpstashCreds,
} from "./upstash";

const CREDS: UpstashCreds = { url: "https://example.upstash.io", token: "tok" };

/** Build a fetch mock that resolves with `{ ok, status, json: { result } }`. */
function mockResult(result: string | null, ok = true, status = 200): Mock {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ result }),
  }));
}

/** Read the POST body of the n-th fetch call, parsed as a command array. */
function bodyAt(mock: Mock, n = 0): string[] {
  const call = (mock.mock.calls[n] ?? mock.mock.calls[0]) as [
    string,
    RequestInit,
  ];
  return JSON.parse(call[1].body as string) as string[];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("kv primitives", () => {
  it("kvGet issues GET and returns the raw result", async () => {
    const mock = mockResult("hello");
    globalThis.fetch = mock as unknown as typeof fetch;
    expect(await kvGet(CREDS, "k")).toBe("hello");
    expect(mock).toHaveBeenCalledOnce();
    expect(bodyAt(mock)).toEqual(["GET", "k"]);
  });

  it("kvSet issues SET key value", async () => {
    const mock = mockResult("OK");
    globalThis.fetch = mock as unknown as typeof fetch;
    await kvSet(CREDS, "k", "v");
    expect(bodyAt(mock)).toEqual(["SET", "k", "v"]);
  });

  it("kvDel issues DEL key", async () => {
    const mock = mockResult("1");
    globalThis.fetch = mock as unknown as typeof fetch;
    await kvDel(CREDS, "k");
    expect(bodyAt(mock)).toEqual(["DEL", "k"]);
  });

  it("absent creds → null, no fetch (Upstash optional)", async () => {
    const mock = mockResult("x");
    globalThis.fetch = mock as unknown as typeof fetch;
    expect(await kvGet({ url: "", token: "" }, "k")).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it("HTTP error throws upstash HTTP <status>", async () => {
    globalThis.fetch = mockResult(null, false, 500) as unknown as typeof fetch;
    await expect(kvGet(CREDS, "k")).rejects.toThrow("upstash HTTP 500");
  });

  it("non-https URL → null, no fetch (token never sent over http)", async () => {
    const mock = mockResult("x");
    globalThis.fetch = mock as unknown as typeof fetch;
    expect(
      await kvGet({ url: "http://insecure.upstash.io", token: "tok" }, "k"),
    ).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("dialogue wrappers", () => {
  const record = JSON.stringify({
    platformId: "deepseek",
    dialogueId: "1",
    contextLimit: 1_048_576,
    totalTokens: 5,
    roundCount: 1,
    rounds: [],
    updatedAt: 9,
  });

  it("getDialogue parses a stored record", async () => {
    globalThis.fetch = mockResult(record) as unknown as typeof fetch;
    const rec = await getDialogue(CREDS, dialogueKey("deepseek", "1"));
    expect(rec?.platformId).toBe("deepseek");
    expect(rec?.totalTokens).toBe(5);
  });

  it("getDialogue returns null when the key is absent", async () => {
    globalThis.fetch = mockResult(null) as unknown as typeof fetch;
    expect(await getDialogue(CREDS, "k")).toBeNull();
  });

  it("getDialogue returns null on corrupt JSON", async () => {
    globalThis.fetch = mockResult("not-json{") as unknown as typeof fetch;
    expect(await getDialogue(CREDS, "k")).toBeNull();
  });

  it("setDialogue serializes the record under SET", async () => {
    const mock = mockResult("OK");
    globalThis.fetch = mock as unknown as typeof fetch;
    await setDialogue(CREDS, "k", {
      platformId: "p",
      dialogueId: "d",
      contextLimit: 1,
      totalTokens: 0,
      roundCount: 0,
      rounds: [],
      updatedAt: 0,
    });
    const [cmd, , payload] = bodyAt(mock);
    expect(cmd).toBe("SET");
    expect(JSON.parse(payload).platformId).toBe("p");
  });

  it("delDialogue issues DEL", async () => {
    const mock = mockResult("1");
    globalThis.fetch = mock as unknown as typeof fetch;
    await delDialogue(CREDS, "k");
    expect(bodyAt(mock)).toEqual(["DEL", "k"]);
  });

  it("setDialogue throws on HTTP error", async () => {
    globalThis.fetch = mockResult(null, false, 500) as unknown as typeof fetch;
    await expect(
      setDialogue(CREDS, "k", {
        platformId: "p",
        dialogueId: "d",
        contextLimit: 1,
        totalTokens: 0,
        roundCount: 0,
        rounds: [],
        updatedAt: 0,
      }),
    ).rejects.toThrow("upstash HTTP 500");
  });

  it("delDialogue throws on HTTP error", async () => {
    globalThis.fetch = mockResult(null, false, 500) as unknown as typeof fetch;
    await expect(delDialogue(CREDS, "k")).rejects.toThrow("upstash HTTP 500");
  });
});

describe("key scheme", () => {
  it("dialogueKey follows the spec scheme", () => {
    expect(dialogueKey("deepseek", "abc")).toBe("headroom:conv:deepseek:abc");
  });

  it("SETTINGS_KEY is the cloud settings key", () => {
    expect(SETTINGS_KEY).toBe("headroom:settings");
  });
});

describe("kvScan", () => {
  it("pages through cursors until 0, collecting all keys", async () => {
    const mock = vi.fn();
    mock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            "7",
            ["headroom:conv:deepseek:a", "headroom:conv:deepseek:b"],
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: ["0", ["headroom:conv:deepseek:c"]] }),
      });
    globalThis.fetch = mock as unknown as typeof fetch;
    const keys = await kvScan(CREDS, "headroom:conv:deepseek:*");
    expect([...keys].sort()).toEqual([
      "headroom:conv:deepseek:a",
      "headroom:conv:deepseek:b",
      "headroom:conv:deepseek:c",
    ]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("issues SCAN cursor MATCH pattern COUNT", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: ["0", []] }),
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    await kvScan(CREDS, "headroom:conv:deepseek:*");
    expect(bodyAt(mock)).toEqual([
      "SCAN",
      "0",
      "MATCH",
      "headroom:conv:deepseek:*",
      "COUNT",
      "100",
    ]);
  });

  it("single page (cursor 0 immediately) → one call", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: ["0", ["headroom:conv:p:only"]] }),
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    expect(await kvScan(CREDS, "headroom:conv:p:*")).toEqual([
      "headroom:conv:p:only",
    ]);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("stalled cursor (non-zero, unchanged) → breaks instead of looping forever", async () => {
    // Server keeps returning the same non-zero cursor — without the guard
    // this would loop infinitely. First call advances cursor to "42",
    // second call sees "42" === "42" and breaks. Total: 2 calls.
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: ["42", ["headroom:conv:p:a"]] }),
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    const keys = await kvScan(CREDS, "headroom:conv:p:*");
    expect(keys).toEqual(["headroom:conv:p:a"]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("malformed cursor (non-string) → breaks with warning", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: [999, ["headroom:conv:p:a"]] }),
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    const keys = await kvScan(CREDS, "headroom:conv:p:*");
    expect(keys).toEqual([]);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("absent creds → [] no fetch", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: ["0", ["x"]] }),
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    expect(await kvScan({ url: "", token: "" }, "p*")).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("selectZombieKeys", () => {
  it("returns cloud keys whose dialogueId is not in the live list", () => {
    const cloud = [
      "headroom:conv:deepseek:alive",
      "headroom:conv:deepseek:gone",
      "headroom:conv:deepseek:also-gone",
      "headroom:conv:chatgpt:other", // wrong platform → ignored
      "headroom:settings", // not a conv key → ignored
    ];
    expect(selectZombieKeys(cloud, new Set(["alive"]), "deepseek")).toEqual([
      "headroom:conv:deepseek:gone",
      "headroom:conv:deepseek:also-gone",
    ]);
  });

  it("returns [] when every cloud id is still live", () => {
    expect(
      selectZombieKeys(
        ["headroom:conv:deepseek:a", "headroom:conv:deepseek:b"],
        new Set(["a", "b"]),
        "deepseek",
      ),
    ).toEqual([]);
  });

  it("ignores keys from other platforms", () => {
    expect(
      selectZombieKeys(["headroom:conv:chatgpt:z"], new Set([]), "deepseek"),
    ).toEqual([]);
  });

  it("returns [] for an empty cloud", () => {
    expect(selectZombieKeys([], new Set(["a"]), "deepseek")).toEqual([]);
  });
});
