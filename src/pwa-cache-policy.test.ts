import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { PRIVATE_NO_STORE, responseHeaderRules } from "../next.config";

type WorkerHandler = (event: Record<string, unknown>) => void;

function loadServiceWorker() {
  const handlers = new Map<string, WorkerHandler>();
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
  };
  const caches = {
    delete: vi.fn().mockResolvedValue(true),
    keys: vi
      .fn()
      .mockResolvedValue(["conspectus-shell-v1", "conspectus-static-v1", "other-app-cache"]),
    match: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(cache),
  };
  const fetchMock = vi.fn();
  const self = {
    addEventListener: (type: string, handler: WorkerHandler) => handlers.set(type, handler),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    location: { origin: "https://conspectus.example" },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
  };

  const source = readFileSync(
    fileURLToPath(new URL("../public/sw.js", import.meta.url)),
    "utf8",
  );
  runInNewContext(source, {
    Promise,
    Response,
    URL,
    caches,
    fetch: fetchMock,
    self,
  });

  return { cache, caches, fetchMock, handlers, self };
}

function dispatchFetch(handler: WorkerHandler, request: Record<string, unknown>) {
  let response: Promise<Response> | undefined;
  const respondWith = vi.fn((result: Promise<Response>) => {
    response = Promise.resolve(result);
  });
  handler({ request, respondWith });
  return { respondWith, response: () => response };
}

describe("PWA private cache boundary", () => {
  it("pre-caches only public offline assets and evicts the old shell cache", async () => {
    const { cache, caches, handlers } = loadServiceWorker();
    const install = handlers.get("install");
    const activate = handlers.get("activate");
    expect(install).toBeDefined();
    expect(activate).toBeDefined();

    let installWork: Promise<unknown> | undefined;
    install?.({ waitUntil: (work: Promise<unknown>) => (installWork = work) });
    await installWork;
    expect(cache.addAll).toHaveBeenCalledWith([
      "/offline.html",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-512-maskable.png",
    ]);

    let activateWork: Promise<unknown> | undefined;
    activate?.({ waitUntil: (work: Promise<unknown>) => (activateWork = work) });
    await activateWork;
    expect(caches.delete).toHaveBeenCalledWith("conspectus-shell-v1");
    expect(caches.delete).toHaveBeenCalledWith("conspectus-static-v1");
    expect(caches.delete).not.toHaveBeenCalledWith("other-app-cache");
  });

  it("falls back every offline navigation to offline.html without caching HTML", async () => {
    const { cache, caches, fetchMock, handlers } = loadServiceWorker();
    const fetchHandler = handlers.get("fetch");
    expect(fetchHandler).toBeDefined();

    const offline = new Response("offline");
    fetchMock.mockRejectedValue(new TypeError("offline"));
    caches.match.mockImplementation(async (request: unknown) =>
      request === "/offline.html" ? offline : undefined,
    );

    const event = dispatchFetch(fetchHandler!, {
      method: "GET",
      mode: "navigate",
      url: "https://conspectus.example/subscriptions",
    });
    expect(event.respondWith).toHaveBeenCalledOnce();
    await expect(event.response()).resolves.toBe(offline);
    expect(caches.match).toHaveBeenCalledWith("/offline.html");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("does not intercept API, RSC or Server Action requests", () => {
    const { handlers } = loadServiceWorker();
    const fetchHandler = handlers.get("fetch")!;

    for (const request of [
      { method: "GET", mode: "cors", url: "https://conspectus.example/api/export" },
      { method: "GET", mode: "cors", url: "https://conspectus.example/subscriptions?_rsc=abc" },
      { method: "POST", mode: "cors", url: "https://conspectus.example/subscriptions" },
    ]) {
      expect(dispatchFetch(fetchHandler, request).respondWith).not.toHaveBeenCalled();
    }
  });

  it("caches allowlisted public assets but refuses private/no-store responses", async () => {
    const { cache, caches, fetchMock, handlers } = loadServiceWorker();
    const fetchHandler = handlers.get("fetch")!;
    caches.match.mockResolvedValue(undefined);

    fetchMock.mockResolvedValueOnce(
      new Response("chunk", { headers: { "Cache-Control": "public, max-age=31536000" } }),
    );
    const publicRequest = {
      method: "GET",
      mode: "cors",
      url: "https://conspectus.example/_next/static/chunks/app-abc.js",
    };
    await dispatchFetch(fetchHandler, publicRequest).response();
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledOnce());

    fetchMock.mockResolvedValueOnce(
      new Response("private", { headers: { "Cache-Control": PRIVATE_NO_STORE } }),
    );
    const privateRequest = {
      method: "GET",
      mode: "cors",
      url: "https://conspectus.example/icons/private.png",
    };
    await dispatchFetch(fetchHandler, privateRequest).response();
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("defaults all app responses to private/no-store and only overrides public assets", () => {
    const rules = responseHeaderRules();
    expect(rules[0]).toEqual({
      source: "/:path*",
      headers: [{ key: "Cache-Control", value: PRIVATE_NO_STORE }],
    });
    expect(rules.at(-1)).toEqual({
      source: "/sw.js",
      headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
    });
  });
});
