// Live Upstash connectivity + storage-structure probe.
//
// Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from .env, then
// exercises the finalized Redis key scheme + JSON shapes against the REAL
// instance: DialogueRecord SET→GET→DEL, and cloud-settings SET→GET→DEL
// (asserting credentials never leak into the stored JSON).
//
// Uses throwaway probe keys (headroom:_probe:*) and cleans them up in a finally
// block — it never touches real headroom:conv:* / headroom:settings data.
//
// NOT part of npm test / CI (it needs network + real creds). Run manually:
//   node scripts/probe-upstash.mjs
import "dotenv/config";

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Keep this scheme in sync with utils/upstash.ts (dialogueKey / SETTINGS_KEY).
const CONV_KEY = "headroom:_probe:conv:testplatform:test123";
const SETTINGS_KEY = "headroom:_probe:settings";

const lines = [];
const ok = (m) => lines.push(`✅ ${m}`);
const fail = (m, e) => lines.push(`❌ ${m}: ${e}`);

function assert(cond, msg) {
  if (!cond) throw new Error(`assert: ${msg}`);
}

async function cmd(args) {
  const res = await fetch(`${URL}/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${JSON.stringify(args)}`);
  const data = await res.json();
  return data.result ?? null;
}

async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e instanceof Error ? e.message : String(e));
  }
}

try {
  if (!URL || !TOKEN) {
    console.error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env");
    process.exit(2);
  }

  // --- 1. DialogueRecord round-trip (headroom:conv:{platform}:{dialogueId}) ---
  await step("conv SET", async () => {
    const rec = {
      platformId: "testplatform",
      dialogueId: "test123",
      contextLimit: 1_048_576,
      totalTokens: 42,
      roundCount: 1,
      rounds: [{ messageId: "test-msg", order: 1, n: 1, promptTokens: 10, answerTokens: 32, total: 42, createdAt: 1 }],
      updatedAt: 1,
    };
    await cmd(["SET", CONV_KEY, JSON.stringify(rec)]);
  });

  await step("conv GET round-trips the record shape", async () => {
    const raw = await cmd(["GET", CONV_KEY]);
    assert(raw !== null, "conv missing after SET");
    const rec = JSON.parse(raw);
    assert(rec.totalTokens === 42, `totalTokens mismatch: ${raw}`);
    assert(rec.roundCount === 1, `roundCount mismatch: ${raw}`);
    assert(rec.platformId === "testplatform", `platform mismatch: ${raw}`);
    assert(Array.isArray(rec.rounds) && rec.rounds.length === 1, "rounds mismatch");
  });

  await step("conv DEL removes it (idempotent)", async () => {
    await cmd(["DEL", CONV_KEY]);
    const after = await cmd(["GET", CONV_KEY]);
    assert(after === null, `conv still present after DEL: ${after}`);
  });

  // --- 2. Cloud settings round-trip (headroom:settings, NO credentials) ---
  await step("settings SET (payload has no credentials)", async () => {
    const cloud = {
      thresholds: { yellow: 0.5, red: 0.7 },
      language: "auto",
      contextLimits: { deepseek: 1_048_576 },
      tokenCoefficients: {},
      updatedAt: 12345,
    };
    const json = JSON.stringify(cloud);
    // Credential keys must not appear as JSON fields in the cloud settings
    // payload. Use the key-colon form to avoid matching \"tokenCoefficients\".
    assert(
      !/"token"\s*:/.test(json),
      "token leaked into cloud settings JSON",
    );
    assert(
      !/"upstash"\s*:/.test(json),
      "upstash block leaked into cloud settings JSON",
    );
    await cmd(["SET", SETTINGS_KEY, json]);
  });

  await step("settings GET matches + carries no credentials", async () => {
    const raw = await cmd(["GET", SETTINGS_KEY]);
    assert(raw !== null, "settings missing after SET");
    assert(
      !/"token"\s*:/.test(raw),
      `creds present in stored settings: ${raw}`,
    );
    assert(
      !/"upstash"\s*:/.test(raw),
      `upstash block present in stored settings: ${raw}`,
    );
    const s = JSON.parse(raw);
    assert(s.thresholds.red === 0.7, `thresholds mismatch: ${raw}`);
    assert(s.updatedAt === 12345, `updatedAt mismatch: ${raw}`);
    assert(s.language === "auto", `language mismatch: ${raw}`);
  });

  await step("settings DEL removes it", async () => {
    await cmd(["DEL", SETTINGS_KEY]);
    const after = await cmd(["GET", SETTINGS_KEY]);
    assert(after === null, `settings still present after DEL: ${after}`);
  });
} finally {
  // Always clean up probe keys, even on crash.
  try {
    await cmd(["DEL", CONV_KEY, SETTINGS_KEY]);
  } catch {
    /* best-effort cleanup */
  }
}

console.log(lines.join("\n"));
const failed = lines.filter((l) => l.startsWith("❌")).length;
if (failed > 0) {
  console.error(`\n${failed} step(s) failed`);
  process.exit(1);
}
console.log("\nAll Upstash interactions verified against the live instance.");
