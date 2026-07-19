// Prepare the Next.js standalone output for packaging inside Electron.
//
//   1. Copies `.next/standalone` into `dist-electron-server/` and works ONLY on
//      that copy. It used to patch `.next/standalone` in place — which left an
//      Electron-ABI better_sqlite3.node inside it, so any prepare-standalone.mjs
//      run AFTER a desktop build (without re-running `next build`) shipped a
//      server tarball whose DB binding crashes under Node ("NODE_MODULE_VERSION
//      mismatch"). The pristine tree now stays pristine.
//   2. Next's standalone build does not copy the static asset folders, so we copy
//      `.next/static` and `public` next to the standalone server.
//   3. The bundled `better-sqlite3` native binding must match Electron's ABI (the
//      desktop server runs under ELECTRON_RUN_AS_NODE). We compile it against the
//      Electron headers in a throwaway copy of the module — so the project's own
//      node_modules stays Node-ABI and the web/dev workflow keeps working — then
//      drop the resulting .node into the copied server.
//   4. Ships desktop/server-shim.js next to server.js: main.js forks the shim,
//      which exits when the Electron main process dies (see the shim's comment).
//
// Safe to run repeatedly. Requires `electron`, a C toolchain and network access
// (to fetch the Electron headers) for the rebuild step — a build-time dependency
// only; the packaged app itself never makes a network call.
//
// Model: /home/pc/Documents/auralis_enterprise_grade/scripts/prepare-desktop.mjs

import { existsSync, cpSync, mkdirSync, rmSync, copyFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
const serverOut = path.join(root, "dist-electron-server");

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("[prepare-desktop] .next/standalone/server.js not found — run `next build` first.");
  process.exit(1);
}

// 0. Work on a copy ----------------------------------------------------------
rmSync(serverOut, { recursive: true, force: true });
cpSync(standalone, serverOut, { recursive: true });
console.log("[prepare-desktop] copied .next/standalone -> dist-electron-server (source tree left untouched)");

// 0b. Prune non-runtime cruft ------------------------------------------------
// Next's standalone tracer copies the whole project root, including build
// outputs, deploy infra and the native-app sources. Left in, they balloon the
// package and expose operator infra for nothing. Keep this list a SUPERSET of
// prepare-standalone.mjs's — the desktop artefact is the most widely
// distributed one.
// "vpn"/"data" = secrets runtime (clé WireGuard Mullvad) : ne JAMAIS empaqueter.
const PRUNE = [
  "vpn", "data",
  "dist-desktop", "dist-standalone", "dist-electron-server", "android-native", "test", "build", "scripts", "src", "desktop",
  "deploy", "docs", "media", "videos",
  "electron-builder.yml", "Dockerfile", ".dockerignore", ".github", ".gitignore",
  "docker-compose.yml", "docker-compose.arr.yml", "docker-compose.vpn.yml", "docker-compose.dns.yml", "docker-compose.podman.yml",
  "eslint.config.mjs", "postcss.config.mjs", "next.config.ts", "tsconfig.json", "tsconfig.tsbuildinfo",
  "package-lock.json",
];
for (const entry of PRUNE) {
  rmSync(path.join(serverOut, entry), { recursive: true, force: true });
}
console.log(`[prepare-desktop] pruned standalone cruft: ${PRUNE.join(", ")}`);

// 1. Static assets ----------------------------------------------------------
cpSync(path.join(root, ".next", "static"), path.join(serverOut, ".next", "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) {
  cpSync(path.join(root, "public"), path.join(serverOut, "public"), { recursive: true });
}
console.log("[prepare-desktop] copied static assets + public/");

// 1b. Server lifecycle shim --------------------------------------------------
copyFileSync(path.join(root, "desktop", "server-shim.js"), path.join(serverOut, "server-shim.js"));

// 1c. Hashed external aliases -------------------------------------------------
// Turbopack sometimes emits serverExternalPackages requires under a hashed
// alias ("better-sqlite3-<16hex>") that nothing materialises in node_modules —
// the .nft.json traces point at a path that doesn't exist and the tracer skips
// it silently, so the require fails at runtime in whichever routes ended up in
// that chunk. Same fix as scripts/prepare-standalone.mjs: link alias → base.
{
  const nodeModules = path.join(serverOut, "node_modules");
  const present = new Set(readdirSync(nodeModules));
  const aliasRe = /["']((?:@[\w.-]+\/)?[\w.-]+?-[0-9a-f]{16})["']/g;
  const chunkDir = path.join(serverOut, ".next", "server", "chunks");
  for (const entry of readdirSync(chunkDir, { recursive: true })) {
    const file = String(entry);
    if (!file.endsWith(".js")) continue;
    for (const match of readFileSync(path.join(chunkDir, file), "utf8").matchAll(aliasRe)) {
      const alias = match[1];
      const base = alias.replace(/-[0-9a-f]{16}$/, "");
      if (base === alias || !present.has(base) || present.has(alias)) continue;
      try {
        symlinkSync(base, path.join(nodeModules, alias), "junction");
      } catch {
        cpSync(path.join(nodeModules, base), path.join(nodeModules, alias), { recursive: true });
      }
      present.add(alias);
      console.log(`[prepare-desktop] materialised hashed external alias: ${alias}`);
    }
  }
}

// 2. Native module for Electron's ABI --------------------------------------
function electronVersion() {
  try {
    return JSON.parse(readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

const version = electronVersion();
if (!version) {
  console.warn("[prepare-desktop] electron not installed — skipping native rebuild. Install desktop deps before packaging.");
  process.exit(0);
}

const srcModule = path.join(root, "node_modules", "better-sqlite3");
const tmp = path.join(os.tmpdir(), "flix-bsq-electron");
const arch = process.arch;

rmSync(tmp, { recursive: true, force: true });
cpSync(srcModule, tmp, { recursive: true });

try {
  execSync(
    `npx --yes node-gyp rebuild --release --target=${version} --arch=${arch} --dist-url=https://electronjs.org/headers`,
    { stdio: "inherit", cwd: tmp },
  );
} catch (error) {
  console.error("[prepare-desktop] native rebuild failed:", error.message);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const built = path.join(tmp, "build", "Release", "better_sqlite3.node");
const dest = path.join(serverOut, "node_modules", "better-sqlite3", "build", "Release");
mkdirSync(dest, { recursive: true });
copyFileSync(built, path.join(dest, "better_sqlite3.node"));
rmSync(tmp, { recursive: true, force: true });
console.log(`[prepare-desktop] better-sqlite3 compiled for Electron ${version} (${arch})`);
