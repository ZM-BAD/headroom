# AGENTS.md

Project instructions for AI coding agents (Claude Code, Cursor, Copilot, Windsurf, etc.) working in this repository.

> **Single source of truth — edit `AGENTS.md`, not `CLAUDE.md`.** `CLAUDE.md` is a symlink to this file (`AGENTS.md`). This is deliberate: `AGENTS.md` is the cross-agent standard filename (Cursor / Copilot / Windsurf read it), while Claude Code reads `CLAUDE.md` — the symlink serves both from one source. Most editors and tools (including the Edit tool) **reject writing through a symlink** ("Refusing to write through symlink"), so always open and edit `AGENTS.md` directly. Do **not** replace the symlink with a real file, delete it, or duplicate the content into `CLAUDE.md`.

## Project Overview

Headroom is a browser extension built with [WXT](https://wxt.dev/) (next-gen web extension framework). **Manifest V3 only** — Chrome, Edge, and Firefox. MV2 is not supported (`manifestVersion: 3` is set in `wxt.config.ts`, overriding WXT's Firefox-default MV2).

## Commands

```bash
npm run dev            # Dev + HMR → .output/chrome-mv3-dev/ (DIFFERENT dir from build!)
npm run dev:firefox    # Dev mode for Firefox
npm run build          # Production build → .output/chrome-mv3/
npm run build:firefox  # Production build → .output/firefox-mv3/
npm run zip            # Package .zip for distribution
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm run typecheck      # TypeScript type check (tsc --noEmit)
npx wxt prepare        # Regenerate types in .wxt/ (auto-runs on postinstall)
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
- `headroom:settings` → `{ thresholds, language, contextLimits, updatedAt }`. **Credentials are NEVER written here** — you can't read Redis without them, so storing them is both pointless and a leak. Local `Settings` keeps the full object (creds included); the cloud keeps only this stripped shape (`utils/cloud-settings.ts`).

**Client layering — keep it this way:** generic primitives `kvGet` / `kvSet` / `kvDel` (shape-agnostic transport) under one typed wrapper per domain value (`getDialogue`/`setDialogue`/`delDialogue`, `getCloudSettings`/`setCloudSettings`/`delCloudSettings`). A new Redis value type = a new thin wrapper over the kv primitives, **not** a fourth fetch path.

**Credentials stay local.** The extension reads them from local `Settings.upstash`; the debug probe reads `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` from `.env` (gitignored).

**Verify after any change here:** `node scripts/probe-upstash.mjs` — reads `.env`, runs GET/SET/DEL × (conv + settings) against the **live** instance on throwaway `headroom:_probe:*` keys (self-cleans in `finally`), and asserts no credentials leak into the stored settings JSON. Not part of `npm test`.

## Key Files

- `wxt.config.ts` — WXT config + manifest overrides
- `tsconfig.json` — extends `.wxt/tsconfig.json` (generated by `wxt prepare`)
- `eslint.config.js` — ESLint flat config (TS + auto-imports aware)
- `.github/workflows/ci.yml` — GitHub Actions: lint + typecheck + build
- `.husky/pre-commit` — lint-staged (ESLint + Prettier on staged files)
- `.wxt/` — generated types, do not edit manually
- `.output/` — build output, gitignored

## Commit Messages

AI 和人都按这一节写 commit。格式 = **Conventional Commits + 经典 50/72**。文档负责"为什么 + 怎么写";**格式的硬保证靠 commit-msg 钩子的 commitlint 机械校验**(见末尾),不靠 AI 自觉。

### 格式模板

```
<type>(<scope>): <subject>      ← 主题:一行,祈使语气,≤50 字符(硬限 72),无句号
                                 ← 空行(git 靠它区分主题/正文)
<body>                          ← 正文(非平凡才写):每行 ≤72;只写 WHY + 地雷
                                 ← 空行
<footer>                        ← BREAKING CHANGE: / Co-Authored-By:
```

### 主题行

- **祈使语气**:用 `add` / `fix` / `remove`,**不用** `added` / `fixes` / `adding`。自检句:**"If applied, this commit will \_\_\_"** 读得通就对(例:"…will **add** the DEL command" → `feat(upstash): add DEL command`)。
- **长度**:目标 ≤50 字符,绝对 ≤72。(AI 数字符不准没关系,精神 = 一行写完、尽量短;scope 挤就省 scope。)
- 句末**无句号**。
- **type**(必选,小写):`feat`(新功能)/ `fix`(修 bug)/ `docs`(文档)/ `refactor`(重构,不改行为)/ `perf`(性能)/ `test` / `build` / `ci` / `chore`(杂务·脚手架)/ `style`(纯格式)。
- **scope**(可选):受影响模块,如 `upstash` / `sidepanel` / `background`。

### 正文(非平凡改动才写)

- 主题与正文间**一个空行**;每行 ≤72 字符换行。
- **只写两样:WHY(动机、为什么这么改)+ 地雷(非显然的坑、踩过的雷、与旧行为的对比)。**
- **禁止复述 diff** —— diff 已是 WHAT,message 再讲一遍是纯噪音。

### Footer

- 破坏性改动:`BREAKING CHANGE: <说明>`,或主题 type 后加 `!`(如 `feat(api)!: …`)。
- **`Co-Authored-By: Claude <noreply@anthropic.com>` 必加**(凡 AI 参与的 commit)。

### 好 / 坏对照

✅ 好(正文是 WHY + 地雷,无一字复述 diff):

```
fix(background): count round on ROUND_COMPLETE, not on send

The service worker can be evicted between the send request and the
AI reply finishing; counting on send mis-counts when the SW restarts
mid-round. Move the increment to ROUND_COMPLETE so it survives
eviction.

Co-Authored-By: Claude <noreply@anthropic.com>
```

❌ 坏(过去式 + 复述 WHAT + 零 WHY + 无 type/scope/署名):

```
fix: fixed the bug

This change updates the code to fix the round counting issue by
changing where we increment the counter. Now it works correctly.
```

### squash 策略

开发期 churn(我刚引入的 bug、格式化、删冗余、lint)→ squash 进功能 commit。但**地雷的教训必须活下来**:留这个 commit,或把教训搬进代码注释 / 本文件 playbook。

### 格式硬保证(已装)

`commitlint.config.js`(`@commitlint/config-conventional` + header/body ≤72)在两处机械校验,主题不合规范直接拒:

- 本地:`.husky/commit-msg` 钩子(commit 时校验;`--no-verify` 可绕过)。
- CI:`ci.yml` 的 "Lint commit messages" 步骤(PR 校验 base→HEAD,push 校验 HEAD)。

注:这会在**每个** commit(含开发期中间提交)上强制 Conventional 格式 —— 与你的 squash 习惯兼容(中间提交也写成 `fix: x`,squash 时合并即可;AI 写这类消息近乎零成本)。

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

## Adding New Entrypoints

After creating a new entrypoint file, run `npx wxt prepare` to update generated types before TypeScript will resolve the auto-imports.

## Development & Debugging Playbook

Lessons learned building Headroom. Stack-specific (WXT + MV3 extension), not generic advice. Read before starting a change.

### The loop (agreed)

| Who   | Action                                                                              |
| ----- | ----------------------------------------------------------------------------------- |
| AI    | edit → `npm run typecheck` → `npm run lint` → `npm run build` → say "ready"         |
| Human | `chrome://extensions` → 🔄 reload the Headroom card → test in browser → report back |

- **The AI does not host `npm run dev` in the background.** WXT dev reads stdin for keyboard commands; in this sandbox there's no tty → stdin EOF → the process exits (code 0) within a turn. Tried twice, unreliable. Default to `build` + manual reload. The _human_ may run `npm run dev` in their own terminal for HMR + load `.output/chrome-mv3-dev/`.
- **The AI does not auto-launch or remote-control Chrome.** `--load-extension` + CDP is flaky here (macOS routes to an existing instance; the service-worker target spins down; the toolbar click can't be simulated). The human loads and tests in their own browser.

### Do

- After **every** code change, run `npm run build` before saying "ready" — the human reloads whatever dir they loaded.
- **`dev` and `build` output to different dirs** (`chrome-mv3-dev` vs `chrome-mv3`). If the human loaded `-mv3` (or `-dev`), rebuild **that** dir or they run stale code. A missed rebuild was a real bug.
- Run `npm run typecheck` and `npm run lint` every change. **`wxt build` transpiles with esbuild and does NOT type-check** — a green build ≠ correct types.
- Verify config field names against installed WXT types rather than guessing (it's `webExt`, not `webExtConfig`).
- After adding a new entrypoint, run `npx wxt prepare`.
- Keep the spec the current source of truth: edit it in place when requirements change. Don't append "Implementation Notes" — fold only code/git-irrecoverable bits (decisions, landmines) into the relevant section or a code comment (see Spec-Driven Development → Rules).

### Don't

- Don't Remove + re-Load-unpacked after a rebuild — just 🔄 reload. The unpacked extension ID is path-derived and stable.
- Don't add explicit imports for WXT auto-imports (`browser`, `defineBackground`, `defineContentScript`, `defineConfig`). "Cannot find name" before `wxt prepare` is expected — prepare fixes it.
- Don't claim a feature works without evidence. State exactly what you verified (typecheck/lint/build/grep) vs. what's pending the human's runtime test.
- Don't hand the human manual shell work the build can do, and don't spawn `npm run dev` expecting it to stay alive.

### Verify / don't verify

- **Verify every change:** `typecheck`, `lint`, `build` succeeds, and the built manifest carries the expected keys/permissions.
- **Confirm code landed in the output by grepping build artifacts.** Grep **string literals** (IDs, query selectors, permission names like `view-settings`, `sidePanel`) — they survive minification. Do **not** grep function/variable names — esbuild mangles them (`showView` won't appear), giving false negatives.
- **Don't** try to verify runtime UI by auto-driving Chrome. Defer it to the human.

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
- **Reading a request body: don't patch `window.fetch` in a MAIN-world content script — use `webRequest`.** Real sites' bundles / analytics SDKs (e.g. DeepSeek's ByteDance Rangers) re-wrap `window.fetch` after your `document_start` script, clobbering your override before the request you care about fires — your wrapper is installed but silently never sees the request (confirmed via DevTools: `[Headroom-MAIN] interceptor installed` logged, but no interception log on send). `webRequest.onBeforeRequest` with `["requestBody"]` observes at the network layer regardless of fetch/XHR/worker or who re-wrapped fetch; needs the `webRequest` permission + a `host_permissions` entry (which may gray the unpacked card pending re-grant).

## Long-Running Task Discipline

When a task may run multi-hour, the conversation _will_ compact and the session may die or hit a rate limit. Follow this so work survives across compactions and restarts. This section is **behavioral** — it's what CLAUDE.md/AGENTS.md can control. The auto-compact threshold, rate-limit retry, and timeouts are runtime/env config (settings.json + env vars), **not** things this file can change; don't try to "fix" them by editing here.

### Persist state out of the conversation

- **The conversation is volatile.** Auto-compact summarizes it away; a crash loses it. Anything needed to recover — current step, decisions made, what's tried-and-failed, next action — must live **on disk** (the spec, a TODO file, commit messages), not just in chat.
- **TodoWrite is the in-session mirror of this** and survives compaction better than prose. Keep it current.
- **Before a risky or hard-to-reverse operation, checkpoint first** — commit or stage so `/rewind` + git can roll it back.

### Keep the main context lean

- **Dispatch exploration to subagents** (Task/Agent). Subagents return only a summary to the main context, so the main thread stays small → fewer compactions AND lower tokens/min (less chance of a 429). Pull a whole file into the main context only when you'll keep editing it.
- **At a natural breakpoint, run `/compact <what to preserve>` proactively** rather than waiting for the auto trigger near ~95% (which loses detail). If auto-compact keeps firing mid-step, that's the signal you're holding too much in context.

### Survive a crash / rate limit

- **Rate limits (429): there is no reliable built-in "wait and retry."** Reduce concurrency, keep the context lean, and if the session errors out, resume with `claude --continue` (most recent) or `claude --resume` (pick a session) — both restore context.
- **Resuming is only useful if state is on disk** (see above). A resume into a context with no persisted progress restarts blind.
