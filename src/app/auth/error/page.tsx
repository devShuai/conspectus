import Link from "next/link";

import { resolveAuthError } from "./messages";

/** 分支决定回哪儿：绑定从账号设置发起，复核从原页面发起，回首页对它们没有意义。 */
const RETRY: Record<string, { href: string; label: string }> = {
  login: { href: "/", label: "返回并重试" },
  bind: { href: "/me", label: "回到账号设置" },
  reauth: { href: "/", label: "返回" },
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  const { branch, title, message } = resolveAuthError(code);
  const retry = RETRY[branch];
  return (
    <main className="shell">
      <p className="eyebrow">认证失败</p>
      <h1>{title}</h1>
      <p className="summary">{message}</p>
      <Link className="button" href={retry.href}>{retry.label}</Link>
    </main>
  );
}
