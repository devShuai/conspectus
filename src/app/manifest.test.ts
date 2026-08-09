import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import manifest from "./manifest";

/** #121-11：192 / 512 普通图标 + 两个尺寸的 maskable 变体（§7.9）。 */
describe("PWA manifest icons", () => {
  it("declares a 192x192 maskable icon alongside the other variants", () => {
    const icons = manifest().icons ?? [];
    const bySrc = new Map(icons.map((icon) => [icon.src, icon]));

    expect(bySrc.get("/icons/icon-192.png")).toMatchObject({ sizes: "192x192" });
    expect(bySrc.get("/icons/icon-512.png")).toMatchObject({ sizes: "512x512" });
    expect(bySrc.get("/icons/icon-192-maskable.png")).toMatchObject({
      sizes: "192x192",
      purpose: "maskable",
    });
    expect(bySrc.get("/icons/icon-512-maskable.png")).toMatchObject({
      sizes: "512x512",
      purpose: "maskable",
    });
  });

  it("every declared icon file exists under public/", () => {
    for (const icon of manifest().icons ?? []) {
      const path = join(process.cwd(), "public", icon.src);
      expect(existsSync(path), `${icon.src} missing`).toBe(true);
    }
  });
});
