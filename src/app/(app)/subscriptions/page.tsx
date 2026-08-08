import Link from "next/link";
import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { listSubscriptions, listVendors } from "@/server/billing/subscriptions";
import { formatMoney } from "@/components/money";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  trial: "试用中",
  active: "生效中",
  paused: "已暂停",
  canceled: "已取消",
  expired: "已到期",
};

const CYCLE_LABEL: Record<string, string> = {
  weekly: "每周",
  monthly: "每月",
  quarterly: "每季",
  yearly: "每年",
  custom: "自定义",
  lifetime: "买断",
  one_time: "一次性",
};

/** Active-first, then by next billing date; ended ones sink to the bottom. */
const STATUS_ORDER = ["trial", "active", "paused", "expired", "canceled"];

function formatDate(value: Date | null): string {
  if (!value) return "—";
  return value.toISOString().slice(0, 10);
}

export default async function SubscriptionsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [subs, vendors] = await Promise.all([
    listSubscriptions(session.userId),
    listVendors(session.userId),
  ]);
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));

  const sorted = [...subs].sort((a, b) => {
    const byStatus =
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (byStatus !== 0) return byStatus;
    const an = a.nextBillingAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bn = b.nextBillingAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return an - bn;
  });

  return (
    <main className="shell">
      <p className="eyebrow">订阅资产管理中心</p>
      <h1>订阅</h1>

      <div className="actions">
        <Link href="/subscriptions/new" className="button">
          新建订阅
        </Link>
      </div>

      {sorted.length === 0 ? (
        <p className="muted">
          还没有订阅。点「新建订阅」录入第一条 —— 填好周期与首次计费日后，系统会自动算出下次续费日。
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>价格</th>
                <th>周期</th>
                <th>下次续费</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((sub) => (
                <tr key={sub.id}>
                  <td>
                    <Link href={`/subscriptions/${sub.id}`}>{sub.name}</Link>
                    {sub.vendorId && vendorName.has(sub.vendorId) && (
                      <span className="muted"> · {vendorName.get(sub.vendorId)}</span>
                    )}
                    {sub.planName && <span className="muted"> · {sub.planName}</span>}
                  </td>
                  <td>{formatMoney(Number(sub.price), sub.currency)}</td>
                  <td>
                    {CYCLE_LABEL[sub.billingCycle] ?? sub.billingCycle}
                    {sub.billingCycle === "custom" && sub.cycleDays
                      ? ` ${sub.cycleDays} 天`
                      : ""}
                  </td>
                  <td>{formatDate(sub.nextBillingAt)}</td>
                  <td>
                    <span className="tag">{STATUS_LABEL[sub.status] ?? sub.status}</span>
                    {sub.status === "trial" && (
                      <span className="muted"> · 按转正价格估算</span>
                    )}
                    {!sub.autoRenew && <span className="muted"> · 不续费</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
