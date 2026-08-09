"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * (app) 段错误边界（issue #80）：品牌化错误页，说明 + 重试 + 回总览。
 * Next 16.3 起 retry 是稳定 prop（替代旧的 reset），重新获取并重渲染本段。
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="shell">
      <p className="eyebrow">订阅资产管理中心</p>
      <h1>页面出错了</h1>
      <p className="muted">
        加载时发生异常，多数是暂时的，可以重试一次。
        {error.digest && `（错误编号 ${error.digest}，反馈时请附上）`}
      </p>
      <div className="actions">
        <button type="button" className="button" onClick={() => retry()}>
          重试
        </button>
        <Link href="/" className="button secondary">
          回总览
        </Link>
      </div>
    </main>
  );
}
