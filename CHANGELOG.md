# Changelog

All notable changes to Headroom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-20

### Added

- Context window usage gauge with three-level color warning (green/yellow/red)
- Token estimation engine — 6-way per-script coefficients (CJK, Kana, Hangul, Cyrillic, Arabic, Latin)
- Platform-agnostic adapter architecture — 7 AI chat platforms supported (DeepSeek, ChatGPT, Gemini, Kimi, Qwen, 通义千问, 豆包)
- Platform brand logos in settings UI (context limits + advanced settings) with default icon fallback
- Per-platform token coefficient overrides (user-tunable in Advanced Settings)
- Platform Reference section in settings — model name, context size, tokenizer per platform
- How token estimation works guide (char-based vs word-based counting)
- About section in settings — version, copyright, tech stack, contribution link
- Native browser side panel UI with round-by-round token breakdown
- Customizable warning thresholds (dual range slider)
- Per-platform context window limit override
- BYOK Upstash Redis cloud storage for cross-device sync
- Cross-device reconciliation engine (open-and-sync, union merge by messageId)
- Zombie conversation cleanup (periodic alarms + home-page trigger, with throttle guard)
- Local multi-conversation cache with LRU eviction
- Zombie cleanup throttle unit tests (shouldRunCleanup / cleanupStateAfterRun)
- Delete linkage — platform-side deletion syncs to local + cloud
- 10 UI languages (en, zh_CN full; ja, ko, ru, es, pt_BR, fr, de, id fall back to en for new keys)
- Reconciliation frequency control — debounce on rapid SPA conversation switches
- Tool & web-search token tracking — per-round Search/Tool column; search-result and tool-invocation text counted into round totals (Kimi, Qwen, 通义千问, Doubao from history API; ChatGPT invocation text; Gemini source site names)

### Changed

- TypeScript 5.9 → 6.0; aligned ESLint/Prettier/commitlint ecosystem
- Extension icons regenerated from brand/blue.svg (PNG 16/48/96/128)
- Context window defaults display as 1M/256K/128K (human-readable)
- Platform Reference refreshed to current default models (GPT-5.6 Luna/Sol, Gemini 3.6 Flash, Kimi K3, Qwen 3.8 Max, Doubao Seed 2.1); Kimi context limit 256K → 1M (K3 default); ChatGPT default → 27K (web free-tier per-plan cap, with in-settings note)

### Fixed

- i18n fallback — manually-selected non-en/zh_CN languages now correctly fall back to English instead of the browser's locale
- Kimi logo K-fill changed from white to black for legibility on light backgrounds
- ChatGPT Search/Tool column double-counted the prompt — the search invocation embeds the full prompt (`search("…")`), inflating tool tokens to match Input; queries duplicating the prompt are now deduped, and literal `\uXXXX` escapes in code nodes are decoded (live shape 2026-08-21)
- Round-table legend explains the Search/Tool "-" semantics — no extra search/tool content this round (DeepSeek/ChatGPT search content never persists into later rounds); all 10 locales, footnote-sized, bold dash
