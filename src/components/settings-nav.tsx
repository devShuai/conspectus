"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/settings", label: "通用" },
  { href: "/settings/usage", label: "用量来源" },
  { href: "/settings/connections", label: "服务端连接" },
  { href: "/settings/devices", label: "采集设备" },
  { href: "/settings/notifications", label: "通知" },
  { href: "/settings/data", label: "数据与导入" },
] as const;

export default function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="settings-nav" aria-label="设置分区">
      {ITEMS.map((item) => {
        const current = item.href === "/settings" ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
