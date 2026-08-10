import { describe, expect, it } from "vitest";

import { needsShell, runCli, usesShell } from "./exec.js";

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

  it.skipIf(process.platform !== "win32")(
    "launches an absolute exe directly even when its path contains spaces",
    async () => {
      expect(usesShell(process.execPath)).toBe(false);
      await expect(runCli(process.execPath, ["--version"])).resolves.toMatch(/^v\d+\./);
    },
  );

  it("keeps Windows npm shims on the shell path", () => {
    expect(usesShell("claude", "win32")).toBe(true);
    expect(usesShell("C:\\tools\\claude.cmd", "win32")).toBe(true);
    expect(usesShell("C:\\Program Files\\Codex\\codex.exe", "win32")).toBe(false);
  });
});
