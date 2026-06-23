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
- [ ] **Runtime acceptance passed** — at minimum spec 001 Gate 1 (DeepSeek
      end-to-end). The listing copy and screenshots must reflect what the gauge
      actually does, not what it's planned to do.

### Listing copy (one set, localized) ⏳

Draft **after** Gate 1 passes, so the copy describes verified behavior.

- [ ] **Short description** (≤132 chars, store limit) — one sentence.
- [ ] **Long description** (~500 words) — the Problem / Solution / How-it-works
      framing from the README, re-flowed for the store card.
- [ ] **English + Simplified Chinese** versions of both. The extension ships
      `en` + `zh_CN` locales; match them.
- [ ] **Category** — Productivity.
- [ ] **Keywords** (where the store supports them): `AI`, `chatbot`,
      `context-window`, `token`, `ChatGPT`, `DeepSeek`, `productivity`.

### Screenshots / store graphics ⏳

- [ ] **5 screenshots** (1280×800 or 640×400, PNG) showing: the gauge green →
      orange → red; the settings panel (thresholds + Upstash); a multi-round
      conversation. Use a throwaway conversation, not real user data.
- [ ] **Promotional tile** (440×280, PNG) — optional but recommended for
      featuring.
- [ ] **Extension icon** — already in `public/icon/`; confirm the store wants
      128×128.

## Chrome Web Store

Dashboard: https://chrome.google.com/webstore/devconsole/

- [ ] One-time **$5 developer fee** (credit card, lifetime).
- [ ] **Privacy Policy URL** field — Account → Privacy Policy. Point at
      `PRIVACY.md` GitHub URL.
- [ ] **Permissions justification** — for each permission and each
      `host_permissions` entry, a one-line justification. Chrome review will
      reject without these. Source them from `PRIVACY.md` → "Permissions":
  - `webRequest` — "observes outgoing chat-send and delete requests to count tokens and sync deletions"
  - each AI-chat host — "the platform the user is chatting on"
- [ ] **Data usage declaration** — answer "Yes, I collect user data" and fill
      (source the wording from `PRIVACY.md`):
  - **Personally identifiable info**: None.
  - **Authentication information**: Upstash REST credentials (stored locally
    only; used to sync token counts to the user's own storage).
  - **Personal communications / Website content**: Yes — Headroom reads
    conversation text on the 7 supported AI-chat domains (each prompt, each
    reply, and — when a conversation is opened — its full prior history via the
    platform's own API) **only to count tokens**. It retains **only the token
    counts**, never the text; text is never stored locally or in Upstash.
  - **Web history**: None.
  - Declare: data is **not** sold, **not** used for unrelated purposes, **not**
    transferred to third parties (matches the Limited Use nod).
- [ ] **Single-purpose statement** — one sentence: "Show context-window usage in
      AI chat conversations." Chrome requires this.
- [ ] **Packaged zip** — `npm run zip` → `.output/chrome-mv3/chrome-mv3.zip`.
      Upload that.
- [ ] **Distribution visibility** — start "Unlisted" for self-testing, then flip
      to "Public".

## Microsoft Edge Add-ons

Partner Center: https://partner.microsoft.com/dashboard/microsoftedge

- [ ] **Microsoft Partner Center account** (free, but requires a personal MSA /
      org Azure AD).
- [ ] **Privacy Policy URL** — same `PRIVACY.md` URL.
- [ ] **Permissions justification** — Edge inherits Chrome's strictness; paste
      the same justifications.
- [ ] **Packaged zip** — the Chrome MV3 build (`npm run zip`) works on Edge
      (same Chromium MV3). No separate build needed.
- [ ] Edge review is typically faster than Chrome but can still take days.

## Firefox AMO (addons.mozilla.org)

Submit: https://addons.mozilla.org/developers/

- [ ] **Mozilla account** (free).
- [ ] **Permanent add-on id** — currently `TODO` in `wxt.config.ts`
      (`browser_specific_settings.gecko.id`). **Must be set before first AMO
      submit** (can't change it post-publish without a new listing).
      Convention: `headroom@<your-domain>` or an email-style id.
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
