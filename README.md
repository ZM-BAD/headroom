# Headroom

> Know when your AI is about to forget.

**English** | [简体中文](./README_zh.md)

**Headroom** is a browser extension that shows you how much context window you have left in AI chat conversations — before your AI silently starts losing important details.

## The Problem

When you're deep in a long conversation with an AI (DeepSeek, Gemini, Claude, ChatGPT...), you've probably experienced this:

- The AI forgets a constraint you mentioned 10 rounds ago
- It starts contradicting earlier parts of the conversation
- Output quality degrades silently, and you don't know why

This happens because **context windows have limits**, and when they fill up, the AI quietly drops earlier information. None of the major AI chat platforms show you how much context room you have left. It's a silent killer.

## The Solution

Headroom sits in your browser's native side panel and gives you a real-time, visual indicator of your context window usage:

- 🟢 **Green** — Plenty of room, keep chatting
- 🟠 **Orange** — Starting to fill up, be mindful
- 🔴 **Red** — Almost full, consider starting a new conversation

Thresholds are customizable, and the extension auto-detects which model you're using to calculate the correct context window limit.

## Who Is This For

**Professionals who use AI chat as part of their daily workflow** — developers, researchers, writers, analysts.

If you spend significant time in AI chat interfaces for architecture discussions, code reviews, research deep-dives, or technical writing, Headroom helps you maintain conversation quality by knowing exactly when context is running out.

This is **not** a token cost calculator. AI models are getting cheaper by the month — cost is not the concern. The concern is **context quality**: making sure your AI hasn't silently forgotten something critical.

## How It Works

1. **Install the extension** in Chrome, Edge, or Firefox
2. **Bring your own Upstash KV** — create a free [Upstash](https://upstash.com/) account, provision a Redis KV instance, and paste your API key into the extension settings. Your data stays in your own private storage.
3. **Open the side panel** on any supported AI chat platform — Headroom automatically tracks your conversation's token usage
4. **Watch the indicator** — as your conversation grows, Headroom shows you how much context room remains

## Browser Support

Headroom is **Manifest V3 only** (MV2 is not supported) and requires a recent browser version:

| Browser        | Minimum Version |
| -------------- | --------------- |
| Google Chrome  | ≥ 149           |
| Microsoft Edge | ≥ 149           |
| Firefox        | ≥ 151           |

## Supported Platforms

| Platform         | Status                 |
| ---------------- | ---------------------- |
| DeepSeek         | 🚧 In Development (v1) |
| More coming soon | —                      |

Built with a platform-agnostic architecture — adding new AI chat platforms is a matter of writing a new content adapter.

## Tech Stack

- **[WXT](https://wxt.dev/)** — Next-gen web extension framework (Manifest V3)
- **Native Side Panel API** — Browser-native sidebar (Chrome `sidePanel`, Firefox `sidebarAction`)
- **js-tiktoken** — Client-side token calculation
- **Upstash Redis KV** — User-owned cloud storage (BYOK model)

## Development

```bash
npm install
npm run dev            # Dev mode with HMR (Chrome default)
npm run dev:firefox    # Dev mode for Firefox
npm run build          # Production build
```

See [AGENTS.md](./AGENTS.md) for full development guidelines and architecture details.

## License

MIT
