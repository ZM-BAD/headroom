/**
 * Rough token estimate WITHOUT bundling a tokenizer (YAGNI for v1). Real BPE
 * counting is deferred behind a future `chrome.debugger`-based accuracy
 * upgrade that reads each platform's own usage metadata.
 *
 * Heuristic: CJK chars ≈ 1 token each; everything else ≈ 4 chars/token. The
 * warning level is driven by the *ratio* to the context limit, so an estimate
 * is good enough to tell "plenty of room" from "about to forget".
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // CJK Unified Ideographs, CJK punctuation + kana, full-width forms.
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.round(cjk + other / 4);
}
