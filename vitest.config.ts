import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function loadEnvFile(): void {
  for (const name of [".env.local", ".env"]) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnvFile();

/**
 * One entry point for every package (#69).
 *
 * `collector/` is a separate npm package; when it was only reachable through
 * its own `npm test`, nothing invoked it and M4 shipped with zero coverage
 * while the root run still reported a growing green total. Both projects are
 * declared here so a single `npm test` cannot silently skip one.
 */
export default defineConfig({
  test: {
    // 远端共享测试库在满核并行下会瞬断（"Can't reach database server" 的间歇
    // 失败来源）；限制 worker 数，用少量耗时换确定性
    maxWorkers: 2,
    projects: [
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        test: {
          name: "app",
          environment: "node",
          include: ["src/**/*.test.ts"],
          restoreMocks: true,
        },
      },
      {
        test: {
          name: "collector",
          root: fileURLToPath(new URL("./collector", import.meta.url)),
          environment: "node",
          include: ["src/**/*.test.ts"],
          restoreMocks: true,
        },
      },
    ],
  },
});
