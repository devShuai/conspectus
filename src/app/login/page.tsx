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
    <main className="shell auth-shell">
      <section className="auth-intro">
        <picture>
          <source srcSet="/logo-dark.svg" media="(prefers-color-scheme: dark)" />
          <img src="/logo.svg" alt="conspectus" width="260" height="64" />
        </picture>
        <p className="eyebrow">订阅资产管理中心</p>
        <h1>一览你的所有订阅</h1>
        <p className="summary">
          管理缴费时间、到期日与用量——音乐、视频、AI Coding 计划，一处总览。
        </p>
        <ul className="auth-benefits">
          <li>续费与试用到期不再遗漏</li>
          <li>Codex、Claude、Kimi 用量自动采集</li>
          <li>凭据与业务 Session 保持最小化</li>
        </ul>
      </section>
      <section className="auth-panel" aria-labelledby="login-title">
        <p className="eyebrow">欢迎回来</p>
        <h2 id="login-title">登录 conspectus</h2>
        {registered && (
          <p className="notice success">注册成功，验证邮件已发送（30 分钟内有效）。请登录。</p>
        )}
        {reset === "ok" && <p className="notice success">密码已重置，请用新密码登录。</p>}
        {error && <p className="notice danger">{LOGIN_ERRORS[error] ?? "登录失败，请重试。"}</p>}

        {showCertus && (
          <div className="actions auth-primary-action">
            <a className="button" href="/api/auth/certus/start">
              使用 certus 登录
            </a>
          </div>
        )}
        {showLocal && showCertus && <div className="auth-divider"><span>或使用本地账号</span></div>}
        {showLocal && (
          <form action="/api/auth/local-login" method="post" className="auth-form">
            <div className="field">
              <label htmlFor="login-email">邮箱</label>
              <input id="login-email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="field">
              <label htmlFor="login-password">密码</label>
              <input id="login-password" name="password" type="password" required autoComplete="current-password" />
            </div>
            <button className={`button${showCertus ? " secondary" : ""}`} type="submit">邮箱登录</button>
            <p className="field-hint">
              <Link href="/register">注册账号</Link> · <Link href="/reset-password">忘记密码</Link>
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
