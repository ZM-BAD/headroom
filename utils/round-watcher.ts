import type { PlatformAdapter } from "./platform-adapter";

/**
 * DOM round-completion watcher. Observes the page and, when the latest
 * assistant message stops changing for ~1.5s (streaming settled), emits its
 * text — and, if the adapter has a `userSelector`, the latest user message's
 * text as a prompt fallback (for platforms whose request body can't be parsed).
 *
 * Watches `document.body` (subtree) so it works even when the adapter's
 * `conversationSelector` is wrong — only `answerSelector` must be right.
 * Selectors are best-guess per platform and NEED live DevTools confirmation.
 *
 * @param onRound receives (answerText, promptText|null)
 */
export function watchRounds(
  adapter: PlatformAdapter,
  onRound: (answerText: string, promptText: string | null) => void,
): void {
  let lastText = "";
  let timer: ReturnType<typeof setTimeout>;

  const settle = (): void => {
    const answers = document.querySelectorAll(adapter.answerSelector);
    const lastAnswer = answers[answers.length - 1];
    const text = lastAnswer?.textContent?.trim() ?? "";
    if (!text || text === lastText) return;
    lastText = text;

    let promptText: string | null = null;
    if (adapter.userSelector) {
      const users = document.querySelectorAll(adapter.userSelector);
      const lastUser = users[users.length - 1];
      const pText = lastUser?.textContent?.trim() ?? "";
      if (pText) promptText = pText;
    }
    onRound(text, promptText);
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
