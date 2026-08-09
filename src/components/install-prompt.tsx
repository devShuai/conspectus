"use client";

import { useEffect, useState } from "react";

/** Chromium 专有事件，lib.dom 无类型；最小结构声明。 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const VISIT_COUNT_KEY = "conspectus:visits";
const VISIT_SESSION_KEY = "conspectus:visit-counted";
const DISMISSED_KEY = "conspectus:install-dismissed";

/** 用过两次以上再提示安装（§7.9），不在首次访问就弹。 */
const MIN_VISITS = 3;

function recordVisit(): number {
  try {
    // 每个浏览器会话只记一次访问，刷新不灌水
    if (!sessionStorage.getItem(VISIT_SESSION_KEY)) {
      sessionStorage.setItem(VISIT_SESSION_KEY, "1");
      const count = Number(localStorage.getItem(VISIT_COUNT_KEY) ?? "0") + 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(count));
      return count;
    }
    return Number(localStorage.getItem(VISIT_COUNT_KEY) ?? "0");
  } catch {
    // 隐私模式等存储不可用时放弃提示，不影响主流程
    return 0;
  }
}

/**
 * PWA 安装引导（§7.9）：捕获 beforeinstallprompt，访问超过两次后才展示
 * 轻量横幅；用户可触发原生安装或关闭（关闭后不再打扰）。
 */
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [eligible, setEligible] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    const visits = recordVisit();
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");
    } catch {
      setDismissed(true);
    }
    setEligible(visits >= MIN_VISITS);

    const onBeforeInstallPrompt = (event: Event) => {
      // 总是先拦下原生迷你信息条，是否展示由 eligible 决定
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  if (!eligible || dismissed || !deferredPrompt) return null;

  const install = async () => {
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setDeferredPrompt(null);
    }
  };
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // 存储不可用时仅本次隐藏
    }
  };

  return (
    <div
      role="dialog"
      aria-label="安装 conspectus"
      style={{
        position: "fixed",
        left: "1rem",
        right: "1rem",
        bottom: "calc(4.5rem + env(safe-area-inset-bottom))",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.75rem 1rem",
        borderRadius: "0.75rem",
        background: "#14161F",
        color: "#F2F3F7",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
        fontSize: "0.875rem",
      }}
    >
      <span style={{ flex: 1 }}>把 conspectus 装到主屏幕，随手查订阅。</span>
      <button
        type="button"
        onClick={install}
        style={{
          padding: "0.375rem 0.875rem",
          borderRadius: "0.5rem",
          border: "none",
          background: "#C4553C",
          color: "#F2F3F7",
          cursor: "pointer",
        }}
      >
        安装
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="关闭安装提示"
        style={{
          padding: "0.375rem 0.5rem",
          border: "none",
          background: "transparent",
          color: "#F2F3F7",
          opacity: 0.7,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}
