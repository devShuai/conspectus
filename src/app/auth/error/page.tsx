import Link from "next/link";

const safeMessages: Record<string, string> = {
  invalid_callback_url: "回调地址与本应用登记值不一致。",
  invalid_state: "登录事务校验失败，请重新开始。",
  invalid_transaction: "登录事务已失效或已使用，请重新开始。",
  invalid_claims: "身份声明未通过校验。",
  account_suspended: "账号已被停用，无法创建新的业务 Session。",
  authorization_response_rejected:
    "certus 返回的授权响应未通过校验。请确认 APP_URL 与 certus 登记的 redirect_uri 完全一致（含 localhost / 127.0.0.1），且 client secret 正确；开发环境可查看服务端日志 [auth/callback]。",
  unexpected_error: "认证暂时不可用，请稍后重试。",
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code = "unexpected_error" } = await searchParams;
  return (
    <main className="shell">
      <p className="eyebrow">认证失败</p>
      <h1>没有创建业务 Session</h1>
      <p className="summary">{safeMessages[code] ?? safeMessages.unexpected_error}</p>
      <Link className="button" href="/">返回并重试</Link>
    </main>
  );
}
