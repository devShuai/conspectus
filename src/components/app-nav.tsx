"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "总览" },
  { href: "/subscriptions", label: "订阅" },
  { href: "/calendar", label: "日历" },
  { href: "/usage", label: "用量" },
  { href: "/inbox", label: "收件箱" },
  { href: "/settings", label: "设置" },
];

/** Mobile bottom tab bar + desktop top nav (PWA, design §7.9). */
export default function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="app-nav" aria-label="主导航">
      <div className="app-nav-inner">
        {/* 桌面顶栏左侧字标（#83）；移动端底栏保持纯文字标签，CSS 里隐藏 */}
        <Link href="/" className="app-nav-brand">
          <picture>
            <source srcSet="/logo-mark-dark.svg" media="(prefers-color-scheme: dark)" />
            <img src="/logo-mark.svg" alt="" width="24" height="24" />
          </picture>
          <span className="app-nav-wordmark">conspectus</span>
        </Link>
        {NAV.map((item) => {
          const current =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="app-nav-item"
              aria-current={current ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
