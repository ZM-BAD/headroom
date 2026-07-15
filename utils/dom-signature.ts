/**
 * Change signature for the content script's DOM-poll completion detector
 * (`needsDomPollDetection` platforms — Gemini). One poll tick = one signature;
 * the detector ships a provisional update (local broadcast only) on any
 * change and re-arms a 2s settle timer alongside it.
 *
 * Why count alone is not enough (measured live 2026-07): Gemini mounts the
 * <model-response> element at stream START and fills its text for many
 * seconds afterwards. A count-only signature stabilised immediately, so the
 * old detector's 1s debounce fired mid-stream (at 180 of 983 chars) and —
 * with the count never changing again — no re-trigger ever corrected the
 * partial scrape. Folding the LAST answer's text length into the signature
 * keeps the detector alive during streaming: each text-length change
 * triggers a provisional update at the poll cadence (~1.5s), and the settle
 * timer ensures one final non-provisional ship with the complete text writes
 * the cloud in exactly one GET+SET pair regardless of answer length.
 */
export function answerStreamSignature(
  answerCount: number,
  lastAnswerTextLen: number,
): string {
  return `${answerCount}:${lastAnswerTextLen}`;
}
