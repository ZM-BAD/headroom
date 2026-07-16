# Contributing to Headroom

Thank you for your interest in Headroom! Contributions of all kinds are welcome.

## Reporting Bugs

There are two ways to report issues:

- **GitHub Issues**: [Create a new issue](https://github.com/ZM-BAD/headroom/issues/new/choose)
- **Discord / Email**: if sensitive information is involved, please contact me privately

### Before Submitting an Issue

- [ ] Reloaded the extension card (`chrome://extensions` → 🔄)
- [ ] Refreshed the target platform page (F5)
- [ ] Checked for duplicate issues

### Helpful Information

Please provide as much of the following as possible to help us diagnose quickly:

- Platform name (DeepSeek / ChatGPT / Gemini / Kimi / Qwen / Tongyi Qianwen / Doubao)
- Browser and version (Chrome / Edge / Firefox + version number)
- Extension version (visible in `chrome://extensions`)
- Steps to reproduce
- Expected vs. actual behavior
- Console logs (F12 → Console, filter by `[Headroom]`)
- Screenshots (if helpful)

## Testing Matrix

Headroom covers multiple platform × browser combinations. Core functionality is tested by the maintainer before each release; **community testing helps us cover more edge cases**.

The following are the test categories where we especially need community feedback:

### Cross-Platform Smoke Testing

If you have time, you can help verify basic functionality on the following platforms:

- Toolbar icon is not grayed out on that platform
- Opening the conversation loads the panel
- dialogueId displays correctly
- Deletion interception works (if configured)
- Opening an existing conversation shows cumulative token count + round count
- Conversation title displays correctly

### Token Estimation Verification

- CJK characters: tokens ≈ characters × 0.6 tok/ch
- Kana / Hangul: characters × their respective coefficient
- English / Latin: tokens ≈ words × 0.5 tok/wd
- Mixed Chinese + English: CJK counted per character, English per word, no double-counting

### Round Lifecycle

- New round added: round count +1, cumulative increases
- Regenerate: round count unchanged, that round's token count updated
- Stop generation: not counted as a completed round
- SPA conversation switch: panel shows new conversation data

### History Loading

After opening a longer conversation (5+ rounds), verify:

- Panel round count = actual number of Q&A pairs
- Cumulative token count is in a reasonable range

## Code Contributions

### Setting Up the Development Environment

```bash
# Clone the repository
git clone https://github.com/ZM-BAD/headroom.git
cd headroom

# Install dependencies
npm install

# Prepare WXT types
npx wxt prepare

# Development build (outputs to .output/chrome-mv3-dev/)
npm run dev

# Production build (outputs to .output/chrome-mv3/)
npm run build
```

### Code Quality Checks

**Required after every change (in order):**

```bash
npm run typecheck   # TypeScript type check (tsc --noEmit)
npm run lint        # ESLint check
npm run test:run    # Vitest unit tests (utils + adapters)
npm run build       # Production build (wxt build does NOT typecheck!)
```

> **`npm run build` uses esbuild for transpilation and does NOT type-check** — a green build ≠ type-correct. Run `typecheck` first.

### Testing

**Unit tests** cover `utils/` (pure logic) and `adapters/` (parse functions):

```bash
npm run test:run        # Run all once
npm run test            # Watch mode (for development)
npx vitest --coverage   # Coverage report (requires @vitest/coverage-v8)
```

Unit tests run in a node environment (no browser API); `browser.*` calls must be mocked.

**Entrypoints (background / content script / side panel) are currently not unit-tested** — they depend heavily on `browser.*` APIs (tabs, webRequest, storage, runtime…), where mocking cost is high and return is low. These are covered by the **live acceptance checklist** (see `specs/acceptance-checklist.md`) and a future Playwright E2E suite.

### Code Style

- Use TypeScript strict mode
- Follow [Conventional Commits](https://www.conventionalcommits.org/) format (`commitlint` enforces this in the commit-msg hook)
- Keep files under ~200 lines where possible
- Update related tests alongside code changes
- Architecture decisions are recorded in `specs/` — read the relevant spec before changing design

### Project Structure

```
headroom/
├── entrypoints/             # WXT entrypoints
│   ├── background.ts        # Background service worker (engine core)
│   ├── platform.content.ts  # Content script (shared, injected on all platforms)
│   └── sidepanel/           # Side panel UI (main view + settings)
├── adapters/                # Per-platform adapters (new platform = add one file)
│   ├── index.ts             # Adapter registry
│   ├── deepseek.ts          # DeepSeek reference implementation
│   └── __tests__/           # Adapter parse tests
├── utils/                   # Utility functions (pure logic, unit-tested)
│   ├── estimate.ts          # Six-way script token estimation engine (spec 004)
│   ├── dialogue-record.ts   # Dialogue record data structure + union merge
│   ├── upstash.ts           # Upstash REST client
│   ├── local-cache.ts       # Local cache with LRU eviction
│   ├── platform-adapter.ts  # Adapter interface definition
│   ├── messages.ts          # Message protocol types
│   ├── settings.ts          # Settings read/write
│   ├── cloud-settings.ts    # Cloud settings (credential-stripped)
│   ├── thresholds.ts        # Warning threshold logic
│   └── match-host.ts        # URL → platform matching
├── brand/                   # Headroom brand logo source files (SVG)
│   ├── blue.svg             # Main logo (colored gauge icon)
│   ├── gray.svg             # Gray variant (disabled toolbar icon)
│   └── white.svg            # Light-background fallback
├── icon/                    # AI platform brand logos (SVG, used by sidePanel UI)
│   ├── deepseek.svg
│   ├── doubao.svg
│   ├── gemini.svg
│   ├── kimi.svg
│   ├── openai.svg           # ChatGPT
│   ├── qianwen.svg          # Tongyi Qianwen
│   └── qwen.svg
├── public/                  # Static assets
│   ├── _locales/            # i18n translations (en + zh_CN complete, others fall back to en)
│   └── icon/                # Extension toolbar icon PNGs (rendered from brand/)
├── specs/                   # Design specs + acceptance checklist
│   ├── 001-headroom-core.md
│   ├── 002-upstash-data-layer.md
│   ├── 003-cross-device-sync.md
│   ├── 004-optimizations.md
│   ├── ROADMAP.md
│   └── acceptance-checklist.md
├── scripts/
│   └── probe-upstash.mjs    # Upstash connectivity probe (not part of npm test)
├── public/                  # Static assets (icons, _locales translations)
└── wxt.config.ts            # WXT configuration
```

### Pull Request Workflow

1. Fork the repository
2. Create a feature branch (`feature/xxx` or `fix/xxx`)
3. Develop + run `typecheck && lint && test:run && build`
4. Update relevant specs (when design changes)
5. Submit a PR (link related Issues)

## Design Decisions

If you have architecture suggestions, please open an Issue to discuss before writing code.

Key principles:

- **Tokens are always estimated by us** — never trust platform-reported token counts
- **Conversation text is never stored** in the cloud — only counts
- **Share code wherever possible** — everything except per-platform `fetchHistory` is shared

## Other Ways to Contribute

- 📖 Improve documentation
- 🌐 Translate UI strings
- 🎨 Design icons, logos
- 📣 Spread the word about Headroom

Thank you for contributing!
