import { NextResponse } from "next/server";

/**
 * 认证模式开关（design §7.1 模式 B / §12.4 / #97）：
 * - certus：仅 certus OIDC；本地端点必须 404 而不是隐藏入口
 * - local：仅本地邮箱密码；certus 端点必须 404
 * - both：两者都开
 */

export type AuthMode = "certus" | "local" | "both";

export function currentAuthMode(
  environment: Record<string, string | undefined> = process.env,
): AuthMode {
  const raw = environment.AUTH_MODE?.trim() || "certus";
  if (raw === "certus" || raw === "local" || raw === "both") return raw;
  throw new Error(`AUTH_MODE must be one of certus/local/both, got "${raw}"`);
}

export function localAuthEnabled(mode: AuthMode): boolean {
  return mode !== "certus";
}

export function certusAuthEnabled(mode: AuthMode): boolean {
  return mode !== "local";
}

/**
 * 端点模式闸门：功能在当前模式关闭时返回 404（§7.1「关闭时返回 404 而不是
 * 隐藏入口」），否则返回 null。必须放在路由处理的最前面，先于限流与 DB。
 */
export function authModeGate(
  kind: "local" | "certus",
  environment: Record<string, string | undefined> = process.env,
): NextResponse | null {
  const mode = currentAuthMode(environment);
  const enabled = kind === "local" ? localAuthEnabled(mode) : certusAuthEnabled(mode);
  if (enabled) return null;
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/** 浏览器表单导航（区别于 API fetch）：成功/失败都应以 303 回页面而非裸 JSON。 */
export function wantsHtmlRedirect(request: Request): boolean {
  return request.headers.get("sec-fetch-mode") === "navigate";
}
