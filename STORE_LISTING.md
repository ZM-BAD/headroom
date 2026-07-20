# Store Listing Checklist

> A working checklist for publishing Headroom to the three target stores.
> Items marked ⏳ are **blocked on runtime acceptance** (001 Gate 1) — don't
> draft them until the gauge is verified working end-to-end, or you'll rewrite.

## Common to all three stores

### Required before any submission

- [x] **Privacy Policy** — [`PRIVACY.md`](./PRIVACY.md). Public URL = the GitHub
      `main`-branch raw/blob URL of that file. Each store asks for one URL field.
- [x] **License** — Apache-2.0 ([`LICENSE`](./LICENSE)).
- [x] **Source build clean** — `npm run typecheck && npm run lint && npm run build`
      green (the AGENTS.md "loop").
- [x] **Runtime acceptance passed** — at minimum spec 001 Gate 1 (DeepSeek
      end-to-end). The listing copy and screenshots must reflect what the gauge
      actually does, not what it's planned to do.

### Listing copy (one set, localized)

Gate 1 passed — copy describes verified behavior.

- [x] **Category** — Productivity.
- [x] **Keywords** (where the store supports them): `AI`, `chatbot`,
      `context-window`, `token`, `ChatGPT`, `DeepSeek`, `productivity`.
- [x] **Short description** (≤132 chars):

  **EN** (108 chars):

  > Real-time context-window gauge for AI chat — see how much room you have
  > left before the AI starts forgetting.

  **ZH** (49 chars):

  > AI 聊天上下文用量实时监测 — 看清 context window 还剩多少，避免 AI 悄悄遗忘。

- [x] **Long description** (~400 words EN, matching ZH):

  **EN:**

  > **AI chats have a hidden limitation — and none of the major platforms tell
  > you about it.**
  >
  > When you're deep in a long conversation, AI models don't have unlimited
  > memory. Each model has a fixed "context window" — the amount of text it can
  > see at once. When that window fills up, the AI silently drops earlier parts
  > of your conversation. No warning. No indicator. You just notice the quality
  > degrading: constraints you set 10 rounds ago are forgotten, earlier decisions
  > are contradicted, and you have no idea why.
  >
  > **Headroom fixes this.**
  >
  > Headroom sits in your browser's native side panel and gives you a real-time,
  > color-coded gauge of your context window usage. Green means you have plenty
  > of room. Yellow means you're filling up — be mindful. Red means you're near
  > the limit — time to start a fresh conversation.
  >
  > **Works across 7 AI platforms — no setup required.**
  >
  > Headroom automatically detects which AI platform you're on and uses the
  > correct context window limit for that platform. It supports DeepSeek,
  > ChatGPT, Gemini, Kimi, Qwen, Tongyi Qianwen, and Doubao. No account, no API
  > key, no configuration — install and it just works.
  >
  > **What you get:**
  >
  > - **Real-time gauge** — Color-coded green / yellow / red thresholds show you
  >   exactly when to start a new conversation. Customizable per platform.
  > - **Per-round breakdown** — Estimated input and output token counts for every
  >   Q&A pair in the conversation.
  > - **Per-platform context limits** — Each platform's default context window is
  >   built-in and user-overridable.
  > - **Optional cloud sync** — Connect your own Upstash Redis instance (free
  >   tier is more than enough) to sync settings and counts across devices.
  >   Fully optional — the gauge works entirely offline.
  > - **Privacy by design** — Conversation text is read transiently to estimate
  >   tokens, then immediately discarded. Only token counts are stored. Headroom
  >   has no server, no analytics, no tracking.
  >
  > **Who this is for:**
  >
  > Professionals who use AI chat daily — developers doing architecture
  > discussions, researchers doing deep-dives, writers working on long-form
  > content, analysts processing complex data. If your conversations regularly
  > exceed 20+ rounds, Headroom prevents the silent context-quality degradation
  > that otherwise goes unnoticed.
  >
  > **Not a token cost calculator.**
  >
  > AI models are getting cheaper by the month — cost isn't the concern. The
  > concern is that your AI has silently forgotten something critical, and you
  > don't know it. Headroom makes the invisible visible.

  **ZH:**

  > **AI 聊天有一个隐藏的限制——所有主流平台都不会主动告诉你。**
  >
  > 当你沉浸在长时间的 AI 对话中，模型其实并没有无限的记忆能力。每个模型
  > 都有一个固定的"上下文窗口"（context window）——即它能同时"看到"的文本
  > 总量。当窗口被填满，AI 会悄悄丢弃对话早期的信息。没有警告，没有提示。你
  > 只会发现输出质量悄悄下降：10 轮之前设定的约束被遗忘、早前的决策被推翻、
  > 而你完全不知道为什么。
  >
  > **Headroom 解决了这个问题。**
  >
  > Headroom 驻留在浏览器的原生侧边栏中，通过一个颜色编码的实时仪表盘，直观
  > 展示你的上下文窗口用量。绿色表示空间充裕。黄色表示接近上限——需要留意。
  > 红色表示几乎耗尽——是时候开启一段新对话了。
  >
  > **覆盖 7 大 AI 平台——零配置开箱即用。**
  >
  > Headroom 自动识别你所在的 AI 平台，匹配对应的上下文窗口上限。支持
  > DeepSeek、ChatGPT、Gemini、Kimi、Qwen、通义千问、豆包（Doubao）。无需
  > 注册、无需 API Key、无需任何设置——安装即用。
  >
  > **主要功能：**
  >
  > - **实时仪表盘** — 绿/黄/红三色阈值直观展示，可按平台自定义。
  > - **逐轮明细** — 每一轮问答的输入和输出 token 估算量分别展示。
  > - **平台感知** — 内置各平台默认上下文窗口上限，支持用户按平台覆盖。
  > - **可选云同步** — 接入你自己的 Upstash Redis 实例（免费层绰绰有余），
  >   跨设备同步设置和计数。完全可选——仪表盘纯离线也能正常工作。
  > - **隐私优先** — 对话文本仅瞬时读取用于 token 估算，立即丢弃。只存储
  >   token 计数。Headroom 没有自建服务器，不收集分析数据，不追踪用户。
  >
  > **面向谁：**
  >
  > 日常高频使用 AI 聊天的专业人士——做架构讨论的开发者、做深度调研的研究者、
  > 撰写长文内容的作者、处理复杂数据的分析师。如果你的对话经常超过 20+ 轮，
  > Headroom 能帮你避免上下文质量悄悄下降而不自知。
  >
  > **不是 token 计费工具。**
  >
  > AI 模型越来越便宜——费用不是核心问题。核心问题是：你的 AI 是否已经悄悄
  > 忘掉了关键信息，而你完全不知道。Headroom 让不可见的变得可见。

### Screenshots / store graphics

Most recent requirements (researched 2025-07-20). All three stores accept 1280×800
or 640×400 PNG.

#### Extension icon

- [x] **128×128 PNG** — already in `public/icon/`.
- [x] **Firefox marketing icon — 512×512 PNG** → `store-assets/amo-marketing-512.png`.

#### Screenshots (required — 1280×800 or 640×400, PNG)

| #   | Content                                               | Chrome | Edge | Firefox |
| --- | ----------------------------------------------------- | :----: | :--: | :-----: |
| 1   | Gauge green — safe state + multi-round conversation   |   ✅   |  ✅  |   ✅    |
| 2   | Gauge yellow — approaching threshold                  |   ✅   |  ✅  |   ✅    |
| 3   | Gauge red — tight, near context limit                 |   ✅   |  ✅  |   ✅    |
| 4   | Settings — thresholds + platform context limits       |   ✅   |  ✅  |   ✅    |
| 5   | Settings — Upstash sync section                       |   ✅   |  ✅  |   ✅    |
| 6   | Multi-platform support (switched to another platform) |   —    |  ✅  |   ✅    |

- Chrome: max 5 screenshots → use #1–5.
- Edge: max 6 → add #6.
- Firefox: max 15 → use the full set.
- Use a throwaway conversation, not real user data.

#### README screenshots (not for store submission)

- [x] **EN README** — animated demo → `show.webp` (inline in README).
- [x] **ZH README** — animated demo → `show_zh.webp` (inline in README_zh).

#### Promotional tiles (optional but recommended)

| Asset            | Size         | Chrome | Edge | Firefox |
| ---------------- | ------------ | :----: | :--: | :-----: |
| Small promo tile | 440×280 PNG  |   ⬜   |  ⬜  |   ⬜    |
| Marquee tile     | 1400×560 PNG |   ⬜   |  ⬜  |    —    |
| Small tile       | 280×90 PNG   |   —    |  —   |   ⬜    |

> ⚠️ Chrome's old 920×680 "Large Promo Tile" is **deprecated** and no longer
> displayed — do not waste time on it.

Design rules for promo tiles (Chrome):

- Full bleed, no padding, no transparency.
- Medium or dark background; avoid white edges.
- Must look good at 50% scale.
- Saturated colours; minimal text; don't use screenshots.
- No marketing slogans ("Install now!", "Get it today!").

## Chrome Web Store

Dashboard: https://chrome.google.com/webstore/devconsole/

- [x] One-time **$5 developer fee** (credit card, lifetime).
- [x] **Privacy Policy URL** field — Account → Privacy Policy. Point at
      `PRIVACY.md` GitHub URL.
- [ ] **Permissions justification** — paste these into the Chrome dashboard
      "Permission justification" field for each entry:

  **`webRequest`**:

  > Reads outgoing chat-send and conversation-delete HTTP requests on supported AI
  > platforms to detect when a new round of conversation occurs, so token counts can
  > be updated. No request body content is stored or transmitted.

  **Each AI-chat `host_permissions` entry** (`chat.deepseek.com`, `chatgpt.com`,
  `gemini.google.com`, `kimi.moonshot.cn`, `chat.qwen.ai`, `tongyi.aliyun.com`,
  `doubao.com`):

  > This is an AI chat platform the user chooses to monitor. Headroom reads
  > conversation text on this domain solely to estimate token counts; it retains
  > only the counts, never the text.

- [ ] **Data usage declaration** — Chrome dashboard "Privacy" tab. Answer "Yes,
      I collect user data" and fill each question with the text below:

  **Single purpose**:

  > Show context-window usage in AI chat conversations.

  **Personally identifiable information**: None.

  **Authentication information**:

  > Upstash REST credentials (URL + token) are stored locally in the browser and
  > sent only to the user's own Upstash Redis instance over HTTPS to sync token
  > counts across devices. Credentials are never sent to Headroom servers (there
  > are none) or any third party.

  **Personal communications / Website content**: Yes — for each prompt and reply

  > on the 7 supported AI-chat domains, Headroom reads the conversation text to
  > count tokens. When a conversation is opened, it also reads the full prior
  > history via the platform's own API to estimate accumulated token usage. It
  > retains **only the token counts**, never the text; text is never stored
  > locally, in Upstash, or anywhere else.

  **Web history**: None.

  **Data sold / transferred / used for unrelated purposes**: No to all three.

  **Remote code**: No — all code is packaged in the extension.

- [ ] **Packaged zip** — `npm run zip` → `.output/chrome-mv3/chrome-mv3.zip`.
      Upload that.
- [ ] **Distribution visibility** — start "Unlisted" for self-testing, then flip
      to "Public".

## Microsoft Edge Add-ons

Partner Center: https://partner.microsoft.com/dashboard/microsoftedge

- [x] **Microsoft Partner Center account** (free, but requires a personal MSA /
      org Azure AD).
- [ ] **Privacy Policy URL** — same `PRIVACY.md` URL.
- [ ] **Permissions justification** — Edge inherits Chrome's strictness; paste
      the same justifications.
- [ ] **Packaged zip** — the Chrome MV3 build (`npm run zip`) works on Edge
      (same Chromium MV3). No separate build needed.
- [ ] Edge review is typically faster than Chrome but can still take days.

## Firefox AMO (addons.mozilla.org)

Submit: https://addons.mozilla.org/developers/

- [x] **Mozilla account** (free).
- [ ] **512×512 marketing icon** — uploaded separately in the AMO dashboard
      (not via manifest `icons`). PNG format; SVG not accepted.
- [x] **Permanent add-on id** — `headroom@zmbad.me` in `wxt.config.ts`
- [ ] **Privacy Policy** — since the June 2025 policy update, AMO no longer
      _requires_ hosting the policy on AMO, but **a link is still strongly
      recommended** and reviewers expect one for `webRequest` + host-permission
      extensions. Provide the `PRIVACY.md` URL.
- [ ] **Firefox-specific consent** — Firefox MV3 requires a data-collection
      consent declaration (`browser_specific_settings.gecko.data_collection`
      or the equivalent AMO-submission checkbox). Headroom reads website
      content (conversation text) to count tokens and retains only the counts
      → declare it and point at the privacy policy. See `wxt.config.ts` (the
      `websiteContent` consent is already drafted).
- [ ] **Source code submission** — AMO review for extensions requesting broad
      permissions often asks for the source. Provide the GitHub repo URL; the
      zip you upload must match a public tag.
- [ ] **Packaged zip** — `npm run zip:firefox` → `.output/firefox-mv3/...zip`.
      Firefox MV3 has small differences (uses `sidebarAction`, no `sidePanel`);
      the build already handles them.
- [ ] **Self-hosted vs AMO-listed** — AMO-listed gets auto-update signing for
      free; self-hosted needs a signed XPI. Start AMO-listed.

## Submission order (recommended)

1. **Chrome Web Store first** — strictest review; passing it de-risks Edge/AMO.
2. **Edge Add-ons next** — same Chromium MV3 build, faster review.
3. **Firefox AMO last** — different manifest surface (`sidebarAction`), needs
   the gecko id + consent fields finalized.

Run spec 001 Gate 1 (DeepSeek end-to-end) **before step 1** — a store rejection
on broken behavior wastes the review queue slot.

## Post-publish upkeep

- **Version bumps**: update `package.json` version + tag; re-zip all three; bump
  each store listing.
- **Permission additions**: any new `host_permissions` / `permissions` entry
  triggers re-review on all three stores and may grey the user's card pending
  re-grant.
- **Privacy policy drift**: keep `PRIVACY.md` in sync with code — a PR that
  changes data flow must update the policy in the same PR.
