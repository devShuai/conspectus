import Link from "next/link";
import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await currentAppSession();
  if (session) redirect("/");

  return (
    <main className="shell">
      <img src="/logo.svg" alt="conspectus" width="260" height="64" />
      <p className="eyebrow">订阅资产管理中心</p>
      <h1>一览你的所有订阅</h1>
      <p className="summary">
        管理缴费时间、到期日与用量——音乐、视频、AI Coding 计划，一处总览。
      </p>
      <div className="actions">
        <Link className="button" href="/api/auth/certus/start">
          使用 certus 登录
        </Link>
      </div>
    </main>
  );
}
