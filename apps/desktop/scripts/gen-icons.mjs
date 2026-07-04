// Generate the Arke desktop app icons (SPEC-022) from the brand SVG. Produces the platform formats
// electron-builder consumes from `build/`: icon.png (Linux), icon.ico (Windows), icon.icns (macOS).
// Run: node scripts/gen-icons.mjs  (or `npm run icons -w @arke/desktop`).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import iconGen from "icon-gen";

const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "build-resources");
const svg = readFileSync(resolve(buildDir, "icon.svg"));

// 1) Rasterise the brand SVG → a 1024×1024 master PNG (also the Linux icon).
const master = resolve(buildDir, "icon.png");
await sharp(svg, { density: 384 }).resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(master);
console.log("wrote", master);

// 2) Master PNG → Windows .ico + macOS .icns (multi-resolution).
await iconGen(master, buildDir, {
  report: true,
  ico: { name: "icon", sizes: [16, 24, 32, 48, 64, 128, 256] },
  icns: { name: "icon", sizes: [16, 32, 64, 128, 256, 512, 1024] },
});
console.log("wrote icon.ico + icon.icns in", buildDir);
