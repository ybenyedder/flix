"use client";

import { useEffect } from "react";

// Enregistre le service worker (public/sw.js) — cache local des assets
// statiques + affiches et coquille hors-ligne. Production uniquement : en dev,
// un SW actif masque le HMR et sert des assets périmés.
export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Best-effort : une PWA sans SW reste une app web parfaitement fonctionnelle.
    });
  }, []);
  return null;
}
