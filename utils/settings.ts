import { ADAPTERS } from "../adapters";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./thresholds";
import type { UpstashCreds } from "./upstash";
import type { TokenCoefficients } from "./estimate";

/** Storage key follows the spec's settings-key scheme. */
export const STORAGE_KEY = "headroom:settings";

/** "auto" follows the browser UI locale; any other value forces a language. */
export type Language =
  | "auto"
  | "en"
  | "zh_CN"
  | "ja"
  | "ko"
  | "ru"
  | "es"
  | "pt_BR"
  | "fr"
  | "de"
  | "id";

/**
 * Per-platform context-window limits in tokens, keyed by platformId.
 * **Delta storage** (same model as `tokenCoefficients`): only user overrides
 * live here — locally and in the cloud. Adapter defaults stay in code
 * (`adapter.contextLimit`), so updating a default reaches every user who
 * never overrode it. Consumers fall back per entry:
 * `settings.contextLimits[id] ?? adapter.contextLimit`.
 */
export type ContextLimits = Record<string, number>;

export interface Settings {
  thresholds: Thresholds;
  language: Language;
  upstash: UpstashCreds;
  contextLimits: ContextLimits;
  /** Per-platform user coefficient overrides (spec 004). Keys = platformId; only overridden fields stored. */
  tokenCoefficients: Record<string, Partial<TokenCoefficients>>;
  /**
   * epoch ms of the last local modification — drives LWW against the cloud
   * snapshot (spec 003 settings pull). 0 = never modified (fresh defaults),
   * so any cloud record wins on first pull. Save stamps it with the same
   * timestamp pushed to the cloud; adopting a cloud snapshot copies the
   * cloud's timestamp (see `mergeCloudSettings`).
   */
  updatedAt: number;
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
  contextLimits: {},
  tokenCoefficients: {},
  updatedAt: 0,
};

/** Read settings from local storage, falling back to defaults per field. */
export async function getSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<Settings> | undefined;
  // Delta model: keep only valid stored overrides that DIFFER from the
  // current adapter default. An entry equal to the default is a baked-in
  // legacy value (pre-delta versions persisted the full default map) — drop
  // it so future adapter-default updates reach the user. Unknown platform
  // ids have no current default and pass through verbatim.
  const defaults = defaultContextLimits();
  const contextLimits: ContextLimits = {};
  const storedLimits = stored?.contextLimits;
  if (storedLimits && typeof storedLimits === "object") {
    for (const [id, val] of Object.entries(storedLimits)) {
      if (
        typeof val === "number" &&
        Number.isFinite(val) &&
        val > 0 &&
        val !== defaults[id]
      ) {
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
    tokenCoefficients:
      stored?.tokenCoefficients && typeof stored.tokenCoefficients === "object"
        ? (stored.tokenCoefficients as Record<
            string,
            Partial<TokenCoefficients>
          >)
        : {},
    updatedAt:
      typeof stored?.updatedAt === "number" && Number.isFinite(stored.updatedAt)
        ? stored.updatedAt
        : 0,
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
