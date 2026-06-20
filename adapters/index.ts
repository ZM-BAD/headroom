import type { PlatformAdapter } from "../utils/platform-adapter";
import { deepseekAdapter } from "./deepseek";
import { chatgptAdapter } from "./chatgpt";
import { geminiAdapter } from "./gemini";
import { kimiAdapter } from "./kimi";
import { qwenAdapter } from "./qwen";
import { qianwenAdapter } from "./qianwen";
import { doubaoAdapter } from "./doubao";

/**
 * Registry of every platform adapter. The background builds its webRequest
 * URL filter + host dispatch from this; the side panel looks up display names
 * via `platformDisplayName`; the generic content script matches every
 * adapter's matchPattern. Adding a platform = append an adapter here + add the
 * host(s) to `wxt.config.ts host_permissions`. No other registration needed.
 */
export const ADAPTERS: PlatformAdapter[] = [
  deepseekAdapter,
  chatgptAdapter,
  geminiAdapter,
  kimiAdapter,
  qwenAdapter,
  qianwenAdapter,
  doubaoAdapter,
];

/** Human-readable name for a platformId, for the side panel. "" if unknown. */
export function platformDisplayName(platformId: string | null): string {
  if (!platformId) return "";
  return (
    ADAPTERS.find((a) => a.platformId === platformId)?.displayName ?? platformId
  );
}
