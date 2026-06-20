import type { DialogueRecord } from "./dialogue-record";

/**
 * Minimal Upstash Redis REST client. The REST API is CORS-permissive and takes
 * a pipeline array body: `["GET", key]` / `["SET", key, value]`. One HTTPS
 * POST per command. Returns null when creds are absent (Upstash optional —
 * the live gauge works off local state without it; Upstash only persists
 * per-dialogue history across sessions).
 */
export interface UpstashCreds {
  url: string;
  token: string;
}

async function command(
  creds: UpstashCreds,
  args: string[],
): Promise<string | null> {
  if (!creds.url || !creds.token) return null;
  // Bound the request so a wedged/slow Upstash can't hang the service worker
  // (M4). On abort the fetch rejects and the caller falls back to a local tally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${creds.url}/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
    const data = (await res.json()) as { result?: string | null };
    return data.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export function dialogueKey(platform: string, dialogueId: string): string {
  return `headroom:conv:${platform}:${dialogueId}`;
}

export async function getDialogue(
  creds: UpstashCreds,
  key: string,
): Promise<DialogueRecord | null> {
  const raw = await command(creds, ["GET", key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DialogueRecord;
  } catch {
    return null;
  }
}

export async function setDialogue(
  creds: UpstashCreds,
  key: string,
  record: DialogueRecord,
): Promise<void> {
  await command(creds, ["SET", key, JSON.stringify(record)]);
}
