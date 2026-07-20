/**
 * Audit adapter hostnames against wxt.config.ts host_permissions.
 *
 * Each adapter declares which hosts Headroom talks to (completionUrl,
 * deleteUrl, deleteHost, matchPattern, etc.). These MUST all appear in
 * the manifest's host_permissions — otherwise webRequest won't observe
 * the traffic and the round-complete / delete-interception signals fail
 * silently on those hosts.
 *
 * Exit 0 = all covered; exit 1 = gaps found.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ADAPTERS_DIR = resolve(ROOT, "adapters");
const WXT_CONFIG = resolve(ROOT, "wxt.config.ts");

// ── 1. Collect hostnames from all adapter files ─────────────────────────

const hosts = new Set();

for (const f of readdirSync(ADAPTERS_DIR)) {
  if (!f.endsWith(".ts") || f === "index.ts") continue;
  const src = readFileSync(resolve(ADAPTERS_DIR, f), "utf-8");

  // Bare hostname fields: host / deleteHost
  for (const m of src.matchAll(/(?:host|deleteHost):\s*"[^"]+"/g)) {
    const host = m[0].match(/"([^"]+)"/)?.[1];
    if (host && !host.includes(" ")) hosts.add(host);
  }

  // URL-pattern fields: completionUrl / continueUrl / stopUrl /
  // deleteUrl / matchPattern — extract host from *://host/...
  for (const m of src.matchAll(/\*:\/\/([^/\*"]+)/g)) {
    hosts.add(m[1]);
  }
}

// ── 2. Collect hostnames from wxt.config.ts host_permissions ────────────

const wxtSrc = readFileSync(WXT_CONFIG, "utf-8");
const permMatch = wxtSrc.match(/host_permissions:\s*\[([\s\S]*?)\]/);
if (!permMatch) {
  console.error("❌ Could not find host_permissions in wxt.config.ts");
  process.exit(1);
}
const permHosts = new Set();
for (const m of permMatch[1].matchAll(/\*:\/\/([^/\*"]+)/g)) {
  permHosts.add(m[1]);
}

// ── 3. Compare ──────────────────────────────────────────────────────────

const missing = [...hosts].filter((h) => !permHosts.has(h)).sort();
const extra = [...permHosts].filter((h) => !hosts.has(h)).sort();

let exit = 0;
if (missing.length) {
  console.error(
    `\n❌ Adapter hosts MISSING from host_permissions (${missing.length}):`,
  );
  missing.forEach((h) => console.error(`  - *://${h}/*`));
  exit = 1;
}
if (extra.length) {
  console.error(
    `\n⚠️  host_permissions entries NOT found in any adapter (${extra.length}):`,
  );
  extra.forEach((h) => console.error(`  - *://${h}/*`));
  // extra entries are wasteful but not blocking — warn only, don't fail
}
if (exit === 0) {
  console.log(
    `✅ host_permissions: ${hosts.size} adapter hosts, all covered`,
  );
}

process.exit(exit);
