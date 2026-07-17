// Flix service worker — cache local minimal pour la PWA.
//
// Périmètre volontairement étroit : ce SW ne touche JAMAIS aux flux vidéo,
// segments HLS, sous-titres ou API d'état (Range/SSE/CSRF passent en direct,
// comportement réseau par défaut du navigateur). Il ne fait que :
//   1. servir les assets statiques fingerprientés (/_next/static, icônes,
//      manifest) en cache-first — ils sont immuables par construction ;
//   2. garder un cache borné des affiches (/api/images/*) — contenu adressé
//      par hash, donc sûr à servir depuis le cache ;
//   3. garder la dernière coquille de navigation pour afficher quelque chose
//      d'utile (plutôt que l'erreur navigateur) si le serveur est éteint.
// 100 % same-origin : aucun octet ne part ni ne vient d'un autre hôte.

const STATIC_CACHE = "flix-static-v1";
const IMAGE_CACHE = "flix-images-v1";
const SHELL_CACHE = "flix-shell-v1";
const KNOWN_CACHES = [STATIC_CACHE, IMAGE_CACHE, SHELL_CACHE];

// Plafond du cache d'affiches : au-delà, on évince les entrées les plus
// anciennes (ordre d'insertion de CacheStorage) — pas de LRU exact, inutile ici.
const IMAGE_CACHE_MAX_ENTRIES = 400;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  );
}

function isPosterImage(url) {
  return url.pathname.startsWith("/api/images/");
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (cacheName === IMAGE_CACHE) {
      const keys = await cache.keys();
      if (keys.length > IMAGE_CACHE_MAX_ENTRIES) {
        await Promise.all(keys.slice(0, keys.length - IMAGE_CACHE_MAX_ENTRIES).map((k) => cache.delete(k)));
      }
    }
  }
  return response;
}

// Coquille hors-ligne de dernier recours, en dur pour ne dépendre d'aucun fetch.
const OFFLINE_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Flix — hors ligne</title><style>body{background:#141414;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:2rem}h1{color:#e50914;font-size:2rem;margin:0 0 .5rem}p{color:#aaa}</style></head><body><main><h1>Flix</h1><p>Le serveur Flix est injoignable.<br>Vérifie qu'il est démarré, puis réessaie.</p></main></body></html>`;

async function shellNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // On ne garde qu'une seule coquille : la racine. Les vues sont un état
    // client (Zustand), pas des routes — inutile de cacher d'autres pages.
    // Et uniquement du HTML : une réponse binaire (téléchargement servi en
    // navigation) ne doit jamais empoisonner la coquille hors-ligne.
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.includes("text/html")) await cache.put("/", response.clone());
    return response;
  } catch {
    const hit = await cache.match("/");
    if (hit) return hit;
    return new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isPosterImage(url)) {
    event.respondWith(cacheFirst(IMAGE_CACHE, request));
    return;
  }
  // Toute autre route /api/ passe en direct, AVANT la branche navigate : une
  // navigation vers /api/* (ex. téléchargement de la sauvegarde
  // /api/admin/backup) ne doit jamais transiter par la coquille.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(shellNetworkFirst(request));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(STATIC_CACHE, request));
    return;
  }
  // Tout le reste (flux vidéo, HLS, sous-titres, API d'état, SSE…) : réseau
  // par défaut, sans interception — surtout pas de cache sur du contenu à
  // Range/authentification/temps réel.
});
