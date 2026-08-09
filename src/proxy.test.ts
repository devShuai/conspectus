import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { config, proxy } from "./proxy";

/**
 * #121-12：认证 HTML/RSC/Action 响应统一 `private, no-store`（§7.9/§9）。
 * proxy 是 next.config 全局 header 之外的第二道保障；公开静态资产与
 * /api/cron（自带 no-store 契约）必须被 matcher 排除。
 */
describe("proxy cache-control guard", () => {
  it("sets private, no-store on matched responses", () => {
    const response = proxy(new NextRequest("http://localhost/subscriptions"));
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0, must-revalidate",
    );
  });

  it("excludes public assets and cron endpoints from the matcher", () => {
    const matcher = config.matcher[0];
    // 排除项都在负向前瞻里：静态资产、PWA 公开文件、cron 端点
    for (const excluded of [
      "_next/static",
      "_next/image",
      "icons/",
      "api/cron",
      "sw\\.js",
      "offline\\.html",
      "manifest\\.webmanifest",
      "favicon",
      "logo",
    ]) {
      expect(matcher).toContain(excluded);
    }
  });
});
