/**
 * Compare i18n keys: en (authoritative) ↔ zh_CN (manually maintained).
 * Keys missing in zh_CN silently show English to Chinese users.
 * Keys in zh_CN but not in en are stale leftovers — also worth surfacing.
 *
 * Only en↔zh_CN: the other 8 locales fall back to en via t()'s chain
 * (see entrypoints/sidepanel/main.ts → t()), so their key gaps are
 * intentional and not checked here.
 *
 * Exit 0 = identical key sets; exit 1 = differences found.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LOCALES = resolve(ROOT, "public", "_locales");

function loadKeys(locale) {
  const raw = readFileSync(resolve(LOCALES, locale, "messages.json"), "utf-8");
  return new Set(Object.keys(JSON.parse(raw)));
}

const en = loadKeys("en");
const zhCN = loadKeys("zh_CN");

const missingInZhCN = [...en].filter((k) => !zhCN.has(k)).sort();
const staleInZhCN = [...zhCN].filter((k) => !en.has(k)).sort();

let exit = 0;
if (missingInZhCN.length) {
  console.error(
    `\n❌ Keys in en but MISSING in zh_CN (${missingInZhCN.length}):`,
  );
  missingInZhCN.forEach((k) => console.error(`  - ${k}`));
  exit = 1;
}
if (staleInZhCN.length) {
  console.error(
    `\n⚠️  Keys in zh_CN but NOT in en (stale, ${staleInZhCN.length}):`,
  );
  staleInZhCN.forEach((k) => console.error(`  - ${k}`));
  exit = 1;
}
if (exit === 0) console.log("✅ i18n keys: en ↔ zh_CN match");

process.exit(exit);
