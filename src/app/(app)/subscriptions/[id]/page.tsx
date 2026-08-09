import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import {
  TenantError,
  getSubscription,
  listVendors,
} from "@/server/billing/subscriptions";
import {
  changeSubscriptionStatusAction,
  deleteSubscriptionAction,
  updateSubscriptionAction,
} from "@/server/billing/subscription-actions";
import SubscriptionForm from "@/components/subscription-form";
import ActionButton from "@/components/action-button";
import { formatMoney } from "@/components/money";
import { annualizedCost } from "@/server/billing/cycle";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  trial: "试用中",
  active: "生效中",
  paused: "已暂停",
  canceled: "已取消",
  expired: "已到期",
};

function toDateInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

export default async function SubscriptionDetailPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const { id } = await params;
  let sub;
  try {
    sub = await getSubscription(session.userId, id);
  } catch (cause) {
    if (cause instanceof TenantError && cause.code === "not_found") notFound();
    throw cause;
  }

  const vendors = await listVendors(session.userId);
  const price = Number(sub.price);
  // 年化口径以服务端为唯一实现（§7.2 / #79）；one_time 无年化口径不展示
  const yearly =
    sub.billingCycle === "one_time"
      ? null
      : annualizedCost(price, sub.billingCycle, sub.cycleDays);

  return (
    <main className="shell">
      <p className="eyebrow">
        <Link href="/subscriptions">订阅</Link>
      </p>
      <h1>{sub.name}</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">单周期价格</div>
          <div className="stat-value">{formatMoney(price, sub.currency)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">年化成本</div>
          <div className="stat-value">
            {yearly === null ? "—" : formatMoney(yearly, sub.currency)}
          </div>
          {sub.status === "trial" && (
            <div className="stat-sub">试用中 · 按转正价格估算</div>
          )}
          {sub.billingCycle === "lifetime" && (
            <div className="stat-sub">终身买断 · 按 3 年摊销估算</div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">下次续费</div>
          <div className="stat-value">{toDateInput(sub.nextBillingAt) || "—"}</div>
          {!sub.autoRenew && <div className="stat-sub">已关闭自动续费</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label">状态</div>
          <div className="stat-value">{STATUS_LABEL[sub.status] ?? sub.status}</div>
        </div>
      </div>

      <h2>快捷操作</h2>
      <div className="actions">
        {sub.status === "active" && (
          <ActionButton
            action={changeSubscriptionStatusAction}
            fields={{ id: sub.id, status: "paused" }}
            label="暂停"
          />
        )}
        {sub.status === "paused" && (
          <ActionButton
            action={changeSubscriptionStatusAction}
            fields={{ id: sub.id, status: "active" }}
            label="恢复"
          />
        )}
        {sub.status !== "canceled" && (
          <ActionButton
            action={changeSubscriptionStatusAction}
            fields={{ id: sub.id, status: "canceled" }}
            label="标记为已取消"
          />
        )}
        <ActionButton
          action={deleteSubscriptionAction}
          fields={{ id: sub.id }}
          label="删除"
          variant="danger"
          confirm={`删除「${sub.name}」？此操作不可撤销。`}
        />
      </div>

      <h2>编辑</h2>
      <SubscriptionForm
        action={updateSubscriptionAction}
        submitLabel="保存"
        vendorOptions={vendors.map((v) => ({
          id: v.id,
          name: v.name,
          isSystem: v.userId === null,
        }))}
        values={{
          id: sub.id,
          name: sub.name,
          planName: sub.planName ?? "",
          status: sub.status,
          price: String(price),
          currency: sub.currency,
          billingCycle: sub.billingCycle,
          cycleDays: sub.cycleDays ? String(sub.cycleDays) : "",
          anchorDay: sub.anchorDay ? String(sub.anchorDay) : "",
          startedAt: toDateInput(sub.startedAt),
          trialEndsAt: toDateInput(sub.trialEndsAt),
          autoRenew: sub.autoRenew,
          vendorId: sub.vendorId ?? "",
          tags: sub.tags.join(", "),
          notes: sub.notes ?? "",
        }}
      />
    </main>
  );
}
