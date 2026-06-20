import { DEFAULT_THRESHOLDS, type Thresholds } from "./thresholds";

/** Storage key follows the spec's settings-key scheme. */
export const STORAGE_KEY = "headroom:settings";

/** "auto" follows the browser UI locale; en/zh_CN force a language. */
export type Language = "auto" | "en" | "zh_CN";

/**
 * Upstash REST API credentials (BYOK). Empty strings = not configured.
 * These are the REST API pair (UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN), NOT the native Redis URL/password — the
 * browser can only reach Upstash over HTTPS via the REST API.
 */
export interface UpstashConfig {
  url: string;
  token: string;
}

export interface Settings {
  thresholds: Thresholds;
  language: Language;
  upstash: UpstashConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  thresholds: { ...DEFAULT_THRESHOLDS },
  language: "auto",
  upstash: { url: "", token: "" },
};

/** Read settings from local storage, falling back to defaults per field. */
export async function getSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<Settings> | undefined;
  return {
    thresholds: {
      yellow: stored?.thresholds?.yellow ?? DEFAULT_THRESHOLDS.yellow,
      red: stored?.thresholds?.red ?? DEFAULT_THRESHOLDS.red,
    },
    language: stored?.language ?? "auto",
    upstash: {
      url: stored?.upstash?.url ?? "",
      token: stored?.upstash?.token ?? "",
    },
  };
}

/**
 * Write the full settings object. The side panel holds an authoritative
 * working copy of every field and persists it as a whole on Save, so a
 * full overwrite is correct here — there is exactly one writer and it
 * always writes complete state. Replaces the Phase 1 read-merge-write
 * helpers now that the settings UI uses explicit (whole-object) saves.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: settings });
}
