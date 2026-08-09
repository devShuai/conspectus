import { NextResponse, type NextRequest } from "next/server";

/**
 * 认证面响应的统一缓存契约（design §7.9 / §9 PWA 缓存）：所有认证 HTML、
 * RSC payload、API 与 Server Action 响应一律 `private, no-store`，Service
 * Worker 与共享设备缓存都不得留存上一用户的财务数据。
 *
 * 这是 next.config `responseHeaderRules()` 全局默认值之外的第二道保障：
 * config 规则被重排/重构时 proxy 仍兜底。与 next.config 保持一致的字面值，
 * 有意不从 next.config 导入——proxy 不应依赖共享模块（Next 16 文档约定）。
 */
const PRIVATE_NO_STORE = "private, no-store, max-age=0, must-revalidate";

export function proxy(_request: NextRequest): NextResponse {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", PRIVATE_NO_STORE);
  return response;
}

export const config = {
  matcher: [
    /*
     * 覆盖页面（含 RSC/Action POST）与 API；排除：
     * - _next/static、_next/image：内容哈希公开资产，必须保持可缓存
     * - icons/manifest/favicon/logo/offline.html/sw.js：PWA 公开资产
     * - api/cron：自带显式 `Cache-Control: no-store` 契约（§5.4），不被覆盖
     */
    "/((?!_next/static|_next/image|icons/|api/cron|sw\\.js|offline\\.html|manifest\\.webmanifest|favicon|logo).*)",
  ],
};
