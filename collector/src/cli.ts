import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadCliConfig, saveCliConfig, type CliConfig } from "./config.js";
import { deviceLogin, logout } from "./auth.js";
import { ensureDevice, replaceDeviceAfterLogin } from "./device.js";
import {
  fetchManifest,
  flushReportBuffer,
  isRetryableReportError,
  reportLedger,
  reportReadings,
  type ReportResult,
} from "./report.js";
import { resolveCodeburnEntry, runCodeburnLedger } from "./collectors/codeburn-export.js";
import { spawnCli } from "./exec.js";
import { AGENT_VERSION } from "./version.js";
import { renderShow, summarizeLedger, type ShowModel } from "./ui/show.js";
import { enqueueFailedBatch, bufferStats } from "./buffer.js";
import { runDiagnose } from "./diagnose.js";
import { listCollectors } from "./collectors/registry.js";
import { runAllCollectors } from "./collectors/runner.js";
import { collectionDiagnostics } from "./collection-diagnostics.js";
import type { DeviceLoginResult } from "./types.js";

// Side-effect imports: each collector registers itself on load. Without these
// the registry stays empty and `run` would never collect anything.
import "./collectors/claude.js";
import "./collectors/codex.js";
import "./collectors/kimi.js";

async function ask(label: string): Promise<string> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(label);
  rl.close();
  return answer;
}

/**
 * 把参数原样透传给 codeburn 并让出终端。
 *
 * codeburn 是本包的**依赖**，它的 bin 垫片落在本包的 node_modules/.bin 里，
 * npm 只为顶层包链接 bin —— 所以全局装了 conspectus-collect 之后，`codeburn`
 * 这个命令在 PATH 上并不存在。show 的提示语原本直接写「codeburn today」，
 * 对没有另行全局安装 codeburn 的人来说是句跑不通的建议。
 *
 * 这里用当前 node 直接跑它的 dist/cli.js（与 resolveCodeburnEntry 同一条路径），
 * stdio 全继承，交互式 TUI 与退出码都照旧。
 */
async function passthroughCodeburn(args: string[]): Promise<void> {
  const entry = resolveCodeburnEntry();
  if (!entry) {
    console.error("codeburn 依赖未安装；重新安装 @devshuai/conspectus-collect 即可带上它");
    process.exitCode = 1;
    return;
  }
  const child = spawnCli(process.execPath, [entry, ...args], { stdio: "inherit" });
  process.exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (error) => {
      console.error("codeburn 启动失败:", error.message);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  // 必须在下面的 --diagnose 快捷方式之前：透传的参数属于 codeburn，不该被本 CLI 解释
  if (command === "codeburn") {
    await passthroughCodeburn(args);
    return;
  }
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
      const replaceDevice = args.includes("--replace-device");
      await deviceLogin(config, (code: DeviceLoginResult) => {
        console.log("请在浏览器打开并输入代码:");
        console.log(`  ${code.verificationUri}`);
        console.log(`  代码: ${code.userCode}`);
        if (code.verificationUriComplete) {
          console.log(`  直达: ${code.verificationUriComplete}`);
        }
      });
      // design §7.4：首次完成 certus 授权后就生成签名密钥对并注册公钥。此前这步
      // 只在首次 run 的上报路径里发生（report.ts 调 ensureDevice），于是 login
      // 成功后「设置 / 采集设备」始终是空的 —— 用户既无法确认本机是否登记成功，
      // 也无法撤销一台还没上报过的设备。ensureDevice 幂等，重复 login 不会重复注册。
      // Replacement is intentionally after deviceLogin: a revoked device may
      // only be replaced after the user explicitly authorizes a fresh Device
      // Grant. A failed/expired grant therefore leaves local device state intact.
      const device = replaceDevice
        ? await replaceDeviceAfterLogin(config)
        : await ensureDevice(config);
      console.log(`✓ 已连接，设备已注册: ${device.deviceId}`);
      return;
    }
    case "show": {
      // 本地展示：把 diagnose 的连接/缓冲区、manifest 的绑定与本轮读数、
      // 以及 codeburn 的消耗汇总拼成一页。全程只读，不上报任何东西。
      const noSpend = args.includes("--no-spend");
      const diagnostic = await runDiagnose();
      const model: ShowModel = {
        generatedAt: new Date(),
        agentVersion: AGENT_VERSION,
        server: {
          url: diagnostic.config.serverUrl,
          issuer: diagnostic.config.issuer,
          reachable: diagnostic.connectivity.server?.reachable,
          status: diagnostic.connectivity.server?.status,
          error: diagnostic.connectivity.server?.error,
        },
        auth: {
          loggedIn: diagnostic.tokens.hasAccessToken,
          expiresAt: diagnostic.tokens.expiresAt,
          expired: diagnostic.tokens.expired,
        },
        device: {
          registered: diagnostic.device.registered,
          deviceId: diagnostic.device.deviceId,
        },
        bindings: null,
        collectorErrors: [],
        warnings: [],
        spend: null,
        buffer: diagnostic.buffer,
      };

      // 绑定与读数需要配置 + 登录；缺任何一项都降级显示，而不是整页报错
      let config: CliConfig | null = null;
      try {
        config = loadCliConfig();
      } catch (cause) {
        model.manifestError = cause instanceof Error ? cause.message : String(cause);
      }
      if (config && !diagnostic.tokens.hasAccessToken) {
        model.manifestError = "未登录";
      } else if (config) {
        try {
          const manifest = await fetchManifest(config);
          const bindings = manifest.map((b) => ({
            bindingId: b.bindingId,
            collectorId: b.collectorId,
            metric: b.metric,
            kind: b.kind,
            unit: b.unit,
          }));
          const { readings, statuses } = await runAllCollectors(bindings);
          const byBinding = new Map(readings.map((r) => [r.bindingId, r]));
          model.bindings = bindings.map((binding) => {
            const reading = byBinding.get(binding.bindingId);
            return {
              collectorId: binding.collectorId,
              metric: binding.metric,
              kind: binding.kind,
              unit: binding.unit,
              used: reading?.usedValue ?? reading?.remainingValue,
              limit: reading?.limitValue,
              capturedAt: reading?.capturedAt,
            };
          });
          const diagnostics = collectionDiagnostics(
            bindings,
            statuses,
            readings.length,
            listCollectors().map((collector) => collector.id),
          );
          model.collectorErrors = diagnostics.collectorErrors;
          model.warnings = diagnostics.warnings;
        } catch (cause) {
          model.manifestError = cause instanceof Error ? cause.message : String(cause);
        }
      }

      if (noSpend) {
        model.spendError = "已用 --no-spend 跳过";
      } else {
        // 进度提示走 stderr：stdout 要能干净地重定向进文件或贴进 issue
        process.stderr.write("正在读取 codeburn…\n");
        try {
          const ledger = await runCodeburnLedger();
          if (ledger) {
            model.spend = summarizeLedger(ledger);
          } else {
            model.spendError = "codeburn 导出为空或 schema 不符";
          }
        } catch (cause) {
          model.spendError = (cause instanceof Error ? cause.message : String(cause)).slice(0, 160);
        }
      }

      process.stdout.write(renderShow(model));
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
      const diagnostics = collectionDiagnostics(
        bindings,
        statuses,
        readings.length,
        listCollectors().map((collector) => collector.id),
      );
      if (dryRun) {
        console.log(
          JSON.stringify(
            { dryRun: true, readings, ...diagnostics, buffered: bufferStats() },
            null,
            2,
          ),
        );
        return;
      }

      // 消耗流水账（#143）：与读数各走各的端点，一侧失败不影响另一侧
      // 此处已过 dry-run 的提前返回，无需再判
      let ledger:
        | { accepted: number; days: number; sessions: number; tools: number; models: number }
        | { error: string };
      try {
        // 不传 provider = 全部来源。codeburn 支持 41 个工具，写死 claude 会把
        // codex / kimi / copilot 等的消耗整段丢掉。
        const bundle = await runCodeburnLedger();
        if (bundle) {
          const result = await reportLedger(config, bundle);
          ledger = {
            ...result,
            days: bundle.days.length,
            sessions: bundle.sessions.length,
            tools: bundle.tools.length,
            models: bundle.models.length,
          };
        } else {
          ledger = { error: "导出为空或 schema 不符" };
        }
      } catch (cause) {
        ledger = { error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 160) };
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
          ...diagnostics,
          ledger,
          replayed: { flushed: flush.flushed, dropped: flush.dropped },
          bufferedNow,
          bufferDepth: bufferStats().readings,
        }),
      );
      return;
    }
    default:
      console.log(
        "Usage: conspectus-collect <configure|login [--replace-device]|status|run [--dry-run]|diagnose|logout>",
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
