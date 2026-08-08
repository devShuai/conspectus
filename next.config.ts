import type { NextConfig } from "next";

export const PRIVATE_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const PUBLIC_STATIC_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const SERVICE_WORKER_CACHE = "public, max-age=0, must-revalidate";

function cacheControl(value: string) {
  return [{ key: "Cache-Control", value }];
}

/**
 * Default every application response to private/no-store. Public PWA assets
 * are deliberately opted back into caching by later, more-specific rules.
 * Next.js keeps content-hashed `/_next/static` assets immutable regardless.
 */
export function responseHeaderRules() {
  return [
    { source: "/:path*", headers: cacheControl(PRIVATE_NO_STORE) },
    { source: "/offline.html", headers: cacheControl(PUBLIC_STATIC_CACHE) },
    { source: "/manifest.webmanifest", headers: cacheControl(PUBLIC_STATIC_CACHE) },
    { source: "/icons/:path*", headers: cacheControl(PUBLIC_STATIC_CACHE) },
    { source: "/logo.svg", headers: cacheControl(PUBLIC_STATIC_CACHE) },
    { source: "/favicon.svg", headers: cacheControl(PUBLIC_STATIC_CACHE) },
    { source: "/favicon-16.svg", headers: cacheControl(PUBLIC_STATIC_CACHE) },
    { source: "/favicon-32.svg", headers: cacheControl(PUBLIC_STATIC_CACHE) },
    { source: "/sw.js", headers: cacheControl(SERVICE_WORKER_CACHE) },
  ];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  async headers() {
    return responseHeaderRules();
  },
};

export default nextConfig;
