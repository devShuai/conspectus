import type { Metadata, Viewport } from "next";

import ServiceWorkerRegistration from "@/components/service-worker-registration";
import "./styles.css";

export const metadata: Metadata = {
  title: "conspectus",
  description: "订阅资产管理中心",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
};

/* PWA 全面屏（#86）：声明 viewport-fit=cover 后 env(safe-area-inset-*) 才生效 */
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
