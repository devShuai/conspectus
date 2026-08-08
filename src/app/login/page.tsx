import Link from "next/link";
import { redirect } from "next/navigation";

import { certusAuthEnabled, currentAuthMode, localAuthEnabled } from "@/server/auth/auth-mode";
import { currentAppSession } from "@/server/auth/current-session";

export const dynamic = "force-dynamic";

const LOGIN_ERRORS: Record<string, string> = {
  invalid_credentials: "邮箱或密码不正确。",
  account_locked: "失败次数过多，账号已锁定 15 分钟。",
  account_suspended: "账号已被停用，请联系管理员。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; registered?: string; reset?: string }>;
}) {
  const session = await currentAppSession();
  if (session) redirect("/");
  const { error, registered, reset } = await searchParams;

  const mode = currentAuthMode();
  const showLocal = localAuthEnabled(mode);
  const showCertus = certusAuthEnabled(mode);

  return (
    <main className="shell">
      <img src="/logo.svg" alt="conspectus" width="260" height="64" />
      <p className="eyebrow">订阅资产管理中心</p>
      <h1>一览你的所有订阅</h1>
      <p className="summary">
        管理缴费时间、到期日与用量——音乐、视频、AI Coding 计划，一处总览。
      </p>

      {registered && (
        <p className="field-hint">注册成功，验证邮件已发送（30 分钟内有效）。请登录。</p>
      )}
      {reset === "ok" && <p className="field-hint">密码已重置，请用新密码登录。</p>}
      {error && <p className="field-error">{LOGIN_ERRORS[error] ?? "登录失败，请重试。"}</p>}

      {showLocal && (
        <form action="/api/auth/local-login" method="post" className="auth-form">
          <div className="field">
            <label htmlFor="login-email">邮箱</label>
            <input id="login-email" name="email" type="email" required autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <button className="button" type="submit">
            邮箱登录
          </button>
          <p className="field-hint">
            <Link href="/register">注册账号</Link> ·{" "}
            <Link href="/reset-password">忘记密码</Link>
          </p>
        </form>
      )}

      {showCertus && (
        <div className="actions">
          <Link className="button" href="/api/auth/certus/start">
            使用 certus 登录
          </Link>
        </div>
      )}
    </main>
  );
}
