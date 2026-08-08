import { redirect } from "next/navigation";

import ExportPanel from "@/components/settings/export-panel";
import { currentAppSession } from "@/server/auth/current-session";

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
      <p className="muted">
        导入预检（上传 → 逐行校验预览 → 确认执行）尚未开放 —— 解析与确认链路未实现，
        开放前不会在界面上伪装可用。当前可通过 CSV 导出做备份与迁移。
      </p>
    </main>
  );
}
