import Link from "next/link";
import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import { RebaseForm, TimezoneForm } from "@/components/settings/general-forms";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import {
  requestRebase,
  retryRebase,
  updateTimezone,
} from "@/server/settings/actions";

export const dynamic = "force-dynamic";

const SECTIONS = [
  { href: "/settings/connections", label: "服务商连接", note: "API Key 加密存储，自动拉取用量" },
  { href: "/settings/usage", label: "用量录入", note: "手动创建额度、更新读数" },
  { href: "/settings/data", label: "数据", note: "CSV 导出（需重新认证）与导入" },
  { href: "/settings/notifications", label: "通知", note: "规则与渠道、不可投递原因" },
  { href: "/settings/devices", label: "采集设备", note: "本地采集器的设备与撤销" },
];

export default async function SettingsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { baseCurrency: true, timezone: true },
  });
  if (!user) redirect("/login");

  const [activeJob, lastFailedJob] = await Promise.all([
    db.currencyRebaseJob.findFirst({
      where: { userId: session.userId, status: { in: ["pending", "running"] } },
      orderBy: { createdAt: "desc" },
    }),
    db.currencyRebaseJob.findFirst({
      where: { userId: session.userId, status: "failed" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <main className="shell">
      <p className="eyebrow">设置</p>
      <h1>账户与偏好</h1>

      <h2>通用</h2>
      <TimezoneForm action={updateTimezone} current={user.timezone} />

      <h2>本位币</h2>
      <p className="muted">
        当前本位币：<strong>{user.baseCurrency}</strong>，所有金额折算到它再汇总。
      </p>
      {activeJob ? (
        <div className="stat-card">
          <div className="stat-label">正在变更 → {activeJob.toCurrency}</div>
          <div className="stat-value">
            {activeJob.doneCount} / {activeJob.totalCount}
          </div>
          <p className="field-hint">
            状态 {activeJob.status}；后台任务每 5 分钟推进一次，完成前报表保持 {user.baseCurrency} 口径
          </p>
        </div>
      ) : (
        <RebaseForm action={requestRebase} current={user.baseCurrency} />
      )}
      {!activeJob && lastFailedJob && (
        <div className="stat-card">
          <div className="stat-label">上次变更失败（→ {lastFailedJob.toCurrency}）</div>
          <p className="field-error">{lastFailedJob.lastError ?? "未知错误"}</p>
          <ActionButton
            action={retryRebase}
            fields={{ jobId: lastFailedJob.id }}
            label="重试"
            pendingLabel="重试中…"
          />
        </div>
      )}

      <h2>分区</h2>
      <div className="usage-grid">
        {SECTIONS.map((section) => (
          <div key={section.href} className="usage-card">
            <div className="usage-card-head">
              <Link href={section.href} className="usage-metric">
                {section.label}
              </Link>
            </div>
            <p className="usage-meta">{section.note}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
