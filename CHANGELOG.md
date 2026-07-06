# Changelog

All notable changes to Headroom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Context window usage gauge with three-level color warning (green/yellow/red)
- Token estimation engine with per-script coefficients (CJK + Latin)
- Platform-agnostic adapter architecture — 7 AI chat platforms supported (DeepSeek, ChatGPT, Gemini, Kimi, Qwen, 通义千问, 豆包)
- Native browser side panel UI with round-by-round token breakdown
- Customizable warning thresholds (dual range slider)
- Per-platform context window limit override
- BYOK Upstash Redis cloud storage for cross-device sync
- Cross-device reconciliation engine (open-and-sync, union merge by messageId)
- Zombie conversation cleanup (periodic alarms + home-page trigger)
- Local multi-conversation cache with LRU eviction
- Delete linkage — platform-side deletion syncs to local + cloud
- 8 UI languages (en, zh_CN, ja, ko, ru, es, pt_BR, fr, de, id)
- Reconciliation frequency control — debounce on rapid SPA conversation switches
