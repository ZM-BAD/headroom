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

**Digit-run sub-word counting (added 2026-08-17, spec 006)**: consecutive `\p{N}` characters are counted per `\p{N}{1,3}` chunk (BPE tokenizers split digit strings into 1–3-digit tokens — Kimi's pat_str literally carries `\p{N}{1,3}`), NOT as part of the surrounding word. Without this, a dense date/number string ("2026年8月11日") measured as ONE latin word (~1.4 tokens) while the real tokenizer emits ~4–5 — a measured 20–45% UNDERESTIMATE on tool text (search snippets, dates, stats; spec 006 §calibration). Digit chunks ride the latin bucket. All coefficients were re-fitted after this change (2026-08-17; shifts ≤0.02 — the prose corpus has almost no digits).

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

Current default models per platform web version (2026-08-20, adversarially verified web research — 3-vote per claim; refreshed 2026-08-20 after the model-default wave of Jul–Aug 2026):

| Platform       | Default Model                 | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT        | GPT-5.6 (Luna / Sol)          | Confirmed — GPT-5.6 family (Sol/Terra/Luna) launched 2026-07-09; **Luna replaced GPT-5.5 Instant as free default on 2026-08-06**; updated Sol is default for Plus/Pro. **Tokenizer confirmed o200k_base** (tiktoken mappings + community, 2026-08). **API context 1.05M (1,050,000) all tiers** (official docs, 128K max output) — **but the web app enforces per-plan caps** (openai.com pricing 2026-08): Free 27K / Go·Plus·Business 54K / Pro 128K instant. The gauge monitors the web product → plugin default = **27K (Free)**, user-overridable per plan (hint under the settings row) |
| DeepSeek       | DeepSeek V4 (Flash / Pro)     | Confirmed — V4 GA on 2026-07-15 (Preview label dropped); V4-Flash stable API 2026-07-31; V4-Pro-0813 stable 2026-08-13. Instant Mode = V4-Flash (284B), Expert Mode = V4-Pro (1.6T); 1M context                                                                                                                                                                                                                                                                                                                                                                                               |
| Qwen           | Qwen 3.8 Max                  | Confirmed — released 2026-08-03 (preview live since 07-19); the official release post points to Qwen Chat as the default way to try it; **1M context**; open weights shipped 2026-08-12 — 2.4T-A95B (first Max-class open weights, custom license) + 27B dense (Apache-2.0). **3.8's open tokenizer ships byte-identical vocab.json + merges.txt as 3.6** (md5-verified 2026-08-20) — exact coefficients carry over                                                                                                                                                                           |
| Tongyi Qianwen | Qwen 3.8 Max (presumed)       | Unverified — presumed same Qwen family (千问 API platform docs list `qwen3.8-max` as latest model; user-confirmed on qianwen web 2026-08-20)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Kimi           | Kimi K3                       | Confirmed — default on kimi.com since 2026-07-16; open weights 2026-07-27; **1M context**. Coefficients fitted on the open Kimi tiktoken vocab — K3's open weights ship the byte-identical file (md5-verified 2026-08-20), exact calibration carries over                                                                                                                                                                                                                                                                                                                                     |
| Gemini         | Gemini 3.6 Flash              | Confirmed — default on gemini.google.com since 2026-07-21 (replaced 3.5 Flash); model card states "up to 1M" context / 64K output. **No per-plan web caps** (unlike ChatGPT — free tier gets the full 1M; limits are rate-based, 15 RPM); tokenizer proxy (Gemma 4) remains the only open proxy, 3.6 unconfirmed unchanged                                                                                                                                                                                                                                                                    |
| Doubao         | Doubao Seed 2.1 (Pro / Turbo) | Confirmed — launched 2026-06-23 (Volcano Engine FORCE); production IDs `doubao-seed-2-1-pro-260628` / `doubao-seed-2-1-turbo-260628`, turbo build refreshed 2026-08-10; 256K context; **web default = 2.1 Turbo (free) / 2.1 Pro (专业版)** — web-tier cap unconfirmed (single pre-2.1 user report of 32K on the 2.0-pro era; not authoritative)                                                                                                                                                                                                                                              |

Key verification sources: [DeepSeek V4 official announcement](https://api-docs.deepseek.com/news/news260424/) · [DeepSeek V4 GA timeline (2026-07-15/07-31/08-13)](https://cloud.tencent.cn/developer/article/2712893) · [Kimi K3 launch (web default 2026-07-16)](https://emergent.sh/news/kimi-k3-launch) · [GPT-5.6 family + Luna default](https://itbrief.co.uk/story/openai-widens-free-chatgpt-access-with-gpt-5-6-update) · [Gemini 3.6 Flash default](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/) · [Doubao Seed 2.1](https://tech.ifeng.com/c/8uBalPRxcZq) · [Seed 2.1 Turbo 2026-08-10 build](https://www.orcarouter.ai/blog/seed-2-1-turbo-build-20260810) · [Qwen3.8-Max release](https://incrypted.com/en/qwen3-8-max-review/) · [Qwen3.8 open weights (2.4T-A95B + 27B)](https://m.163.com/dy/article_v5/L4613T3I05561FZO.html) · [千问平台最新模型文档](https://platform.qianwenai.com/docs/developer-guides/getting-started/latest-model) · [o200k_base for gpt-4o and later](https://community.openai.com/t/tokenizer-latest-chat-gpt-models/1371076) · [Gemma ships the same tokenizer as Gemini](https://developers.googleblog.com/en/gemma-explained-whats-new-in-gemma-3/). Full research report with the evidence chain: git `d9ec75d` (`report.md`).

#### 4.2 Tokenizers and Vocabularies

A tokenizer is bound to a model at training time. Types and vocab sizes below are **measured from the actual tokenizer files** (not model-card claims):

| Platform       | Tokenizer                                                                       | Vocab Size | Calibration source (fidelity)                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT        | tiktoken `o200k_base` (byte-BPE)                                                | 200,019    | `tiktoken` npm, o200k_base (**exact** — gpt-4o through GPT-5.6 all use o200k_base; 5.6 family confirmed 2026-08 via tiktoken mappings + community verification)                                                                                                                                                                                                                           |
| DeepSeek       | BPE `tokenizer.json` (`PreTrainedTokenizerFast`)                                | 129,280    | [deepseek-ai/DeepSeek-V4-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) (**exact** — production model is open; same vocab as V3)                                                                                                                                                                                                                                            |
| Qwen           | BBPE, `Qwen2Tokenizer` lineage                                                  | 248,320    | [Qwen/Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B) (**exact BPE** — web default Qwen3.8-Max's open weights ([2.4T-A95B](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B) / [27B](https://huggingface.co/Qwen/Qwen3.8-27B-FP8)) ship byte-identical vocab.json + merges.txt, md5-verified 2026-08-20; only diff is 7 TTS/audio added tokens. NOT the old dense-Qwen3 151,936 vocab) |
| Tongyi Qianwen | Same as Qwen                                                                    | 248,320    | Same as above                                                                                                                                                                                                                                                                                                                                                                             |
| Kimi           | tiktoken-format BPE (`tiktoken.model` + Han-aware `pat_str`, no tokenizer.json) | 163,584    | [moonshotai/Kimi-K3](https://huggingface.co/moonshotai/Kimi-K3) (**exact** — web default since 2026-07-16; K3's open weights ship the byte-identical `tiktoken.model` + `PATTERN` regex the coefficients were fitted on, md5-verified 2026-08-20; 163,584 entries measured from the file, official materials round to 160K)                                                               |
| Gemini         | SentencePiece (Gemini-family)                                                   | 262,144    | [google/gemma-4-12B-it-qat-q4_0-unquantized](https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-unquantized) (**proxy** — Gemma 4 (2026-04) is the current open Google family (all variants share the 262K SentencePiece vocab); Google's "same tokenizer as Gemini" claim dates to the Gemma 3/Gemini 3 era; 3.6 Flash unconfirmed unchanged)                                         |
| Doubao         | BPE + ByteLevel (`PreTrainedTokenizerFast`)                                     | 155,136    | [ByteDance-Seed/Seed-OSS-36B-Instruct](https://huggingface.co/ByteDance-Seed/Seed-OSS-36B-Instruct) (**proxy** — same ByteDance Seed team; production model closed; Seed-OSS-36B remains the latest open Seed LLM as of 2026-08, no newer proxy exists)                                                                                                                                   |

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
- ChatGPT web-tier context limit: RESOLVED (2026-08) — web caps confirmed per plan (openai.com pricing): Free 27K / Go·Plus·Business 54K / Pro 128K instant; adapter defaults to 27K (Free); the API's 1.05M does not apply to chatgpt.com
- Doubao: production identity RESOLVED (2026-08) — Seed 2.1 Pro/Turbo (2026-06-23); web default = 2.1 Turbo (free) / Pro (专业版). Tokenizer still closed — Seed-OSS-36B remains the only open proxy (no newer open Seed LLM); kana coefficient is the least trustworthy value in the matrix; web-tier context cap unconfirmed (single pre-2.1 user report of 32K on the 2.0-pro era)
