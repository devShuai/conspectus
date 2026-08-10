"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV = [
  { href: "/", label: "总览", icon: "overview" },
  { href: "/subscriptions", label: "订阅", icon: "subscriptions" },
  { href: "/usage", label: "用量", icon: "usage" },
  { href: "/calendar", label: "日历", icon: "calendar" },
  { href: "/inbox", label: "收件箱", icon: "inbox" },
] as const;

type IconName = (typeof NAV)[number]["icon"] | "settings" | "account";

function NavIcon({ name }: Readonly<{ name: IconName }>) {
  const paths: Record<IconName, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    subscriptions: <><path d="M4 7.5h16M7 4v7M17 4v7"/><rect x="3" y="4" width="18" height="17" rx="3"/></>,
    usage: <><path d="M5 19a9 9 0 1 1 14 0"/><path d="m12 12 5-3"/><circle cx="12" cy="12" r="1"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></>,
    inbox: <><path d="M4 4h16l2 11v5H2v-5L4 4Z"/><path d="M2.5 15H8l2 2h4l2-2h5.5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    account: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

/** Desktop sidebar + mobile top bar/bottom tabs. */
export default function AppNav() {
  const pathname = usePathname();
  return (
    <>
      <header className="mobile-header">
        <Link href="/" className="mobile-brand" aria-label="conspectus 总览">
          <picture>
            <source srcSet="/logo-mark-dark.svg" media="(prefers-color-scheme: dark)" />
            <img src="/logo-mark.svg" alt="" width="28" height="28" />
          </picture>
          <span>conspectus</span>
        </Link>
        <Link href="/settings" className="icon-button" aria-label="设置">
          <NavIcon name="settings" />
        </Link>
      </header>
      <nav className="app-nav" aria-label="主导航">
        <div className="app-nav-inner">
          <Link href="/" className="app-nav-brand">
            <picture>
              <source srcSet="/logo-mark-dark.svg" media="(prefers-color-scheme: dark)" />
              <img src="/logo-mark.svg" alt="" width="30" height="30" />
            </picture>
            <span className="app-nav-wordmark">conspectus</span>
          </Link>
          <div className="app-nav-label">工作台</div>
          {NAV.map((item) => {
            const current = item.href === "/"
              ? pathname === "/" || pathname.startsWith("/analytics")
              : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className="app-nav-item" aria-current={current ? "page" : undefined}>
                <NavIcon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
          <div className="app-nav-label app-nav-label-spaced">管理</div>
          <Link href="/settings" className="app-nav-item app-nav-secondary" aria-current={pathname.startsWith("/settings") ? "page" : undefined}>
            <NavIcon name="settings" />
            设置
          </Link>
          <Link href="/me" className="app-nav-account" aria-current={pathname === "/me" ? "page" : undefined}>
            <span className="account-mark"><NavIcon name="account" /></span>
            <span><strong>我的账号</strong><small>资料与安全</small></span>
          </Link>
        </div>
      </nav>
    </>
  );
}
