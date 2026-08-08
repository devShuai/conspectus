import { describe, expect, it, vi } from "vitest";

import {
  createPinnedLookup,
  isBlockedWebhookAddress,
  matchesResolvedAddress,
  resolveWebhookTarget,
} from "./webhook-safe";

describe("webhook SSRF boundary", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::8.8.8.8",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
  ])("blocks private or special-use address %s", (address) => {
    expect(isBlockedWebhookAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isBlockedWebhookAddress(address)).toBe(false);
    },
  );

  it("rejects unsafe URL forms and literal private addresses", async () => {
    await expect(resolveWebhookTarget("file:///etc/passwd")).resolves.toBeNull();
    await expect(resolveWebhookTarget("https://user:pass@example.com/hook")).resolves.toBeNull();
    await expect(resolveWebhookTarget("https://example.com/hook#fragment")).resolves.toBeNull();
    await expect(resolveWebhookTarget("http://127.0.0.1/hook")).resolves.toBeNull();
    await expect(resolveWebhookTarget("http://[fc00::1]/hook")).resolves.toBeNull();
    await expect(resolveWebhookTarget("http://[::ffff:8.8.8.8]/hook")).resolves.toBeNull();
    await expect(
      resolveWebhookTarget("https://api.localhost/hook", async () => [
        { address: "93.184.216.34", family: 4 },
      ]),
    ).resolves.toBeNull();
  });

  it("rejects the whole hostname when DNS mixes public and private answers", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(resolveWebhookTarget("https://webhook.example/hook", resolver)).resolves.toBeNull();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("pins the connector to the address returned by the single validation lookup", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const target = await resolveWebhookTarget("https://webhook.example/hook?source=test", resolver);
    expect(target).toMatchObject({
      hostname: "webhook.example",
      address: "93.184.216.34",
      family: 4,
    });

    const pinned = createPinnedLookup(target!);
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinned("webhook.example", { family: 4 }, (error, address, family) => {
        if (error) return reject(error);
        if (typeof address !== "string") return reject(new Error("expected one pinned address"));
        resolve({ address, family: family ?? 0 });
      });
    });

    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("fails the pinned lookup if the connector requests a different hostname", async () => {
    const target = await resolveWebhookTarget(
      "https://webhook.example/hook",
      async () => [{ address: "93.184.216.34", family: 4 }],
    );
    const pinned = createPinnedLookup(target!);

    const code = await new Promise<string | undefined>((resolve) => {
      pinned("rebound.example", { family: 4 }, (error) => resolve(error?.code));
    });
    expect(code).toBe("ENOTFOUND");
  });

  it("accepts only the exact validated peer address at connect time", () => {
    expect(matchesResolvedAddress("93.184.216.34", "93.184.216.34")).toBe(true);
    expect(matchesResolvedAddress("93.184.216.34", "93.184.216.35")).toBe(false);
    expect(
      matchesResolvedAddress(
        "2606:4700:4700::1111",
        "2606:4700:4700:0:0:0:0:1111",
      ),
    ).toBe(true);
    expect(matchesResolvedAddress("93.184.216.34", "::ffff:93.184.216.34")).toBe(false);
  });
});
