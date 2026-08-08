import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __conspectusPrisma: PrismaClient | undefined;
}

/**
 * 数据源选择（issue #64，design.md §5.4 的就绪分层）：
 * `TEST_DATABASE_URL` 只在测试环境生效；生产环境检测到它存在直接抛错 ——
 * CI 变量继承、env 文件复用、Vercel scope 误配都可能把它带进生产运行时，
 * 那时整个应用会静默连到测试库且 /api/ready 照样通过，必须拦在流量进入前。
 */
export function resolveDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const isTest = environment.NODE_ENV === "test" || environment.VITEST === "true";
  // next build 会加载 .env.local 并在收集页面数据时求值本模块；构建不服务流量，
  // 且 PrismaClient 首次查询才连接，构建期不构成切换数据源的实际风险。
  // 硬失败留给真正的生产运行时（next start 后的首次求值与 /api/ready）。
  const isBuildPhase = environment.NEXT_PHASE === "phase-production-build";
  if (
    !isTest &&
    !isBuildPhase &&
    environment.NODE_ENV === "production" &&
    environment.TEST_DATABASE_URL?.trim()
  ) {
    throw new Error(
      "TEST_DATABASE_URL must not be set in production; it would silently switch the datasource to the test database",
    );
  }
  const url = isTest
    ? (environment.TEST_DATABASE_URL ?? environment.DATABASE_URL)
    : environment.DATABASE_URL;
  if (!url) {
    throw new Error(
      isTest
        ? "DATABASE_URL (or TEST_DATABASE_URL) is required"
        : "DATABASE_URL is required",
    );
  }
  return url;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: resolveDatabaseUrl() },
    },
  });
}

export const db: PrismaClient =
  globalThis.__conspectusPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__conspectusPrisma = db;
}
