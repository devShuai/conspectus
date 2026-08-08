import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { localAuthEnabled, currentAuthMode } from "@/server/auth/auth-mode";
import { currentAppSession } from "@/server/auth/current-session";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; sent?: string; error?: string }>;
}) {
  if (!localAuthEnabled(currentAuthMode())) notFound();
  const session = await currentAppSession();
  if (session) redirect("/");
  const { token, sent, error } = await searchParams;

  return (
    <main className="shell">
      <p className="eyebrow">找回密码</p>
      <h1>{token ? "设置新密码" : "申请重置链接"}</h1>

      {sent && (
        <p className="field-hint">
          如果该邮箱已注册本地账号，重置邮件已发送（30 分钟内有效）。
        </p>
      )}
      {error === "invalid_token" && (
        <p className="field-error">重置链接无效或已过期，请重新申请。</p>
      )}

      {token ? (
        <form action="/api/auth/password-reset" method="post" className="auth-form">
          <input type="hidden" name="token" value={token} />
          <div className="field">
            <label htmlFor="reset-password">新密码（至少 12 位）</label>
            <input
              id="reset-password"
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
          </div>
          <button className="button" type="submit">
            重置密码
          </button>
          <p className="field-hint">重置成功后所有已登录会话都会失效。</p>
        </form>
      ) : (
        <form action="/api/auth/password-reset" method="post" className="auth-form">
          <div className="field">
            <label htmlFor="reset-email">注册邮箱</label>
            <input id="reset-email" name="email" type="email" required autoComplete="email" />
          </div>
          <button className="button" type="submit">
            发送重置邮件
          </button>
          <p className="field-hint">
            想起密码了？<Link href="/login">去登录</Link>
          </p>
        </form>
      )}
    </main>
  );
}
