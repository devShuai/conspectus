import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #91 回归：/api/cron/notification-digest 路由存在但 vercel.json 与
 * docker/cron-jobs.sh 均未列入，批次即便创建也永不投递。
 * 这里把「每个 cron 路由目录都必须出现在两处调度配置里」固化成契约。
 */
const cronDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

function routeNames(): string[] {
  return readdirSync(cronDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("cron scheduling contract (#91)", () => {
  const routes = routeNames();
  const vercel = JSON.parse(readFileSync(`${repoRoot}/vercel.json`, "utf8")) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  const cronJobs = readFileSync(`${repoRoot}/docker/cron-jobs.sh`, "utf8");

  it("found at least one cron route directory", () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  for (const name of routes) {
    it(`/api/cron/${name} is scheduled in vercel.json and cron-jobs.sh`, () => {
      expect(vercel.crons.map((c) => c.path)).toContain(`/api/cron/${name}`);
      expect(cronJobs).toContain(`job ${name} `);
    });
  }
});
