import { describe, expect, it } from "vitest";

import {
  bar,
  colorEnabled,
  displayWidth,
  palette,
  stripAnsi,
  table,
  truncate,
  wrapJoin,
} from "./format.js";

const ESC = "\u001B";

describe("displayWidth", () => {
  it("counts CJK as two columns", () => {
    // 按 .length 算是 2，终端里占 4 列 —— 这个差值就是表格歪掉的原因
    expect("采集".length).toBe(2);
    expect(displayWidth("采集")).toBe(4);
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("采集器 x")).toBe(8);
  });

  it("ignores ANSI escapes", () => {
    expect(displayWidth(`${ESC}[32m采集${ESC}[0m`)).toBe(4);
  });

  it("treats zero-width marks as taking no column", () => {
    expect(displayWidth("é")).toBe(1);
  });
});

describe("stripAnsi", () => {
  it("removes only real escape sequences, not bracketed text", () => {
    // 少了 ESC 的正则会把正文里的 [0m 也吃掉
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi("literal [0m stays")).toBe("literal [0m stays");
  });
});

describe("truncate", () => {
  it("never exceeds the requested width with wide characters", () => {
    // 宽字符跨边界时宁可少一列：多一列会把整行挤到下一行
    for (const max of [1, 2, 3, 4, 5, 6, 7]) {
      expect(displayWidth(truncate("采集器状态", max))).toBeLessThanOrEqual(max);
    }
  });

  it("leaves short text alone", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("采集", 4)).toBe("采集");
  });
});

describe("table", () => {
  it("aligns columns to equal display width across mixed scripts", () => {
    const lines = table(
      [{ header: "采集器" }, { header: "值", align: "right" }],
      [
        ["claude-code", "12"],
        ["kimi-code", "3456"],
        ["中文采集器", "7"],
      ],
    );
    const widths = lines.map((line) => displayWidth(line));
    // 表头、分隔线与所有数据行必须等宽（trimEnd 只削尾部空格，右对齐列不受影响）
    expect(new Set(widths).size).toBe(1);
  });

  it("right-aligns numeric columns", () => {
    const lines = table(
      [{ header: "n", align: "right" }],
      [["1"], ["1000"]],
    );
    expect(lines[2]).toBe("   1");
    expect(lines[3]).toBe("1000");
  });

  it("caps a column at its max width", () => {
    const lines = table([{ header: "m", max: 5 }], [["abcdefghij"]]);
    expect(displayWidth(lines[2])).toBeLessThanOrEqual(5);
  });
});

describe("colorEnabled", () => {
  it("is off when piped so the output can be pasted into an issue", () => {
    expect(colorEnabled({ isTTY: undefined }, {})).toBe(false);
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
  });

  it("honours NO_COLOR over a TTY", () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
  });

  it("honours FORCE_COLOR when not a TTY, but not FORCE_COLOR=0", () => {
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "0" })).toBe(false);
  });
});

describe("palette", () => {
  it("is a no-op when disabled so widths stay predictable", () => {
    const plain = palette(false);
    expect(plain.green("ok")).toBe("ok");
    const colored = palette(true);
    expect(stripAnsi(colored.green("ok"))).toBe("ok");
    expect(displayWidth(colored.green("ok"))).toBe(2);
  });
});

describe("wrapJoin", () => {
  it("packs items into lines that fit the width", () => {
    const items = ["coding $1,000.00", "debugging $500.00", "exploration $200.00"];
    for (const line of wrapJoin(items, " · ", 40, "  ")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("keeps every item and never splits one", () => {
    const items = ["aaa", "bbb", "ccc", "ddd"];
    const joined = wrapJoin(items, " · ", 10).join(" ");
    for (const item of items) expect(joined).toContain(item);
  });

  it("emits a single over-wide line rather than dropping an unsplittable item", () => {
    // 单个片段就超宽时只能让它超出，但不能丢
    const lines = wrapJoin(["一个非常非常长的分类名 $9,999.00"], " · ", 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("9,999.00");
  });

  it("returns nothing for no items", () => {
    expect(wrapJoin([], " · ", 40)).toEqual([]);
  });
});

describe("bar", () => {
  it("stays exactly the requested width and clamps out-of-range input", () => {
    expect(displayWidth(bar(0.5, 10))).toBe(10);
    expect(displayWidth(bar(-1, 10))).toBe(10);
    expect(displayWidth(bar(5, 10))).toBe(10);
  });
});
