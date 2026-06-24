import type { DialogueRecord } from "./dialogue-record";

/**
 * Minimal Upstash Redis REST client — the cloud transport + structure layer
 * (spec 002). The REST API is CORS-permissive and takes a command-array body
 * (`["GET",key]` / `["SET",key,val]` / `["DEL",key]`), one HTTPS POST per
 * command. Returns null when creds are absent (Upstash is optional — the live
 * gauge works off local state; Upstash only persists per-dialogue history +
 * settings across sessions/devices).
 *
 * `UpstashCreds` is the BYOK REST pair (UPSTASH_REDIS_REST_URL + _TOKEN), NOT
 * the native Redis URL/password. `command()` refuses non-https URLs so the
 * token is never sent in the clear.
 *
 * Layered: generic `kvGet` / `kvSet` / `kvDel` primitives (shape-agnostic
 * transport) under thin typed wrappers — `getDialogue` / `setDialogue` /
 * `delDialogue` here, settings via `cloud-settings.ts` (same primitives).
 */

/** BYOK REST credentials. Empty strings = not configured. */
export interface UpstashCreds {
  url: string;
  token: string;
}

/** Cloud-side settings key. Credentials are NEVER stored here (see cloud-settings). */
export const SETTINGS_KEY = "headroom:settings";

async function command(
  creds: UpstashCreds,
  args: string[],
): Promise<string | null> {
  if (!creds.url || !creds.token) return null;
  if (!creds.url.startsWith("https://")) {
    // Refuse to send the REST token over a non-https URL — defense at the
    // transport layer (the settings UI should also reject http on input).
    console.warn("[Headroom] refusing non-https Upstash URL:", creds.url);
    return null;
  }
  // Bound the request so a wedged/slow Upstash can't hang the service worker
  // (MV3). On abort the fetch rejects and the caller falls back to local.
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

/** Generic transport — GET a raw string value (null if absent or unconfigured). */
export async function kvGet(
  creds: UpstashCreds,
  key: string,
): Promise<string | null> {
  return command(creds, ["GET", key]);
}

/** Generic transport — SET a raw string value. No-op when unconfigured. */
export async function kvSet(
  creds: UpstashCreds,
  key: string,
  value: string,
): Promise<void> {
  await command(creds, ["SET", key, value]);
}

/** Generic transport — DEL a key (idempotent). No-op when unconfigured. */
export async function kvDel(creds: UpstashCreds, key: string): Promise<void> {
  await command(creds, ["DEL", key]);
}

export function dialogueKey(platformId: string, dialogueId: string): string {
  return `headroom:conv:${platformId}:${dialogueId}`;
}

export async function getDialogue(
  creds: UpstashCreds,
  key: string,
): Promise<DialogueRecord | null> {
  const raw = await kvGet(creds, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DialogueRecord;
  } catch (e) {
    console.warn(
      `[Headroom] corrupt dialogue record at ${key}, treating as absent:`,
      e,
    );
    return null;
  }
}

export async function setDialogue(
  creds: UpstashCreds,
  key: string,
  record: DialogueRecord,
): Promise<void> {
  await kvSet(creds, key, JSON.stringify(record));
}

/** Delete a dialogue record (idempotent). Backs the delete-interception flow (002). */
export async function delDialogue(
  creds: UpstashCreds,
  key: string,
): Promise<void> {
  await kvDel(creds, key);
}
