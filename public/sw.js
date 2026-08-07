const CACHE = "conspectus-shell-v1";
const SHELL = ["/", "/offline.html"];

// Static application shell only. Auth HTML, RSC payloads, API and Server
// Action responses are private,no-store and NEVER intercepted.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return; // never cache API
  if (url.pathname === "/offline" || url.pathname === "/") {
    // network-first for the shell page, offline fallback to cached shell
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request).then((r) => r || caches.match("/offline"))),
    );
    return;
  }
  // static assets (icons, fonts): cache-first with network fallback
  if (/\.(png|svg|woff2?|css|js)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});
