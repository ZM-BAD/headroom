---
name: browser-extension-developer
description: Use this skill when developing or maintaining browser extension code in the WXT project, including Chrome/Firefox/Edge compatibility, content scripts, background scripts, popup, options, side panel, or i18n updates.
---

# Browser Extension Developer

Cross-browser extension (Chrome/Firefox/Edge) using **WXT framework** with Manifest V3.

## Project Structure

```plaintext
headroom/
├── entrypoints/       # popup/, background.ts, content scripts
├── public/            # Static assets (icons, _locales for i18n)
├── assets/            # Bundled assets
├── components/        # Shared UI components
├── composables/       # Composable functions
├── hooks/             # Custom hooks
├── utils/             # Utility functions
├── wxt.config.ts      # WXT configuration
├── tsconfig.json      # TypeScript config
└── package.json       # Dependencies & scripts
```

## Commands

- `npm run dev` - Development mode (Chrome default, HMR enabled)
- `npm run dev:firefox` - Firefox dev mode
- `npm run build` - Production build (chrome-mv3)
- `npm run build:firefox` - Firefox production build
- `npm run zip` - Package for distribution

## Key Concepts

### Entrypoints (File-based Routing)

- `entrypoints/popup/index.html` + `entrypoints/popup/main.ts` → Popup UI
- `entrypoints/background.ts` → Service worker (MV3)
- `entrypoints/<name>.ts` with `export default defineContentScript(...)` → Content script
- `entrypoints/<name>/index.html` → Side panel, options, newtab, etc.

### WXT Auto-imports

- `defineBackground`, `defineContentScript`, `defineConfig` etc. are auto-imported
- `browser` (from WXT) replaces `chrome` for cross-browser compat
- Types generated in `.wxt/` via `wxt prepare`

### Manifest

- Configured in `wxt.config.ts` via `manifest` field
- WXT auto-generates `manifest.json` during build

### i18n

- Locale files in `public/_locales/<lang>/messages.json`
- Access via `browser.i18n.getMessage("key")`

## Development Guidelines

- Use TypeScript for all entrypoints and utilities
- Follow WXT file-based routing conventions for entrypoints
- Use `browser.*` APIs instead of `chrome.*` for cross-browser compatibility
- Run `wxt prepare` after adding new entrypoints to update types
- Content scripts: always specify `matches` in `defineContentScript` options
- Background script: `main()` cannot be async in `defineBackground`
- Popup/HTML entrypoints: use directory structure (`<name>/index.html` + `<name>/main.ts`)
