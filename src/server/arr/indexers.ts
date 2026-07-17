// Public indexer catalogue + live "add indexer packs" orchestration.
//
// Flix's *arr stack ships with only FlareSolverr auto-configured; enabling actual
// search sources is otherwise a manual step in the Prowlarr UI. This module lets
// the operator add whole packs of curated PUBLIC (no-account) indexers straight
// from Flix's Settings — the same definitions the deploy-time FLIX_ARR_INDEXERS
// env var seeds, kept in sync with deploy/arr/arr-init.mjs.
//
// Every source here is `type: public` in Prowlarr's definitions repo (no login),
// so nothing stored here is a credential. Public sources are legally sensitive
// and flaky (geo-blocks, Cloudflare) — that's why this is opt-in and each add is
// reported individually rather than being all-or-nothing.
//
// Server-only. Talks exclusively to the operator's own Prowlarr (via client.ts,
// itself hard-gated on isArrEnabled()).

import {
  ArrError,
  prowlarrIndexers,
  prowlarrIndexerSchemas,
  prowlarrAddIndexer,
  prowlarrTags,
  prowlarrAddTag,
  prowlarrIndexerProxies,
  prowlarrIndexerProxySchemas,
  prowlarrAddIndexerProxy,
  type ProwlarrSchema,
  type ProwlarrSchemaField,
} from "./client";

// --- catalogue ---------------------------------------------------------------

export type IndexerPresetKey = "public" | "anime" | "fr" | "ru";

export interface IndexerPreset {
  label: string;
  description: string;
  /** Prowlarr definition names (verified to exist & be public). */
  defs: string[];
}

/** Curated packs of public indexers. Definition names match Prowlarr's repo
 *  (github.com/Prowlarr/Indexers). Keep this in sync with the mirror in
 *  deploy/arr/arr-init.mjs (INDEXER_PRESETS). */
export const INDEXER_PRESETS: Record<IndexerPresetKey, IndexerPreset> = {
  public: {
    label: "Publics (films & séries)",
    description: "Grand jeu de trackers publics anglophones vérifiés fiables : The Pirate Bay, 1337x, YTS, EZTV, LimeTorrents, TorrentProject, Knaben, TorrentsCSV, MagnetDownload, DaMagNet, BTdirectory, showRSS, Internet Archive…",
    defs: [
      "thepiratebay",
      "1337x",
      "yts",
      "eztv",
      "limetorrents",
      "torrentproject2",
      "uindex",
      "internetarchive",
      "knaben",
      "torrentscsv",
      "torrentcore",
      "magnetdownload",
      "damagnet",
      "btdirectory",
      "showrss",
    ],
  },
  anime: {
    label: "Anime",
    description: "Sources publiques spécialisées anime : Nyaa, Tokyo Toshokan, Shana Project, ACG.RIP, DMHY, SubsPlease.",
    defs: ["nyaasi", "tokyotosho", "shanaproject", "acgrip", "dmhy", "subsplease"],
  },
  fr: {
    label: "Français",
    description: "Tracker public francophone : Torrent9.",
    defs: ["torrent9"],
  },
  ru: {
    label: "Russe",
    description: "Tracker public russophone : Rutor.",
    defs: ["rutor"],
  },
};

/** Cloudflare-protected sources — routed through FlareSolverr (registered as a
 *  Prowlarr proxy) so their challenge gets solved. Normalised names. */
export const CF_INDEXER_KEYS = new Set(["1337x", "eztv", "torrent9", "uindex", "dmhy", "torrentcore"]);

const FLARESOLVERR_URL = "http://flaresolverr:8191";
const FLARESOLVERR_TAG = "flaresolverr";

/** Normalise an indexer name so "The Pirate Bay" === "thepiratebay". */
export function normIndexerName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** The selection token that means "every PUBLIC definition Prowlarr knows" —
 *  the whole catalogue (hundreds of sources), not just the curated packs. It
 *  expands against the live schema list, so it can't be resolved statically. */
export const EVERYTHING_KEY = "everything";

/** Whether a selection asks for the full public catalogue. */
export function selectionWantsEverything(raw: string): boolean {
  return String(raw || "")
    .split(",")
    .some((t) => t.trim().toLowerCase() === EVERYTHING_KEY);
}

/** The schemas the "everything" mode may auto-add: public (no-account) only —
 *  private/semi-private definitions need credentials we don't have. */
export function filterPublicSchemas<T extends Pick<ProwlarrSchema, "privacy" | "name" | "definitionName">>(schemas: T[]): T[] {
  return schemas.filter((s) => String(s.privacy || "").toLowerCase() === "public" && (s.name || s.definitionName));
}

/** Expand a selection string into a deduped, ordered list of definition names.
 *  Each comma token is a preset key ("public"/"anime"/"fr"/"ru"), the special
 *  "all" (every preset), or a literal Prowlarr definition name. The special
 *  "everything" token is consumed here (see selectionWantsEverything) — it only
 *  expands against the live Prowlarr schema list, inside addIndexers(). */
export function resolveIndexerSelection(raw: string): string[] {
  const tokens = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const key = normIndexerName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === EVERYTHING_KEY) {
      continue; // resolved live against Prowlarr's schema list
    } else if (lower === "all") {
      for (const preset of Object.values(INDEXER_PRESETS)) preset.defs.forEach(push);
    } else if (lower in INDEXER_PRESETS) {
      INDEXER_PRESETS[lower as IndexerPresetKey].defs.forEach(push);
    } else {
      // A literal definition name — Prowlarr rejects unknown ones and we report
      // them as "failed" rather than guessing.
      push(token);
    }
  }
  return out;
}

// --- FlareSolverr (best-effort) ----------------------------------------------

function setField(fields: ProwlarrSchemaField[], name: string, value: unknown): void {
  const f = fields.find((x) => x.name === name);
  if (f) f.value = value;
}

async function ensureTag(label: string): Promise<number> {
  const existing = await prowlarrTags();
  const found = existing.find((t) => t.label === label);
  if (found) return found.id;
  const created = await prowlarrAddTag(label);
  return created.id;
}

/** Register FlareSolverr as a Prowlarr indexer proxy and return the tag id that
 *  routes an indexer through it. Idempotent, never throws (returns null on any
 *  failure — CF indexers just get added without the proxy then). */
async function ensureFlareSolverr(): Promise<number | null> {
  try {
    const tagId = await ensureTag(FLARESOLVERR_TAG);
    const existing = await prowlarrIndexerProxies();
    if (existing.some((p) => String(p.implementation).toLowerCase() === "flaresolverr")) return tagId;
    const schemas = await prowlarrIndexerProxySchemas();
    const schema = schemas.find((s) => String(s.implementation).toLowerCase() === "flaresolverr");
    if (!schema) return tagId;
    const fields = Array.isArray(schema.fields) ? schema.fields.map((f) => ({ name: f.name, value: f.value })) : [];
    setField(fields, "host", FLARESOLVERR_URL);
    await prowlarrAddIndexerProxy({
      name: "FlareSolverr",
      implementation: schema.implementation,
      implementationName: schema.implementationName,
      configContract: schema.configContract,
      fields,
      tags: [tagId],
    });
    return tagId;
  } catch {
    return null;
  }
}

// --- add ---------------------------------------------------------------------

export interface AddIndexersResult {
  /** Newly enabled, with whether they route via FlareSolverr. */
  added: { name: string; viaFlare: boolean }[];
  /** Already present in Prowlarr — left untouched. */
  skipped: string[];
  /** Could not be added (unknown definition, geo-block, CF, …). */
  failed: { name: string; reason: string }[];
  /** Definitions still waiting for an attempt (per-call batch cap) — the caller
   *  POSTs again, passing the failed names as `exclude`, until this hits 0. */
  remaining: number;
  /** Total indexers configured in Prowlarr after this run. */
  total: number;
}

/** Whether a failure message smells like a Cloudflare challenge — those get one
 *  retry routed through FlareSolverr before being reported as failed. */
export function looksCloudflareBlocked(message: string): boolean {
  return /forbidden|cloudflare|\b403\b/i.test(message);
}

/** Turn a raw Prowlarr/arrFetch error into a short, human French reason for the
 *  UI — public indexers fail in a few recognisable ways. */
export function classifyAddFailure(message: string): string {
  const m = message.toLowerCase();
  if (looksCloudflareBlocked(m)) return "bloqué par Cloudflare (403)";
  if (/unauthorized|\b401\b|api ?key|apikey/.test(m)) return "nécessite une clé API / un compte";
  if (/timed out|timeout|n'a pas répondu|aborted|injoignable/.test(m)) return "site injoignable (délai dépassé)";
  if (/not found|introuvable|\b404\b/.test(m)) return "introuvable";
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? clean.slice(0, 117) + "…" : clean;
}

/** Prowlarr connectivity-tests each add synchronously, so adds are slow and the
 *  full catalogue is processed in bounded batches: at most MAX_ADDS_PER_CALL
 *  attempts per call, ADD_CONCURRENCY at a time, each capped tighter than the
 *  curated 40s so one dead site can't drag a whole chunk. */
const ADD_CONCURRENCY = 6;
const DEFAULT_MAX_ADDS_PER_CALL = 20;
const EVERYTHING_ADD_TIMEOUT_MS = 20_000;

/** Tiny worker pool: run fn over items, at most `limit` in flight. Results keep
 *  the input order. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface AddTarget {
  name: string;
  key: string;
  schema: ProwlarrSchema;
}
type AddOutcome = { kind: "added"; key: string; name: string; viaFlare: boolean } | { kind: "failed"; name: string; reason: string };

/** One best-effort add. A failure that looks Cloudflare-blocked and wasn't
 *  already routed through FlareSolverr gets a single retry via the proxy —
 *  that rescues CF sources outside the hand-curated CF_INDEXER_KEYS set. */
async function addOne(target: AddTarget, flareTagId: number | null, timeoutMs?: number): Promise<AddOutcome> {
  // appProfileId must be > 0; the schema ships 0, so coerce falsy/≤0 to the
  // default "Standard" profile (id 1 on a fresh Prowlarr).
  const appProfileId = target.schema.appProfileId && target.schema.appProfileId > 0 ? target.schema.appProfileId : 1;
  const priority = target.schema.priority && target.schema.priority > 0 ? target.schema.priority : 25;
  const payload = (viaFlare: boolean): Record<string, unknown> => ({
    ...(target.schema as Record<string, unknown>),
    enable: true,
    appProfileId,
    priority,
    tags: viaFlare && flareTagId != null ? [flareTagId] : [],
  });

  const viaFlare = CF_INDEXER_KEYS.has(target.key) && flareTagId != null;
  try {
    await prowlarrAddIndexer(payload(viaFlare), timeoutMs);
    return { kind: "added", key: target.key, name: target.name, viaFlare };
  } catch (error) {
    const raw = error instanceof ArrError ? error.message : "échec inattendu";
    if (!viaFlare && flareTagId != null && looksCloudflareBlocked(raw)) {
      try {
        await prowlarrAddIndexer(payload(true), timeoutMs);
        return { kind: "added", key: target.key, name: target.name, viaFlare: true };
      } catch (retryError) {
        const retryRaw = retryError instanceof ArrError ? retryError.message : "échec inattendu";
        return { kind: "failed", name: target.name, reason: classifyAddFailure(retryRaw) };
      }
    }
    return { kind: "failed", name: target.name, reason: classifyAddFailure(raw) };
  }
}

/** Add a pack/selection of public indexers to Prowlarr, live. Each indexer is
 *  best-effort: one failing (often geo-blocked / Cloudflare) never aborts the
 *  rest. The "everything" selection expands to every PUBLIC definition Prowlarr
 *  knows; attempts are capped per call (see result.remaining) so the HTTP
 *  request stays bounded — the UI just calls again until remaining is 0. The
 *  Applications sync pushes every added indexer to Sonarr/Radarr. */
export async function addIndexers(rawSelection: string, opts: { exclude?: string[]; maxAdds?: number } = {}): Promise<AddIndexersResult> {
  const wantsEverything = selectionWantsEverything(rawSelection);
  const explicit = resolveIndexerSelection(rawSelection);
  const result: AddIndexersResult = { added: [], skipped: [], failed: [], remaining: 0, total: 0 };
  if (!wantsEverything && explicit.length === 0) return result;

  const flareTagId = await ensureFlareSolverr();
  const [existing, schemas] = await Promise.all([prowlarrIndexers(), prowlarrIndexerSchemas()]);
  const existingKeys = new Set(existing.map((i) => normIndexerName(i.definitionName || i.name || "")));

  const targets = [...explicit];
  if (wantsEverything) {
    const seen = new Set(explicit.map(normIndexerName));
    for (const s of filterPublicSchemas(schemas)) {
      const name = s.name || s.definitionName || "";
      const key = normIndexerName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      targets.push(name);
    }
  }

  // Names the caller already saw fail this session — dropped silently so the
  // chunked "everything" loop makes strict forward progress instead of retrying
  // the same dead sites every round.
  const excluded = new Set((opts.exclude ?? []).map(normIndexerName));

  const toAttempt: AddTarget[] = [];
  for (const target of targets) {
    const key = normIndexerName(target);
    if (existingKeys.has(key)) {
      result.skipped.push(target);
      continue;
    }
    if (excluded.has(key)) continue;
    const schema = schemas.find((s) => normIndexerName(s.definitionName || "") === key || normIndexerName(s.name || "") === key);
    if (!schema) {
      result.failed.push({ name: target, reason: "définition introuvable dans Prowlarr" });
      continue;
    }
    toAttempt.push({ name: schema.name ?? target, key, schema });
  }

  const maxAdds = opts.maxAdds ?? DEFAULT_MAX_ADDS_PER_CALL;
  const batch = toAttempt.slice(0, maxAdds);
  result.remaining = toAttempt.length - batch.length;

  const outcomes = await mapConcurrent(batch, ADD_CONCURRENCY, (t) => addOne(t, flareTagId, wantsEverything ? EVERYTHING_ADD_TIMEOUT_MS : undefined));
  for (const outcome of outcomes) {
    if (outcome.kind === "added") {
      result.added.push({ name: outcome.name, viaFlare: outcome.viaFlare });
      existingKeys.add(outcome.key);
    } else {
      result.failed.push({ name: outcome.name, reason: outcome.reason });
    }
  }

  result.total = existingKeys.size;
  return result;
}

// --- state (GET) -------------------------------------------------------------

export interface IndexerPresetView {
  key: string;
  label: string;
  description: string;
  count: number;
}
export interface IndexerStateView {
  presets: IndexerPresetView[];
  /** null when Prowlarr is unreachable/unconfigured. */
  configured: { count: number; names: string[] } | null;
}

/** Presets available in the UI, plus a live snapshot of what's already in
 *  Prowlarr. Never throws: an unreachable Prowlarr yields configured: null.
 *  When Prowlarr is up, a live "everything" pseudo-preset is appended, counting
 *  every PUBLIC definition its schema list carries. */
export async function listIndexerState(): Promise<IndexerStateView> {
  const presets: IndexerPresetView[] = (Object.keys(INDEXER_PRESETS) as IndexerPresetKey[]).map((key) => ({
    key,
    label: INDEXER_PRESETS[key].label,
    description: INDEXER_PRESETS[key].description,
    count: INDEXER_PRESETS[key].defs.length,
  }));

  let configured: { count: number; names: string[] } | null = null;
  const [existingRes, schemasRes] = await Promise.allSettled([prowlarrIndexers(), prowlarrIndexerSchemas()]);
  if (existingRes.status === "fulfilled") {
    configured = {
      count: existingRes.value.length,
      names: existingRes.value
        .map((i) => String(i.name ?? i.definitionName ?? ""))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    };
  }
  if (schemasRes.status === "fulfilled") {
    const everythingCount = filterPublicSchemas(schemasRes.value).length;
    if (everythingCount > 0) {
      presets.push({
        key: EVERYTHING_KEY,
        label: "Tout l'existant",
        description:
          `Active l'intégralité du catalogue public de Prowlarr : les ${everythingCount} sources sans compte connues, tous pays et toutes langues. ` +
          "Les ajouts se font par vagues ; les sources mortes ou géo-bloquées sont listées individuellement sans bloquer le reste.",
        count: everythingCount,
      });
    }
  }
  return { presets, configured };
}
