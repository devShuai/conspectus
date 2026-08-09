import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 统一空状态（issue #80）：logo-mark + 一句说明 + 可选 CTA，
 * 替代各处干巴巴的一行灰字。M6 草稿箱等新页面也直接复用。
 */
export default function EmptyState({
  title,
  hint,
  action,
}: Readonly<{
  title: string;
  hint?: ReactNode;
  action?: { href: string; label: string };
}>) {
  return (
    <div className="empty-state">
      <svg className="empty-state-mark" viewBox="0 0 44 44" aria-hidden="true">
        <rect x="2" y="2" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="4" />
        <rect x="25" y="2" width="17" height="17" rx="4" fill="var(--brand-accent)" />
        <rect x="2" y="25" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="4" />
        <rect x="25" y="25" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="4" opacity=".4" />
      </svg>
      <p className="empty-state-title">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      {action && (
        <Link href={action.href} className="button">
          {action.label}
        </Link>
      )}
    </div>
  );
}
