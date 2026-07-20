#!/bin/bash
# Flix — Pterodactyl/Pelican install script.
# Runs as root in a throwaway node:22-bookworm-slim container with the server
# volume mounted at /mnt/server (= /home/container at runtime). Network access
# is available HERE ONLY — at runtime Flix makes zero outbound calls, so
# everything it needs (app bundle + static ffmpeg) is fetched now.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends curl ca-certificates tar xz-utils jq git python3 build-essential

GITHUB_REPO="${GITHUB_REPO:-ybenyedder/flix}"
VERSION="${FLIX_VERSION:-latest}"
ASSET="flix-standalone-linux-x64.tar.gz"

mkdir -p /mnt/server
cd /mnt/server

# Wipe the previous app install but never user state: data/ (db, images),
# media/ (library) and ffmpeg/ survive reinstalls untouched.
clean_app_files() {
  rm -rf /mnt/server/.next /mnt/server/node_modules /mnt/server/public \
    /mnt/server/server.js /mnt/server/start.mjs /mnt/server/package.json
}

# ---------------------------------------------------------------- app bundle
if [ "$VERSION" = "latest" ]; then
  API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
else
  API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${VERSION}"
fi

DOWNLOAD_URL="$(curl -fsSL "$API_URL" 2>/dev/null | jq -r --arg name "$ASSET" '.assets[]? | select(.name == $name) | .browser_download_url' 2>/dev/null || true)"

if [ -n "$DOWNLOAD_URL" ] && [ "$DOWNLOAD_URL" != "null" ]; then
  echo "==> Downloading prebuilt server bundle: ${DOWNLOAD_URL}"
  curl -fL "$DOWNLOAD_URL" -o /tmp/flix.tar.gz
  # Extract to a scratch dir FIRST: wiping the old install before tar has
  # proven the archive sound (ENOSPC, truncated download) would leave the
  # server unbootable when the previous install still worked.
  rm -rf /tmp/flix-extract
  mkdir -p /tmp/flix-extract
  tar -xzf /tmp/flix.tar.gz -C /tmp/flix-extract
  clean_app_files
  # cp -a instead of mv: /tmp and /mnt/server may be different filesystems.
  cp -a /tmp/flix-extract/. /mnt/server/
  rm -rf /tmp/flix-extract /tmp/flix.tar.gz
else
  echo "==> No prebuilt '${ASSET}' asset on ${GITHUB_REPO}@${VERSION} — building from source."
  echo "    (This needs roughly 3 GB of RAM in the install container.)"
  rm -rf /tmp/flix-src
  CLONE_ARGS=(--depth 1)
  [ "$VERSION" != "latest" ] && CLONE_ARGS+=(--branch "$VERSION")
  git clone "${CLONE_ARGS[@]}" "https://github.com/${GITHUB_REPO}.git" /tmp/flix-src
  cd /tmp/flix-src
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
  npm ci
  npm run build
  node scripts/prepare-standalone.mjs
  clean_app_files
  cp -a /tmp/flix-src/dist-standalone/. /mnt/server/
  cd /mnt/server
  rm -rf /tmp/flix-src
fi

# ------------------------------------------- native binding ABI safety net
# The bundle ships better-sqlite3 compiled for the Node version it was built
# with. If this container's Node (same image family as the runtime yolk)
# can't load it, fetch a matching build — prebuilt when available, compiled
# otherwise.
if ! node -e "require('/mnt/server/node_modules/better-sqlite3')" >/dev/null 2>&1; then
  BSQ_VERSION="$(node -p "require('/mnt/server/node_modules/better-sqlite3/package.json').version")"
  echo "==> Rebuilding better-sqlite3@${BSQ_VERSION} for this Node ABI…"
  rm -rf /tmp/bsq && mkdir -p /tmp/bsq
  (cd /tmp/bsq && npm install --no-save "better-sqlite3@${BSQ_VERSION}")
  rm -rf /mnt/server/node_modules/better-sqlite3
  cp -a /tmp/bsq/node_modules/better-sqlite3 /mnt/server/node_modules/
  rm -rf /tmp/bsq
  node -e "require('/mnt/server/node_modules/better-sqlite3')"
fi

# ------------------------------------------------------------ static ffmpeg
# The nodejs yolk has no ffmpeg; ship a static build inside the server volume.

# Never extract/execute an ffmpeg tarball we haven't integrity-checked — it is
# a privileged binary fetched over the network. Verify $1 against the expected
# hex digest $2 using tool $3 (md5sum|sha256sum) and abort on mismatch OR on a
# missing checksum (refuse to run anything unverified rather than best-guess).
verify_ffmpeg_archive() {
  local file="$1" expected="$2" tool="$3"
  if [ -z "$expected" ]; then
    echo "!! Could not fetch a checksum for $(basename "$file"); refusing to run unverified ffmpeg." >&2
    exit 1
  fi
  local actual
  actual="$("$tool" "$file" | cut -d' ' -f1)"
  if [ "$actual" != "$expected" ]; then
    echo "!! Checksum mismatch for $(basename "$file"): expected ${expected}, got ${actual}." >&2
    exit 1
  fi
  echo "    checksum OK (${tool})"
}

if [ ! -x /mnt/server/ffmpeg/ffmpeg ] || [ ! -x /mnt/server/ffmpeg/ffprobe ]; then
  echo "==> Installing static ffmpeg…"
  mkdir -p /mnt/server/ffmpeg
  JV_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
  if curl -fL "$JV_URL" -o /tmp/ffmpeg.tar.xz; then
    # johnvansickle regenerates a .md5 next to the tarball for each release,
    # so the digest fetched now matches the tarball we just pulled.
    JV_MD5="$(curl -fsSL "${JV_URL}.md5" | cut -d' ' -f1 || true)"
    verify_ffmpeg_archive /tmp/ffmpeg.tar.xz "$JV_MD5" md5sum
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp
    cp /tmp/ffmpeg-*-static/ffmpeg /tmp/ffmpeg-*-static/ffprobe /mnt/server/ffmpeg/
    rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-*-static
  else
    echo "==> johnvansickle.com unreachable, falling back to BtbN builds…"
    BTBN_BASE="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
    BTBN_TARBALL="ffmpeg-master-latest-linux64-gpl.tar.xz"
    curl -fL "${BTBN_BASE}/${BTBN_TARBALL}" -o /tmp/ffmpeg.tar.xz
    # BtbN publishes one checksums.sha256 per release listing every asset;
    # pull the line for our tarball and verify the same way.
    BTBN_SHA="$(curl -fsSL "${BTBN_BASE}/checksums.sha256" | grep " ${BTBN_TARBALL}$" | cut -d' ' -f1 || true)"
    verify_ffmpeg_archive /tmp/ffmpeg.tar.xz "$BTBN_SHA" sha256sum
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp
    cp /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffprobe /mnt/server/ffmpeg/
    rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-master-latest-linux64-gpl
  fi
  chmod +x /mnt/server/ffmpeg/ffmpeg /mnt/server/ffmpeg/ffprobe
fi
/mnt/server/ffmpeg/ffmpeg -version | head -1

mkdir -p /mnt/server/media /mnt/server/data

echo ""
echo "=================================================================="
echo " Flix installed."
echo "   1. Upload your movies/shows to /home/container/media (SFTP)."
echo "   2. Start the server, open http://<node-ip>:<port>."
echo "   3. First boot prints a temporary admin password in the console"
echo "      (unless the FLIX_ADMIN_PASSWORD variable is set)."
echo "=================================================================="
