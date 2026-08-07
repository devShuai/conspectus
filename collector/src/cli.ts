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
      for (const collector of listCollectors()) {
        if (!(await collector.detect())) continue;
        const bindings = manifest.map((id) => ({
          bindingId: id,
          metric: "",
          kind: "quota" as const,
          unit: "",
        }));
        const collected = await collector.collect({ bindings });
        readings.push(...collected);
      }
      if (dryRun) {
        console.log(JSON.stringify({ dryRun: true, readings }, null, 2));
        return;
      }
      const result = await reportReadings(config, readings);
      console.log(JSON.stringify(result));
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
