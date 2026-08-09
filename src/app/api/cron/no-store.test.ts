import { describe, expect, it } from "vitest";

/**
 * §5.4 统一契约：所有 /api/cron/* 端点的响应都带 `Cache-Control: no-store`，
 * 包括 401/400/503。用无凭据请求逐个验证 10 个路由的 401 响应即可覆盖
 * 「每个响应点都走 cronJson」。
 */
const routes: Record<string, () => Promise<{ GET: (req: Request) => Promise<Response> }>> = {
  "certus-capabilities": () => import("./certus-capabilities/route"),
  fx: () => import("./fx/route"),
  "identity-status": () => import("./identity-status/route"),
  "notification-digest": () => import("./notification-digest/route"),
  "notification-dispatch": () => import("./notification-dispatch/route"),
  "notification-scan": () => import("./notification-scan/route"),
  purge: () => import("./purge/route"),
  rebase: () => import("./rebase/route"),
  renewals: () => import("./renewals/route"),
  "usage-sync": () => import("./usage-sync/route"),
};

describe("cron no-store contract (#121)", () => {
  for (const [name, load] of Object.entries(routes)) {
    it(`GET /api/cron/${name} carries Cache-Control: no-store`, async () => {
      const { GET } = await load();
      const response = await GET(new Request(`http://localhost/api/cron/${name}`));
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  }
});
