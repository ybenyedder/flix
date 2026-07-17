# syntax=docker/dockerfile:1
# Flix — production image.
#
#   docker build -t flix .
#   docker run -d -p 4247:4247 -v flix-data:/data -v /path/to/videos:/media:ro flix
#
# Node version note: better-sqlite3 compiles against the builder's Node ABI, so
# the build and runtime stages MUST share the same Node major (22 here — keep in
# sync with .github/workflows and the Pterodactyl egg's yolk image).

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for better-sqlite3's native binding.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Electron is a devDependency of the desktop build only — skip its ~100MB
# binary download; npm ci still installs the JS package so the lockfile checks out.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN npm ci

COPY . .
RUN npm run build && node scripts/prepare-standalone.mjs


FROM node:22-bookworm-slim AS runtime

# ffmpeg: scanning (ffprobe), remux, transcode, poster extraction.
# tini: proper PID-1 signal forwarding + zombie reaping (ffmpeg children).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app/dist-standalone ./

# /data → SQLite db, image cache, transcode scratch. /media → your library (read-only is fine).
# No PORT here on purpose: start.mjs resolves FLIX_PORT > PORT > SERVER_PORT > 4247,
# and a baked-in PORT would override the SERVER_PORT that panels (Pterodactyl)
# inject when this image is used as a custom runtime.
ENV NODE_ENV=production \
    FLIX_DATA_DIR=/data \
    FLIX_MEDIA_DIR=/media \
    FLIX_LOG_FORMAT=pretty
RUN mkdir -p /data /media && chown node:node /data /media

USER node
EXPOSE 4247
VOLUME ["/data", "/media"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.FLIX_PORT||process.env.PORT||process.env.SERVER_PORT||4247}/api/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "start.mjs"]
