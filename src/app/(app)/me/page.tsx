import Link from "next/link";
import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { formatDateTime } from "@/components/datetime";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ reauth?: string; delete_error?: string }>;
}) {
  const session = await currentAppSession();
  if (!session) redirect("/login");
  const { reauth, delete_error } = await searchParams;

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

      <div className="table-wrap">
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
              <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt, user.timezone) : "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>

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

      <h2>危险区</h2>
      <div className="danger-zone">
        <p className="muted">
          注销账号将<strong>永久删除</strong> conspectus
          侧的全部数据：订阅、账单记录、用量快照、通知规则、设备与登录会话。
          此操作不可撤销。你的 <strong>certus 账号不受影响</strong>。
        </p>
        {delete_error && (
          <p className="field-error">
            {delete_error === "email_mismatch" && "邮箱不匹配，请重新输入你的注册邮箱。"}
            {delete_error === "reauth_required" && "需要先完成重新认证。"}
            {delete_error === "reauth_invalid" &&
              "重新认证已失效或被使用，请重新发起。"}
            {delete_error === "user_not_found" && "账号状态异常，请重新登录后再试。"}
          </p>
        )}
        {reauth ? (
          <form action="/api/auth/delete-account" method="post">
            <input type="hidden" name="reauth" value={reauth} />
            <div className="field">
              <label htmlFor="delete-email">输入你的邮箱以确认删除</label>
              <input
                id="delete-email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder={user.email ?? "你的注册邮箱"}
              />
            </div>
            <button className="button danger" type="submit">
              永久删除我的账号
            </button>
          </form>
        ) : (
          <p>
            注销需要先重新认证（certus 重新登录一次）：
            <a
              className="button danger"
              href={`/api/auth/reauth/start?action=delete_account&target=${encodeURIComponent("/me")}`}
            >
              重新认证并继续注销
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
