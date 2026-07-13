/**
 * Render extension toolbar icons from SVG sources.
 *
 * Reads brand/blue.svg (color) and brand/gray.svg (gray) and renders
 * them to PNG at the sizes the manifest declares (16, 48, 128).
 *
 * Usage: node scripts/generate-icons.mjs
 *
 * The gray variant is a luminance-preserving grayscale conversion of the
 * original — not a simple desaturate. The gradient contrast is preserved so
 * the gray bars remain distinguishable. This is the "disabled" icon used by
 * the 3-dimensional ACL workaround (see AGENTS.md MV3 gotchas).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BRAND_DIR = resolve(ROOT, "brand");
const OUT_DIR = resolve(ROOT, "public", "icon");

const SIZES = [16, 48, 128];

const SOURCES = [
  { svg: "blue.svg", suffix: "", label: "color" },
  { svg: "gray.svg", suffix: "-gray", label: "gray" },
];

for (const { svg, suffix, label } of SOURCES) {
  const svgPath = resolve(BRAND_DIR, svg);
  const svgBuffer = readFileSync(svgPath);

  for (const size of SIZES) {
    const outPath = resolve(OUT_DIR, `${size}${suffix}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`  ${label} ${size}x${size} → ${outPath}`);
  }
}

console.log("Done.");
