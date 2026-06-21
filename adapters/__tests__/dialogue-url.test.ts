import { describe, expect, it } from "vitest";

import { ADAPTERS } from "../index";

/**
 * dialogueIdFromUrl drives the "reset the gauge when the user starts/switches a
 * conversation" logic. A wrong regex → either the gauge never resets (id missed)
 * or resets spuriously (id over-captured, e.g. query strings leaking in). These
 * pin each platform's home/new-chat URL → null and chat URL → id, using the
 * exact URL shapes confirmed live in Playwright (2026-06).
 */

const byId = (id: string) => ADAPTERS.find((a) => a.platformId === id)!;

const cases = [
  {
    platform: "deepseek",
    home: "https://chat.deepseek.com/",
    chat: "https://chat.deepseek.com/a/chat/s/45e9d5e2-f0b4-4f41-b1eb-8a7b1dce96eb",
    expectedId: "45e9d5e2-f0b4-4f41-b1eb-8a7b1dce96eb",
  },
  {
    platform: "kimi",
    home: "https://www.kimi.com/?chat_enter_method=new_chat",
    chat: "https://www.kimi.com/chat/19ee95d8-7852-8cc1-8000-094453c49e80",
    expectedId: "19ee95d8-7852-8cc1-8000-094453c49e80",
  },
  {
    platform: "chatgpt",
    home: "https://chatgpt.com/",
    chat: "https://chatgpt.com/c/6a37a5c0-43f4-83e8-a884-6d24dc7fb201",
    expectedId: "6a37a5c0-43f4-83e8-a884-6d24dc7fb201",
  },
  {
    platform: "gemini",
    home: "https://gemini.google.com/app",
    chat: "https://gemini.google.com/app/1988a0be5df2b59a",
    expectedId: "1988a0be5df2b59a",
  },
  {
    platform: "qwen",
    home: "https://chat.qwen.ai/",
    chat: "https://chat.qwen.ai/c/6a9b1691-f4e0-4efe-a042-0be1f7d7bb58",
    expectedId: "6a9b1691-f4e0-4efe-a042-0be1f7d7bb58",
  },
  {
    platform: "qianwen",
    home: "https://www.qianwen.com/",
    chat: "https://www.qianwen.com/chat/3a6c64a2f5b749f0a9eea257700d2667",
    expectedId: "3a6c64a2f5b749f0a9eea257700d2667",
  },
  {
    platform: "doubao",
    home: "https://www.doubao.com/chat/",
    chat: "https://www.doubao.com/chat/38431887179074562",
    expectedId: "38431887179074562",
  },
] as const;

describe("dialogueIdFromUrl — per-platform chat-URL extraction", () => {
  it.each(cases)(
    "$platform: home / new-chat URL → null (gauge resets to 0)",
    ({ platform, home }) => {
      expect(byId(platform).dialogueIdFromUrl?.(home) ?? null).toBeNull();
    },
  );

  it.each(cases)(
    "$platform: chat URL → its id",
    ({ platform, chat, expectedId }) => {
      expect(byId(platform).dialogueIdFromUrl?.(chat) ?? null).toBe(expectedId);
    },
  );

  it.each(cases)(
    "$platform: query strings / fragments don't leak into the id",
    ({ platform, chat, expectedId }) => {
      expect(
        byId(platform).dialogueIdFromUrl?.(`${chat}?ref=hist#top`) ?? null,
      ).toBe(expectedId);
    },
  );
});
