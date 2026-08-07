import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  title: "conspectus · M0",
  description: "订阅资产管理中心认证风险验证",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
