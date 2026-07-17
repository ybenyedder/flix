import fs from "fs";
import path from "path";
import { getConfig, setMediaDir } from "@/server/config";
import { runScan } from "@/server/library/scanner";
import { requireAdmin, checkCsrf, readJsonBody, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → the current media source folder (and whether it exists on disk).
// Admin-only: the absolute host path is operator-level information.
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { mediaDir } = getConfig();
  return json({ mediaDir, exists: fs.existsSync(mediaDir) });
}

// POST { dir } → repoint the library at a host-chosen folder, then rescan.
// Admin-only: repointing the root neutralises every per-file path guard, so a
// non-admin must never reach this (it would expose arbitrary host video files).
export async function POST(request: Request) {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = await readJsonBody<{ dir?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const raw = typeof parsed.body.dir === "string" ? parsed.body.dir.trim() : "";
  if (!raw) return json({ error: "Chemin de dossier requis" }, { status: 400 });

  const abs = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return json({ error: "Dossier introuvable" }, { status: 400 });
  }
  if (!stat.isDirectory()) return json({ error: "Le chemin n'est pas un dossier" }, { status: 400 });

  setMediaDir(abs);
  const scan = await runScan();
  return json({ mediaDir: abs, scan });
}
