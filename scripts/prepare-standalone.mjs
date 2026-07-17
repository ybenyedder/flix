// Assemble the Next.js standalone output into a self-contained, deployable
// server bundle at dist-standalone/ — the thing the Dockerfile ships, the CI
// release publishes as a tarball, and the Pterodactyl egg downloads.
//
//   dist-standalone/
//     server.js            Next standalone server (entry used by `node server.js`)
//     start.mjs            container entrypoint (port/bind/ffmpeg plumbing)
//     .next/…              compiled app + static assets
//     public/…             icons, service worker
//     node_modules/…       traced runtime deps (better-sqlite3 binding is
//                          compiled for THIS machine's Node ABI — deploy on the
//                          same major Node version you built with)
//
// Usage: node scripts/prepare-standalone.mjs [--tar <outfile.tar.gz>]
// Safe to run repeatedly.

import { existsSync, cpSync, rmSync, copyFileSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
const out = path.join(root, "dist-standalone");

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("[prepare-standalone] .next/standalone/server.js not found — run `next build` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(standalone, out, { recursive: true });

// Same prune list as prepare-desktop.mjs: the tracer copies the whole project
// root, including sources and build outputs the running server never touches.
const PRUNE = [
  // "vpn" contient gluetun.env = clé privée WireGuard Mullvad. Ne JAMAIS l'embarquer.
  "vpn", "data",
  "dist-desktop", "dist-standalone", "android-native", "test", "build", "scripts", "src", "desktop",
  "deploy", "docs", "electron-builder.yml", "Dockerfile", "docker-compose.yml", ".dockerignore",
  "eslint.config.mjs", "postcss.config.mjs", "next.config.ts", "tsconfig.json", "tsconfig.tsbuildinfo",
  "package-lock.json", ".gitignore",
];
for (const entry of PRUNE) {
  rmSync(path.join(out, entry), { recursive: true, force: true });
}

// Standalone output does not include static assets — ship them alongside.
cpSync(path.join(root, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) {
  cpSync(path.join(root, "public"), path.join(out, "public"), { recursive: true });
}

copyFileSync(path.join(root, "deploy", "container", "start.mjs"), path.join(out, "start.mjs"));

// Turbopack sometimes emits serverExternalPackages requires under a HASHED
// alias — require("better-sqlite3-90e2652d1716b047") — that nothing ever
// materialises in node_modules: the .nft.json traces reference the alias path,
// it doesn't exist, and the tracer skips missing files silently. Which chunk
// carries the hashed variant varies between builds (the container build put it
// in the shared root chunk → every DB route 500'd at runtime). Materialise
// every alias found in the compiled chunks as a symlink to its base package.
{
  const nodeModules = path.join(out, "node_modules");
  const present = new Set(readdirSync(nodeModules));
  const aliasRe = /["']((?:@[\w.-]+\/)?[\w.-]+?-[0-9a-f]{16})["']/g;
  const chunkDir = path.join(out, ".next", "server", "chunks");
  const created = [];
  for (const entry of readdirSync(chunkDir, { recursive: true })) {
    const file = String(entry);
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(path.join(chunkDir, file), "utf8");
    for (const match of source.matchAll(aliasRe)) {
      const alias = match[1];
      const base = alias.replace(/-[0-9a-f]{16}$/, "");
      // Only alias names whose base is a real traced package — filters out
      // arbitrary hash-suffixed strings that happen to match the pattern.
      if (base === alias || !present.has(base) || present.has(alias)) continue;
      try {
        symlinkSync(base, path.join(nodeModules, alias), "junction");
      } catch {
        cpSync(path.join(nodeModules, base), path.join(nodeModules, alias), { recursive: true });
      }
      present.add(alias);
      created.push(alias);
    }
  }
  if (created.length) console.log(`[prepare-standalone] materialised hashed external aliases: ${created.join(", ")}`);
}

console.log("[prepare-standalone] bundle ready at dist-standalone/ (entry: node start.mjs)");

const tarFlag = process.argv.indexOf("--tar");
if (tarFlag !== -1) {
  const outfile = process.argv[tarFlag + 1];
  if (!outfile) {
    console.error("[prepare-standalone] --tar requires an output filename");
    process.exit(1);
  }
  // -C dist-standalone . so the archive extracts flat into the target directory
  // (Pterodactyl installs into /mnt/server directly).
  execFileSync("tar", ["-czf", outfile, "-C", out, "."], { stdio: "inherit" });
  console.log(`[prepare-standalone] tarball written: ${outfile}`);
}
