<div align="center">

# FLIX

### Your library. Your server. Your rules.

A self-hosted, 100% offline video platform with the look and feel of a
mainstream streaming service — minus the telemetry, the algorithm, and the
subscription.

</div>

---

## What it is

Point Flix at a folder of movies and TV shows. It scans them, reads real
metadata (filenames, `ffprobe`, Kodi-style `.nfo` sidecars), generates posters
and backdrops straight from the video frames, and serves a full streaming
experience: a billboard hero, horizontal rows, hover previews, per-profile
"Continue watching," and a local recommendation engine that learns your taste
from what you actually watch — never from what leaves your server, because
nothing ever does.

Playback always favors quality: the original file is served byte-for-byte
whenever the client can play it, falls back to a lossless container remux
when only the wrapper is unsupported, and only re-encodes as a last resort.

## Why

Most "smart" media apps trade your viewing habits for recommendations. Flix
keeps the trade-off local: the taste engine, the metadata, the images, the
playback decisions — all computed on your own machine, for your own
household, and never phoned home. Zero outbound network calls, by design
(with one exception: the opt-in automatic-downloads integration, off by
default — see below).

## Features

- **Netflix-style UI** — billboard hero, carousels, hover-to-preview cards,
  detail pages with season/episode pickers, search, "My List."
- **Multi-profile** — a "Who's watching?" picker per household member, with
  an optional kids-safe profile that filters mature content everywhere
  (catalogue, search, recommendations).
- **Adaptive playback** — direct play → remux → transcode, in that strict
  order, so you never lose quality you didn't have to. HLS sessions support
  seeking to any point instantly.
- **Local recommendation engine** — a taste profile per user built from
  completions, abandons, ratings and your list, with time decay so old
  signals fade and content genuinely similar to what you loved gets
  surfaced — "Because you watched," genre rows, and a real "Top 10."
  All of it stays on your server.
- **A player built for bingeing** — chapter markers on the seek bar,
  "Skip intro/recap," scrubbing preview thumbnails (trickplay), auto-advance
  that fires on the end-credits chapter when one exists, per-profile
  audio/subtitle language memory, and a version picker for movies that exist
  in several editions.
- **Watch together ("Séance")** — start a room, share a 6-character code, and
  everyone watches in sync like a private screening: play, pause and seek are a
  shared remote (anyone can drive), the host picks the title, and a late joiner
  drops in at the exact same frame. Live presence, floating emoji reactions and
  a chat come along for the ride. Pure server-side sync over SSE — no third
  party, no accounts anywhere but your server.
- **Your library, your state** — mark anything watched or unwatched, dismiss
  titles from "Continue watching," "New" badges on recent additions,
  combinable browse filters (genres, decade, unseen, 4K/HDR) with sorting,
  and a "Surprise me" button that picks an unseen title weighted by your
  taste profile.
- **Self-hosted comfort** — automatic rescans when the library folder
  changes, a web settings page (repoint the library, toggle auto-scan,
  download a consistent SQLite backup), and a per-profile viewing-stats
  page ("My activity").
- **Real metadata, zero network** — filename parsing, `ffprobe`, and Kodi
  `.nfo`/sidecar images if you have them; otherwise posters and backdrops are
  generated directly from the video (with a filter to skip black frames and
  a tone-mapping pass for HDR sources).
- **Ships everywhere** — web/PWA (installable, with an offline app shell and
  a local poster cache), Electron desktop (Linux `.deb`/`.AppImage`,
  Windows `.exe`), and native Android + Android TV apps (Kotlin, Compose,
  Media3/ExoPlayer) that play HEVC/AV1/HDR directly, no transcoding needed.
- **Hardened by default** — no telemetry, strict CSP, scrypt-hashed
  passwords, CSRF-protected mutations, path-traversal-safe streaming,
  sandboxed Electron shell, `allowBackup=false` on Android.

## Get started

Requirements: Node 20+, `ffmpeg`/`ffprobe` on your `PATH`.

```bash
git clone https://github.com/ybenyedder/flix.git
cd flix
npm install
npm run dev
```

Open `http://localhost:4247`. On first launch, a temporary admin password is
written to `INITIAL_ADMIN_PASSWORD.txt` in the data directory — log in, set a
real password, then delete that file.

By default Flix scans `~/Videos` and stores its database/cache under
`~/.local/share/flix` (XDG on Linux; the platform equivalent elsewhere).
Both are configurable — see [Configuration](#configuration).

For a real deployment:

```bash
npm run build
npm run start          # serves on port 4247
```

## Deploy

### Docker / Docker Compose

The published image ships Node 22 + ffmpeg, runs as a non-root user, and
exposes a healthcheck on `/api/health`:

```bash
docker run -d --name flix \
  -p 4247:4247 \
  -v flix-data:/data \
  -v /path/to/your/videos:/media:ro \
  ghcr.io/ybenyedder/flix:latest
```

Or edit the volumes in [`docker-compose.yml`](docker-compose.yml) and
`docker compose up -d`. To build the image yourself: `docker build -t flix .`.
First boot prints a temporary admin password in the container logs unless
`FLIX_ADMIN_PASSWORD` is set.

### Pterodactyl / Pelican panel

Flix ships a ready-to-import egg: [`deploy/pterodactyl/egg-flix.json`](deploy/pterodactyl/egg-flix.json).
Import it (Admin → Nests → Import Egg), create a server from it, upload your
library to `/home/container/media` over SFTP, and start. The install script
fetches the prebuilt server bundle from GitHub Releases (or builds from
source when none exists) plus a static ffmpeg — at runtime the server makes
zero outbound calls, as always (unless you enable the opt-in downloads
integration below).

Step-by-step guide (in French): [`docs/deploy-pterodactyl.md`](docs/deploy-pterodactyl.md).

### Automatic downloads (opt-in)

Off by default. When enabled, Flix connects to your own Sonarr, Radarr,
Prowlarr and Bazarr so you can search a title that isn't in your library,
click **Demander**, and have it download, get subtitled, and appear in your
library automatically. This is the **only** feature that makes outbound
network calls, and only to services you run yourself.

Deploy the whole stack (Sonarr, Radarr, Prowlarr, Bazarr, qBittorrent) next
to Flix and let it wire itself up:

```bash
mkdir -p media/{movies,shows,downloads}
docker compose -f docker-compose.yml -f docker-compose.arr.yml up -d
```

The one manual step is adding search sources. The easiest way: in **Flix →
Paramètres → Téléchargements automatiques → Sources de téléchargement**, add
whole packs of public indexers in one click (**Publics**, **Anime**, **Français**,
**Russe**, **Tout ajouter**) — or **Tout l'existant**, which enables every public
(no-account) definition Prowlarr knows, i.e. the entire catalogue, in progressive
waves with Cloudflare-blocked sources automatically retried through FlareSolverr.
Flix creates them in Prowlarr and they sync to Sonarr/Radarr. At deploy time you
can instead set `FLIX_ARR_INDEXERS` to a pack (`public`, `anime`, `fr`, `ru`),
`all`, `everything`, or a combined list (`public,anime`) —
opt-in, since public indexers are copyright-sensitive and unreliable. Already run
these services? Just point Flix at them in **Paramètres → Téléchargements**. Full
guide: [`docs/downloads-arr.md`](docs/downloads-arr.md).

### Bare metal / systemd

```bash
npm run build
node scripts/prepare-standalone.mjs   # self-contained bundle in dist-standalone/
node dist-standalone/start.mjs        # binds 0.0.0.0:4247 by default
```

The bundle only needs Node 22 and ffmpeg on the target machine — no
`node_modules` install step. `start.mjs` resolves the port from
`FLIX_PORT`/`PORT`/`SERVER_PORT`, checks the ffmpeg binaries, and prints a
`[flix] ready` line once the server answers.

### Desktop app (Linux and Windows)

```bash
npm run desktop:build:linux   # .deb + .AppImage
npm run desktop:build:win     # NSIS installer + portable .exe
```

The desktop shell spawns its own local server on loopback only, with no
auto-updater and no network access beyond your own LAN.

### Android and Android TV

Native Kotlin/Compose clients live under `android-native/` (`:core`, `:app`,
`:tv`). They talk to your own Flix server over your local network and
declare their real device codec/HDR capabilities, so most playback happens
as a true direct play — no transcoding, full original quality.

```bash
cd android-native
./gradlew :app:assembleDebug   # phone/tablet
./gradlew :tv:assembleDebug    # Android TV
```

## Naming your files

Movies:

```
Movies/Inception (2010)/Inception (2010) 1080p.mkv
```

Shows:

```
Shows/Dark (2017)/Season 01/Dark S01E01.mkv
```

Drop a Kodi-style `movie.nfo`/`tvshow.nfo` and `poster.jpg`/`fanart.jpg`
next to your files for richer metadata — Flix reads them but never fetches
anything from the network to fill gaps.

## Configuration

All configuration is environment variables, with sane local-first defaults.

| Variable | Default | Purpose |
|---|---|---|
| `FLIX_MEDIA_DIR` | `~/Videos` | Library root that gets scanned and streamed |
| `FLIX_DATA_DIR` | `~/.local/share/flix` | Database, image cache, transcode scratch space |
| `FLIX_PORT` | `4247` | HTTP port (falls back to `PORT`, then `SERVER_PORT` — the var Pterodactyl injects) |
| `FLIX_HOST` | `0.0.0.0` (containers) | Bind address for the standalone bundle's `start.mjs` |
| `FLIX_ADMIN_PASSWORD` | *(generated)* | Set the initial admin password explicitly |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Override the binaries used for probing/transcoding |
| `FLIX_MAX_TRANSCODES` | `2` | Concurrent transcode/remux session cap |
| `FLIX_MAX_TRANSCODE_HEIGHT` | `1080` | Resolution ceiling for a software transcode |
| `FLIX_TRICKPLAY` | off | Generate scrubbing-preview sprites during scan |
| `FLIX_LOG_FORMAT` | `json` in production | `pretty` keeps human-readable log lines (panel consoles, `docker logs`) |

## Architecture

- **Server**: Next.js App Router, with a framework-agnostic core under
  `src/server/` (scanning, metadata, images, playback, recommendations,
  auth) exposed through thin route handlers.
- **Database**: SQLite (`better-sqlite3`) with FTS5 full-text search — a
  single file, no external service.
- **Playback**: range-request direct streaming, or an on-demand HLS fMP4
  session (`ffmpeg`) for remux/transcode, with keyframe-accurate seeking.
- **Frontend**: React 19, Zustand, Tailwind CSS v4 — no third-party UI kit.
- **Recommendations**: a decayed-signal taste model per profile
  (`src/server/reco/engine.ts`), computed entirely server-side.

```
npm run check   # lint + typecheck + build
npm test        # node --test, full unit + integration suite
```

## License

All rights reserved.

## Contact

Built by [ybenyedder](https://github.com/ybenyedder).
