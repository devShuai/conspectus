"use client";

import { useEffect } from "react";

/** Register the static-shell Service Worker (PWA, design §7.9). */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // offline PWA is progressive enhancement; failure is non-fatal
    });
  }, []);
  return null;
}
