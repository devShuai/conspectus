import Link from "next/link";

import { currentAppSession } from "@/server/auth/current-session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await currentAppSession();

  return (
    <main className="shell">
      <img src="/logo.svg" alt="conspectus" width="260" height="64" />
      <p className="eyebrow">订阅资产管理中心</p>
      <h1>一览你的所有订阅</h1>
      <p className="summary">
        管理缴费时间、到期日与用量——音乐、视频、AI Coding 计划，一处总览。
      </p>
      {session ? (
        <div className="actions">
          <Link className="button" href="/">
            进入总览
          </Link>
          <form action="/api/auth/logout" method="post">
            <button className="button secondary" type="submit">
              注销
            </button>
          </form>
        </div>
      ) : (
        <div className="actions">
          <a className="button" href="/api/auth/certus/start">
            使用 certus 登录
          </a>
        </div>
      )}
    </main>
  );
}
