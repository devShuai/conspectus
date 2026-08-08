"use client";

import { useState } from "react";

const ENTITIES = [
  { id: "subscriptions", label: "订阅" },
  { id: "billing", label: "账单" },
  { id: "usage", label: "用量" },
] as const;

/**
 * CSV 导出（design §7.1 敏感操作）：先走 reauth（certus prompt=login），
 * 回调带回一次性 token（5 分钟）后再调 /api/export。
 */
export default function ExportPanel({
  initialEntity,
  reauthToken,
}: Readonly<{ initialEntity: string; reauthToken: string | null }>) {
  const [entity, setEntity] = useState(
    ENTITIES.some((e) => e.id === initialEntity) ? initialEntity : "subscriptions",
  );

  const reauthHref = `/api/auth/reauth/start?action=export&target=${encodeURIComponent(
    `/settings/data?entity=${entity}`,
  )}`;
  const exportHref = `/api/export?entity=${encodeURIComponent(entity)}&reauth=${encodeURIComponent(
    reauthToken ?? "",
  )}`;

  return (
    <div>
      <div className="field" style={{ maxWidth: 280 }}>
        <label htmlFor="export-entity">导出内容</label>
        <select
          id="export-entity"
          value={entity}
          onChange={(event) => setEntity(event.target.value)}
        >
          {ENTITIES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
      <div className="actions">
        {reauthToken ? (
          <>
            <a className="button" href={exportHref}>
              下载 CSV
            </a>
            <span className="tag">已重新认证（5 分钟内有效）</span>
          </>
        ) : (
          <a className="button" href={reauthHref}>
            重新认证并导出
          </a>
        )}
      </div>
      <p className="field-hint">
        导出全部数据属敏感操作（design §7.1），需要先完成一次重新认证；CSV 带 BOM，Excel 中文不乱码
      </p>
    </div>
  );
}
