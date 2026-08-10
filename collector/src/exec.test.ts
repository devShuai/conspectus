import { describe, expect, it } from "vitest";

import { needsShell, runCli } from "./exec.js";

describe("needsShell", () => {
  /*
   * Windows 上 npm 全局安装留下的只有 foo.cmd / foo.ps1 垫片：不带 shell 时
   * execFile("foo") 报 ENOENT，execFile("foo.cmd") 因 CVE-2024-27980 的加固报
   * EINVAL。detect() 于是恒为 false，装好的 claude / codex 一个都检测不到。
   */
  it("only shells out on win32", () => {
    expect(needsShell("win32")).toBe(true);
    expect(needsShell("darwin")).toBe(false);
    expect(needsShell("linux")).toBe(false);
  });
});

describe("runCli", () => {
  it("resolves a bare command through PATH and returns stdout", async () => {
    // 裸命令名，交给 PATH —— 这正是 claude / codex 的调用形态
    const out = await runCli("node", ["--version"]);
    expect(out.trim()).toMatch(/^v\d+\./);
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      runCli("conspectus-no-such-binary-xyz", ["--version"]),
    ).rejects.toThrow();
  });

  /*
   * shell 模式下参数是拼接的：`C:\Program Files\...` 会被 cmd 在空格处切开，
   * 变成一条谁也看不懂的命令。宁可当场报错。
   */
  it.skipIf(process.platform !== "win32")(
    "refuses paths with spaces instead of letting cmd split them",
    async () => {
      await expect(runCli(process.execPath, ["--version"])).rejects.toThrow(/空格/);
    },
  );
});
