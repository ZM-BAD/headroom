/**
 * Tool-text estimation validation (spec 006, final): with the digit-run
 * sub-word engine in utils/estimate.ts (numbers counted per \p{N}{1,3} chunk
 * instead of as one word) and the SHIPPED spec-004 coefficients (re-fitted
 * 2026-08-17 — nearly unchanged, the corpus has almost no digits), is the
 * real tool-text corpus (live search snippets, scripts/tool-corpus/) within
 * the ±15% target?
 *
 * History: the spec-004 coefficients alone UNDERESTIMATED tool text by
 * 20–45% (dense digits/dates/URLs counted as single words); a per-platform
 * tool-coefficient fit was attempted and rejected (corpus too bimodal — fits
 * either overcorrected Chinese or blew up latin). The engine fix (digit
 * chunking) removes the largest bias source for BOTH dialogue and tool text
 * with ONE coefficient set — no toolCoefficients field needed.
 *
 * Run (same deps as calibrate-hf.mjs):
 *   npm i --no-save tiktoken @huggingface/transformers
 *   node --experimental-strip-types scripts/calibrate-tool-text.mjs
 */
import { readFileSync } from "node:fs";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { get_encoding, Tiktoken } from "tiktoken";
import { estimateTokens } from "../utils/estimate.ts";
// Coefficients come from the SHIPPED adapters — never hardcode a copy that
// drifts (this script is the spec-006 regression gate; it must validate what
// actually ships).
import { kimiAdapter } from "../adapters/kimi.ts";
import { qwenAdapter } from "../adapters/qwen.ts";
import { qianwenAdapter } from "../adapters/qianwen.ts";
import { doubaoAdapter } from "../adapters/doubao.ts";
import { chatgptAdapter } from "../adapters/chatgpt.ts";

env.cacheDir = "/tmp/headroom-hf-cache";

const COEFFS = {
  Kimi: kimiAdapter.tokenCoefficients,
  Qwen: qwenAdapter.tokenCoefficients,
  Qianwen: qianwenAdapter.tokenCoefficients,
  Doubao: doubaoAdapter.tokenCoefficients,
  ChatGPT: chatgptAdapter.tokenCoefficients,
};

const readCorpus = (name) =>
  JSON.parse(readFileSync(`./scripts/tool-corpus/${name}.json`, "utf8"));

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
const chatgpt = get_encoding("o200k_base");
const qwenTok = await AutoTokenizer.from_pretrained("Qwen/Qwen3.6-27B");
const doubaoTok = await AutoTokenizer.from_pretrained("ByteDance-Seed/Seed-OSS-36B-Instruct");

const RUNS = [
  { platform: "Kimi", coeff: COEFFS.Kimi, corpus: readCorpus("kimi"), encode: (t) => kimi.encode(t).length },
  { platform: "Qwen", coeff: COEFFS.Qwen, corpus: readCorpus("qwen"), encode: (t) => qwenTok.encode(t, { add_special_tokens: false }).length },
  { platform: "Qianwen", coeff: COEFFS.Qianwen, corpus: readCorpus("qianwen"), encode: (t) => qwenTok.encode(t, { add_special_tokens: false }).length },
  { platform: "Doubao", coeff: COEFFS.Doubao, corpus: readCorpus("doubao"), encode: (t) => doubaoTok.encode(t, { add_special_tokens: false }).length },
  { platform: "ChatGPT", coeff: COEFFS.ChatGPT, corpus: ['search("@网页搜索 2026年8月14日今天有什么重要新闻?")', 'search("帮我查一下 React 19 的最新发布信息")'], encode: (t) => chatgpt.encode(t).length },
];

let globalWorst = 0;
let globalWorstInfo = "";
for (const { platform, coeff, corpus, encode } of RUNS) {
  console.log(`\n==== ${platform} — tool text with digit-run engine + shipped coefficients (${corpus.length} samples) ====`);
  let worst = 0;
  let worstText = "";
  let totalActual = 0;
  let totalEst = 0;
  for (const t of corpus) {
    const actual = await encode(t);
    const est = estimateTokens(t, coeff);
    const err = ((est - actual) / actual) * 100;
    totalActual += actual;
    totalEst += est;
    if (Math.abs(err) > worst) { worst = Math.abs(err); worstText = t.slice(0, 34); }
    console.log(`  actual ${String(actual).padStart(5)}  est ${String(Math.round(est)).padStart(5)}  err ${err >= 0 ? "+" : ""}${err.toFixed(1)}%${Math.abs(err) > 15 ? "  ⚠" : ""}  | ${t.slice(0, 34)}`);
  }
  const totalErr = ((totalEst - totalActual) / totalActual) * 100;
  console.log(`  worst ${worst.toFixed(1)}% (${worstText}...) | aggregate ${totalErr >= 0 ? "+" : ""}${totalErr.toFixed(1)}% ${worst <= 15 ? "WITHIN ±15%" : "OVER ±15%"}`);
  if (worst > globalWorst) { globalWorst = worst; globalWorstInfo = `${platform} (${worstText})`; }
}

kimi.free();
chatgpt.free();
console.log(`\nGLOBAL worst: ${globalWorst.toFixed(1)}% (${globalWorstInfo})`);
