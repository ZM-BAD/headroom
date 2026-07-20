# Roadmap

It is fine for specs to be a few milestones ahead of the code — but **the further out, the lighter**: near-term (next to build) gets a full PRD; far-term gets only goals / gates / scope, and is fleshed out when its turn comes. Writing detailed PRDs too early for distant milestones is mostly speculation — high maintenance cost and prone to mislead.

## Milestone Overview

| Spec                               | Milestone                                                                                | Status                                                                                      | Gate (live device)                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [001](./001-headroom-core.md)      | Core monitor + estimation engine + adapter base                                          | 🟢 done · 7 platforms, all gates checked                                                    | DeepSeek single-device end-to-end passing                                |
| [002](./002-upstash-data-layer.md) | Upstash data layer (structure + transport)                                               | 🟢 done · 5/5 live acceptance passed                                                        | Live: Upstash shows records                                              |
| [003](./003-cross-device-sync.md)  | Cross-device reconciliation engine                                                       | 🟢 done · 11/11 live acceptance passed                                                      | Open-and-sync full history, no cross-device loss, mobile rounds included |
| [004](./004-optimizations.md)      | Token estimation upgrade (script expansion + per-platform coefficients + user overrides) | 🟢 Phase A done · 🟢 Phase B calibration measured + applied · 🟡 B8 live spot-check pending | Multi-script estimation error bounded + user-overridable coefficients    |

Dependency order: **001 → 002 → 003**. 004 is an upgrade to 001's estimation engine and does not block the main trunk.

## Cross-Cutting Principles (apply to all milestones)

- **Don't leave cross-browser to the end.** 001 acceptance Gate 3 already includes Firefox/Edge **smoke** (installable, launchable, basic interception works); deep QA goes in the [`acceptance-checklist.md`](./acceptance-checklist.md) cross-browser section. Surface Chrome-specific assumptions early to avoid compounding later.
- **One theme per milestone.** Don't bundle unrelated work.
- **Validate one platform end-to-end before expanding.** Architecture is decoupled by adapter, but validation starts from DeepSeek as the cheapest.
- **Spec = current truth.** When a decision changes, overwrite the original text directly; no strikethrough, no "we changed it" notes. Git is the history; the spec reflects only the present.

## On "Internationalization" — Two Separate Concerns Defined at Inception

- **Token estimation calibrated by writing system (→ 001 engine / 004 upgrade)**: Estimation coefficients are a "platform × writing system" matrix. v1 handles Chinese (CJK) + English (Latin) in 001; 004 expands to 6 writing systems + per-platform tokenizer calibration.
- **Extension UI localization (no separate spec)**: `_locales/` dictionaries + language dropdown. Low technical complexity, no standalone spec.

The two are independent of each other.

## Capabilities That Don't Get a Separate Spec (where they land)

- **New platform (Claude / Grok / MiniMax…)**: No separate spec. 001's adapter contract was designed for this — new platform = register + one `adapters/<platform>.ts`.
- **UI translated into more languages**: No separate spec.
- **Cross-browser deep QA**: No separate spec; goes in the [`acceptance-checklist.md`](./acceptance-checklist.md) cross-browser section.
