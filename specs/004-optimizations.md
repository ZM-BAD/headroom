# 004: Token Estimation System Upgrade — Writing System Expansion + Per-Platform Coefficients + User Overrides

## Status

In progress. Phase A code infrastructure complete (type extensions + estimateTokens upgrade + Settings UI layering + Advanced panel). Phase B calibration **measured** against real tokenizers, locally and exactly, for 6 of 7 platforms (method §4.4; harness `scripts/calibration-lib.mjs`) and applied to all 7 adapters. Remaining: live mixed-script spot-check (B8).

## Summary

Upgrade token estimation from v1's 2 writing systems to v2's 6, with independent coefficients per platform, user-overridable per platform in Advanced Settings.

**Out of scope for this spec**: cross-browser deep QA (goes to [`acceptance-checklist.md`](./acceptance-checklist.md)).

## Motivation

Three problems with v1:

1. **Narrow writing-system coverage**: Japanese kana and Korean Hangul are incorrectly bucketed into Latin and counted as words; significant deviation.
2. **No per-platform tokenizer distinction**: DeepSeek and ChatGPT produce different token counts for the same Chinese character, but all 7 platforms share one coefficient set.
3. **User has no control**: Code path is already parameterized (`TokenCoefficients` → `estimateTokens(text, coeff)`), but the settings panel does not expose it.

## Design

### 1. Writing System Expansion

Expand from 2 to 6 writing systems, each with independent coefficients:

| Writing System        | Unicode Range              | Counting Unit | Priority |
| --------------------- | -------------------------- | ------------- | -------- |
| CJK Unified Ideograph | `\p{Unified_Ideograph}`    | per character | —        |
| Japanese Kana         | `\p{Hiragana}\p{Katakana}` | per character | High     |
| Korean Hangul         | `\p{Hangul}`               | per character | High     |
| Cyrillic              | `\p{Cyrillic}`             | per word      | Medium   |
| Arabic                | `\p{Arabic}`               | per word      | Medium   |
| Latin & others        | remainder                  | per word      | —        |

> **Per-character vs. per-word**: CJK / Kana / Hangul counted per character (one character ≈ 1–3 tokens, low variance); Cyrillic / Arabic / Latin counted per whitespace-separated word (word length varies widely, per-word is more stable).

**v2 estimation formula**:

```
tokens(text) = Σ over scripts s [ count_chars_or_words(text, s) × coeff[s] ]
```

where `coeff[s]` is read from the adapter's `tokenCoefficients`.

### 2. TokenCoefficients Type

```typescript
// utils/estimate.ts
interface TokenCoefficients {
  cjk: number; // CJK Unified Ideograph
  kana: number; // Japanese Kana
  hangul: number; // Korean Hangul
  cyrillic: number; // Cyrillic
  arabic: number; // Arabic
  latin: number; // Latin & others (fallback bucket)
}
```

All fields required. `estimateTokens` internally classifies per character via Unicode property escapes (`\p{...}`, `u` flag) → bucket counting → multiply and sum by coefficient.

### 3. Coefficient Resolution Chain (Two-Level)

```
Settings.tokenCoefficients[platformId].cjk   ← user override (highest priority)
  ?? adapter.tokenCoefficients.cjk            ← platform default (each adapter must provide)
```

No third-level global fallback — each adapter's `tokenCoefficients` is a required field; the adapter itself is that platform's default. "Reset" action clears the user override, returning to the adapter's built-in value.

`DEFAULT_COEFFICIENTS` constant does not participate in the runtime estimation chain (`resolveCoefficients` uses only user override → adapter default). It appears in the settings panel as a defensive `??` fallback for missing adapter fields (unreachable in practice — every adapter provides all six) and as the parameter set in `estimateTokens` unit tests.

### 4. Per-Platform Default Models, Tokenizers, and Coefficient Estimation

**Core principle**: Headroom does not bundle tokenizers. It only needs **coefficients** — "how many characters/words per token does each writing system average under this tokenizer." Coefficients are calibrated empirically; tokenizer source code is not required.

#### 4.1 Default Models

Current default models per platform web version (2026-07, adversarially verified web research — 3-vote per claim):

| Platform       | Default Model           | Verification                                                                                             |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| ChatGPT        | GPT-5.5 Instant         | Confirmed — default since 2026-05-05, replaced GPT-5.3 Instant; API alias `chat-latest`                  |
| DeepSeek       | DeepSeek V4 Preview     | Confirmed — Instant Mode (V4-Flash, 284B MoE) is the default; Expert Mode (V4-Pro) opt-in                |
| Qwen           | Qwen 3.7 preview family | Partial — 3.7-Max/Plus previews live since 2026-05; which variant is the homepage default is unconfirmed |
| Tongyi Qianwen | Qwen 3.7 (presumed)     | Unverified — no direct claims found; presumed same Qwen family                                           |
| Kimi           | Kimi K2.6               | Confirmed — "default across web, mobile app, and Kimi Code" (2026-04-22)                                 |
| Gemini         | Gemini 3.5 Flash        | Confirmed — default on gemini.google.com since 2026-05-19                                                |
| Doubao         | Unknown                 | Unconfirmed — "Doubao 2.1" could not be verified; production model name unknown                          |

Key verification sources: [DeepSeek V4 official announcement](https://api-docs.deepseek.com/news/news260424/) · [Kimi K2.6 default coverage](https://pandaily.com/moonshot-ai-open-sources-kimi-k2-6-advancing-multi-agent-collaboration/) · GPT-5.5 Instant default (TechCrunch / VentureBeat / itbrief, consistent secondaries) · Gemini 3.5 Flash default (DigitalTrends / deeplearning.ai) · [o200k_base for gpt-4o and later](https://community.openai.com/t/tokenizer-latest-chat-gpt-models/1371076) · [Gemma ships the same tokenizer as Gemini](https://developers.googleblog.com/en/gemma-explained-whats-new-in-gemma-3/). Full research report with the evidence chain: git `d9ec75d` (`report.md`).

#### 4.2 Tokenizers and Vocabularies

A tokenizer is bound to a model at training time. Types and vocab sizes below are **measured from the actual tokenizer files** (not model-card claims):

| Platform       | Tokenizer                                                                       | Vocab Size | Calibration source (fidelity)                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT        | tiktoken `o200k_base` (byte-BPE)                                                | 200,019    | `tiktoken` npm, o200k_base (**exact** — gpt-4o through latest chat models all use o200k_base)                                                                                          |
| DeepSeek       | BPE `tokenizer.json` (`PreTrainedTokenizerFast`)                                | 129,280    | [deepseek-ai/DeepSeek-V4-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) (**exact** — production model is open; same vocab as V3)                                         |
| Qwen           | BBPE, `Qwen2Tokenizer` lineage                                                  | 248,320    | [Qwen/Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B) (**sibling** — web 3.7 is closed; 3.6 is the newest open sibling. NOT the old dense-Qwen3 151,936 vocab)                   |
| Tongyi Qianwen | Same as Qwen                                                                    | 248,320    | Same as above                                                                                                                                                                          |
| Kimi           | tiktoken-format BPE (`tiktoken.model` + Han-aware `pat_str`, no tokenizer.json) | 163,840    | [moonshotai/Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6) (**exact** — production model is open)                                                                             |
| Gemini         | SentencePiece (Gemini-family)                                                   | 262,144    | [google/gemma-4-12B-it-qat-q4_0-unquantized](https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-unquantized) (**proxy** — Google states Gemma ships "the same tokenizer as Gemini") |
| Doubao         | BPE + ByteLevel (`PreTrainedTokenizerFast`)                                     | 155,136    | [ByteDance-Seed/Seed-OSS-36B-Instruct](https://huggingface.co/ByteDance-Seed/Seed-OSS-36B-Instruct) (**proxy** — same ByteDance Seed team; production model closed)                    |

**Vocab size vs. compression rate**: larger vocab → common characters/word groups more likely encoded as a single token → lower coefficient. **Measured reality (2026 vocabs, 129K–262K)**: Chinese-heavy vocabs pack multi-character _words_ into single tokens, so CJK lands at **0.58–0.83 tokens per character** — below 1.0 on every platform. The older BPE rule of thumb "1 Chinese char ≈ 1.5–2.5 tokens" is a cl100k-era artifact and must not be used for estimation.

#### 4.3 Measured Coefficient Matrix

Fitted by joint 6-variable least squares against each real tokenizer over the shared calibration corpus (`scripts/calibration-lib.mjs`: 58 samples, prose + markdown + LLM-answer-shaped per writing system; bucket counts from the real `estimateTokens` engine via one-hot coefficients). **Coefficients already include markdown format overhead** (see §5) — no runtime markdown parsing needed. Reproduce with `scripts/calibrate-chatgpt.mjs` + `scripts/calibrate-hf.mjs` (`npm i --no-save tiktoken @huggingface/transformers`).

| Platform           | CJK  | Kana | Hangul | Cyrillic | Arabic | Latin | Fidelity |
| ------------------ | ---- | ---- | ------ | -------- | ------ | ----- | -------- |
| **ChatGPT**        | 0.83 | 0.78 | 0.66   | 1.76     | 1.84   | 1.30  | exact    |
| **DeepSeek**       | 0.62 | 0.74 | 0.78   | 2.10     | 2.15   | 1.33  | exact    |
| **Qwen**           | 0.61 | 0.52 | 0.55   | 1.77     | 1.71   | 1.36  | sibling  |
| **Tongyi Qianwen** | 0.61 | 0.52 | 0.55   | 1.77     | 1.71   | 1.36  | sibling  |
| **Kimi**           | 0.58 | 0.85 | 0.98   | 2.77     | 2.78   | 1.31  | exact    |
| **Gemini**         | 0.70 | 0.52 | 0.62   | 1.73     | 1.96   | 1.35  | proxy    |
| **Doubao**         | 0.68 | 1.27 | 0.82   | 2.04     | 2.30   | 1.38  | proxy    |

Coefficient precision **two decimal places**. Platform quirks: Kimi's `[\p{Han}]+` pre-tokenization makes Chinese ultra-cheap but non-Latin words expensive (Cyrillic/Arabic ≈ 2.8/wd); Seed-OSS carries little Japanese (kana 1.27, ~2× the others) — treat Doubao's kana as low-confidence.

**Accepted error modes** (held-out mixed-script validation; recur across all six tokenizers, property of the linear model, not of any coefficient value):

- Code-heavy English: underestimates 19–29% (code tokenizes denser than prose; one Latin coefficient averages both).
- Korean+English mix: overestimates 20–36% (tech loanwords in Hangul prose tokenize cheaper than pure Hangul).
- Everything else lands within the ±15% target.

> **History**: an earlier estimated matrix (CJK 1.3–1.8, derived from the "1.5–2.5 tok/char" rule of thumb) was applied to the adapters before measurement; it overestimated char-based scripts 2–3× and underestimated Cyrillic/Arabic on Kimi/DeepSeek/Doubao. Measurement supersedes it. Full evidence: git `d9ec75d` (`report.md`).

#### 4.4 Calibration Method (done)

All six tokenizers were calibrated **offline and locally** — no server-side regression was needed, because every platform family turned out to have a public tokenizer or a vendor-stated-equivalent proxy (§4.2). Loaders: `tiktoken` npm (ChatGPT o200k_base; Kimi's `tiktoken.model` + moonshotai's own `pat_str` through the same wasm core) and `@huggingface/transformers` (DeepSeek / Qwen / Gemma / Seed-OSS `tokenizer.json`). Server-side spot-checks (DeepSeek `accumulated_token_usage`, Qwen `usage.total_tokens`) remain useful only to measure per-round chat-template overhead — an optional follow-up, not part of the coefficients.

### 5. Markdown Format Overhead Estimation

LLMs output in markdown by default; formatting symbols consume additional tokens. Headroom estimates the **full output text** (including formatting), so coefficients must absorb this overhead.

#### 5.1 Typical Token Overhead per Format Element

| Format           | Example              | Extra Token Overhead | Notes                               |
| ---------------- | -------------------- | -------------------- | ----------------------------------- |
| Table row        | `\| col1 \| col2 \|` | 5–7 tokens / row     | includes `\|` separators and spaces |
| Table separator  | `\|--- \|--- \|`     | 3–5 tokens           | includes `\|` and `-` characters    |
| Code block fence | ` ```python `        | 2–3 tokens           | includes backticks and language tag |
| Heading          | `## Heading`         | 3–5 tokens           | `#` × level + space + content       |
| List item        | `- item`             | 2–3 tokens           | `-` + space + content               |
| Bold             | `**bold**`           | 3–5 tokens           | 4 `*` + content                     |
| Blockquote       | `> quote`            | 2–3 tokens           | `>` + space + content               |
| Link             | `[text](url)`        | 4–6 tokens           | brackets + content                  |

#### 5.2 Impact on Overall Estimation

Token composition of a typical LLM reply (500 Chinese chars + markdown formatting, ChatGPT measured coefficients):

```
Pure text content (500 Chinese chars):  ~415 tokens (measured CJK coefficient 0.83)
Markdown format overhead:              ~55–105 tokens (~12–15%)
  ├── 1 table (3 cols × 4 rows):       +40 tokens
  ├── 1 code block (10 lines):         +30 tokens
  ├── 3 headings:                      +10 tokens
  ├── 5 list items:                    +10 tokens
  └── 8 bold/italic:                   +15 tokens
─────────────────────────────────────────
Total:                                 ~470–520 tokens
```

#### 5.3 Implementation Rationale

**Choice: directly estimate raw text (including formatting); do not strip markdown.**

Rationale:

1. **Tokens actually consumed by the LLM include formatting symbols** — these are real cost, not "noise." Users pay for these tokens (token-billed APIs) or occupy context window with them.
2. **Format proportion is relatively stable** (10–15% of total tokens), absorbed by the coefficient's ±15% error band.
3. **Different platforms' markdown usage varies** (ChatGPT likes tables, DeepSeek likes code blocks), but the difference is within the error band.
4. **Simple to implement** — no need to introduce a markdown parser, avoiding added code complexity and performance cost.
5. **Stripping markdown is expensive**: requires parsing AST → judging which symbols are "formatting" vs. "content" (e.g. `|` is formatting in tables, content in math formulas) → easily introduces new errors.

**Conclusion**: Sample texts for coefficient calibration should **include typical markdown formatting**, so calibrated coefficients naturally include format overhead; no special handling needed at runtime.

> **Implementation status**: §4.3's coefficient matrix was measured on a corpus that "includes markdown formatting" — i.e., coefficient values already fold in format overhead. At runtime, `estimateTokens` directly applies coefficients to raw text (including markdown syntax symbols), with no stripping or special handling.

### 6. Settings Layering: General vs. Advanced

Current settings panel is flat. After adding the coefficient matrix, split into two layers:

**General Settings** (existing, unchanged):

| Setting                | Description                                |
| ---------------------- | ------------------------------------------ |
| Warning Thresholds     | dual slider: yellow / red threshold        |
| UI Language            | Auto / en / zh_CN / …                      |
| Context Limit Override | per-platform context window override       |
| Upstash Config         | REST URL / Token / Test Connection / Clear |

**Advanced Settings** (new):

| Setting                       | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| Token Estimation Coefficients | per-platform writing system coefficient override |

**UI interaction**:

- "Advanced" collapsible section at the bottom of the settings panel, collapsed by default
- When expanded, grouped by platform with one collapsible row per platform (`<details>` or accordion)
- Expand platform row → shows 6 coefficient input boxes (`<input type="number" step="0.01">`)
- Per-platform "Reset" button on the right → restores that adapter's default values
- "Reset All" button → clears all user overrides
- After saving settings, toast: "Coefficient changes take effect after refreshing the platform page"

### 7. Data Model

**Settings (local) new field**:

```typescript
// utils/settings.ts
interface Settings {
  // ... existing fields ...
  tokenCoefficients: Record<string, Partial<TokenCoefficients>>;
  // indexed by platformId, stores only overridden fields. Unoverridden fields read from adapter defaults.
}
```

**CloudSettings (cloud) new field**:

```typescript
// utils/cloud-settings.ts
interface CloudSettings {
  // ... existing fields ...
  tokenCoefficients: Record<string, Partial<TokenCoefficients>>;
}
```

`toCloudSettings` carries it; `mergeCloudSettings` does LWW merge. Credentials are never included in `tokenCoefficients` (consistent stripping logic with existing fields).

**PlatformAdapter type change**:

`tokenCoefficients` changed from optional (`?`) to required. Every adapter must provide a default coefficient set.

### 8. Runtime Effect Timing

User saves coefficient override → settings panel displays a toast "Refresh the platform page for changes to take effect" → user manually F5 → page reloads → content script injects → `PAGE_READY` → `fetchHistory` → `applyHistory` → `estimateTokens` reads new coefficients.

Hot-reload on save is not supported — conversation history has already been estimated with old coefficients; after a coefficient change, full re-estimation is needed.

## Implementation

Split into two phases. Calibration work (Phase B) is pure config data and does not block Phase A.

### Phase A — Code Infrastructure

| Step | File                                                         | Change                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `utils/estimate.ts`                                          | `TokenCoefficients` expanded to 6 fields; `estimateTokens` adds kana / hangul / cyrillic / arabic character classification and bucket counting; Unicode property escapes `\p{...}` replaces manual ranges |
| A2   | `utils/estimate.test.ts`                                     | New 6-writing-system bucket tests + mixed-script tests                                                                                                                                                    |
| A3   | `utils/platform-adapter.ts`                                  | `tokenCoefficients?` → `tokenCoefficients` (required)                                                                                                                                                     |
| A4   | `adapters/*.ts` (7 files)                                    | No change needed — already reference placeholder values, type follows automatically                                                                                                                       |
| A5   | `utils/settings.ts`                                          | `Settings` adds `tokenCoefficients` field; `getSettings` reads                                                                                                                                            |
| A6   | `utils/settings.test.ts`                                     | Add coefficient override priority tests                                                                                                                                                                   |
| A7   | `utils/cloud-settings.ts`                                    | `CloudSettings` adds `tokenCoefficients`; `toCloudSettings` carries; `mergeCloudSettings` LWW merge                                                                                                       |
| A8   | `utils/cloud-settings.test.ts`                               | Add coefficient sync + credential-stripping tests                                                                                                                                                         |
| A9   | `entrypoints/background.ts`                                  | `applyHistory` resolution chain changed to: `settings.tokenCoefficients[platformId] ?? adapter.tokenCoefficients`                                                                                         |
| A10  | `entrypoints/sidepanel/main.ts` + `index.html` + `style.css` | Settings panel refactor: General section + Advanced collapsible section; per-platform grouped coefficient inputs + Reset buttons + Reset All                                                              |
| A11  | `_locales/*/messages.json`                                   | New Advanced Settings copy keys                                                                                                                                                                           |

### Phase B — Coefficient Calibration (Config Data, Independent Track)

Output is 7 adapters × one line of config data change each; no logic changes.

#### B.1 Research + Measurement (done — see §4)

- Default models verified per platform (§4.1); tokenizer types and vocab sizes measured from actual tokenizer files (§4.2)
- Measured coefficient matrix via joint least-squares fit against all six tokenizers (§4.3); markdown overhead folded in (§5)
- Calibration harness checked in: `scripts/calibration-lib.mjs` (shared corpus + fit + validation), `scripts/calibrate-chatgpt.mjs`, `scripts/calibrate-hf.mjs`

#### B.2 Remaining

| Step | Task                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| B8   | Live spot-check 2–3 platforms with mixed-script conversations; optional server-side check of per-round chat-template overhead |

#### B.3 Sample Construction Requirements

Embodied in `scripts/calibration-lib.mjs` (the shared corpus all calibration scripts import):

- 8–10 samples per writing system (pure prose + markdown-formatted + LLM-answer-shaped), 80–400 chars each
- Samples **include typical markdown formatting** so format overhead is absorbed by coefficients (see §5)
- Mixed-script samples (zh/ja/ko/ru + en, code blocks) are held OUT of the fit and used as validation against the ±15% target

## Acceptance Criteria

> Detailed steps in [`specs/acceptance-checklist.md`](./acceptance-checklist.md).

- Japanese / Korean / Cyrillic / Arabic mixed-text estimation error within target range (determined during calibration)
- Per-platform default coefficients calibrated; matrix table has no placeholder markers remaining
- User changes coefficient in Advanced Settings → saves → refreshes page → next round estimated with new coefficient
- Per-platform "Reset" restores that adapter's default value; "Reset All" clears all overrides
- Toast after saving coefficients: "refresh platform page required"
- Coefficient overrides sync across devices
- When Upstash not configured, coefficient overrides only take effect locally

## Open Questions

- Whether to introduce a lightweight tokenizer as an optional precision upgrade (still not the default path); would fix the two accepted error modes (§4.3) — code-heavy under, ko+en over
- Re-calibration trigger: platforms swap models without notice — rerun `scripts/calibrate-*.mjs` when a default-model change is observed (tokenizer files are far more stable than product defaults)
- ChatGPT web-tier context limit: GPT-5.5 Instant model max is reported 400K–1M (sources conflict), but the web product caps per tier are unknown — adapter keeps 131,072 until verified
- Doubao production model identity (and whether its tokenizer matches Seed-OSS) remains unknown; kana coefficient is the least trustworthy value in the matrix
