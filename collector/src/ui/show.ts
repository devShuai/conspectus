import {
  bar,
  colorEnabled,
  heading,
  number,
  palette,
  table,
  terminalWidth,
  usd,
  wrapJoin,
  type Palette,
} from "./format.js";

/**
 * `conspectus-collect show` 的视图模型与渲染（本地展示）。
 *
 * 渲染是**纯函数**：模型进、字符串数组出，不碰网络也不碰文件。数据采集在
 * cli.ts 那侧完成 —— 这样表格对齐、脱敏、降级分支都能直接单测，不用起服务。
 *
 * 只做汇总，不做明细。消耗的逐条钻取交给 codeburn 自己的 TUI，经
 * `conspectus-collect codeburn …` 透传（codeburn 是本包依赖，不在 PATH 上，
 * 直接敲 `codeburn` 跑不起来）。这里重复实现一遍既是浪费，也会两边算法漂移。本命令
 * 独有的价值在上半部分：哪些 binding 在 manifest 里、本轮各自采到什么、
 * 没采到是为什么、还有多少积在缓冲区没发出去。
 */

export interface ShowBinding {
  collectorId: string;
  metric: string;
  kind: string;
  unit: string;
  /** 本轮采到的值；未采到时为 undefined。 */
  used?: string;
  limit?: string;
  capturedAt?: string;
}

export interface ShowModel {
  generatedAt: Date;
  agentVersion: string;
  server: {
    url?: string;
    issuer?: string;
    reachable?: boolean;
    status?: number;
    error?: string;
  };
  auth: { loggedIn: boolean; expiresAt?: string; expired?: boolean };
  device: { registered: boolean; deviceId?: string };
  /** manifest 拉取失败时为 null，与「拉到了但是空的」区分开。 */
  bindings: ShowBinding[] | null;
  manifestError?: string;
  collectorErrors: Array<{ collectorId: string; error: string }>;
  warnings: Array<{ code: string; message: string }>;
  spend: ShowSpend | null;
  spendError?: string;
  buffer: {
    batches: number;
    readings: number;
    oldestEnqueuedAt: string | null;
    lastError: string | null;
  };
}

export interface ShowSpend {
  sourceCurrency: string;
  costUsd: number;
  savedUsd: number;
  tokens: number;
  reasoningTokens: number;
  apiCalls: number;
  sessions: number;
  dayRows: number;
  byProvider: Array<{ key: string; costUsd: number; apiCalls: number }>;
  byCategory: Array<{ key: string; costUsd: number }>;
}

const OK = "✓";
const BAD = "✗";
const WARN = "!";

/**
 * 把采集器的完整聚合收成展示用的汇总。与服务端 ledger-query 的口径保持一致：
 * 推理 token **不并进** tokens（codex/opencode 的是 output 的子集，grok 的是独立
 * 计量，合并会把前者算重），会话数取会话快照的条数而非按日行相加（同一会话
 * 横跨多天多模型，相加会重复计数）。
 */
export function summarizeLedger(ledger: {
  sourceCurrency: string;
  days: Array<{
    provider: string;
    category: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    apiCalls: number;
    costUsd: number;
    savedUsd: number;
  }>;
  sessions: unknown[];
}): ShowSpend {
  const byProvider = new Map<string, { costUsd: number; apiCalls: number }>();
  const byCategory = new Map<string, number>();
  const totals = {
    costUsd: 0,
    savedUsd: 0,
    tokens: 0,
    reasoningTokens: 0,
    apiCalls: 0,
  };

  for (const row of ledger.days) {
    const tokens =
      row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    totals.costUsd += row.costUsd;
    totals.savedUsd += row.savedUsd;
    totals.tokens += tokens;
    totals.reasoningTokens += row.reasoningTokens;
    totals.apiCalls += row.apiCalls;

    const provider = byProvider.get(row.provider) ?? { costUsd: 0, apiCalls: 0 };
    provider.costUsd += row.costUsd;
    provider.apiCalls += row.apiCalls;
    byProvider.set(row.provider, provider);

    const category = row.category || "未分类";
    byCategory.set(category, (byCategory.get(category) ?? 0) + row.costUsd);
  }

  return {
    sourceCurrency: ledger.sourceCurrency,
    costUsd: round2(totals.costUsd),
    savedUsd: round2(totals.savedUsd),
    tokens: totals.tokens,
    reasoningTokens: totals.reasoningTokens,
    apiCalls: totals.apiCalls,
    sessions: ledger.sessions.length,
    dayRows: ledger.days.length,
    byProvider: [...byProvider.entries()]
      .map(([key, value]) => ({ key, costUsd: round2(value.costUsd), apiCalls: value.apiCalls }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byCategory: [...byCategory.entries()]
      .map(([key, costUsd]) => ({ key, costUsd: round2(costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function renderShow(
  model: ShowModel,
  stream: { isTTY?: boolean; columns?: number } = process.stdout,
  env: Record<string, string | undefined> = process.env,
): string {
  const colors = palette(colorEnabled(stream, env));
  const width = terminalWidth(stream);
  const lines: string[] = [];

  lines.push(
    colors.bold("conspectus-collect") +
      colors.dim(` ${model.agentVersion} · ${model.generatedAt.toISOString().replace("T", " ").slice(0, 19)}Z`),
  );

  lines.push(...connection(model, colors, width));
  lines.push(...collection(model, colors, width));
  lines.push(...spendSection(model, colors, width));
  lines.push(...outbox(model, colors, width));

  return lines.join("\n") + "\n";
}

function mark(colors: Palette, ok: boolean, warn = false): string {
  if (warn) return colors.yellow(WARN);
  return ok ? colors.green(OK) : colors.red(BAD);
}

function connection(model: ShowModel, colors: Palette, width: number): string[] {
  const lines = heading("连接", colors, width);
  const rows: string[][] = [];

  rows.push(["服务端", model.server.url ?? colors.dim("未配置")]);
  rows.push(["认证中心", model.server.issuer ?? colors.dim("未配置")]);

  if (model.server.reachable === undefined) {
    rows.push(["可达性", colors.dim("未探测")]);
  } else if (model.server.reachable) {
    rows.push(["可达性", `${mark(colors, true)} HTTP ${model.server.status ?? "?"}`]);
  } else {
    rows.push(["可达性", `${mark(colors, false)} ${model.server.error ?? "不可达"}`]);
  }

  if (!model.auth.loggedIn) {
    rows.push(["登录", `${mark(colors, false)} 未登录，运行 conspectus-collect login`]);
  } else if (model.auth.expired) {
    rows.push(["登录", `${mark(colors, false, true)} 令牌已过期，下次上报会自动刷新`]);
  } else {
    rows.push([
      "登录",
      `${mark(colors, true)} 有效${model.auth.expiresAt ? colors.dim(`　至 ${model.auth.expiresAt}`) : ""}`,
    ]);
  }

  rows.push([
    "设备",
    model.device.registered
      ? `${mark(colors, true)} ${model.device.deviceId ?? ""}`
      : `${mark(colors, false)} 未注册，运行 conspectus-collect login`,
  ]);

  lines.push(
    ...table([{ header: "" }, { header: "" }], rows).slice(2).map((line) => "  " + line),
  );
  return lines;
}

function collection(model: ShowModel, colors: Palette, width: number): string[] {
  const lines = heading("采集", colors, width);

  if (model.bindings === null) {
    lines.push("  " + colors.red(BAD) + " 无法获取 manifest：" + (model.manifestError ?? "未知错误"));
    lines.push("  " + colors.dim("下面的绑定与读数因此为空，不代表本机采集器有问题。"));
    return lines;
  }

  if (model.bindings.length === 0) {
    lines.push("  " + colors.dim("manifest 里没有本地采集绑定。"));
  } else {
    const rows = model.bindings.map((binding) => {
      const collected = binding.used !== undefined;
      return [
        mark(colors, collected, !collected),
        binding.collectorId,
        binding.metric,
        binding.kind,
        collected
          ? binding.limit
            ? `${binding.used} / ${binding.limit} ${binding.unit}`
            : `${binding.used} ${binding.unit}`
          : colors.dim("未采到"),
        binding.capturedAt ? colors.dim(binding.capturedAt.replace("T", " ").slice(0, 19)) : "",
      ];
    });
    lines.push(
      ...table(
        [
          { header: "" },
          { header: "采集器", max: 18 },
          { header: "指标", max: 24 },
          { header: "类型", max: 8 },
          { header: "值", max: 28 },
          { header: "采集时刻", max: 20 },
        ],
        rows,
      ).map((line) => "  " + line),
    );
  }

  for (const error of model.collectorErrors) {
    lines.push(`  ${colors.red(BAD)} ${error.collectorId}: ${error.error}`);
  }
  for (const warning of model.warnings) {
    lines.push(`  ${colors.yellow(WARN)} ${warning.message}`);
  }
  return lines;
}

function spendSection(model: ShowModel, colors: Palette, width: number): string[] {
  const lines = heading("消耗（codeburn，近 30 天）", colors, width);

  if (model.spend === null) {
    lines.push("  " + colors.dim(model.spendError ?? "未采集"));
    return lines;
  }
  const spend = model.spend;

  const stats = [
    `成本 ${colors.bold(usd(spend.costUsd))}`,
    `Token ${number(spend.tokens)}`,
    `调用 ${number(spend.apiCalls)}`,
    `会话 ${number(spend.sessions)}`,
  ];
  if (spend.reasoningTokens > 0) stats.push(`推理 ${number(spend.reasoningTokens)}`);
  if (spend.savedUsd > 0) stats.push(`已省 ${usd(spend.savedUsd)}`);
  lines.push(...wrapJoin(stats, colors.dim("　·　"), width, "  "));

  if (spend.sourceCurrency !== "USD") {
    // 金额已按 codeburn 的汇率折回 USD，但用户看到的 codeburn 界面是另一个币种，
    // 不说明白会以为两边对不上
    lines.push(
      "  " +
        colors.yellow(WARN) +
        ` codeburn 显示币种为 ${spend.sourceCurrency}，上面的金额已折算回 USD。`,
    );
  }

  const total = spend.byProvider.reduce((sum, row) => sum + row.costUsd, 0);
  if (spend.byProvider.length > 0) {
    lines.push("");
    lines.push(
      ...table(
        [
          { header: "来源", max: 14 },
          { header: "成本", align: "right" },
          { header: "占比", align: "right" },
          { header: "", max: 16 },
          { header: "调用", align: "right" },
        ],
        spend.byProvider.map((row) => {
          const share = total > 0 ? row.costUsd / total : 0;
          return [
            row.key,
            usd(row.costUsd),
            (share * 100).toFixed(1) + "%",
            colors.dim(bar(share, 16)),
            number(row.apiCalls),
          ];
        }),
      ).map((line) => "  " + line),
    );
  }

  if (spend.byCategory.length > 0) {
    lines.push("");
    const items = spend.byCategory.slice(0, 6).map((row) => `${row.key} ${usd(row.costUsd)}`);
    const wrapped = wrapJoin(items, colors.dim("　·　"), width, "  ");
    lines.push("  " + colors.dim("任务类型"));
    lines.push(...wrapped);
  }

  lines.push(
    "  " + colors.dim(`按日聚合 ${number(spend.dayRows)} 行。逐条明细：conspectus-collect codeburn today / … web`),
  );
  return lines;
}

function outbox(model: ShowModel, colors: Palette, width: number): string[] {
  const lines = heading("待发送", colors, width);
  if (model.buffer.readings === 0) {
    lines.push("  " + colors.green(OK) + " 缓冲区为空");
    return lines;
  }
  lines.push(
    `  ${colors.yellow(WARN)} ${number(model.buffer.readings)} 条读数积压在 ${number(model.buffer.batches)} 个批次里，下次 run 会先重放`,
  );
  if (model.buffer.oldestEnqueuedAt) {
    lines.push("  " + colors.dim(`最旧一批：${model.buffer.oldestEnqueuedAt}`));
  }
  if (model.buffer.lastError) {
    lines.push("  " + colors.dim(`上次失败：${model.buffer.lastError}`));
  }
  return lines;
}
