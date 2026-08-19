import { describe, expect, it } from "vitest";

import { geminiAdapter, pairGeminiTurns, type GeminiTurn } from "../gemini";

/**
 * pairGeminiTurns pairs a document-order list of <user-query>/<model-response>
 * turns into ascending rounds. Gemini has no parseable history API — turns come
 * from the DOM (parseGeminiDom reads <chat-window>); this pure pairing step is
 * split out so it's unit-testable in node (vitest has no DOM). Each user is
 * paired with the immediately-following model response.
 */
describe("pairGeminiTurns", () => {
  it("pairs a user turn with the immediately-following model turn", () => {
    const turns: GeminiTurn[] = [
      { kind: "user", text: "你好,这是测试" },
      { kind: "model", text: "你好！收到。" },
    ];
    expect(pairGeminiTurns(turns)).toEqual([
      {
        messageId: "gemini:1",
        order: 1,
        promptText: "你好,这是测试",
        answerText: "你好！收到。",
      },
    ]);
  });

  it("joins grounding source site names into toolText (spec 005 P1)", () => {
    const turns: GeminiTurn[] = [
      { kind: "user", text: "今天有什么新闻?" },
      {
        kind: "model",
        text: "三条新闻…",
        sources: ["美国之音", "Reuters", "美国之音"],
      },
    ];
    expect(pairGeminiTurns(turns)).toEqual([
      {
        messageId: "gemini:1",
        order: 1,
        promptText: "今天有什么新闻?",
        answerText: "三条新闻…",
        toolText: "美国之音\nReuters",
      },
    ]);
  });

  it("leaves toolText unset when the model turn has no sources", () => {
    const turns: GeminiTurn[] = [
      { kind: "user", text: "Q1" },
      { kind: "model", text: "A1" },
    ];
    expect(pairGeminiTurns(turns)[0]!.toolText).toBeUndefined();
  });

  it("pairs multiple consecutive turns (1-based n, document order)", () => {
    const turns: GeminiTurn[] = [
      { kind: "user", text: "Q1" },
      { kind: "model", text: "A1" },
      { kind: "user", text: "Q2" },
      { kind: "model", text: "A2" },
    ];
    expect(pairGeminiTurns(turns)).toEqual([
      { messageId: "gemini:1", order: 1, promptText: "Q1", answerText: "A1" },
      { messageId: "gemini:2", order: 2, promptText: "Q2", answerText: "A2" },
    ]);
  });

  // NOTE: unlike Doubao's adjacency rule (which stops at the next user),
  // Gemini produces an empty-answer round for EVERY user that has no adjacent
  // model, even mid-sequence. This reflects the current implementation; if the
  // 003 union-merge rejects empty-answer rounds, revisit this. Real Gemini DOM
  // is strictly alternating (user → model → user → model), so this case is
  // defensive — verified live in the Playwright pass.
  it("produces an empty-answer round for a user with no adjacent model (mid-sequence)", () => {
    const turns: GeminiTurn[] = [
      { kind: "user", text: "Q1 no reply" },
      { kind: "user", text: "Q2 real" },
      { kind: "model", text: "A2" },
    ];
    expect(pairGeminiTurns(turns)).toEqual([
      {
        messageId: "gemini:1",
        order: 1,
        promptText: "Q1 no reply",
        answerText: "",
      },
      {
        messageId: "gemini:2",
        order: 2,
        promptText: "Q2 real",
        answerText: "A2",
      },
    ]);
  });

  it("produces an empty-answer round for a trailing user with no reply (just-sent prompt)", () => {
    const turns: GeminiTurn[] = [
      { kind: "user", text: "Q1" },
      { kind: "model", text: "A1" },
      { kind: "user", text: "Q2 pending" }, // sent, model hasn't replied yet
    ];
    expect(pairGeminiTurns(turns)).toEqual([
      { messageId: "gemini:1", order: 1, promptText: "Q1", answerText: "A1" },
      {
        messageId: "gemini:2",
        order: 2,
        promptText: "Q2 pending",
        answerText: "",
      },
    ]);
  });

  it("ignores leading model turns (no user to pair them with)", () => {
    const turns: GeminiTurn[] = [
      { kind: "model", text: "stray model" },
      { kind: "user", text: "Q1" },
      { kind: "model", text: "A1" },
    ];
    expect(pairGeminiTurns(turns)).toEqual([
      { messageId: "gemini:1", order: 1, promptText: "Q1", answerText: "A1" },
    ]);
  });

  it("returns [] for empty / malformed input", () => {
    expect(pairGeminiTurns([])).toEqual([]);
    expect(pairGeminiTurns(undefined as unknown as never[])).toEqual([]);
  });
});

/**
 * dialogueTitleFromDoc extracts the conversation title from document.title.
 * Confirmed live (2026-06): a real conversation showed
 * "Git 分支集成与工作流流派 - Google Gemini" (the brand is always suffixed).
 * The home / new-chat page stays the bare "Google Gemini" → null.
 */
describe("geminiAdapter.dialogueTitleFromDoc", () => {
  // dialogueTitleFromDoc only reads .title, so a minimal stand-in for Document
  // suffices (duck-typed; vitest runs in node with no DOM).
  const doc = (title: string) => ({ title }) as Document;
  const { dialogueTitleFromDoc } = geminiAdapter;
  if (!dialogueTitleFromDoc) throw new Error("dialogueTitleFromDoc missing");

  it("strips the trailing ' - Google Gemini' brand suffix", () => {
    expect(
      dialogueTitleFromDoc(doc("Git 分支集成与工作流流派 - Google Gemini")),
    ).toBe("Git 分支集成与工作流流派");
  });

  it("returns null for the home page (bare brand, no conversation title)", () => {
    expect(dialogueTitleFromDoc(doc("Google Gemini"))).toBeNull();
  });

  it("returns null for an empty / missing title", () => {
    expect(dialogueTitleFromDoc(doc(""))).toBeNull();
    expect(dialogueTitleFromDoc(doc("  "))).toBeNull();
  });

  it("handles an en-dash / em-dash separator too", () => {
    expect(dialogueTitleFromDoc(doc("Some Topic – Google Gemini"))).toBe(
      "Some Topic",
    );
    expect(dialogueTitleFromDoc(doc("Some Topic — Google Gemini"))).toBe(
      "Some Topic",
    );
  });
});
