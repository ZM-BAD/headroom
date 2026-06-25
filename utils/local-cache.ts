/**
 * Local multi-conversation cache management (spec 003 LRU). The gauge reads
 * from `browser.storage.local` (`headroom:conv:{p}:{id}`); as conversations
 * accumulate, storage grows. Eviction keeps it bounded: when total bytes
 * exceed SOFT_LIMIT, drop the oldest conversations (by `updatedAt`) until
 * back under HARD_LIMIT. Local is a cache, not truth — Upstash holds the
 * full record — so evicting loses nothing the next open can't re-fetch.
 *
 * `conv-index` (`headroom:conv-index` → `{ [fullKey]: updatedAt }`) is the
 * LRU's lookup table: it avoids a full `storage.local.get(null)` scan to find
 * the oldest conversation, and `DialogueRecord.updatedAt` (refreshed on every
 * write) is the LRU timestamp for free.
 *
 * Pure helpers only (unit-tested). The background wires them to storage, the
 * byte measurement, and the post-write eviction trigger.
 */

/** Evict once local usage exceeds this (8 MB; leaves headroom for settings). */
export const SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
/** Evict down to this (6 MB; hysteresis avoids thrashing on every write). */
export const HARD_LIMIT_BYTES = 6 * 1024 * 1024;

/** `{ [fullStorageKey]: updatedAt }` — the LRU ordering table. */
export type ConvIndex = Record<string, number>;

/** New index with `key` set to `updatedAt` (pure; input untouched). */
export function convIndexAfterSet(
  index: ConvIndex,
  key: string,
  updatedAt: number,
): ConvIndex {
  return { ...index, [key]: updatedAt };
}

/** New index with `key` removed (pure; no-op copy if absent). */
export function convIndexAfterDelete(index: ConvIndex, key: string): ConvIndex {
  const rest: ConvIndex = { ...index };
  delete rest[key];
  return rest;
}

/**
 * The `count` keys with the smallest `updatedAt`, ascending. Ties break by key
 * (ascending) for deterministic eviction order. Fewer than `count` keys ⇒ all
 * of them, oldest-first. Empty index / count ≤ 0 ⇒ `[]`.
 */
export function pickOldestKeys(index: ConvIndex, count: number): string[] {
  if (count <= 0) return [];
  return Object.entries(index)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, count)
    .map(([k]) => k);
}
