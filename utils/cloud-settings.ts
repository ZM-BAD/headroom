import type { ContextLimits, Language, Settings } from "./settings";
import type { Thresholds } from "./thresholds";
import type { TokenCoefficients } from "./estimate";
import {
  kvDel,
  kvGet,
  kvSet,
  SETTINGS_KEY,
  type UpstashCreds,
} from "./upstash";

/**
 * The subset of settings persisted to Upstash (cloud truth, cross-device merge
 * point). Credentials are NEVER included — you can't read anything from Upstash
 * without them, so storing them there is both pointless and a leak risk. The
 * local `Settings` holds the full object (creds included); the cloud holds only
 * this shape.
 */
export interface CloudSettings {
  thresholds: Thresholds;
  language: Language;
  contextLimits: ContextLimits;
  /** Per-platform user coefficient overrides (spec 004). */
  tokenCoefficients: Record<string, Partial<TokenCoefficients>>;
  /** epoch ms — drives last-write-wins on read-merge. */
  updatedAt: number;
}

/**
 * Project the full local settings into the cloud shape: copy the three
 * syncable fields, drop credentials, stamp `updatedAt = now`. `now` is injected
 * (not read from Date inside) so this stays pure and deterministic under test.
 */
export function toCloudSettings(local: Settings, now: number): CloudSettings {
  return {
    thresholds: local.thresholds,
    language: local.language,
    contextLimits: local.contextLimits,
    tokenCoefficients: local.tokenCoefficients,
    updatedAt: now,
  };
}

/**
 * Fold a cloud snapshot back into local settings, last-write-wins on
 * `updatedAt`. Only the non-credential fields are adoptable from the cloud;
 * local credentials always survive. Pass the local settings' own `updatedAt`
 * (0 before the settings phase adds the field). Returns a NEW object; never
 * mutates `local`. When cloud is absent or not newer, local wins unchanged.
 */
export function mergeCloudSettings(
  local: Settings,
  cloud: CloudSettings | null,
  localUpdatedAt: number,
): Settings {
  if (!cloud || cloud.updatedAt <= localUpdatedAt) return { ...local };
  return {
    ...local, // preserve upstash credentials + any future local-only fields
    thresholds: cloud.thresholds,
    language: cloud.language,
    contextLimits: cloud.contextLimits,
    tokenCoefficients: cloud.tokenCoefficients,
  };
}

export async function getCloudSettings(
  creds: UpstashCreds,
): Promise<CloudSettings | null> {
  const raw = await kvGet(creds, SETTINGS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudSettings;
  } catch (e) {
    console.warn("[Headroom] corrupt cloud settings, treating as absent:", e);
    return null;
  }
}

export async function setCloudSettings(
  creds: UpstashCreds,
  cloud: CloudSettings,
): Promise<void> {
  await kvSet(creds, SETTINGS_KEY, JSON.stringify(cloud));
}

export async function delCloudSettings(creds: UpstashCreds): Promise<void> {
  await kvDel(creds, SETTINGS_KEY);
}
