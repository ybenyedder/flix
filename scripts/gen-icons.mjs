// Generates every PNG icon Flix needs — the PWA manifest set (public/icons/)
// and the electron-builder packaging set (build/icons/ + build/icon.png) —
// entirely locally from the single committed SVG source (public/icons/icon.svg).
// No network access, no external icon-generation service: sharp rasterizes the
// vector artwork directly, in-process.
//
// Safe to run repeatedly (idempotent). Re-run after editing the source SVG:
//   node scripts/gen-icons.mjs

import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const svgPath = path.join(root, "public", "icons", "icon.svg");
const publicIconsDir = path.join(root, "public", "icons");
const buildIconsDir = path.join(root, "build", "icons");
const buildDir = path.join(root, "build");

const BACKGROUND = "#141414";

const svg = readFileSync(svgPath, "utf8");

// The maskable variant needs generous uniform padding: Android/Chrome crop
// adaptive/maskable icons to a circle or squircle, discarding anything outside
// a centered "safe zone" (~80% of the canvas). Rather than crop our full-bleed
// artwork (which would clip the mark), derive a transparent-background copy of
// the same source, then re-composite it at a smaller scale over a solid canvas
// so the whole composition shrinks toward the center instead.
const markOnlySvg = svg.replace(/<rect width="512" height="512"[^/]*\/>\s*/, "");

mkdirSync(publicIconsDir, { recursive: true });
mkdirSync(buildIconsDir, { recursive: true });

async function renderSquare(source, size, dest) {
  await sharp(Buffer.from(source)).resize(size, size).png().toFile(dest);
  console.log(`[gen-icons] ${path.relative(root, dest)} (${size}x${size})`);
}

async function renderMaskable(size, dest) {
  const innerSize = Math.round(size * 0.6);
  const mark = await sharp(Buffer.from(markOnlySvg)).resize(innerSize, innerSize).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(dest);
  console.log(`[gen-icons] ${path.relative(root, dest)} (${size}x${size}, maskable safe zone)`);
}

async function main() {
  // --- PWA manifest icons (public/icons/), consumed by src/app/manifest.ts ---
  await renderSquare(svg, 192, path.join(publicIconsDir, "icon-192.png"));
  await renderSquare(svg, 512, path.join(publicIconsDir, "icon-512.png"));
  await renderMaskable(512, path.join(publicIconsDir, "maskable-512.png"));
  // Apple ignores the web manifest entirely and wants its own opaque icon
  // (no alpha) referenced via <link rel="apple-touch-icon">.
  await renderSquare(svg, 180, path.join(publicIconsDir, "apple-touch-icon.png"));

  // --- electron-builder packaging icons (build/icons/) -----------------------
  // Sizes match the Linux hicolor icon theme set electron-builder expects (see
  // /home/pc/Documents/auralis_enterprise_grade/build/icons/) so the .deb
  // installs every resolution instead of only 512 — which is what makes menus,
  // docks and panels show a correctly downscaled icon instead of a generic one.
  const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
  for (const size of LINUX_SIZES) {
    await renderSquare(svg, size, path.join(buildIconsDir, `${size}x${size}.png`));
  }
  // A single high-resolution square PNG that electron-builder's bundled
  // app-builder tool (already vendored locally in node_modules/app-builder-bin —
  // no download at build time) converts to .ico for the Windows NSIS/portable
  // targets (see electron-builder.yml's `win.icon`).
  await renderSquare(svg, 1024, path.join(buildDir, "icon.png"));

  console.log("[gen-icons] done.");
}

main().catch((error) => {
  console.error("[gen-icons] failed:", error);
  process.exitCode = 1;
});
