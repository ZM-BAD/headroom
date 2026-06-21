import type { PlatformAdapter } from "./platform-adapter";

/**
 * DOM round-completion watcher. Observes the page and, when the latest
 * assistant message stops changing for ~1.5s (streaming settled), emits its
 * text — and, if the adapter has a `userSelector`, the latest user message's
 * text as a prompt fallback (for platforms whose request body can't be parsed).
 *
 * Watches `document.body` (subtree) so it works even when the adapter's
 * `conversationSelector` is wrong — only `answerSelector` must be right.
 *
 * **Round identity (roundId):** the callback receives a 1-based `roundId` =
 * the number of DISTINCT assistant messages on the page (selector matches that
 * aren't nested inside another match → exactly one per message, even for
 * adapters whose selector hits a wrapper + inner element, e.g. Kimi). This id
 * is STABLE while a given message streams (same message → same id), so the
 * background UPSERTS that round instead of appending a new one each time the
 * text settles mid-stream — which was the over-counting bug (one real round
 * counted as N because the answer streamed in >1.5s-gap bursts). When a new
 * message appears the count increments → genuinely new round.
 *
 * Selectors are best-guess per platform and NEED live DevTools confirmation.
 *
 * @param onRound receives (roundId, answerText, promptText|null)
 */
export function watchRounds(
  adapter: PlatformAdapter,
  onRound: (
    roundId: number,
    answerText: string,
    promptText: string | null,
  ) => void,
): void {
  let lastText = "";
  let timer: ReturnType<typeof setTimeout>;

  const settle = (): void => {
    const messages = distinctAnswerElements(adapter.answerSelector);
    const lastMessage = messages[messages.length - 1];
    const text = lastMessage?.textContent?.trim() ?? "";
    if (!text || text === lastText) return;
    lastText = text;

    let promptText: string | null = null;
    if (adapter.userSelector) {
      const users = document.querySelectorAll(adapter.userSelector);
      const lastUser = users[users.length - 1];
      const pText = lastUser?.textContent?.trim() ?? "";
      if (pText) promptText = pText;
    }
    onRound(messages.length, text, promptText);
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(settle, 1500);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/**
 * Selector matches that are NOT nested inside another match → one element per
 * assistant message. Handles adapters whose selector hits both a wrapper and an
 * inner element (e.g. Kimi's `.chat-content-item-assistant [class*="markdown"]`
 * matches `.markdown-container` + inner `.markdown`); the wrapper is kept, the
 * inner is dropped as a descendant. For 1-match-per-message selectors this is
 * just the full match list.
 */
function distinctAnswerElements(selector: string): Element[] {
  const all = Array.from(document.querySelectorAll(selector));
  // Keep an element iff no OTHER match contains it (i.e. it's a top-level match).
  return all.filter(
    (el) => !all.some((other) => other !== el && other.contains(el)),
  );
}
