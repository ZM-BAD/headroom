# AGENTS.md

Project instructions for AI coding agents (Claude Code, Cursor, Copilot, Windsurf, etc.) working in this repository.

> **Single source of truth — edit `AGENTS.md`, not `CLAUDE.md`.** `CLAUDE.md` is a symlink to this file (`AGENTS.md`). This is deliberate: `AGENTS.md` is the cross-agent standard filename (Cursor / Copilot / Windsurf read it), while Claude Code reads `CLAUDE.md` — the symlink serves both from one source. Most editors and tools (including the Edit tool) **reject writing through a symlink** ("Refusing to write through symlink"), so always open and edit `AGENTS.md` directly. Do **not** replace the symlink with a real file, delete it, or duplicate the content into `CLAUDE.md`.

## Project Overview

Headroom is a browser extension built with [WXT](https://wxt.dev/) (next-gen web extension framework). **Manifest V3 only** — Chrome, Edge, and Firefox. MV2 is not supported (`manifestVersion: 3` is set in `wxt.config.ts`, overriding WXT's Firefox-default MV2).

## Commands

```bash
npm run dev              # Dev + HMR → .output/chrome-mv3-dev/ (DIFFERENT dir from build!)
npm run dev:firefox      # Dev mode for Firefox
npm run build            # Production build → .output/chrome-mv3/
npm run build:chrome     # Same as build (alias)
npm run build:firefox    # Production build → .output/firefox-mv3/
npm run build:edge       # Production build → .output/edge-mv3/
npm run zip              # Package .zip for distribution (Chrome)
npm run zip:firefox      # Package .zip for Firefox
npm run zip:edge         # Package .zip for Edge
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run typecheck        # TypeScript type check (tsc --noEmit)
npm test                 # Run tests in watch mode
npm run test:run         # Run tests once (CI + pre-commit)
npx wxt prepare          # Regenerate types in .wxt/ (auto-runs on postinstall)
```

## Architecture

**WXT uses file-based routing** — entrypoints are auto-discovered from `entrypoints/` directory.

- **HTML entrypoints** must use directory structure: `entrypoints/<name>/index.html` + `entrypoints/<name>/main.ts`. Do NOT place `.html` and `.ts` sibling files with the same name — WXT treats them as duplicate entrypoints.
- **Script entrypoints**: `background.ts` uses `export default defineBackground(() => {...})`. Content scripts use `export default defineContentScript({ matches: [...], main() {...} })`.
- **Auto-imports**: `defineBackground`, `defineContentScript`, `defineConfig`, `browser` etc. are auto-imported by WXT. Do not add explicit import statements for these.
- **Cross-browser API**: Use `browser.*` (WXT wrapper) instead of `chrome.*` directly.

### Upstash (Redis) data model — the cloud storage layer

Upstash Redis (user-owned, BYOK) is the **cross-device merge point + cloud persistence**; `browser.storage.local` is the acceleration cache the live gauge reads from. The **token truth is the platform's conversation-history text** — tokens are always _estimated_ from that text by the 001 engine, never trusted from the platform; Upstash only persists the resulting counts. The transport layer is spec [002](specs/002-upstash-data-layer.md); the reconciliation that reads/writes these records (open = full recompute, union-merge by round-n, delete sync, zombie cleanup) is spec [003](specs/003-cross-device-sync.md). The extension reaches Upstash only over the HTTPS **REST API** — the browser can't speak native Redis.

**REST contract** (`utils/upstash.ts`): one HTTPS POST per command.
`POST {UPSTASH_REDIS_REST_URL}/` · header `Authorization: Bearer {UPSTASH_REDIS_REST_TOKEN}` · body = JSON command array (`["GET",key]` / `["SET",key,val]` / `["DEL",key]`) → `{ "result": <string|null> }`. 8s `AbortController` timeout — a wedged Upstash must not hang the SW. Empty creds ⇒ every op silently no-ops (Upstash is optional; the gauge works off local state).

**Free-tier budget** ([pricing](https://upstash.com/pricing/redis)): 256 MB storage, **500K commands/month** (account-level, not per-key). Each round costs 2 commands (GET + SET in the read-modify-write), a delete costs 1 (DEL), a settings save costs 1. 500K/month ≈ 250K rounds/month — well beyond a single user. Storage is a non-issue: a `DialogueRecord` stores **only token counts** per round (no prompt/answer text — see `utils/dialogue-record.ts`), so a 50-round conversation is ~4 KB; 256 MB ≈ 65K conversations. **Architectural implication**: 003's zombie-cleanup / open-reconcile can burst commands after a long offline period (there is **no outbox** — missed rounds are simply re-reconciled on next open), but the total stays within budget because they are real user activity that would have been counted anyway. If a user ever exceeds the free tier, Upstash bills ~$0.20/100K extra commands — that's the user's account, not Headroom's concern.

**Key scheme — only two value types live on Redis:**

- `headroom:conv:{platform}:{dialogueId}` → `DialogueRecord` JSON (shape in `utils/dialogue-record.ts`; carries `updatedAt`).
- `headroom:settings` → `{ thresholds, language, contextLimits, tokenCoefficients, updatedAt }`. **Credentials are NEVER written here** — you can't read Redis without them, so storing them is both pointless and a leak. Local `Settings` keeps the full object (creds included); the cloud keeps only this stripped shape (`utils/cloud-settings.ts`).

**Client layering — keep it this way:** generic primitives `kvGet` / `kvSet` / `kvDel` (shape-agnostic transport) under one typed wrapper per domain value (`getDialogue`/`setDialogue`/`delDialogue`, `getCloudSettings`/`setCloudSettings`/`delCloudSettings`). A new Redis value type = a new thin wrapper over the kv primitives, **not** a fourth fetch path.

**Credentials stay local.** The extension reads them from local `Settings.upstash`; the debug probe reads `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` from `.env` (gitignored).

**Verify after any change here:** `node scripts/probe-upstash.mjs` — reads `.env`, runs GET/SET/DEL × (conv + settings) against the **live** instance on throwaway `headroom:_probe:*` keys (self-cleans in `finally`), and asserts no credentials leak into the stored settings JSON. Not part of `npm test`.

## Key Files

- `wxt.config.ts` — WXT config + manifest overrides
- `tsconfig.json` — extends `.wxt/tsconfig.json` (generated by `wxt prepare`)
- `eslint.config.js` — ESLint flat config (TS + auto-imports aware)
- `.github/workflows/ci.yml` — GitHub Actions: lint + typecheck + build
- `.husky/pre-commit` — lint-staged → `npm run lint` → `npm run typecheck` → `npm run test:run` → `npm run build` → `npm run build:firefox`
- `brand/` — project logo source SVGs (`blue.svg` main, `white.svg` light-bg variant)
- `icon/` — per-platform brand SVGs + `default.svg` (→ `../brand/blue.svg` symlink); imported by the sidepanel at build time
- `public/icon/` — extension toolbar icons (PNGs rendered from `brand/blue.svg`)
- `public/_locales/` — i18n message catalogs (en + zh_CN complete; 8 other locales fall back to en for new keys)
- `.wxt/` — generated types, do not edit manually
- `.output/` — build output, gitignored

### i18n system

The sidepanel uses a two-layer translator (`t()` in `main.ts`):

1. Manual override layer — `localeTables[selectedLang]`, loaded at init from the 10 `_locales/*/messages.json` files
2. Browser-native layer — `browser.i18n.getMessage(key)`, used in "auto" mode

When a key is missing in the selected locale, `t()` explicitly falls back to `localeTables["en"]` — NOT to `browser.i18n.getMessage(key)`. The browser API uses the **browser's UI language**, which can be a third language (e.g. browser is zh_CN, user selected Deutsch). Explicit en fallback ensures untranslated keys always show English, not whatever the browser happens to speak.

New keys only need to be added to `en/messages.json` and `zh_CN/messages.json`; the other 8 locales inherit English via the fallback chain. See `sidepanel/main.ts` → `t()` for the implementation.

### Token estimation engine (spec 004)

Six writing systems, each with an independent coefficient:

| Script                   | Counting unit | Default coeff |
| ------------------------ | ------------- | ------------- |
| CJK (中日韩统一表意文字) | per character | 0.6 tok/ch    |
| Kana (仮名)              | per character | 0.5 tok/ch    |
| Hangul (한글)            | per character | 0.5 tok/ch    |
| Cyrillic                 | per word      | 0.5 tok/wd    |
| Arabic                   | per word      | 0.5 tok/wd    |
| Latin (fallback)         | per word      | 0.5 tok/wd    |

Char-based scripts are NOT double-counted as words. Coefficients are user-overridable per platform in the Advanced Settings panel. The engine lives in `utils/estimate.ts`; coefficients flow through `Settings.tokenCoefficients` → Upstash cloud sync.

### Adding a new platform

1. Create `adapters/<platform>.ts` implementing `PlatformAdapter` (see `utils/platform-adapter.ts`)
2. Register in `adapters/index.ts` → `ADAPTERS` array
3. Add SVG brand icon to `icon/<platform>.svg` (and `PLATFORM_ICON` map in `sidepanel/main.ts`)
4. Add entry to `PLATFORM_REF` array in `sidepanel/main.ts` for the Platform Reference section
5. Add `host_permissions` entry in `wxt.config.ts`
6. Run `npx wxt prepare` to refresh types
7. If no SVG exists, `icon/default.svg` (the Headroom gauge) is used automatically via `PLATFORM_ICON[platformId] ?? defaultIcon`

## Commit Messages

Conventional Commits format, enforced by commitlint (`.husky/commit-msg` + CI).

**Format:** `<type>(<scope>): <subject>` — imperative, ≤50 chars, no period. Blank line, then body (WHY + landmines only, never restate the diff; ≤72 chars/line), then `Co-Authored-By: Claude <noreply@anthropic.com>` (required for every AI commit).

**Types:** `feat` `fix` `docs` `refactor` `perf` `test` `build` `ci` `chore` `style`. Scope is the affected module (e.g. `sidepanel` `background` `upstash`).

**Squash:** dev churn gets squashed, but landmine lessons must survive — keep the commit or move the lesson into a code comment / this playbook.

## Spec-Driven Development

Specs are PRDs optimized for AI agents — more precise, less ambiguous, more actionable.

**Pipeline: `requirements/` → `specs/xxx.md` → code**

### Division of labor

| Stage                        | Owner     | Action                                           |
| ---------------------------- | --------- | ------------------------------------------------ |
| `requirements/` (gitignored) | **Human** | Write product requirements, discussion, analysis |
| `specs/xxx.md`               | **AI**    | Read requirements, generate spec from template   |
| Spec review                  | **Human** | Review and commit to main (commit = approved)    |
| Write code                   | **AI**    | Implement based on spec                          |

### Rules

- **No spec, no code.** Never implement without a committed spec in `specs/`.
- **Spec = single source of current truth.** Edit it in place as decisions evolve. When a decision changes, fix the original text — no strikethrough, no appended "we changed it" note. Git is the history; the spec reflects only the present.
- **Never append redundant Implementation Notes.** What code/git already shows (data model, UI inventory, key counts, "build is green") does not go in the spec — it's noise that costs every future AI reader input tokens. Reserve spec edits for what code+git can't recover (decisions, rationale, landmines, deferred scope), and keep them terse, folded into the relevant section — not an appendix.
- When a new requirement appears in `requirements/`, offer to generate a corresponding spec.
- Use `specs/000-spec-template.md` as the template for new specs.

## Development & Debugging Playbook

Lessons learned building Headroom. Stack-specific (WXT + MV3 extension), not generic advice. Read before starting a change.

### The loop (agreed)

**AI:** edit → `npm run typecheck` → `npm run lint` → `npm run build` → say "ready".
**Human:** `chrome://extensions` → 🔄 reload → test in browser → report back.

Don't run `npm run dev` in the background (stdin EOF kills it). Don't try to auto-launch Chrome — CDP is flaky on macOS. Default to `build` + manual reload.

### Do

- After every change: `typecheck` → `lint` → `build`. `wxt build` does NOT type-check.
- `dev` and `build` output to DIFFERENT dirs (`-dev` vs `-mv3`). Rebuild the one the human loaded.
- After adding a new entrypoint: `npx wxt prepare`.
- Verify config field names against WXT types (it's `webExt`, not `webExtConfig`).

### Don't

- Don't add explicit imports for WXT auto-imports. "Cannot find name" before `wxt prepare` is normal.
- Don't Remove + re-Load-unpacked after a rebuild — just 🔄 reload (ID is path-derived, stable).
- Don't claim a feature works without evidence. State what you verified vs. what's pending human test.
- Don't try to auto-drive Chrome for runtime verification. Defer to the human.

### Verify

- `typecheck` + `lint` pass, build succeeds, manifest has expected permissions.
- Grep **string literals** in build artifacts (IDs, permission names) to confirm code landed — they survive minification; function names don't (esbuild mangles them).
- After Upstash changes: `node scripts/probe-upstash.mjs` (live probe, self-cleans). Not part of `npm test`.

### WXT gotchas

- **Two output dirs** (see above).
- **Auto-imports** resolve only after `wxt prepare`; pre-prepare "Cannot find name" is normal.
- **`browser.i18n.getMessage` / `browser.runtime.getURL` are typed to literal unions** (message names / `PublicPath`), so passing a runtime `string` needs a `as (name: string) => string` alias (see `main.ts`) — not a real error.
- **"Don't auto-open a browser in dev"** = `webExt: { disabled: true }` in `wxt.config.ts`.
- **`defineBackground`'s callback can't be async** — fire async helpers with `void fn()`.

### MV3 extension gotchas

- **Side panel on click needs the popup removed.** `action.default_popup` intercepts the toolbar click so the panel never opens. With a `sidepanel/` entrypoint, set `setPanelBehavior({ openPanelOnActionClick: true })` in the background and guard `browser.sidePanel` (absent on Firefox → `sidebarAction`).
- **Adding a manifest permission** (e.g. `storage`): reload usually applies it silently for unpacked extensions, but Chrome _may_ gray the card out pending consent — flag it when you add one.
- **Coupled range sliders:** a thumb sits at `(value-min)/(max-min)`, so changing a slider's `min`/`max` rescales its track and shifts the thumb even with the same value. Keep both `min`/`max` fixed and clamp only the dragged slider's value — never touch the other's bounds or value.
- **MV3 service worker is ephemeral:** keep state in `browser.storage`, not module globals; message handlers must assume a cold start.
- **Content-script long-lived timers must bind to the WXT context (`ctx.setInterval`), not `window.setInterval`.** When the extension is reloaded/updated the OLD content script's context is invalidated, but a raw `window.setInterval` keeps firing on the dead context — `browser.runtime.sendMessage` then throws _synchronously_ (`Uncaught Error: Extension context invalidated`; the returned promise's `.catch` never runs, because the throw happens before the promise exists) and floods the Errors log every tick. `ctx.setInterval` (the `ContentScriptContext` passed to `main(ctx)`) auto-clears on invalidation. Also wrap any `browser.runtime` call in `try/catch` (not just `.catch`) for in-flight races. Note: `"Extension context invalidated"` is the canonical MV3 dev-reload artifact (even Bitwarden / React DevTools hit it) — expected whenever you reload the extension, and the operational fix is to **reload the page after reloading the extension** (reload-extension ≠ re-inject content scripts in open tabs).
- **Reading a request body: don't patch `window.fetch` in a MAIN-world content script — use `webRequest`.** Real sites' bundles / analytics SDKs (e.g. DeepSeek's ByteDance Rangers) re-wrap `window.fetch` after your `document_start` script, clobbering your override before the request you care about fires — your wrapper is installed but silently never sees the request (confirmed via DevTools: `[Headroom-MAIN] interceptor installed` logged, but no interception log on send). `webRequest.onBeforeRequest` with `["requestBody"]` observes at the network layer regardless of fetch/XHR/worker or who re-wrapped fetch; needs the `webRequest` permission + a `host_permissions` entry (which may gray the unpacked card pending re-grant).

### Performance gotchas

- **`estimateTokens` — single-pass only; never `[...tok]` on untokenized text.** The 6-way estimator originally scanned text twice: Pass 1 per-character for CJK/kana/Hangul, then Pass 2 `split(/\s+/)` + `[...tok]` per-word for Cyrillic/Arabic/Latin. Chinese has no whitespace delimiters, so `split` yielded one giant token and `[...tok]` allocated an array of every single character — a GC bomb on 50+ round conversations. Keep it single-pass: one iteration counts char-based scripts per-character AND classifies word-based scripts on whitespace boundaries simultaneously.
- **`applyHistory` — broadcast before `getDialogue`.** The cloud read (Upstash, 1–3 s) ran before the first `broadcast()`, so the gauge stayed frozen until the network round-trip completed — even though the history estimate was already computed. Broadcast the history-only estimate immediately so the panel updates in < 500 ms; read cloud + union-merge asynchronously and re-broadcast only if the merged result differs. The panel listens for `STATE_UPDATE` and re-renders instantly — no refresh needed.
