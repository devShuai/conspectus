import { describe, expect, it } from "vitest";

import { displayWidth } from "./format.js";
import {
  isOwnCommand,
  OWN_COMMANDS,
  parseCodeburnCommands,
  renderHelp,
} from "./help.js";

const PIPED = { isTTY: false, columns: 100 };
const NO_ENV: Record<string, string | undefined> = {};

// 摘自真实 `codeburn --help`，含重名的 status 与需要剔除的 help
const CODEBURN_HELP = `Usage: codeburn [options] [command]

See where your AI coding tokens go - by task, tool, model, and project

Options:
  -V, --version    output the version number
  -h, --help       display help for command

Commands:
  report [options]                Interactive usage dashboard
  today [options]                 Today's usage dashboard
  status [options]                Compact status output (today + month)
  export [options]                Export usage data to CSV or JSON
  model-alias [options] [from]    Map a provider model name to a canonical one
  help [command]                  display help for command
`;

describe("parseCodeburnCommands", () => {
  it("extracts names and summaries", () => {
    const entries = parseCodeburnCommands(CODEBURN_HELP);
    expect(entries.map((e) => e.name)).toContain("today");
    expect(entries.find((e) => e.name === "today")?.summary).toBe("Today's usage dashboard");
    expect(entries.map((e) => e.name)).toContain("model-alias");
  });

  it("drops codeburn's own help and anything this package already owns", () => {
    const names = parseCodeburnCommands(CODEBURN_HELP).map((e) => e.name);
    // status 是唯一重名：本包的 status 从 0.1.0 起就输出 JSON，可能已被脚本消费
    expect(names).not.toContain("status");
    expect(names).not.toContain("help");
  });

  it("returns an empty list rather than throwing on unexpected output", () => {
    // 解析别人的帮助文本是易碎的一环，排版一变就该安静降级
    expect(parseCodeburnCommands("")).toEqual([]);
    expect(parseCodeburnCommands("no commands section here")).toEqual([]);
    expect(parseCodeburnCommands("Commands:\n")).toEqual([]);
  });

  it("stops at the end of the commands block", () => {
    const withTrailer = CODEBURN_HELP + "\nSome trailing prose that is not a command.\n";
    const names = parseCodeburnCommands(withTrailer).map((e) => e.name);
    expect(names).not.toContain("Some");
  });
});

describe("isOwnCommand", () => {
  it("claims this package's commands, including the ambiguous status", () => {
    expect(isOwnCommand("status")).toBe(true);
    expect(isOwnCommand("run")).toBe(true);
    expect(isOwnCommand("show")).toBe(true);
  });

  it("leaves codeburn's commands to the passthrough", () => {
    expect(isOwnCommand("today")).toBe(false);
    expect(isOwnCommand("overview")).toBe(false);
    expect(isOwnCommand("nonsense")).toBe(false);
  });

  it("covers every entry listed in the help", () => {
    // OWN_COMMANDS 与调度用的集合必须同源，否则会出现「帮助里有、却被透传走」
    for (const entry of OWN_COMMANDS) expect(isOwnCommand(entry.name)).toBe(true);
  });
});

describe("renderHelp", () => {
  it("lists both sections and stays within the terminal width", () => {
    const out = renderHelp("9.9.9", parseCodeburnCommands(CODEBURN_HELP), PIPED, NO_ENV);
    expect(out).toContain("采集器");
    expect(out).toContain("codeburn");
    expect(out).toContain("today");
    expect(out).toContain("9.9.9");
    for (const line of out.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(100);
    }
  });

  it("spells out which side wins a name collision", () => {
    const out = renderHelp("9.9.9", parseCodeburnCommands(CODEBURN_HELP), PIPED, NO_ENV);
    expect(out).toContain("conspectus-collect codeburn status");
  });

  it("still renders when the codeburn command table cannot be read", () => {
    const out = renderHelp("9.9.9", null, PIPED, NO_ENV);
    expect(out).toContain("采集器");
    expect(out).toContain("codeburn --help");
    // 本包的命令一条都不能少
    for (const entry of OWN_COMMANDS) expect(out).toContain(entry.name);
  });

  it("says so when codeburn is not installed at all", () => {
    expect(renderHelp("9.9.9", [], PIPED, NO_ENV)).toContain("依赖未安装");
  });

  it("emits no ANSI escapes when piped", () => {
    expect(renderHelp("9.9.9", [], PIPED, NO_ENV)).not.toContain("[");
  });
});
