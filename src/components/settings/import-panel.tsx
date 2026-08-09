"use client";

import { useActionState, useState } from "react";

import type { ImportActionResult } from "@/server/import/actions";
import type { ImportPreview } from "@/server/import/subscriptions";

const STRATEGIES = [
  { id: "skip", label: "跳过冲突行" },
  { id: "update", label: "更新已有订阅" },
  { id: "duplicate", label: "保留两者（复制新建）" },
] as const;

const ACTION_LABELS: Record<string, string> = {
  create: "新建",
  update: "更新",
  skip: "跳过",
  duplicate: "复制新建",
};

type ConfirmAction = (
  prev: ImportActionResult | undefined,
  formData: FormData,
) => Promise<ImportActionResult>;

/**
 * CSV 导入三步走（design §7.7）：上传 → 预检（POST /api/import/preview）→
 * 确认执行（Server Action）。列集与订阅导出对齐，导出文件可直接回导。
 */
export default function ImportPanel({
  confirmAction,
}: Readonly<{ confirmAction: ConfirmAction }>) {
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<string>("skip");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmState, confirmFormAction, confirming] = useActionState(
    confirmAction,
    undefined,
  );

  async function runPreview() {
    if (!file) return;
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("strategy", strategy);
      const response = await fetch("/api/import/preview", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setPreviewError(payload?.error?.message ?? `预检失败（${response.status}）`);
        return;
      }
      setCsvText(await file.text());
      setPreview(payload.data as ImportPreview);
    } catch {
      setPreviewError("预检请求失败，请稍后重试");
    } finally {
      setPreviewing(false);
    }
  }

  const confirmed = confirmState?.ok ? confirmState.data : null;

  return (
    <div>
      <div className="field" style={{ maxWidth: 280 }}>
        <label htmlFor="import-strategy">冲突策略（按 名称+服务商 匹配）</label>
        <select
          id="import-strategy"
          value={strategy}
          onChange={(event) => {
            setStrategy(event.target.value);
            setPreview(null);
          }}
        >
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="import-file">CSV 文件（与导出列集一致，≤ 512KB）</label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setCsvText(null);
            setPreview(null);
            setPreviewError(null);
          }}
        />
        <p className="field-hint">
          列：name,vendor,plan,price,currency,billing_cycle,cycle_days,started_at,anchor_day,status,auto_renew,category,payment_method,tags,notes
        </p>
      </div>
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={!file || previewing}
          onClick={runPreview}
        >
          {previewing ? "预检中…" : "上传预检"}
        </button>
      </div>
      {previewError && (
        <p className="form-error" role="alert">
          {previewError}
        </p>
      )}

      {preview && (
        <div>
          <p className="muted" role="status">
            共 {preview.summary.total} 行：新建 {preview.summary.create}、更新{" "}
            {preview.summary.update}、跳过 {preview.summary.skip}、复制新建{" "}
            {preview.summary.duplicate}、错误 {preview.summary.invalid}
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>行</th>
                  <th>名称</th>
                  <th>服务商</th>
                  <th>动作</th>
                  <th>问题</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 50).map((row) => (
                  <tr key={row.row}>
                    <td className="num">{row.row}</td>
                    <td>{row.name}</td>
                    <td>{row.vendor}</td>
                    <td>
                      {row.action === null ? (
                        <span className="tag">错误</span>
                      ) : (
                        ACTION_LABELS[row.action] +
                        (row.willCreateVendor ? "（新建服务商）" : "")
                      )}
                    </td>
                    <td>{row.errors.join("；")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 50 && (
            <p className="muted">仅展示前 50 行，共 {preview.rows.length} 行</p>
          )}

          {preview.summary.total - preview.summary.invalid > 0 && csvText !== null && (
            <form action={confirmFormAction} className="actions">
              <input type="hidden" name="csv" value={csvText} />
              <input type="hidden" name="strategy" value={strategy} />
              <button className="button" type="submit" disabled={confirming}>
                {confirming ? "导入中…" : "确认执行导入"}
              </button>
            </form>
          )}
        </div>
      )}

      {confirmState && !confirmState.ok && (
        <p className="form-error" role="alert">
          {confirmState.error.message}
        </p>
      )}
      {confirmed && (
        <p className="tag" role="status">
          已新建 {confirmed.created}、更新 {confirmed.updated}、跳过 {confirmed.skipped}
          {confirmed.failed.length > 0 && `、失败 ${confirmed.failed.length}`}
        </p>
      )}
      {confirmed && confirmed.failed.length > 0 && (
        <ul className="muted">
          {confirmed.failed.slice(0, 20).map((f) => (
            <li key={f.row}>
              第 {f.row} 行：{f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
