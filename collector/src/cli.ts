import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadCliConfig, saveCliConfig } from "./config.js";
import { deviceLogin, logout } from "./auth.js";
import { fetchManifest, reportReadings } from "./report.js";
import { listCollectors } from "./collectors/registry.js";
import type { DeviceLoginResult, UsageReading } from "./types.js";

async function ask(label: string): Promise<string> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(label);
  rl.close();
  return answer;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "configure": {
      const serverUrl = await ask("conspectus server URL (e.g. https://c.example.com): ");
      const issuer = await ask("certus issuer (e.g. https://auth.example.com): ");
      const cliClientId =
        (await ask("CLI client id (default conspectus-cli): ")) || "conspectus-cli";
      saveCliConfig({ serverUrl, issuer, cliClientId });
      console.log("configured");
      return;
    }
    case "login": {
      const config = loadCliConfig();
      await deviceLogin(config, (code: DeviceLoginResult) => {
        console.log("请在浏览器打开并输入代码:");
        console.log(`  ${code.verificationUri}`);
        console.log(`  代码: ${code.userCode}`);
        if (code.verificationUriComplete) {
          console.log(`  直达: ${code.verificationUriComplete}`);
        }
      });
      console.log("✓ 已连接");
      return;
    }
    case "status": {
      const config = loadCliConfig();
      const collectors = await Promise.all(
        listCollectors().map(async (c) => ({
          id: c.id,
          installed: await c.detect(),
        })),
      );
      console.log(JSON.stringify({ server: config.serverUrl, collectors }, null, 2));
      return;
    }
    case "logout": {
      logout();
      console.log("已登出");
      return;
    }
    case "run": {
      const config = loadCliConfig();
      const dryRun = args.includes("--dry-run");
      const manifest = await fetchManifest(config);
      const readings: UsageReading[] = [];
      const collectorErrors: Array<{ collectorId: string; error: string }> = [];
      for (const collector of listCollectors()) {
        try {
          if (!(await collector.detect())) continue;
          // CLI 只为 manifest 中匹配本 collector 的 binding 生成读数（#88）；
          // metric/kind/unit 一律来自 binding，不猜、不硬编码
          const bindings = manifest
            .filter((b) => b.collectorId === collector.id)
            .map((b) => ({
              bindingId: b.bindingId,
              metric: b.metric,
              kind: b.kind,
              unit: b.unit,
            }));
          if (bindings.length === 0) continue;
          const collected = await collector.collect({ bindings });
          readings.push(...collected);
        } catch (cause) {
          // 单个 collector 失败不中断其余（§7.4 采集器独立性）
          collectorErrors.push({
            collectorId: collector.id,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      if (dryRun) {
        console.log(JSON.stringify({ dryRun: true, readings, collectorErrors }, null, 2));
        return;
      }
      if (readings.length === 0) {
        console.log(
          JSON.stringify({ accepted: 0, rejected: [], note: "无可上报读数", collectorErrors }),
        );
        return;
      }
      const result = await reportReadings(config, readings);
      console.log(JSON.stringify({ ...result, collectorErrors }));
      return;
    }
    default:
      console.log(
        "Usage: conspectus-collect <configure|login|status|run [--dry-run]|logout>",
      );
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    "conspectus-collect:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
