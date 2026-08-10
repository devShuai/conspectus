import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { localAuthEnabled, currentAuthMode } from "@/server/auth/auth-mode";
import { currentAppSession } from "@/server/auth/current-session";

export const dynamic = "force-dynamic";

const REGISTER_ERRORS: Record<string, string> = {
  email_taken: "该邮箱已注册，请直接登录或找回密码。",
  invalid_email: "邮箱格式不正确。",
  weak_password: "密码至少 12 位。",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // §7.1：注册页与端点一样按模式关闭（不是藏链接）
  if (!localAuthEnabled(currentAuthMode())) notFound();
  const session = await currentAppSession();
  if (session) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="shell auth-compact">
      <p className="eyebrow">注册</p>
      <h1>创建本地账号</h1>
      <p className="summary">本地账号适合独立部署；如果站点启用了 certus，优先使用统一登录。</p>
      {error && (
        <p className="field-error">{REGISTER_ERRORS[error] ?? "注册失败，请重试。"}</p>
      )}
      <form action="/api/auth/local-register" method="post" className="auth-form">
        <div className="field">
          <label htmlFor="register-email">邮箱</label>
          <input id="register-email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="register-password">密码（至少 12 位）</label>
          <input
            id="register-password"
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
          />
        </div>
        <button className="button" type="submit">
          注册
        </button>
        <p className="field-hint">
          注册后会发送验证邮件。已有账号？<Link href="/login">去登录</Link>
        </p>
      </form>
    </main>
  );
}
