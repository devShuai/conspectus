/**
 * 终端渲染的基础件。自己写而不引框架：本包持有设备签名私钥且会被全局安装，
 * 依赖树越小越好（ink 会连带整个 react）。这里只需要宽度计算、补白、表格、
 * 一点 ANSI 颜色 —— 都是几十行的事。
 */

/**
 * 匹配 ANSI 转义序列，用于测量真实显示宽度。
 *
 * 写成 \\u001B 而不是把 ESC 原字节放进源码：控制字符在编辑器、diff、剪贴板
 * 之间容易被悄悄吃掉，而且肉眼完全看不出来 —— 一旦丢了，这条正则会退化成
 * 「匹配任何 [数字m]」，把正文里的方括号内容也当转义剥掉。
 */
const ANSI = /\u001B\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * 东亚宽字符范围。表格里全是中文，按 `.length` 补白会让每一列都歪掉 ——
 * 一个汉字占两个终端列，而 JS 只算一个 code unit。
 *
 * 取的是 Unicode East Asian Width 里 W 与 F 两类的主要区段，外加常见 emoji。
 * 不追求逐字符精确（那要整张 EAW 表），够把中文、日文、全角标点和箱线字符
 * 排齐即可。
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** 组合记号本身不占位（如声调符号）。 */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff
  );
}

function isWide(code: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/** 字符串在终端里实际占多少列（忽略 ANSI 转义）。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (isZeroWidth(code)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度截断，超出时以 `…` 结尾。宽字符可能跨越边界，这时宁可少一列也不
 * 多一列 —— 多出来会把整行挤到下一行，反而更难读。
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  let width = 0;
  let out = "";
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0) ?? 0;
    const w = isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1;
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }
  return out + "…";
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

export type Align = "left" | "right";

export interface Column {
  header: string;
  align?: Align;
  /** 该列最多占多少显示列；超出截断。 */
  max?: number;
}

/**
 * 等宽表格。列宽取「表头与所有单元格的最大显示宽度」，再按 max 收口。
 * 不画边框：等宽空格分隔在窄终端里更耐挤，复制粘贴也干净。
 */
export function table(columns: Column[], rows: string[][], gap = 2): string[] {
  const widths = columns.map((column, index) => {
    const cells = rows.map((row) => displayWidth(row[index] ?? ""));
    const natural = Math.max(displayWidth(column.header), ...cells, 0);
    return column.max ? Math.min(natural, column.max) : natural;
  });

  const separator = " ".repeat(gap);
  const render = (cells: string[]): string =>
    columns
      .map((column, index) => {
        const text = truncate(cells[index] ?? "", widths[index]);
        return column.align === "right"
          ? padStart(text, widths[index])
          : padEnd(text, widths[index]);
      })
      .join(separator)
      .trimEnd();

  return [
    render(columns.map((column) => column.header)),
    render(widths.map((width) => "─".repeat(width))),
    ...rows.map(render),
  ];
}

export interface Palette {
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  cyan: (text: string) => string;
}

const IDENTITY: Palette = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  green: (t) => t,
  yellow: (t) => t,
  cyan: (t) => t,
};

function wrap(code: number): (text: string) => string {
  return (text: string) => `\u001B[${code}m${text}\u001B[0m`;
}

const COLORED: Palette = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36),
};

/**
 * 是否上色。管道重定向时自动去色 —— 这份输出是要贴进 issue 的，
 * 满屏 `\u001B[32m` 没法看。NO_COLOR 与 FORCE_COLOR 遵循通行约定。
 */
export function colorEnabled(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(stream.isTTY);
}

export function palette(enabled: boolean): Palette {
  return enabled ? COLORED : IDENTITY;
}

/** 终端宽度；管道时没有 columns，退回 80。 */
export function terminalWidth(stream: { columns?: number }): number {
  const columns = stream.columns;
  return typeof columns === "number" && columns > 20 ? columns : 80;
}

export function heading(text: string, colors: Palette, width: number): string[] {
  const line = "─".repeat(Math.max(0, width - displayWidth(text) - 1));
  return ["", colors.bold(text) + " " + colors.dim(line)];
}

/** 千分位；避免为了格式化引一个 Intl 包装。 */
export function number(value: number): string {
  return value.toLocaleString("en-US");
}

export function usd(value: number): string {
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 把若干短片段按显示宽度装行。窄终端里一行摆不下时换行，而不是让终端硬折 ——
 * 硬折会从任意字节处断开，把「$1,722.28」劈成两半。
 */
export function wrapJoin(
  items: string[],
  separator: string,
  width: number,
  indent = "",
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const candidate = current === "" ? item : current + separator + item;
    if (current !== "" && displayWidth(indent + candidate) > width) {
      lines.push(indent + current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(indent + current);
  return lines;
}

/** 定宽条形图，用于占比列。 */
export function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "█".repeat(filled) + "·".repeat(width - filled);
}
