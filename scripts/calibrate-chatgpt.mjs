/**
 * B1 — ChatGPT coefficient calibration against tiktoken o200k_base (spec 004 §B.2).
 *
 * Run:  npm i --no-save tiktoken
 *       node --experimental-strip-types scripts/calibrate-chatgpt.mjs
 *
 * Corpus, bucket counting (via the real estimateTokens engine), least-squares
 * fit, and held-out validation all live in scripts/calibration-lib.mjs.
 */
import { get_encoding } from "tiktoken";
import { runCalibration } from "./calibration-lib.mjs";

const enc = get_encoding("o200k_base");
try {
  await runCalibration("ChatGPT — tiktoken o200k_base (exact, local)", (text) => {
    return enc.encode(text).length;
  });
} finally {
  enc.free();
}
