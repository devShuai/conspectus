import Link from "next/link";
import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { listVendors } from "@/server/billing/subscriptions";
import SubscriptionForm from "@/components/subscription-form";
import { createSubscriptionAction } from "@/server/billing/subscription-actions";

export const dynamic = "force-dynamic";

export default async function NewSubscriptionPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const vendors = await listVendors(session.userId);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="shell">
      <p className="eyebrow">
        <Link href="/subscriptions">订阅</Link>
      </p>
      <h1>新建订阅</h1>

      <SubscriptionForm
        action={createSubscriptionAction}
        submitLabel="创建"
        vendorOptions={vendors.map((v) => ({
          id: v.id,
          name: v.name,
          isSystem: v.userId === null,
        }))}
        values={{
          name: "",
          planName: "",
          status: "active",
          price: "",
          currency: "CNY",
          billingCycle: "monthly",
          cycleDays: "",
          anchorDay: "",
          startedAt: today,
          trialEndsAt: "",
          autoRenew: true,
          vendorId: "",
          tags: "",
          notes: "",
        }}
      />
    </main>
  );
}
