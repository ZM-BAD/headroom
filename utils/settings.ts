import { ADAPTERS } from "../adapters";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./thresholds";
import type { UpstashCreds } from "./upstash";

/** Storage key follows the spec's settings-key scheme. */
export const STORAGE_KEY = "headroom:settings";

/** "auto" follows the browser UI locale; en/zh_CN force a language. */
export type Language = "auto" | "en" | "zh_CN";

/**
 * Per-platform context-window limits in tokens, keyed by platformId. Defaults
 * are auto-detected from each adapter's built-in `contextLimit` (the "built-in
 * dictionary"); the user can override any entry in the settings panel to match
 * their actual model/plan.
 */
export type ContextLimits = Record<string, number>;

export interface Settings {
  thresholds: Thresholds;
  language: Language;
  upstash: UpstashCreds;
  contextLimits: ContextLimits;
}

/** The auto-detected defaults — one entry per adapter, straight from its contextLimit. */
export function defaultContextLimits(): ContextLimits {
  return Object.fromEntries(
    ADAPTERS.map((a) => [a.platformId, a.contextLimit]),
  );
}

export const DEFAULT_SETTINGS: Settings = {
  thresholds: { ...DEFAULT_THRESHOLDS },
  language: "auto",
  upstash: { url: "", token: "" },
  contextLimits: defaultContextLimits(),
};

/** Read settings from local storage, falling back to defaults per field. */
export async function getSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<Settings> | undefined;
  // Start from auto-detected defaults, then overlay any valid stored overrides
  // (ignore corrupt / non-positive values so a bad write can't zero the gauge).
  const contextLimits = defaultContextLimits();
  const storedLimits = stored?.contextLimits;
  if (storedLimits && typeof storedLimits === "object") {
    for (const [id, val] of Object.entries(storedLimits)) {
      if (typeof val === "number" && Number.isFinite(val) && val > 0) {
        contextLimits[id] = val;
      }
    }
  }
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
    contextLimits,
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
