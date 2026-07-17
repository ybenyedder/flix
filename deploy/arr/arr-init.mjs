// Flix — *arr auto-wiring init container. Zero npm deps (built-in fetch/fs only),
// mirroring start.mjs's dependency posture. Two modes:
//
//   node arr-init.mjs --seed-qbit   Write qBittorrent.conf if absent (runs once,
//                                   BEFORE qbittorrent's first start).
//   node arr-init.mjs               Wait for Sonarr/Radarr/Prowlarr/Bazarr, then
//                                   configure root folders + qBittorrent download
//                                   clients, register Sonarr/Radarr as Prowlarr
//                                   applications, best-effort wire Bazarr, and
//                                   write arr-services.json into Flix's data volume.
//
// Idempotent: every step checks before it creates, so a restart (restart:
// on-failure) or a re-run is safe. Exit code is non-zero only if a CORE step
// (root folders, download clients, Prowlarr apps, handoff) fails — Bazarr is
// best-effort and never fails the run.

import fs from "node:fs";
import path from "node:path";

const SUBNET = "172.31.247.0/24";
const QBIT_HOST = "qbittorrent";
const QBIT_PORT = 8080;

const SERVICES = {
  sonarr: { url: "http://sonarr:8989", apiBase: "/api/v3", cfg: "/cfg/sonarr/config.xml" },
  radarr: { url: "http://radarr:7878", apiBase: "/api/v3", cfg: "/cfg/radarr/config.xml" },
  prowlarr: { url: "http://prowlarr:9696", apiBase: "/api/v1", cfg: "/cfg/prowlarr/config.xml" },
  bazarr: { url: "http://bazarr:6767", apiBase: "/api", cfg: null }, // yaml, resolved below
};

const BAZARR_CFG_CANDIDATES = ["/cfg/bazarr/config/config.yaml", "/cfg/bazarr/config.yaml"];

// Curated packs of PUBLIC torrent indexers (no account), selectable via
// FLIX_ARR_INDEXERS. Public sources are legally sensitive and unreliable (often
// geo-blocked or behind Cloudflare) — this is opt-in, and any that fail to add
// are logged, not fatal. Keep in sync with src/server/arr/indexers.ts.
const INDEXER_PRESETS = {
  public: [
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
  anime: ["nyaasi", "tokyotosho", "shanaproject", "acgrip", "dmhy", "subsplease"],
  fr: ["torrent9"],
  ru: ["rutor"],
};

// Cloudflare-protected indexers: these are tagged to route through FlareSolverr
// (registered as a Prowlarr proxy) so their requests get past the CF challenge.
const CF_INDEXERS = new Set(["1337x", "eztv", "torrent9", "uindex", "dmhy", "torrentcore"]);
const FLARESOLVERR_URL = "http://flaresolverr:8191";
const FLARESOLVERR_TAG = "flaresolverr";

function log(msg) {
  console.log(`[arr-init] ${msg}`);
}

/** Normalise an indexer name for matching ("The Pirate Bay" === "thepiratebay"). */
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- qBittorrent conf seeding ------------------------------------------------

const QBIT_CONF = `[BitTorrent]
Session\\DefaultSavePath=/data/downloads
Session\\TempPath=/data/downloads/incomplete
Session\\TempPathEnabled=true

[Preferences]
WebUI\\Address=*
WebUI\\Port=${QBIT_PORT}
WebUI\\AuthSubnetWhitelistEnabled=true
WebUI\\AuthSubnetWhitelist=${SUBNET}
WebUI\\LocalHostAuth=false
# Keep qB's DNS-rebinding / CSRF defenses ON. The *arr services reach qBittorrent
# by its compose service name (${QBIT_HOST}) over the internal network, which
# passes host-header validation, so disabling these bought nothing but exposure.
WebUI\\HostHeaderValidation=true
WebUI\\CSRFProtection=true
`;

function seedQbit() {
  const dir = "/config/qBittorrent";
  const file = path.join(dir, "qBittorrent.conf");
  if (fs.existsSync(file)) {
    log("qBittorrent.conf already present — leaving it untouched");
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, QBIT_CONF);
  log(`wrote ${file} (WebUI on :${QBIT_PORT}, auth whitelist ${SUBNET})`);
}

// --- key extraction ----------------------------------------------------------

function extractApiKeyFromXml(text) {
  const m = text.match(/<ApiKey>([^<]+)<\/ApiKey>/i);
  return m ? m[1].trim() : null;
}
function extractApiKeyFromYaml(text) {
  const m = text.match(/apikey:\s*([A-Za-z0-9]+)/i);
  return m ? m[1].trim() : null;
}

async function waitForKey(service, deadline) {
  while (Date.now() < deadline) {
    if (service === "bazarr") {
      for (const cand of BAZARR_CFG_CANDIDATES) {
        try {
          const key = extractApiKeyFromYaml(fs.readFileSync(cand, "utf8"));
          if (key) return key;
        } catch {
          /* not written yet */
        }
      }
    } else {
      try {
        const key = extractApiKeyFromXml(fs.readFileSync(SERVICES[service].cfg, "utf8"));
        if (key) return key;
      } catch {
        /* not written yet */
      }
    }
    await sleep(3000);
  }
  throw new Error(`timed out reading ${service} API key`);
}

// --- HTTP --------------------------------------------------------------------

async function apiFetch(service, key, apiPath, { method = "GET", body } = {}) {
  const { url } = SERVICES[service];
  const res = await fetch(url + apiPath, {
    method,
    headers: {
      "X-Api-Key": key,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${service} ${method} ${apiPath} -> ${res.status} ${detail}`);
  }
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForApi(service, key, deadline) {
  const statusPath = service === "bazarr" ? "/api/system/status" : `${SERVICES[service].apiBase}/system/status`;
  while (Date.now() < deadline) {
    try {
      await apiFetch(service, key, statusPath);
      return;
    } catch {
      /* not ready */
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${service} API`);
}

// --- download client (schema-driven, version-robust) -------------------------

function setField(fields, name, value) {
  const f = fields.find((x) => x.name === name);
  if (f) f.value = value;
}

async function ensureDownloadClient(service, key, category) {
  const base = SERVICES[service].apiBase;
  const existing = (await apiFetch(service, key, `${base}/downloadclient`)) ?? [];
  if (Array.isArray(existing) && existing.some((c) => String(c.implementation).toLowerCase() === "qbittorrent")) {
    log(`${service}: qBittorrent download client already configured`);
    return;
  }
  const schemas = (await apiFetch(service, key, `${base}/downloadclient/schema`)) ?? [];
  const schema = schemas.find((s) => String(s.implementation).toLowerCase() === "qbittorrent");
  if (!schema) throw new Error(`${service}: no qBittorrent download-client schema`);

  const fields = Array.isArray(schema.fields) ? schema.fields.map((f) => ({ name: f.name, value: f.value })) : [];
  setField(fields, "host", QBIT_HOST);
  setField(fields, "port", QBIT_PORT);
  setField(fields, "useSsl", false);
  // Category field name differs (movieCategory / tvCategory / category) — set any.
  for (const f of fields) {
    if (/category$/i.test(f.name) && !/imported/i.test(f.name)) f.value = category;
  }

  const payload = {
    enable: true,
    name: "qBittorrent",
    implementation: schema.implementation,
    implementationName: schema.implementationName,
    configContract: schema.configContract,
    protocol: schema.protocol ?? "torrent",
    priority: 1, // Radarr/Sonarr require 1..50 (default 0 is rejected)
    fields,
    tags: [],
  };
  await apiFetch(service, key, `${base}/downloadclient`, { method: "POST", body: payload });
  log(`${service}: qBittorrent download client created (category "${category}")`);
}

async function ensureRootFolder(service, key, folderPath) {
  const base = SERVICES[service].apiBase;
  const existing = (await apiFetch(service, key, `${base}/rootfolder`)) ?? [];
  if (Array.isArray(existing) && existing.some((r) => r.path === folderPath)) {
    log(`${service}: root folder ${folderPath} already present`);
    return;
  }
  await apiFetch(service, key, `${base}/rootfolder`, { method: "POST", body: { path: folderPath } });
  log(`${service}: root folder ${folderPath} created`);
}

// --- quality profile ---------------------------------------------------------

// Pick the id of the best available quality (or group) for the cutoff, in
// descending preference. Radarr tops out at Remux-2160p, Sonarr at
// "Bluray-2160p Remux".
function bestCutoff(items) {
  const prefs = ["remux-2160p", "2160p remux", "bluray-2160p", "webdl-2160p", "2160p", "remux-1080p", "1080p remux", "bluray-1080p", "webdl-1080p", "1080p"];
  const cands = items.map((it) => (it.quality ? [String(it.quality.name).toLowerCase(), it.quality.id] : [String(it.name || "").toLowerCase(), it.id]));
  for (const pref of prefs) {
    for (const [name, id] of cands) if (name.includes(pref)) return id;
  }
  const last = items[items.length - 1];
  return last.quality ? last.quality.id : last.id;
}

const BALANCED_BAD = ["workprint", "cam", "telesync", "telecine", "regional", "dvdscr", "2160p", "remux", "br-disk", "raw-hd"];
function isBadQuality(name) {
  const s = String(name || "").toLowerCase();
  return BALANCED_BAD.some((k) => s.includes(k));
}

// Configure the quality profile Flix will request against (createRequest uses the
// FIRST profile). FLIX_ARR_QUALITY: "max" (default — allow everything, upgrade all
// the way to 4K Remux), "balanced" (WEB/x264 1080p, no Remux/4K — faster & better
// seeded on public indexers), or "off" (leave the *arr default untouched). Only
// ever touches the pristine "Any" default, and renames it, so a profile you've
// customised is never clobbered on a re-run.
async function ensureQualityProfile(service, key) {
  const mode = (process.env.FLIX_ARR_QUALITY || "max").trim().toLowerCase();
  if (mode === "off" || mode === "none") {
    log(`${service}: profil qualité laissé par défaut (FLIX_ARR_QUALITY=off)`);
    return;
  }
  const base = SERVICES[service].apiBase;
  const profiles = (await apiFetch(service, key, `${base}/qualityprofile`)) ?? [];
  const target = profiles[0];
  if (!target) return;
  if (target.name !== "Any") {
    log(`${service}: profil « ${target.name} » déjà personnalisé — inchangé`);
    return;
  }
  const p = await apiFetch(service, key, `${base}/qualityprofile/${target.id}`);
  if (mode === "balanced") {
    let web1080 = null;
    for (const it of p.items) {
      if (it.quality) {
        it.allowed = !isBadQuality(it.quality.name);
      } else {
        it.allowed = !isBadQuality(it.name);
        if (String(it.name || "").toLowerCase().replace(/\s/g, "") === "web1080p") web1080 = it.id;
      }
    }
    const bluray1080 = p.items.find((it) => it.quality && String(it.quality.name).toLowerCase() === "bluray-1080p");
    p.cutoff = web1080 ?? (bluray1080 ? bluray1080.quality.id : p.cutoff);
    p.name = "Balanced (WEB/x264 1080p)";
  } else {
    for (const it of p.items) it.allowed = true;
    p.cutoff = bestCutoff(p.items);
    p.name = "Ultra (meilleure qualité — jusqu'au 4K/Remux)";
  }
  p.upgradeAllowed = true;
  await apiFetch(service, key, `${base}/qualityprofile/${target.id}`, { method: "PUT", body: p });
  log(`${service}: profil qualité → ${p.name} (cutoff ${p.cutoff})`);
}

// --- Prowlarr applications ---------------------------------------------------

async function ensureProwlarrApp(prowlarrKey, appName, appImpl, appBaseUrl, appKey) {
  const existing = (await apiFetch("prowlarr", prowlarrKey, "/api/v1/applications")) ?? [];
  if (Array.isArray(existing) && existing.some((a) => String(a.implementation).toLowerCase() === appImpl.toLowerCase())) {
    log(`prowlarr: ${appName} application already registered`);
    return;
  }
  const schemas = (await apiFetch("prowlarr", prowlarrKey, "/api/v1/applications/schema")) ?? [];
  const schema = schemas.find((s) => String(s.implementation).toLowerCase() === appImpl.toLowerCase());
  if (!schema) throw new Error(`prowlarr: no ${appImpl} application schema`);

  const fields = Array.isArray(schema.fields) ? schema.fields.map((f) => ({ name: f.name, value: f.value })) : [];
  setField(fields, "prowlarrUrl", "http://prowlarr:9696");
  setField(fields, "baseUrl", appBaseUrl);
  setField(fields, "apiKey", appKey);

  const payload = {
    name: appName,
    syncLevel: "fullSync",
    implementation: schema.implementation,
    implementationName: schema.implementationName,
    configContract: schema.configContract,
    fields,
    tags: [],
  };
  await apiFetch("prowlarr", prowlarrKey, "/api/v1/applications", { method: "POST", body: payload });
  log(`prowlarr: ${appName} application registered (fullSync)`);
}

// --- FlareSolverr (Cloudflare bypass) ----------------------------------------

async function ensureTag(prowlarrKey, label) {
  const tags = (await apiFetch("prowlarr", prowlarrKey, "/api/v1/tag")) ?? [];
  const found = tags.find((t) => String(t.label).toLowerCase() === label.toLowerCase());
  if (found) return found.id;
  const created = await apiFetch("prowlarr", prowlarrKey, "/api/v1/tag", { method: "POST", body: { label } });
  return created.id;
}

// Register FlareSolverr as a Prowlarr indexer proxy and return the tag id that
// routes an indexer through it. Idempotent. Non-fatal to the caller.
async function ensureFlareSolverr(prowlarrKey) {
  const tagId = await ensureTag(prowlarrKey, FLARESOLVERR_TAG);
  const existing = (await apiFetch("prowlarr", prowlarrKey, "/api/v1/indexerproxy")) ?? [];
  if (Array.isArray(existing) && existing.some((p) => String(p.implementation).toLowerCase() === "flaresolverr")) {
    log("prowlarr: proxy FlareSolverr déjà configuré");
    return tagId;
  }
  const schemas = (await apiFetch("prowlarr", prowlarrKey, "/api/v1/indexerproxy/schema")) ?? [];
  const schema = schemas.find((s) => String(s.implementation).toLowerCase() === "flaresolverr");
  if (!schema) throw new Error("schéma FlareSolverr introuvable dans Prowlarr");
  const fields = Array.isArray(schema.fields) ? schema.fields.map((f) => ({ name: f.name, value: f.value })) : [];
  setField(fields, "host", FLARESOLVERR_URL);
  const body = {
    name: "FlareSolverr",
    implementation: schema.implementation,
    implementationName: schema.implementationName,
    configContract: schema.configContract,
    fields,
    tags: [tagId],
  };
  await apiFetch("prowlarr", prowlarrKey, "/api/v1/indexerproxy", { method: "POST", body });
  log(`prowlarr: proxy FlareSolverr configuré (${FLARESOLVERR_URL})`);
  return tagId;
}

// --- Prowlarr indexers (opt-in) ----------------------------------------------

// Expand a FLIX_ARR_INDEXERS value into a deduped list of definition names. Each
// comma token is a preset key ("public"/"anime"/"fr"/"ru"), the special "all"
// (every preset), or a literal Prowlarr definition name (e.g. "1337x"). The
// special "everything" token is consumed here — it expands against the live
// Prowlarr schema list inside ensureIndexers (every PUBLIC definition).
function selectionWantsEverything(raw) {
  return String(raw || "")
    .split(",")
    .some((t) => t.trim().toLowerCase() === "everything");
}
function resolveIndexerSelection(raw) {
  const tokens = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const key = normName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "everything") continue; // resolved live against the schema list
    else if (lower === "all") for (const defs of Object.values(INDEXER_PRESETS)) defs.forEach(push);
    else if (INDEXER_PRESETS[lower]) INDEXER_PRESETS[lower].forEach(push);
    else push(token);
  }
  return out;
}

// Tiny worker pool (Prowlarr tests each add synchronously, so serial adds of the
// full catalogue would take ages — 6 in flight keeps it minutes, not hours).
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
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

// Enable indexers in Prowlarr when FLIX_ARR_INDEXERS is set:
//   "public" / "anime" / "fr" / "ru"  → that curated pack
//   "all"                             → every pack
//   "everything"                      → CHAQUE définition publique de Prowlarr
//   "public,anime" / "1337x,yts"      → combine packs and/or literal names
//   unset/empty                       → nothing (leaving the one manual step)
// Returns { added, requested }. Never fatal — a public indexer being down or
// renamed is a warning, not a failure of the whole init.
async function ensureIndexers(prowlarrKey, flareTagId) {
  const raw = (process.env.FLIX_ARR_INDEXERS || "").trim();
  // Empty or an explicit opt-out both mean "add nothing" (leave the manual step).
  if (!raw || ["off", "none", "0", "no", "false"].includes(raw.toLowerCase())) return { added: 0, requested: 0, opted: false };

  const targets = resolveIndexerSelection(raw);

  const existing = (await apiFetch("prowlarr", prowlarrKey, "/api/v1/indexer")) ?? [];
  const existingKeys = new Set(existing.map((i) => normName(i.definitionName || i.name)));
  const schemas = (await apiFetch("prowlarr", prowlarrKey, "/api/v1/indexer/schema")) ?? [];

  if (selectionWantsEverything(raw)) {
    const seen = new Set(targets.map(normName));
    for (const s of schemas) {
      if (String(s.privacy || "").toLowerCase() !== "public") continue;
      const name = s.name || s.definitionName || "";
      const key = normName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      targets.push(name);
    }
    log(`prowlarr: mode "everything" — ${targets.length} définitions publiques à activer`);
  }

  const toAdd = [];
  for (const target of targets) {
    const key = normName(target);
    if (existingKeys.has(key)) {
      log(`prowlarr: indexeur ${target} déjà présent`);
      continue;
    }
    const schema = schemas.find((s) => normName(s.definitionName) === key || normName(s.name) === key);
    if (!schema) {
      log(`WARNING: indexeur « ${target} » introuvable dans Prowlarr — ignoré`);
      continue;
    }
    toAdd.push({ target, key, schema });
  }

  const outcomes = await mapConcurrent(toAdd, 6, async ({ target, key, schema }) => {
    // appProfileId must be > 0; the schema ships 0, and `?? 1` wouldn't
    // replace 0 (nullish only), so coerce any falsy/≤0 value to the default
    // "Standard" profile (id 1 on a fresh Prowlarr).
    const appProfileId = schema.appProfileId && schema.appProfileId > 0 ? schema.appProfileId : 1;
    const priority = schema.priority && schema.priority > 0 ? schema.priority : 25;
    const payload = (viaFlare) => ({ ...schema, enable: true, appProfileId, priority, tags: viaFlare && flareTagId ? [flareTagId] : [] });
    // Route Cloudflare-protected indexers through FlareSolverr via its tag.
    let viaFlare = CF_INDEXERS.has(key) && !!flareTagId;
    try {
      await apiFetch("prowlarr", prowlarrKey, "/api/v1/indexer", { method: "POST", body: payload(viaFlare) });
    } catch (e) {
      // A 403/Cloudflare failure gets one retry through FlareSolverr — that
      // rescues CF sources beyond the hand-curated CF_INDEXERS set.
      if (viaFlare || !flareTagId || !/forbidden|cloudflare|403/i.test(String(e.message))) {
        log(`WARNING: échec de l'ajout de « ${target} » (souvent géo-bloqué / Cloudflare) : ${e.message}`);
        return false;
      }
      try {
        viaFlare = true;
        await apiFetch("prowlarr", prowlarrKey, "/api/v1/indexer", { method: "POST", body: payload(true) });
      } catch (retryErr) {
        log(`WARNING: échec de l'ajout de « ${target} » (même via FlareSolverr) : ${retryErr.message}`);
        return false;
      }
    }
    log(`prowlarr: indexeur ${schema.name} activé${viaFlare ? " (via FlareSolverr)" : ""}`);
    return true;
  });
  const added = outcomes.filter(Boolean).length;
  return { added, requested: targets.length, opted: true };
}

// --- Bazarr (best-effort) ----------------------------------------------------

async function wireBazarr(bazarrKey, sonarrKey, radarrKey) {
  // Bazarr's settings API is form-encoded and shifts across versions; treat any
  // failure as a warning (subtitles are optional — downloads work without them).
  const form = new URLSearchParams();
  form.set("settings-general-use_sonarr", "True");
  form.set("settings-sonarr-ip", "sonarr");
  form.set("settings-sonarr-port", "8989");
  form.set("settings-sonarr-base_url", "/");
  form.set("settings-sonarr-ssl", "False");
  form.set("settings-sonarr-apikey", sonarrKey);
  form.set("settings-general-use_radarr", "True");
  form.set("settings-radarr-ip", "radarr");
  form.set("settings-radarr-port", "7878");
  form.set("settings-radarr-base_url", "/");
  form.set("settings-radarr-ssl", "False");
  form.set("settings-radarr-apikey", radarrKey);
  // Default language profile: French + English.
  form.set("settings-general-serie_default_enabled", "True");
  form.set("settings-general-movie_default_enabled", "True");
  form.append("languages-enabled", "fr");
  form.append("languages-enabled", "en");

  const res = await fetch(`${SERVICES.bazarr.url}/api/system/settings`, {
    method: "POST",
    headers: { "X-Api-Key": bazarrKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`bazarr settings POST -> ${res.status}`);
  log("bazarr: Sonarr/Radarr wired, default languages fr+en");
}

// --- handoff -----------------------------------------------------------------

function writeHandoff(keys) {
  const payload = {
    version: 1,
    wiredAt: Date.now(),
    services: {
      sonarr: { url: SERVICES.sonarr.url, apiKey: keys.sonarr },
      radarr: { url: SERVICES.radarr.url, apiKey: keys.radarr },
      prowlarr: { url: SERVICES.prowlarr.url, apiKey: keys.prowlarr },
      ...(keys.bazarr ? { bazarr: { url: SERVICES.bazarr.url, apiKey: keys.bazarr } } : {}),
    },
  };
  const dir = "/flix-data";
  const file = path.join(dir, "arr-services.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  log(`wrote ${file} — Flix will auto-detect the services`);
}

// --- main --------------------------------------------------------------------

async function wire() {
  const perServiceDeadline = () => Date.now() + 180_000;
  const keys = {};

  // 1. Wait for each service and read its API key.
  for (const svc of ["radarr", "sonarr", "prowlarr", "bazarr"]) {
    log(`waiting for ${svc}…`);
    try {
      keys[svc] = await waitForKey(svc, perServiceDeadline());
      await waitForApi(svc, keys[svc], perServiceDeadline());
      log(`${svc} is up`);
    } catch (e) {
      if (svc === "bazarr") {
        log(`WARNING: ${svc} not ready — skipping (subtitles can be configured manually later): ${e.message}`);
        keys[svc] = null;
      } else {
        throw e;
      }
    }
  }

  // 2. Radarr — movies root folder + qBittorrent client + quality profile.
  await ensureRootFolder("radarr", keys.radarr, "/data/movies");
  await ensureDownloadClient("radarr", keys.radarr, "radarr");
  try {
    await ensureQualityProfile("radarr", keys.radarr);
  } catch (e) {
    log(`WARNING: profil qualité radarr non défini (non-fatal) : ${e.message}`);
  }

  // 3. Sonarr — shows root folder + qBittorrent client + quality profile.
  await ensureRootFolder("sonarr", keys.sonarr, "/data/shows");
  await ensureDownloadClient("sonarr", keys.sonarr, "sonarr");
  try {
    await ensureQualityProfile("sonarr", keys.sonarr);
  } catch (e) {
    log(`WARNING: profil qualité sonarr non défini (non-fatal) : ${e.message}`);
  }

  // 4. Prowlarr — register Radarr + Sonarr apps, add a qBittorrent client.
  await ensureProwlarrApp(keys.prowlarr, "Radarr", "Radarr", "http://radarr:7878", keys.radarr);
  await ensureProwlarrApp(keys.prowlarr, "Sonarr", "Sonarr", "http://sonarr:8989", keys.sonarr);
  try {
    await ensureDownloadClient("prowlarr", keys.prowlarr, "prowlarr");
  } catch (e) {
    log(`WARNING: prowlarr download client not set (non-fatal): ${e.message}`);
  }

  // 4a. FlareSolverr proxy (Cloudflare bypass) — always set up so CF indexers work.
  let flareTagId = null;
  try {
    flareTagId = await ensureFlareSolverr(keys.prowlarr);
  } catch (e) {
    log(`WARNING: FlareSolverr non configuré (non-fatal) : ${e.message}`);
  }

  // 4b. Optional: auto-enable indexers (opt-in via FLIX_ARR_INDEXERS).
  let indexers = { added: 0, requested: 0, opted: false };
  try {
    indexers = await ensureIndexers(keys.prowlarr, flareTagId);
  } catch (e) {
    log(`WARNING: indexeurs non configurés (non-fatal) : ${e.message}`);
  }

  // 5. Bazarr — best-effort, never fatal.
  if (keys.bazarr) {
    try {
      await wireBazarr(keys.bazarr, keys.sonarr, keys.radarr);
    } catch (e) {
      log(`WARNING: Bazarr auto-config failed — configure it in the Bazarr UI (Settings → Sonarr/Radarr): ${e.message}`);
    }
  }

  // 6. Handoff to Flix.
  writeHandoff(keys);

  // 7. Human summary.
  log("──────────────────────────────────────────────");
  log("Auto-wiring terminé.");
  log(`  Sonarr   ${SERVICES.sonarr.url}   key ${keys.sonarr}`);
  log(`  Radarr   ${SERVICES.radarr.url}   key ${keys.radarr}`);
  log(`  Prowlarr ${SERVICES.prowlarr.url}   key ${keys.prowlarr}`);
  if (keys.bazarr) log(`  Bazarr   ${SERVICES.bazarr.url}   key ${keys.bazarr}`);
  if (indexers.opted) log(`  Indexeurs : ${indexers.added}/${indexers.requested} publics activés (FLIX_ARR_INDEXERS)`);
  log("ÉTAPES MANUELLES :");
  if (indexers.added > 0) {
    log("  1. Indexeurs déjà activés — vérifiez-les dans Prowlarr (:9696) si une recherche reste vide.");
  } else {
    log("  1. Ouvrez Prowlarr (:9696) et ajoutez au moins un indexeur (sync auto vers Sonarr/Radarr).");
    log("     Astuce : FLIX_ARR_INDEXERS=public|anime|fr|ru|all|everything (combinables : public,anime) pour auto-activer des paquets publics.");
    log("     « everything » active TOUTES les définitions publiques connues de Prowlarr.");
    log("     …ou faites-le en un clic depuis Flix : Réglages → Téléchargements automatiques → Sources de téléchargement.");
  }
  log("  2. (Optionnel) Ajoutez des fournisseurs/identifiants de sous-titres dans Bazarr (:6767).");
  log("──────────────────────────────────────────────");
}

async function main() {
  if (process.argv.includes("--seed-qbit")) {
    seedQbit();
    return;
  }
  await wire();
}

main().catch((e) => {
  console.error(`[arr-init] ÉCHEC : ${e.message}`);
  process.exit(1);
});
