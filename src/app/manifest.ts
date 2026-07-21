import type { MetadataRoute } from "next";

// Web App Manifest (Next metadata route → /manifest.webmanifest) so Flix is
// installable as a standalone PWA on desktop + Android with proper icons.
// Model: /home/pc/Documents/auralis_enterprise_grade/src/app/manifest.ts
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Flix — Ta vidéothèque personnelle",
    short_name: "Flix",
    description: "Flix est une plateforme vidéo self-hosted 100% locale : films, séries, recommandations, zéro télémétrie.",
    // Stable install identity: without `id`, browsers key the installed app on
    // start_url — changing it later would orphan existing installations.
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0b10",
    theme_color: "#0b0b10",
    categories: ["entertainment", "video"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Long-press / right-click the installed icon to jump straight to a view. The
    // shell reads ?view= on load (client-side navigation, see src/app/page.tsx),
    // so these deep-link into the running app.
    shortcuts: [
      { name: "Recherche", short_name: "Recherche", url: "/?view=search", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Ma liste", short_name: "Ma liste", url: "/?view=mylist", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
