import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { loadAuthConfig } from "@/server/auth/config";
import { expiredSessionCookieOptions, SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import { currentAppSession } from "@/server/auth/current-session";
import { deleteAccount, DeleteAccountError } from "@/server/auth/delete-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 注销账号（design §8/§9）：reauth + 邮箱二次确认后的表单落点。
 * 成功后清会话 Cookie 回首页；失败回 /me 带错误码。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const session = await currentAppSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", config.appUrl), 303);
  }

  const form = await request.formData();
  const backTo = (code: string) => {
    const url = new URL("/me", config.appUrl);
    url.searchParams.set("delete_error", code);
    return NextResponse.redirect(url, 303);
  };

  try {
    await deleteAccount({
      userId: session.userId,
      sessionId: session.sessionId,
      reauthToken: String(form.get("reauth") ?? "") || undefined,
      confirmEmail: String(form.get("email") ?? ""),
    });
  } catch (cause) {
    if (cause instanceof DeleteAccountError) return backTo(cause.code);
    throw cause;
  }

  // 账号已删：会话 Cookie 一并清掉（Session 行已随级联删除）
  const response = NextResponse.redirect(new URL("/?deleted=1", config.appUrl), 303);
  response.cookies.set(SESSION_COOKIE_NAME, "", expiredSessionCookieOptions(config));
  return response;
}
