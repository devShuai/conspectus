import Link from "next/link";

import { currentAppSession } from "@/server/auth/current-session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await currentAppSession();

  return (
    <main className="shell">
      <img src="/logo.svg" alt="conspectus" width="260" height="64" />
      <p className="eyebrow">M0 · 认证风险验证</p>
      <h1>certus OIDC + 自有 Session PoC</h1>
      <p className="summary">
        OIDC 只负责证明身份；登录完成后，业务页面只读取服务端 Session 中的
        <code> userId</code>。
      </p>
      {session ? (
        <div className="actions">
          <Link className="button" href="/me">查看受保护页面</Link>
          <form action="/api/auth/logout" method="post">
            <button className="button secondary" type="submit">注销 Session</button>
          </form>
        </div>
      ) : (
        <a className="button" href="/api/auth/certus/start">使用 certus 登录</a>
      )}
    </main>
  );
}
