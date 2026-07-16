# Acceptance Checklist

**Live acceptance checklist** — every item must be manually verified in a real browser on a real AI platform and checked off.
Automation (typecheck / lint / unit test / build) cannot replace this checklist — they only verify logic, not browser APIs, platform APIs, and real user interaction.

> **How to use**: Before each live testing session, copy this file locally and check items off one by one. After completion, paste the results into the commit message or PR description.

---

## Prerequisites

- [x] Chrome ≥149 installed
- [x] Extension loaded (`chrome://extensions` → Load unpacked → select `.output/chrome-mv3/`)
- [x] Upstash configured (settings panel → enter REST URL + Token → test connection → save)
- [x] Logged into at least two AI platforms (DeepSeek required, pick 2–3 others for cross-validation)

---

## 001 Core Monitor (Gate 1 — DeepSeek required)

### Installation & Activation

- [x] **001-01** Non-platform page (e.g. `github.com`) → toolbar icon grayed out, click does nothing (3D ACL: `setIcon` gray + `onClicked` intercept + `setOptions({enabled:false})`)
- [x] **001-02** Open `chat.deepseek.com` → icon lights up, clickable
- [x] **001-03** Click icon → native side panel opens, shows Headroom UI
- [x] **001-04** Side panel shows "DeepSeek" platform name + context limit (1,048,576)
- [x] **001-05** Home page (no conversation opened) → gauge shows IDLE state (progress bar at 0)
- [x] **001-06** Close side panel (click × or click icon again) → closes normally

### Conversation Loading

- [x] **001-07** Open an existing conversation → gauge climbs from 0 to real cumulative value (doesn't stay at 0)
- [x] **001-08** Conversation title + dialogueId display correctly (title not empty, id hoverable to see full)
- [x] **001-09** Round count = actual number of Q&A pairs in the conversation
- [x] **001-10** Round-by-round table shows each round's prompt/answer tokens + cumulative

### Real-Time Increment

- [x] **001-11** Send a new message → wait for reply → panel updates (round +1, cumulative increases)
- [x] **001-12** Progress bar length grows with cumulative tokens
- [x] **001-13** Percentage exceeds yellow threshold (default 50%) → progress bar turns yellow
- [x] **001-14** Percentage exceeds red threshold (default 70%) → progress bar turns red
- [x] **001-15** Below yellow threshold → green, status text "Plenty of headroom"

### SPA Conversation Switch

- [x] **001-18** Click another conversation in DeepSeek sidebar → panel updates to new conversation data
- [x] **001-20** Switch back to home page → IDLE state

### Settings Panel

- [x] **001-21** ⚙️ Enter settings → shows threshold dual slider + context override + language dropdown + Upstash config
- [x] **001-22** Drag yellow slider to 40% → save → back to main view → turns yellow at 40%
- [x] **001-23** Drag red slider to 60% → save → turns red at 60%
- [x] **001-24** Reset thresholds → restores defaults 50%/70%
- [x] **001-25** Change DeepSeek context limit to 500,000 → save → main view shows 500,000
- [x] **001-26** Switch language → UI text changes (test at least en ↔ zh_CN)

### Delete Conversation

- [x] **001-27** Delete a conversation on DeepSeek → panel resets to zero (local record cleared)

---

## 001 Gate 2 — Other Platforms Smoke

> For each platform, verify at minimum: load, switch conversation, delete. Cover at least 3 platforms.
> (ChatGPT / Gemini / Doubao "panel update after one Q&A" are known to have bugs, not in scope for this round.)

### ChatGPT (`chatgpt.com`)

- [x] **001-CG-01** Open existing conversation → panel shows cumulative
- [x] **001-CG-03** Switch conversation → panel shows new data
- [x] **001-CG-04** Delete conversation → resets to zero

### Gemini (`gemini.google.com`)

- [x] **001-GM-01** Open existing conversation → panel shows cumulative (DOM fallback path)
- [x] **001-GM-03** Switch conversation → panel shows new data

### Kimi (`www.kimi.com`)

- [x] **001-KM-01** Open existing conversation → panel shows cumulative
- [x] **001-KM-02** Panel updates after one Q&A
- [x] **001-KM-03** Switch conversation → panel shows new data

### Qwen (`chat.qwen.ai`)

- [x] **001-QW-01** Open existing conversation → panel shows cumulative
- [x] **001-QW-02** Panel updates after one Q&A
- [x] **001-QW-03** Switch conversation → panel shows new data

### Tongyi Qianwen (`www.qianwen.com`)

- [x] **001-TY-01** Open existing conversation → panel shows cumulative (pagination path)
- [x] **001-TY-02** Panel updates after one Q&A
- [x] **001-TY-03** Switch conversation → panel shows new data

### Doubao (`www.doubao.com`)

- [x] **001-DB-01** Open existing conversation → panel shows cumulative (IM protocol path)
- [x] **001-DB-02** Panel updates after one Q&A (IM chain async persistence, relies on settle retry — verified live 2026-07)
- [x] **001-DB-03** Switch conversation → panel shows new data

---

## 002 Upstash Data Layer (Live)

- [x] **002-01** Chat 3 rounds on DeepSeek → open Upstash console → `headroom:conv:deepseek:*` key appears
- [x] **002-02** View that key in console → value is valid JSON containing `rounds[]` with no conversation text
- [x] **002-03** Settings panel Save → `headroom:settings` appears in console
- [x] **002-04** `headroom:settings` value has **no `url` / `token` fields** (credential-stripping verification)
- [x] **002-05** Clear Upstash config → delete conversation → no error (no-creds = no-op)

---

## 003 Cross-Device Reconciliation (Live — core risk area)

### Open-and-Reconcile

- [x] **003-01** Fresh install → open existing conversation → gauge climbs from 0 to real cumulative (doesn't wait for network)
- [x] **003-02** Close panel and reopen → instant (reads local cache, doesn't wait for Upstash)
- [x] **003-03** Chat one more round in a conversation with Upstash records → Upstash value updates (full record overwrite)

### Cross-Device (requires two devices / two browser profiles)

- [x] **003-04** Device A chats 5 rounds → Device B opens same conversation → B shows 5-round cumulative (not 0)
- [x] **003-05** Device A chats, then Device B chats 2 more rounds → Device A opens and shows 7 rounds
- [x] **003-06** Conversation includes rounds chatted on mobile (if any) → included in cumulative

### Upstash Connected After the Fact

- [x] **003-07** Don't fill Upstash → chat 3 rounds → fill correct Upstash and save → open same conversation → 3 rounds already pushed to cloud (console shows `headroom:conv:…` key)

### Union Merge Correctness

> Regenerate scenarios not yet accepted — involve platform-specific tree conversation structures; `/regenerate` endpoints are not uniform across platforms, out of MVP scope.

### Delete Linkage & Zombie Cleanup

- [x] **003-10** Delete conversation on web → both local cache and Upstash key disappear
- [x] **003-11** Open platform home page → triggers zombie cleanup, orphaned keys are DEL'd (verify at least DeepSeek + ChatGPT each). Equivalent to verifying: Device A deletes conversation → Device B opens home page → Upstash record is cleaned up
- [x] **003-12** Wait 60min → DevTools Console shows no `zombie cleanup failed` errors
  - **Action**: Keep extension running >1h, occasionally check DevTools Console for zombie cleanup errors.

### Reconciliation Frequency Control (Debounce)

- [x] **003-13** Rapid conversation switching → gauge switches instantly (reads from cache, no lag)
  - **Action**: Open a conversation and wait for it to load, switch to another, switch back to the first. Panel **instantly** shows the first conversation's data (from local cache), no brief blank or "detecting" state.
- [x] **003-14** After reply completes, history is pulled immediately (code path review: REFRESH_HISTORY takes a separate branch calling `fetchAndShipHistory()` directly, bypassing SPA debounce)

---

## Cross-Browser Smoke (001 Gate 3)

### Edge

- [x] **CB-01** Installable
- [x] **CB-02** DeepSeek open conversation → panel shows cumulative
- [x] **CB-03** Panel updates after one Q&A
- [x] **CB-04** Side panel opens/closes normally
- [x] **CB-E05** Switch back to DeepSeek — panel does not auto-restore (known platform limitation, Microsoft issue [#222](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/222) confirmed as design difference, not fixable. Manual click required.)

### Firefox

- [x] **CB-05** Installable (`sidebarAction`, not `sidePanel`)
- [x] **CB-06** DeepSeek open conversation → panel shows cumulative
- [x] **CB-07** Panel updates after one Q&A
- [x] **CB-08** Side panel opens/closes normally (Firefox uses `sidebarAction`, global panel. Tab switch doesn't close it — this is a Firefox platform limitation; `sidebarAction.close()` requires a user gesture)
- [x] **CB-09** Non-platform page icon grayed out, click does nothing (`action.setIcon` reset-then-set + `onClicked` intercept)
- [x] **CB-10** Switch to non-platform page → sidebar content switches to hint page (`sidebarAction.setPanel("not-supported.html")`), switch back to platform page restores normal

---

## Cross-Browser Deep QA (Firefox Differences)

> After smoke passes, verify each known Firefox vs. Chrome difference.

### Side Panel Differences

- [x] **CB-F01** Firefox uses `sidebarAction` (not `sidePanel`) — panel open/close lifecycle consistent with Chrome
- [x] **CB-F02** Firefox sidebar is global (cannot be closed per-tab like Chrome) — confirm panel behavior is reasonable when switching to non-platform pages

### Service Worker Lifecycle

- [x] **CB-F03** Core functionality works after extension reload
  - **Action**: Open `about:debugging#/runtime/this-firefox` → click Headroom's "Reload" button → refresh DeepSeek page → open a conversation → panel shows cumulative normally.
- [x] **CB-F04** Core functionality works after browser restart
  - **Action**: Fully exit Firefox → reopen → open DeepSeek conversation → panel shows cumulative normally (SW recovers from cold start, message channels and alarms work).

### webRequest Behavior Differences

- [x] **CB-F05** Firefox `webRequest.onBeforeRequest` supports `requestBody` — confirm deletion interception works
- [x] **CB-F06** `onCompleted` / `onErrorOccurred` trigger timing consistent with Chrome — SSE stream close = reply-complete detection is accurate

### Storage Differences

- [x] **CB-F07** Firefox `storage.local` quota is based on disk space (not Chrome's 10 MB) — confirm no anomalies after many conversations
- [x] **CB-F08** `storage.local` read/write latency is within acceptable range

### Alarms Differences

- [x] **CB-F09** Firefox `alarms` minimum interval ≥1 min (Chrome supports 10s) — zombie cleanup 60min period unaffected

### Overall

- [x] **CB-F10** At least one other platform (ChatGPT / Kimi / Qwen pick one) fully walks through "open → chat one round → delete → switch conversation"

---

## UI Internationalization

- [x] **I18N-01** Switch to each UI language → panel text correct (verify at least en + zh_CN + ja)
- [x] **I18N-02** Settings panel language labels correct
- [x] **I18N-03** Status text ("Plenty of headroom" / "Headroom running low" etc.) translated correctly

---

## Items Not Verified (with reasons)

| Item                                             | Reason                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Token estimation accuracy (004 scope)            | v1 coefficients not calibrated, known imprecise; acceptance criteria are in 004                                             |
| Live mobile chat                                 | Requires phone + corresponding app, limited conditions; can be indirectly verified via cross-device reconciliation (003-06) |
| `storage.local` precise quantitative measurement | Requires constructing 50+ conversations, not realistic manually; LRU constants and unit tests provide coverage              |
| Regenerate (001-16 / 003-08)                     | `/regenerate` endpoints not uniform across platforms, involves tree conversation structures, out of MVP scope               |
| Stop generation (001-17)                         | `/stop` endpoints not uniform across platforms, to be addressed uniformly later                                             |
