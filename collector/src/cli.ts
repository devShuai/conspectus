import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadCliConfig, saveCliConfig } from "./config.js";
import { deviceLogin, logout } from "./auth.js";
import {
  fetchManifest,
  flushReportBuffer,
  isRetryableReportError,
  reportReadings,
  type ReportResult,
} from "./report.js";
import { enqueueFailedBatch, bufferStats } from "./buffer.js";
import { runDiagnose } from "./diagnose.js";
import { listCollectors } from "./collectors/registry.js";
import { runAllCollectors } from "./collectors/runner.js";
import type { DeviceLoginResult } from "./types.js";

// Side-effect imports: each collector registers itself on load. Without these
// the registry stays empty and `run` would never collect anything.
import "./collectors/claude.js";
import "./collectors/codex.js";
import "./collectors/minimax.js";

async function ask(label: string): Promise<string> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(label);
  rl.close();
  return answer;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "diagnose" || args.includes("--diagnose")) {
    console.log(JSON.stringify(await runDiagnose(), null, 2));
    return;
  }
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
      await logout();
      console.log("已登出");
      return;
    }
    case "run": {
      const config = loadCliConfig();
      const dryRun = args.includes("--dry-run");
      const manifest = await fetchManifest(config);
      // CLI 只为 manifest 中匹配本 collector 的 binding 生成读数（#88）；
      // metric/kind/unit 一律来自 binding，不猜、不硬编码
      const bindings = manifest.map((b) => ({
        bindingId: b.bindingId,
        collectorId: b.collectorId,
        metric: b.metric,
        kind: b.kind,
        unit: b.unit,
      }));
      // 单个 collector 失败不中断其余（§7.4 采集器独立性），状态落盘供 diagnose
      const { readings, statuses } = await runAllCollectors(bindings);
      const collectorErrors = statuses
        .filter((s) => !s.ok && s.error && s.error !== "not_installed")
        .map((s) => ({ collectorId: s.id, error: s.error ?? "unknown" }));
      if (dryRun) {
        console.log(
          JSON.stringify(
            { dryRun: true, readings, collectorErrors, buffered: bufferStats() },
            null,
            2,
          ),
        );
        return;
      }

      // 先重放上次失败的批次（最旧的在前），再上报本轮读数
      const flush = await flushReportBuffer(config);
      let result: ReportResult = { accepted: 0, rejected: [] };
      let bufferedNow = 0;
      if (readings.length > 0) {
        if (flush.retryableFailure) {
          // 服务器仍不可达：本轮直接入缓冲，不再重复打网络
          enqueueFailedBatch(readings, flush.error ?? "server unreachable");
          bufferedNow = readings.length;
        } else {
          try {
            result = await reportReadings(config, readings);
          } catch (cause) {
            if (!isRetryableReportError(cause)) throw cause;
            enqueueFailedBatch(
              readings,
              cause instanceof Error ? cause.message : String(cause),
            );
            bufferedNow = readings.length;
          }
        }
      }
      console.log(
        JSON.stringify({
          ...result,
          collectorErrors,
          replayed: { flushed: flush.flushed, dropped: flush.dropped },
          bufferedNow,
          bufferDepth: bufferStats().readings,
        }),
      );
      return;
    }
    default:
      console.log(
        "Usage: conspectus-collect <configure|login|status|run [--dry-run]|diagnose|logout>",
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
