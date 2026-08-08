import Link from "next/link";
import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      name: true,
      email: true,
      emailVerifiedAt: true,
      baseCurrency: true,
      timezone: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });
  if (!user) redirect("/login");

  return (
    <main className="shell">
      <p className="eyebrow">我的</p>
      <h1>{user.name ?? "未命名用户"}</h1>

      <table className="data-table">
        <tbody>
          <tr>
            <th>邮箱</th>
            <td>
              {user.email ?? "—"}{" "}
              {user.emailVerifiedAt ? (
                <span className="tag">已验证</span>
              ) : (
                <span className="tag warn">未验证</span>
              )}
            </td>
          </tr>
          <tr>
            <th>本位币</th>
            <td>{user.baseCurrency}</td>
          </tr>
          <tr>
            <th>时区</th>
            <td>{user.timezone}</td>
          </tr>
          <tr>
            <th>注册时间</th>
            <td>{user.createdAt.toISOString().slice(0, 10)}</td>
          </tr>
          <tr>
            <th>最近登录</th>
            <td>{user.lastLoginAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"}</td>
          </tr>
        </tbody>
      </table>

      <div className="actions">
        <Link className="button secondary" href="/settings">
          前往设置
        </Link>
        <form action="/api/auth/logout" method="post">
          <button className="button secondary" type="submit">
            退出登录
          </button>
        </form>
      </div>
    </main>
  );
}
