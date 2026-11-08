import { describe, expect, it } from "vitest";

import { joinToolResultText } from "./tool-result-text";

describe("joinToolResultText", () => {
  it("joins a title and snippet with a newline", () => {
    expect(joinToolResultText("Title", "Snippet")).toBe("Title\nSnippet");
  });

  it("omits a missing title or snippet", () => {
    expect(joinToolResultText("Title", "")).toBe("Title");
    expect(joinToolResultText("", "Snippet")).toBe("Snippet");
    expect(joinToolResultText(" Title ", " Snippet ")).toBe("Title\nSnippet");
  });

  it("returns empty for empty / non-string fields", () => {
    expect(joinToolResultText("", "")).toBe("");
    expect(joinToolResultText(42, null)).toBe("");
    expect(joinToolResultText({}, [])).toBe("");
  });
});
