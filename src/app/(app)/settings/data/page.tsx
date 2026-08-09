import { redirect } from "next/navigation";

import ExportPanel from "@/components/settings/export-panel";
import ImportPanel from "@/components/settings/import-panel";
import { currentAppSession } from "@/server/auth/current-session";
import { confirmSubscriptionCsvImportAction } from "@/server/import/actions";

export const dynamic = "force-dynamic";

export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; reauth?: string }>;
}) {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const params = await searchParams;

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 数据</p>
      <h1>导入与导出</h1>

      <h2>CSV 导出</h2>
      <ExportPanel
        initialEntity={params.entity ?? "subscriptions"}
        reauthToken={params.reauth ?? null}
      />

      <h2>CSV 导入</h2>
      <ImportPanel confirmAction={confirmSubscriptionCsvImportAction} />
    </main>
  );
}
