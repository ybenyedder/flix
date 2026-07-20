import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: ["localhost", "127.0.0.1", ...(process.env.FLIX_DEV_ORIGIN ? [process.env.FLIX_DEV_ORIGIN] : [])],
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "sharp"],
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    "*": [
      // La bibliothèque vidéo et le data dir (db + cache images/transcode) vivent
      // souvent DANS le répertoire de déploiement. Ils sont lus via des chemins fs
      // dynamiques à l'exécution — jamais des dépendances de build — donc le tracer
      // standalone ne doit surtout pas les copier (potentiellement des centaines de Go).
      "videos/**",
      "media/**",
      "data/**",
      // SECRET: gluetun.env contient la clé privée WireGuard Mullvad. Il est lu
      // à l'exécution via un chemin fs, jamais une dépendance de build — le tracer
      // standalone ne doit JAMAIS le copier dans l'artefact distribué.
      "vpn/**",
      "dist-desktop/**",
      "dist-standalone/**",
      // Un tarball de bundle précédent qui traîne à la racine (sortie de
      // `prepare-standalone --tar`) serait sinon embarqué (~20 Mo de bundle
      // périmé) dans le standalone suivant ET dans les installeurs desktop.
      "flix-standalone-*.tar.gz",
      "android-native/**",
      "test/**",
      "tests/**",
      "scripts/**",
      "docs/**",
      ".git/**",
      ".next/cache/**",
      "node_modules/.cache/**",
      // NOTE: do NOT exclude node_modules/@swc/** — @swc/helpers (interop_require_default
      // etc.) is a genuine RUNTIME dependency of Next's compiled output, not a build-time
      // tool (there is no @swc/core in this project; Turbopack ships its compiler as
      // @next/swc-* platform packages instead). Excluding it here left the standalone
      // build "working" only by accident, when run from inside the project tree — Node's
      // module resolution silently fell back to the project's own root node_modules.
      // Anywhere the standalone output is copied on its own (e.g. resources/app/server
      // in the packaged Electron app — see scripts/prepare-desktop.mjs), that fallback
      // doesn't exist and next/dist/server/next.js crashes with MODULE_NOT_FOUND.
      "node_modules/@esbuild/**",
      "node_modules/esbuild/**",
      "node_modules/typescript/**",
      "node_modules/electron/**",
      "node_modules/electron-builder/**",
      "node_modules/app-builder-bin/**",
      "**/*.apk",
      "**/*.deb",
      "**/*.AppImage",
      "**/*.map",
      "**/*.md",
    ],
  },
  turbopack: {
    root: process.cwd(),
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    // NB : une migration CSP vers un nonce par requête (middleware) a été
    // évaluée pour retirer 'unsafe-inline' de script-src, mais Next 16 +
    // Turbopack n'appose pas le nonce sur ses scripts inline dans cette config
    // (coquille SPA client), ce qui casse l'hydratation. 'unsafe-inline' est donc
    // conservé volontairement (faiblesse défense-en-profondeur LOW documentée) ;
    // le reste de la politique est strict.
    const isDev = process.env.NODE_ENV !== "production";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "connect-src 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
