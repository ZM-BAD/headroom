/**
 * Join a search-result title + snippet into one tool-text block. Shared by
 * adapters whose history APIs expose the same title/snippet pair (Kimi, Qwen,
 * ChatGPT) so the separator and empty-field handling cannot drift.
 *
 * Non-string / missing fields are treated as empty; a missing snippet yields
 * the title alone. Returns "" when both are empty.
 */
export function joinToolResultText(title: unknown, snippet: unknown): string {
  const t = typeof title === "string" ? title.trim() : "";
  const s = typeof snippet === "string" ? snippet.trim() : "";
  return [t, s].filter(Boolean).join("\n");
}
