const CACHE_PREFIX = "conspectus-static-";
const CACHE = `${CACHE_PREFIX}v3`;
const LEGACY_CACHES = new Set(["conspectus-shell-v1"]);
const OFFLINE_PAGE = "/offline.html";
const PRECACHE = [
  OFFLINE_PAGE,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
];

function isPublicStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;

  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/favicon-16.svg" ||
    url.pathname === "/favicon-32.svg"
  );
}

// Static application shell only. Auth HTML, RSC payloads, API and Server
// Action responses are private,no-store and NEVER intercepted.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => LEGACY_CACHES.has(key) || (key.startsWith(CACHE_PREFIX) && key !== CACHE),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Navigations are always network-only. If the network is unavailable, show
  // the public offline page; never fall back to authenticated HTML or RSC.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => (await caches.match(OFFLINE_PAGE)) || Response.error()),
    );
    return;
  }

  // RSC, APIs, Server Actions, exports and arbitrary same-origin resources are
  // deliberately not intercepted. Only an explicit public-asset allowlist is
  // eligible for runtime caching.
  if (!isPublicStaticAsset(url)) return;

  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((response) => {
          const cacheControl = response.headers.get("Cache-Control") || "";
          if (!response.ok || /(?:^|,)\s*(?:private|no-store)\b/i.test(cacheControl)) {
            return response;
          }

          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        }),
    ),
  );
});
