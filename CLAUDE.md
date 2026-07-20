# CLAUDE.md

Developer/agent guide to the Flix codebase. The user-facing pitch is in
[`README.md`](README.md); this file is the **code map** — how the pieces fit,
the invariants you must not break, and the conventions to imitate.

Flix is a self-hosted, **100%-offline** Netflix clone: films + series, a
Netflix-style UI, a local taste-based recommendation engine, and strict
direct-play/remux/transcode adaptive playback. Web (Next.js/PWA), Electron
desktop, and native Android/Android TV clients all talk to the same server.

## Commands

```bash
npm run dev         # next dev on :4247
npm run build       # next build
npm run start       # production next start on :4247
npm run lint        # eslint, --max-warnings 0 (warnings fail)
npm run typecheck   # tsc --noEmit
npm run check       # lint + typecheck + build (run before considering work done)
npm test            # node --test over test/*.test.ts (tsx loader) — ~511 tests
```

Run a single test file: `node --import tsx --test test/naming.test.ts`.
Requirements: Node 22, `ffmpeg`/`ffprobe` on `PATH`. TypeScript targets **ES2017**
(no named regex groups, no `??=` in older-target spots — check before using).

## Big picture

Three layers, strictly separated:

1. **Route handlers** (`src/app/api/**`) — thin HTTP adapters. They validate
   (CSRF → auth/admin → bounded body read → shape) then delegate. **No business
   logic here.** Every route declares `runtime="nodejs"` + `dynamic="force-dynamic"`.
2. **Framework-agnostic core** (`src/server/**`) — all the real work. Knows
   nothing about Next; returns plain data / tagged unions, never `Response`.
   Independently unit-tested.
3. **SQLite** (`better-sqlite3`, one file, FTS5) — the only persistence. A
   **single connection per process** (`src/server/db.ts`), forward-only
   migrations on `user_version`.

Client state lives in Zustand stores (`src/store/**`); all HTTP goes through one
fetch client (`src/lib/flix/api.ts`); pure client/server-shared logic lives in
`src/lib/flix/**` (imported by both sides, so it stays dependency-free).

### Recurring design pattern: pure vs. effectful split

Every subsystem isolates the logic most likely to be wrong (parsing, maths,
arg-building, status mapping) into **pure, I/O-free, directly unit-tested**
functions, and keeps `fs`/`spawn`/DB/DOM effects in a separate file. When you
add logic, follow this: put the testable core in a pure function, in its own
module. Examples: `naming*.ts` + the extracted phases in `library/scan/` vs
`scanner.ts` (the orchestrator + shared progress state); `hlsArgs.ts` (segment
maths + ffmpeg arg builders) vs `sessions.ts` (process lifecycle);
`reco/{scoring,aggregates,catalogIndex}.ts` vs `reco/engine.ts` (caches +
façade); `authparts/{passwords,sessions}.ts` vs `auth.ts` (secret/seed/CRUD);
`playerLogic.ts` vs `PlayerView.tsx` (DOM); `statusMap.ts` vs `requests.ts`
(arr I/O); `party.ts` maths vs `watch/party.ts` state. Several god-files were
split this way — the original file stays as a façade that re-exports the moved
public symbols, so consumers/tests never change.

## Subsystem map

| Subsystem | Core files | Entry points |
|---|---|---|
| **Core** | `server/{config,db,auth,http,paths,rateLimit,logger,bootstrap}.ts` (auth's scrypt/session internals live in `authparts/`) | every route |
| **Library scan** | `server/library/scanner.ts` (orchestrator) + `library/scan/{walk,classify,upsert,probePass,nfoPass,prune,fts,cacheGc}.ts` (phases) + `naming*`, `nfo`, `ffprobe`, `repository`, `watcher`, `sidecarSubs` | `/api/library*` |
| **Images** | `server/library/{images,frameExtract,imagesPass,trickplay}.ts` | `/api/images/[hash]`, `/api/trickplay/[fileId]` |
| **Playback** | `server/playback/{decision,sessions,hlsArgs,subtitles,access,streamUtil}.ts`, `lib/flix/{playerLogic,caps,videoFormats}.ts` | `/api/play/*`, `/api/stream/[fileId]`, `/api/subs/[id]` |
| **Reco + state** | `server/reco/{engine,scoring,aggregates,catalogIndex}.ts`, `server/state/{userState,settings,stats}.ts`, `lib/flix/{reco,rows,kids}.ts` | `/api/recommend`, `/api/state`, `/api/stats` |
| **Downloads (*arr)** | `server/arr/*.ts` (opt-in) | `/api/arr/*`, `/api/admin/arr/*` |
| **VPN (Mullvad)** | `server/vpn/{config,mullvad}.ts` (opt-in) | `/api/admin/vpn` |
| **Upload** | `server/upload/{manager,targets}.ts`, `store/upload.ts`, `lib/flix/uploadClient.ts` | `/api/admin/upload*` |
| **Watch-party** | `server/watch/party.ts`, `store/watchParty.ts`, `lib/flix/party.ts` | `/api/watch/room` (SSE+POST) |
| **Frontend** | `components/flix/**`, `store/**`, `lib/flix/{useCatalog,types,format,api}.ts` | `src/app/page.tsx` |

Data flow (read): `page.tsx` → Zustand store → `api.ts` fetch → route → core →
SQLite. Data flow (write, e.g. mark watched): store → `POST /api/state` (kind
discriminator) → `userState.ts` → SQLite + `invalidateReco()`.

## Non-negotiable invariants

These are the rules the whole design defends. Breaking one is a real regression
even if tests pass.

- **Quality: direct > remux > transcode**, strictly, always. Never re-encode
  video that could be remuxed; never remux what can direct-play. The decision is
  computed **server-side only** (`playback/decision.ts`); the client never
  recomputes it. `-c:v copy` is mandatory in remux.
- **Zero outbound network calls**, by design — except the opt-in *arr/VPN
  features (`server/arr/*`, `server/vpn/*`), which are hard-gated behind
  `isArrEnabled()`/`isVpnEnabled()` and only ever talk to the operator's own
  services. Do not add a fetch anywhere else.
- **Kids gate = 404, never 403.** A mature title must be byte-identical to an
  unknown id for a kids profile (no existence leak). Enforced on every playback
  route via `playback/access.ts` and in the reco engine.
- **Path containment.** Any filesystem path derived from client input goes
  through `paths.ts` (`resolveLibraryPath` + realpath) before use. Symlinks are
  followed only if their realpath stays inside `mediaDir`.
- **Single DB connection per process**, memoised; caches (signing secret, admin
  seed) are keyed on the connection object so tests recreating the DB
  auto-invalidate. Migrations are append-only, never edited in place.
- **Constant-time secret comparison** everywhere (`crypto.timingSafeEqual`) +
  dummy scrypt work on unknown usernames (no timing enumeration).
- **Atomic durable writes.** Anything a reader can observe mid-write uses
  write-to-temp-then-rename (HLS segments, VTT cache, image variants, upload
  finalize) — a crash never serves a truncated file.

## Conventions to imitate

- **Language split**: user-facing strings in **French**; code, logs, comments in
  **English**. Keep both.
- **Comment the *why***, richly, on any subtle security/concurrency/edge-case
  decision — this codebase does, and it's its best feature. Match that density.
- **Env**: prefix `FLIX_`, parsed centrally in `config.ts` (use the `parseIntEnv`/
  `parseBool` helpers — they reject junk/negatives, a bare `parseInt(...) || d`
  does not). Port `4247`, data dir `~/.local/share/flix`, DB `flix.db`.
- **Failure-tolerant effects**: external spawns/parses never throw — `probeFile`
  resolves `null`, sidecar/NFO parses swallow errors, best-effort deletes are
  wrapped. One bad file must never abort a scan.
- **Discriminated-union request bodies** (`kind` in `/api/state`, `action` in
  `/api/watch/room`), discriminant validated first.
- **React**: reset local state by remounting via `key=`, not setState-in-effect;
  guard async effects with an `alive` flag; read Zustand via `getState()` in
  callbacks, fine-grained selectors in the body.
- **The `@/` import alias maps to `src/`** (e.g. `@/lib/flix/videoFormats`).
- Single sources of truth exist and must be imported, not copied:
  `videoFormats.ts` (playable extensions), `lib/flix/party.ts` (wire protocol +
  code alphabet), `arr/statusMap.ts` (status predicates).

## Gotchas that bite

- **`assetReady = size > 0`** for HLS: `init.mp4` isn't covered by
  `-hls_flags temp_file`; ffmpeg creates it empty then fills `ftyp+moov` later, so
  a 0-byte init makes the whole remux/transcode path unplayable.
- **`audioNeedsTranscode` is mode-independent**: FLAC/DTS/TrueHD/PCM can't be
  `-c:a copy` into fMP4 (remux AND transcode share the container), so gating it on
  remux-only would break a 4K HEVC transcode. (This was a HIGH bug; keep it fixed.)
- **SSE teardown must be idempotent AND independent of `closed`.** A failed
  enqueue flips `closed=true`; gating cleanup on `closed` leaks the ping timer +
  subscriber slot. Use a separate `cleaned` flag (see `watch/room` and
  `library/events`).
- **Capacity slot reserved synchronously** before the first `await` in
  `sessions.createSession`, else N concurrent requests all pass the cap check.
- **`media_files.id` is stable across rescans** (a replaced file keeps its URL);
  cache validators are size+mtime, never the id.
- **Reco windowing asymmetry** (`engine.ts` `buildAggregates`): `seen` is read
  over all history (never expires) but signal *weight* is capped at 365d — a
  fully-decayed item still stays out of discovery rows.
- **Prune is destructive + irreversible** (AUTOINCREMENT id reuse re-homes another
  user's progress), so it's skipped whenever the walk errored or truncated.
- ***arr `languages` field is a weak hint** — the language signal comes from the
  release *title* (`releaseLang.ts`), not the parsed metadata.

## Where to look first

- Adding an API route? Copy the validation preamble from a sibling in
  `src/app/api/**` and keep logic in `src/server/**`.
- Touching playback? `decision.ts` decides the mode; `sessions.ts` runs ffmpeg.
  Read the banner comments — the pure arg-builders are exported and tested.
- Touching naming/scan? Pure parsers in `naming*.ts` (with `test/naming.test.ts`);
  effects in `scanner.ts`.
- Plans/architecture reference: `/home/pc/.claude/plans/floating-dazzling-owl.md`
  (original 9-phase build plan).
