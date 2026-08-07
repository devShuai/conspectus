import Link from "next/link";

const NAV = [
  { href: "/", label: "总览" },
  { href: "/subscriptions", label: "订阅" },
  { href: "/usage", label: "用量" },
  { href: "/notifications", label: "通知" },
  { href: "/devices", label: "设备" },
  { href: "/me", label: "我的" },
];

/** Mobile bottom tab bar + desktop top nav (PWA, design §7.9). */
export default function AppNav() {
  return (
    <nav className="app-nav" aria-label="主导航">
      <div className="app-nav-inner">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className="app-nav-item">
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
