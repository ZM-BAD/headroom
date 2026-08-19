/**
 * B2/B3/B4/B5/B6 — coefficient calibration against open-weights tokenizers
 * from Hugging Face (spec 004 §B.2). Exact local verification where the web
 * platform's model family is open; nearest open sibling as proxy otherwise.
 *
 *   DeepSeek  → deepseek-ai/DeepSeek-V4-Flash    (EXACT: web default is V4 Pro/Flash, same tokenizer)
 *   Qwen/千问 → Qwen/Qwen3.6-27B                 (proxy: web default Qwen 3.7 plus is closed;
 *                                                  3.6 is the newest open sibling, vocab 248320)
 *   Kimi      → moonshotai/Kimi-K2.6             (EXACT: web default; tiktoken-format vocab file)
 *   Gemini    → google/gemma-4-12B-it            (proxy: Gemini 3.5 tokenizer not public;
 *                                                  Gemma 4 is the Google open family, vocab 262144)
 *   Doubao    → ByteDance-Seed/Seed-OSS-36B      (proxy: Doubao 2.1 not public; ByteDance's
 *                                                  open family, vocab 155136)
 *
 * Run:  npm i --no-save tiktoken @huggingface/transformers
 *       node --experimental-strip-types scripts/calibrate-hf.mjs
 *
 * Tokenizer files are fetched from the HF Hub on first run and cached under
 * /tmp/headroom-hf-cache. Kimi ships a tiktoken-format vocab (tiktoken.model)
 * instead of tokenizer.json, so it is loaded through the tiktoken wasm core
 * with the pat_str from moonshotai's tokenization_kimi.py.
 */
import { AutoTokenizer, env } from "@huggingface/transformers";
import { Tiktoken } from "tiktoken";
import { runCalibration, CORPUS } from "./calibration-lib.mjs";

env.cacheDir = "/tmp/headroom-hf-cache";

// spec 006: the tool-text corpus is NOT merged into the fit — dialogue prose
// dominates real context, and merging pulls latin up (English technical
// snippets) which overestimates English prose by 15–35%. Tool text is
// instead handled by the digit-run sub-word engine (estimate.ts, shared) and
// VALIDATED against the tool corpus in calibrate-tool-text.mjs (not fitted).

const HUB_MODELS = [
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    label: "DeepSeek — DeepSeek-V4-Flash tokenizer (exact, vocab 129,280)",
  },
  {
    id: "Qwen/Qwen3.6-27B",
    label: "Qwen / 通义千问 — Qwen3.6-27B tokenizer (open sibling of 3.7 plus, vocab 248,320)",
  },
  {
    id: "google/gemma-4-12B-it-qat-q4_0-unquantized",
    label: "Gemini proxy — Gemma 4 tokenizer (SentencePiece-style, vocab 262,144)",
  },
  {
    id: "ByteDance-Seed/Seed-OSS-36B-Instruct",
    label: "Doubao proxy — Seed-OSS-36B tokenizer (vocab 155,136)",
  },
];

for (const m of HUB_MODELS) {
  const tok = await AutoTokenizer.from_pretrained(m.id);
  await runCalibration(
    m.label,
    (text) => tok.encode(text, { add_special_tokens: false }).length,
    CORPUS,
  );
}

// —— Kimi K2.6: tiktoken-format vocab + the pat_str from tokenization_kimi.py
// (Rust regex class intersection [..&&[^\p{Han}]] is supported by the tiktoken
// wasm core — same engine the Python reference implementation uses). ——
const KIMI_VOCAB = "/tmp/headroom-tokenizers/kimi-tiktoken.model";
const KIMI_PAT = [
  String.raw`[\p{Han}]+`,
  String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
  String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?`,
  String.raw`\p{N}{1,3}`,
  String.raw` ?[^\s\p{L}\p{N}]+[\r\n]*`,
  String.raw`\s*[\r\n]+`,
  String.raw`\s+(?!\S)`,
  String.raw`\s+`,
].join("|");

const kimi = new Tiktoken(readFileSync(KIMI_VOCAB, "utf8"), {}, KIMI_PAT);
try {
  await runCalibration(
    "Kimi — Kimi-K2.6 tiktoken vocab (exact, vocab 163,840)",
    (text) => kimi.encode(text).length,
  );
} finally {
  kimi.free();
}
