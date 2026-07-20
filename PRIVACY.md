# Privacy Policy

> **Last updated:** 2026-06-22
>
> This policy is version-controlled alongside the source code. The live URL
> submitted to each store points at this file on the `main` branch.

## TL;DR

Headroom reads your AI-chat conversation **transiently** — just long enough to
count tokens — then keeps **only the counts**. Your conversation text is never
stored, on your device or anywhere else. Those token counts sync to **your own**
Upstash KV (if you configure it) so the gauge picks up where you left off on
another device. Headroom has **no server** — nothing flows through the project
author.

## What Headroom reads

To compute your context-window usage, the extension reads:

| What                                                | How                                                                                                                                        | Why                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Your **prompt text** for each message you send      | `webRequest` observes the outgoing request to the AI platform's API; the adapter extracts the prompt field                                 | Needed to count the tokens you're submitting                                                             |
| The **AI's reply text**                             | A content script reads the rendered reply from the page DOM once a round settles                                                           | Needed to count the tokens in the reply                                                                  |
| A **conversation/session id**                       | From the same request body or the page URL                                                                                                 | Needed to group rounds into one conversation tally                                                       |
| The **full conversation history** (all past rounds) | When you open a conversation, the extension calls the platform's own history API (using your existing login session) to fetch prior rounds | Needed to estimate tokens for rounds sent from other devices (e.g. chatted on mobile or another machine) |

**Scope:** reading is limited to the seven supported AI-chat domains listed in
`host_permissions` (`chat.deepseek.com`, `chatgpt.com`, `gemini.google.com`,
`www.kimi.com`, `chat.qwen.ai`, `www.qianwen.com` + its API host
`chat2.qianwen.com`, `www.doubao.com`). Headroom does **not** read, and has no
access to, any other website, your other tabs, your browsing history, or any
data outside those seven domains.

## What Headroom stores, and where

Headroom uses a **two-tier** model. **You control the cloud tier.**

### 1. Local storage (`browser.storage.local`) — always, on your device

- **Settings** — your thresholds, language, per-platform context-limit overrides,
  and your Upstash REST credentials (URL + token). Used to run the extension.
- **Per-conversation token records** — a `DialogueRecord` per conversation: a
  rolling list of rounds, each carrying **only numeric token counts** (never
  conversation text), cached locally so the gauge re-opens instantly and works
  offline. The cache is bounded by LRU eviction (least-recently-viewed
  conversations are dropped when space runs low); evicted records are
  recoverable from your Upstash KV.
- **Stop-generation feedback** — when you stop the AI mid-reply, the content
  script reads the partial answer straight from the page DOM and Headroom
  creates a temporary local-only round so the gauge updates immediately. This
  temporary round is never synced to Upstash and is replaced by the next real
  history fetch (when you continue or send the next prompt). No prompt or answer
  text is persisted — only the estimated token counts of that in-progress round,
  held in memory until the real round lands.

### 2. Upstash Redis KV — **your own**, optional (BYOK)

If you provide Upstash credentials, Headroom writes a **conversation metadata
record** per conversation to **your** Upstash instance. The record contains:

- The conversation id, platform id, context limit, and a rolling list of rounds
  (capped at 200).
- Each round carries **only numeric metadata**: round number, estimated prompt
  token count, estimated answer token count, and a timestamp.

> **Your conversation text is never persisted.** Headroom reads your prompt and
> the AI's reply to count tokens, but it stores **only the token counts** — not
> the text itself. Neither your local device nor your Upstash KV retains what
> either side actually said. This is by design (`utils/dialogue-record.ts`:
> `RoundRecord` is `{ messageId, order, n, promptTokens, answerTokens, total, createdAt }`
> — numbers and platform-stable identifiers only, no text).

**Your Upstash credentials never leave your device.** They are stored only in
local storage and used to call Upstash's REST API directly from the extension.
They are **not** written to the cloud settings record (see below), not logged,
not transmitted anywhere else.

## What Headroom does NOT do

- ❌ **No Headroom server.** The extension talks only to the AI platform (so you
  can chat) and to **your** Upstash (if you configured it). There is no
  Headroom-operated backend, analytics, or telemetry.
- ❌ **No third-party tracking or advertising.** No Google Analytics, no Sentry,
  no ad SDKs.
- ❌ **No selling or sharing data.** Nothing leaves the two destinations above.
- ❌ **No reading of sites outside the seven supported AI-chat domains.**
- ❌ **No access to your passwords, payment info, or identity.** The extension
  never touches form fields, auth tokens, or cookies on any site.

## Permissions, and why each is needed

| Permission                             | Why                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `storage`                              | Persist settings + per-conversation token records + pending round locally                               |
| `webRequest`                           | Observe outgoing chat-send requests to extract prompt + conversation id (the core token-counting input) |
| `host_permissions` (7 AI-chat domains) | The send/delete APIs live on these hosts; the content script runs on these pages                        |
| `sidePanel` / `sidebarAction`          | Open the gauge in the browser's native side panel                                                       |
| `action`                               | Toggle the side panel on toolbar click; grey-out on unsupported pages                                   |

No `tabs`, no `cookies`, no `<all_urls>`, no `history`, no `nativeMessaging`.

## Conversation deletion sync

When you delete a conversation **on the AI platform itself**, Headroom
intercepts that delete request (same `webRequest` mechanism) and removes the
corresponding record from your Upstash KV and your local cache. This keeps your
KV tidy without manual cleanup.

If Upstash is unreachable at delete time, the delete is **dropped with a
warning** — there is no offline delete queue. The orphaned record is cleaned up
the next time you open the platform's home page: Headroom compares the
platform's current conversation list against your Upstash keys and removes any
that no longer exist. Conversations deleted on another device (e.g. mobile) are
caught the same way, or are removed the next time you open that already-deleted
conversation on a device with Headroom installed.

## Data retention

- **Local storage**: kept until you uninstall the extension or clear browser
  data.
- **Upstash KV**: under **your** control. Headroom writes records; **you** decide
  retention via Upstash's own TTL/eviction or by deleting conversations in the
  AI platform (which Headroom mirrors to your KV).

## Third-party services

The only external services Headroom contacts are:

1. **The AI chat platform you're already using** — Headroom observes the chat
   requests your browser already makes, and additionally fetches a
   conversation's history from the platform's own API (using your existing
   login session) when you open it, to estimate tokens for rounds sent from
   other devices. These are read-only calls to a service you're already logged
   into; Headroom sends no data to the platform.
2. **Upstash** — only if you configure it, only with your credentials, only to
   read/write your own conversation metadata.

Neither is operated by Headroom's author; each is governed by its own terms and
privacy policy.

## Limited Use disclosure

Headroom reads your conversation text only to count tokens, and retains only the
counts — never the text. Its use of the data it reads complies with the
**Limited Use** requirements: the data is used only to provide the feature you
invoked (the context-window gauge), is not used for unrelated purposes, and is
not transferred outside the two destinations above except as required to provide
the feature.

## Children's privacy

Headroom is not directed at children under 13 (or the applicable age in your
jurisdiction) and does not knowingly collect data from them. The AI-chat
platforms themselves have their own age gates.

## Changes to this policy

Material changes will be committed to this file with an updated "Last updated"
date and called out in release notes. The git history of this file is the
canonical record of what changed and when.

## Contact

Open an issue at the project's GitHub repository for privacy-related questions.
For sensitive disclosures, see `SECURITY.md` (if present) or open a private
security advisory on GitHub.
