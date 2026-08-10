import { execFile, spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, win32 as pathWin32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Windows 上外部 CLI 必须经 shell 启动。
 *
 * npm 全局安装留下的是 `foo.cmd` / `foo.ps1` 垫片，没有无扩展名的可执行文件：
 * - `execFile("claude", …)`     → ENOENT，CreateProcess 找不到目标
 * - `execFile("claude.cmd", …)` → EINVAL，Node 自 CVE-2024-27980 起拒绝不带 shell
 *                                  直接执行 .cmd/.bat
 *
 * 于是 detect() 在 Windows 上恒为 false —— 明明装好的 claude / codex 一个都检测
 * 不到，采集器看上去「没装」，实际是起不动。
 *
 * shell 模式下参数是拼接而非转义的，所以调用方只能传固定字面量或自己生成的数值，
 * 绝不能把用量数据、配置里的字符串等外部输入拼进来。
 */
export function needsShell(platform: string = process.platform): boolean {
  return platform === "win32";
}

/** npm shims need cmd.exe; a concrete .exe (including Desktop paths with spaces) must not use it. */
export function usesShell(command: string, platform: string = process.platform): boolean {
  if (!needsShell(platform)) return false;
  const absolute = platform === "win32" ? pathWin32.isAbsolute(command) : isAbsolute(command);
  return !absolute || /\.(?:cmd|bat|ps1)$/i.test(command);
}

/** shell 模式下会被 cmd 切分或解释的字符。 */
const SHELL_UNSAFE = /[\s"'`&|<>^%()!]/;

/**
 * 在 shell 模式下把不安全的命令/参数挡在门外，让它当场报错而不是变成一条被 cmd
 * 切碎的怪命令。含空格的绝对路径就属于这类（`C:\Program Files\...` 会被拆开）——
 * 所以只传裸命令名，交给 PATH 解析。
 */
function assertShellSafe(command: string, args: string[]): void {
  if (!usesShell(command)) return;
  for (const [label, value] of [
    ["command", command],
    ...args.map((a) => ["arg", a] as const),
  ] as Array<[string, string]>) {
    if (SHELL_UNSAFE.test(value)) {
      throw new Error(
        `shell 模式下不能传含特殊字符或空格的 ${label}: ${JSON.stringify(value)}`,
      );
    }
  }
}

/** 取一次性输出（版本号之类）。 */
export async function runCli(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<string> {
  assertShellSafe(command, args);
  // shell 模式下把 args 拼进命令串而不是另传数组：Node 对后者会打 DEP0190
  // 弃用警告（理由正是「参数只拼接、不转义」），而拼接的安全性此处已由
  // assertShellSafe 保证。用户不该每次采集都看到一行吓人的告警。
  const { stdout } = usesShell(command)
    ? await execFileAsync([command, ...args].join(" "), {
        timeout: timeoutMs,
        shell: true,
      })
    : await execFileAsync(command, args, { timeout: timeoutMs });
  return String(stdout);
}

/** 起长驻子进程（codex app-server）。 */
export function spawnCli(
  command: string,
  args: string[],
  options: { stdio?: "pipe" | "ignore" } = {},
): ChildProcess {
  assertShellSafe(command, args);
  const stdio = options.stdio ?? "pipe";
  // 同 runCli：shell 模式拼成单串，避免 DEP0190
  return usesShell(command)
    ? spawn([command, ...args].join(" "), { stdio, shell: true })
    : spawn(command, args, { stdio });
}
