/**
 * 冷启动配置校验接线（design §5.4 / §12.4「无效配置实例不 ready」）：
 * Next 服务器实例启动时调用一次 register，必须在处理请求前完成；
 * loadStartupConfig 抛出即实例拒绝启动/服务。
 *
 * 只在 nodejs runtime 注册——edge 与客户端不跑（proxy 默认 nodejs
 * runtime，共享同一进程内已校验过的 env，无需重复校验）。
 * 注意 Vercel 无单一「进程启动」阶段，平台侧闸门仍由 /api/ready 承担（§5.4）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadStartupConfig } = await import("@/server/auth/startup-config");
  loadStartupConfig();
}
