import { defineConfig } from "vitest/config";

/**
 * collector 自己的配置。没有它，在本目录执行 `npm test` 时 vitest 会向上找到
 * 仓库根的 vitest.config.ts，于是：
 *
 * - app / email-forward 两个 project 一并被拉起。CI 的发布流水线只在 collector/
 *   里装依赖，跑 app 项目会因为缺 next / prisma 直接崩；本地则表现为同一批用例被
 *   app 与 collector 各跑一遍。
 * - 若连根配置也不存在（单独 clone 本目录），默认 include 又会把 dist/ 里编译出的
 *   .test.js 一起扫进来跑第二遍 —— tsc 不清理旧产物，一个被重命名过的陈旧测试会让
 *   构建挂在源码里早已不存在的用例上。
 *
 * 仓库根的 `npm test` 仍通过其 projects 声明覆盖本包（#69 的单一入口），这份配置
 * 只影响以本目录为工作目录的运行。
 */
export default defineConfig({
  test: {
    name: "collector",
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
