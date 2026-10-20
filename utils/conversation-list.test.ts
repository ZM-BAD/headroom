import { describe, expect, it } from "vitest";

import { isAuthoritativeConversationList } from "./conversation-list";

describe("isAuthoritativeConversationList", () => {
  it("allows cleanup only for literal true", () => {
    expect(isAuthoritativeConversationList(true)).toBe(true);
  });

  it("fails closed for missing or malformed values", () => {
    for (const value of [false, undefined, null, 1, "true", {}, []]) {
      expect(isAuthoritativeConversationList(value)).toBe(false);
    }
  });
});
