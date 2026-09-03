import { heading, palette, colorEnabled, table, terminalWidth } from "./format.js";

/**
 * 合并后的命令帮助。
 *
 * conspectus-collect 把 codeburn 的命令并进了自己的命名空间：`conspectus-collect
 * today` 等价于 `codeburn today`。这样用户只需要记一个入口，也不必因为 codeburn
 * 的 bin 不在 PATH 上而绕路。
 *
 * **本包的命令优先**。唯一的重名是 `status`：它在 0.1.0 起就输出 JSON、可能已被
 * 脚本消费，不能因为并入 codeburn 就改语义。被遮住的同名命令一律可以用
 * `conspectus-collect codeburn <名字>` 精确调用。
 */

export interface CommandEntry {
  name: string;
  /** 参数形态，如 `[--dry-run]`；没有就留空。 */
  usage?: string;
  summary: string;
}

/** 本包自己的命令。顺序即展示顺序，按「配置 → 日常 → 排查」排。 */
export const OWN_COMMANDS: readonly CommandEntry[] = [
  { name: "configure", summary: "配置服务端地址与认证中心" },
  { name: "login", usage: "[--replace-device]", summary: "设备授权登录，并注册本机为采集设备" },
  { name: "show", usage: "[--no-spend]", summary: "一页看清采集状态与消耗汇总" },
  { name: "run", usage: "[--dry-run]", summary: "采集一轮并上报（--dry-run 只采不报）" },
  { name: "status", summary: "采集器安装情况（JSON）" },
  { name: "diagnose", summary: "本地诊断报告：配置、令牌、设备、连通性（JSON）" },
  { name: "logout", summary: "清除本机令牌" },
  { name: "codeburn", usage: "[...]", summary: "直接调用 codeburn，用于消歧同名命令" },
];

const OWN_NAMES: ReadonlySet<string> = new Set(OWN_COMMANDS.map((c) => c.name));

/** 某个命令是否由本包处理（而不是透传给 codeburn）。 */
export function isOwnCommand(name: string): boolean {
  return OWN_NAMES.has(name);
}

/**
 * 从 `codeburn --help` 的输出里抽命令表。
 *
 * 解析的是别人的帮助文本，属于**易碎**的一环：commander 改了排版这里就抽不到。
 * 所以失败时返回空数组而不是抛错 —— 帮助页少一段总比整个 -h 打不开好，调度
 * 本身也不依赖这张表（未知命令一律透传，由 codeburn 自己报错）。
 */
export function parseCodeburnCommands(helpText: string): CommandEntry[] {
  const lines = helpText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Commands:/.test(line.trim()));
  if (start < 0) return [];

  const entries: CommandEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    // 命令行必须有缩进；顶格的是下一节的标题
    if (!/^\s{2,}\S/.test(line)) break;
    const trimmed = line.trim();
    // 签名与说明之间是 2 个以上空格；续行（说明换行）没有这个分隔，跳过
    const split = trimmed.search(/\s{2,}/);
    if (split < 0) continue;
    const signature = trimmed.slice(0, split).trim();
    const summary = trimmed.slice(split).trim();
    const name = signature.split(/\s+/)[0];
    if (!name || !/^[a-z][a-z0-9-]*$/i.test(name)) continue;
    // help 由本包自己实现；重名的由本包接管，这里不列出来免得误导
    if (name === "help" || OWN_NAMES.has(name)) continue;
    entries.push({ name, summary });
  }
  return entries;
}

export function renderHelp(
  version: string,
  codeburn: CommandEntry[] | null,
  stream: { isTTY?: boolean; columns?: number } = process.stdout,
  env: Record<string, string | undefined> = process.env,
): string {
  const colors = palette(colorEnabled(stream, env));
  const width = terminalWidth(stream);
  const lines: string[] = [];

  lines.push(colors.bold("conspectus-collect") + colors.dim(` ${version}`));
  lines.push("");
  lines.push(colors.dim("  用法  conspectus-collect <命令> [参数…]"));

  const render = (entries: readonly CommandEntry[]): string[] =>
    table(
      [{ header: "", max: 28 }, { header: "", max: Math.max(20, width - 34) }],
      entries.map((entry) => [
        entry.usage ? `${entry.name} ${colors.dim(entry.usage)}` : entry.name,
        entry.summary,
      ]),
    )
      .slice(2)
      .map((line) => "  " + line);

  lines.push(...heading("采集器", colors, width));
  lines.push(...render(OWN_COMMANDS));

  lines.push(...heading("codeburn（本地消耗分析，参数原样透传）", colors, width));
  if (codeburn === null) {
    lines.push("  " + colors.dim("命令表取不到；`conspectus-collect codeburn --help` 可看 codeburn 自己的用法。"));
  } else if (codeburn.length === 0) {
    lines.push("  " + colors.dim("codeburn 依赖未安装。"));
  } else {
    lines.push(...render(codeburn));
    lines.push("");
    lines.push(
      "  " +
        colors.dim(
          "同名命令以采集器为准（status）；要用 codeburn 的那个，写 conspectus-collect codeburn status。",
        ),
    );
  }

  return lines.join("\n") + "\n";
}
