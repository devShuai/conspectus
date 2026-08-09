import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import ExportPanel from "@/components/settings/export-panel";
import ImportPanel from "@/components/settings/import-panel";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import {
  clearInboundRawAction,
  confirmSubscriptionCsvImportAction,
  revokeInboundAliasAction,
  rotateInboundAliasAction,
  setInboundRawRetentionAction,
} from "@/server/import/actions";
import { inboundAddressDisplay } from "@/server/import/alias";

export const dynamic = "force-dynamic";

export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; reauth?: string }>;
}) {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const params = await searchParams;

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { inboundAddress: true, inboundRetainRaw: true },
  });
  if (!user) redirect("/login");

  const inboundAddress = inboundAddressDisplay(user.inboundAddress);
  const inboundConfigured = process.env.INBOUND_EMAIL_DOMAIN?.trim() ? true : false;

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

      <h2>邮件导入</h2>
      <p className="muted">
        把扣款邮件转发到你的专属收件地址，解析结果先落草稿，确认后才入账（design §7.5）。
      </p>
      {!inboundConfigured ? (
        <p className="muted">未配置 INBOUND_EMAIL_DOMAIN，邮件导入未启用。</p>
      ) : inboundAddress === null ? (
        <div className="actions">
          <ActionButton
            action={rotateInboundAliasAction}
            fields={{}}
            label="生成专属收件地址"
            pendingLabel="生成中…"
          />
        </div>
      ) : (
        <div>
          <p>
            你的专属收件地址：<code>{inboundAddress}</code>
          </p>
          <p className="field-hint">
            在你的邮箱里设置规则，把扣款/收据邮件自动转发到该地址；地址可随时轮换，旧地址立即失效。
          </p>
          <div className="actions">
            <ActionButton
              action={rotateInboundAliasAction}
              fields={{}}
              label="轮换地址"
              pendingLabel="轮换中…"
              confirm="轮换后旧地址立即失效，转发规则需要更新为新地址。继续？"
            />
            <ActionButton
              action={revokeInboundAliasAction}
              fields={{}}
              label="停用地址"
              pendingLabel="停用中…"
              confirm="停用后该地址立即失效，已入库的邮件与草稿保留。继续？"
              variant="danger"
            />
          </div>

          <h3>邮件原文保留</h3>
          <p className="muted">
            原文加密保存，默认 30 天自动清除，仅用于排查解析问题；解析出的结构化字段不受影响。
            当前状态：{user.inboundRetainRaw ? "保留（30 天）" : "不保留"}。
          </p>
          <div className="actions">
            <ActionButton
              action={setInboundRawRetentionAction}
              fields={{ retain: user.inboundRetainRaw ? "false" : "true" }}
              label={user.inboundRetainRaw ? "关闭原文保留" : "开启原文保留"}
              pendingLabel="保存中…"
            />
            <ActionButton
              action={clearInboundRawAction}
              fields={{}}
              label="立即清除已存原文"
              pendingLabel="清除中…"
              confirm="立即删除当前账号下全部已存邮件原文？此操作不可撤销。"
              variant="danger"
            />
          </div>
        </div>
      )}
    </main>
  );
}
