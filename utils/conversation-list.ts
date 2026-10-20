/**
 * Runtime guard for the destructive zombie-cleanup path.
 *
 * TypeScript types disappear at runtime, and extension messages can arrive from
 * an older content-script context or a malformed payload. Only the literal
 * boolean `true` may authorize deletion; `undefined`, `null`, strings, or
 * numbers must all fail closed.
 */
export function isAuthoritativeConversationList(complete: unknown): boolean {
  return complete === true;
}
