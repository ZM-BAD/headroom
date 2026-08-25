# Headroom

> Know when your AI is about to forget.

**English** | [简体中文](./README_zh.md)

<p align="center">
  <a href="https://chromewebstore.google.com/detail/headroom/ededcdndmfhljdjppngbhgmaoogcihjc"><img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome.svg" width="48" alt="Chrome"></a>
  <a href="https://chromewebstore.google.com/detail/headroom/ededcdndmfhljdjppngbhgmaoogcihjc"><img src="https://img.shields.io/chrome-web-store/v/ededcdndmfhljdjppngbhgmaoogcihjc?label=%20&style=flat-square" alt="Chrome Web Store"></a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://microsoftedge.microsoft.com/addons/detail/headroom/hlnpmnlemmiohohhobkbdljomdmhhcnl"><img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge.svg" width="48" alt="Edge"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/headroom/hlnpmnlemmiohohhobkbdljomdmhhcnl"><img src="https://img.shields.io/badge/%20-v0.1.0-ea7233?style=flat-square" alt="Edge Add-ons"></a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://addons.mozilla.org/firefox/addon/headroom/"><img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/firefox/firefox.svg" width="48" alt="Firefox"></a>
  <a href="https://addons.mozilla.org/firefox/addon/headroom/"><img src="https://img.shields.io/amo/v/headroom?label=%20&style=flat-square" alt="Firefox Add-ons"></a>
</p>

**Headroom** is a browser extension that gives you a real-time, visual gauge of your context window usage in AI chat conversations — so you know before the AI starts forgetting.

![Headroom](show.webp)

## Features

- **Zero setup** — No account, no API key, no configuration. Install and it just works.
- **Real-time gauge** — Watch your context window fill up as you chat. 🟢 Green (plenty of room) · 🟠 Yellow (filling up) · 🔴 Red (time for a new conversation).
- **Per-round breakdown** — See estimated token counts for every Q&A pair — prompt and answer separately, plus web-search and tool-call tokens in a dedicated Search/Tool column.
- **Privacy by design** — Conversation text is read transiently to count tokens, then discarded. Only the token counts are stored, locally and optionally in your own cloud storage. No Headroom server exists.

**Supported Platforms & Default Context:** **DeepSeek (1M), ChatGPT (27K), Gemini (1M), Kimi (1M), Qwen (1M), 通义千问 (1M), 豆包/Doubao (256K).**

Context limits are auto-detected per platform and user-overridable. All seven platforms' request parsing and DOM selectors were captured live (2026-08). Built with a platform-agnostic adapter architecture — adding a new AI chat platform is a matter of writing one adapter.

## Why Headroom

When you're deep in a long conversation with an AI, you've probably experienced this: constraints you set 10 rounds ago get forgotten, earlier decisions get contradicted, and output quality degrades silently. **Context windows have limits** — when they fill up, the AI quietly drops earlier information. None of the major AI chat platforms show you how much room you have left.

**Who is this for?** Professionals who use AI chat as part of their daily workflow — developers, researchers, writers, analysts. If your conversations regularly exceed 20+ rounds for architecture discussions, code reviews, research deep-dives, or technical writing, Headroom helps you maintain conversation quality.

> **Not a token cost calculator.** AI models are getting cheaper by the month — the concern is **context quality**: making sure your AI hasn't silently forgotten something critical.

## Requirements

> Install from the [store badges at the top ↑](#headroom) — each badge links directly to that browser's extension store.

Headroom is **Manifest V3 only** (MV2 is not supported) and requires a recent browser version: **Google Chrome ≥ 149, Microsoft Edge ≥ 149, Firefox ≥ 151.**

**Known Platform Differences**

| Behavior                                      | Chrome | Edge                     | Firefox                            |
| --------------------------------------------- | ------ | ------------------------ | ---------------------------------- |
| Icon grays on non-AI pages                    | ✅     | ✅                       | ✅                                 |
| Panel auto-closes when leaving AI page        | ✅     | ✅                       | ❌ (content switches to hint page) |
| Panel auto-restores when returning to AI page | ✅     | ❌ (manual click needed) | ✅ (content restores)              |

**Edge limitation:** `sidePanel.setOptions({ enabled: true })` does not auto-restore the panel after switching back to an AI platform tab. Microsoft confirmed this is "by design" ([issue #222](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/222), open since Nov 2024, no fix). Workaround: click the toolbar icon to reopen.

**Firefox limitation:** `sidebarAction.close()` requires a user gesture and cannot be called on tab switch (Firefox platform limit). The sidebar must be manually closed by the user. When switching to a non-AI page, the sidebar content switches to a hint page via `sidebarAction.setPanel()`.

## Optional: Upstash Sync

Headroom is fully functional with zero cloud setup. For most users, most of the time, that's everything.

Optionally, you can connect your own [Upstash](https://upstash.com/) Redis KV — create a free account, provision a KV instance, and paste the REST credentials into the extension settings (BYOK: the data lives in your own private storage, and the credentials never leave your browser). What connecting adds:

- **Settings sync across devices** — thresholds, language, per-platform context limits, and token-coefficient overrides follow you.
- **Count continuity** — when a platform's history API can't return the full history (pagination caps, interrupted fetches), the cloud record preserves previously counted rounds so your cumulative total never silently shrinks.

Upstash's free tier ([pricing](https://upstash.com/pricing/redis/)) includes 256 MB storage and 500,000 commands/month — far beyond what a single user generates. Headroom stores only token counts per round (no conversation text), so storage is a non-issue (~4 KB per 50-round conversation).

## Tech Stack

- **[WXT](https://wxt.dev/)** — Next-gen web extension framework (Manifest V3)
- **Native Side Panel API** — Browser-native sidebar (Chrome `sidePanel`, Firefox `sidebarAction`)
- **Heuristic token estimation** — 6-way per-script coefficient engine (CJK, Kana, Hangul, Cyrillic, Arabic, Latin); character-based for CJK/kana/Hangul, word-based for the rest. No heavy tokenizer bundled (keeps the extension light and model-agnostic)
- **Upstash Redis KV** — Optional user-owned cloud storage (BYOK model)

## Contributing & Development

We welcome bug reports, feature requests, and code contributions!

- **Found a bug?** → [Report an issue](https://github.com/ZM-BAD/headroom/issues/new/choose)
- **Want to contribute?** → Read our [Contributing Guide](./CONTRIBUTING.md)
- **Testing help needed?** → See [open issues](https://github.com/ZM-BAD/headroom/issues) labeled `needs-test`

**Development**

```bash
npm install
npm run dev            # Dev mode with HMR (Chrome default)
npm run dev:firefox    # Dev mode for Firefox
npm run build          # Production build
```

See [AGENTS.md](./AGENTS.md) for full development guidelines and architecture details.

## Privacy

Headroom reads your conversation text only to count tokens — it stores **only
the counts**, never the text itself, locally and in **your own** Upstash KV (if
configured). There is no Headroom-operated server and no third-party tracking.
Full details: [PRIVACY.md](./PRIVACY.md).

## License

Copyright 2026 ZM-BAD.

Licensed under the **Apache License, Version 2.0** — see [LICENSE](./LICENSE).
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS.
