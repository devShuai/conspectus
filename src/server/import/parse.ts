import { daysInMonth } from "@/server/billing/cycle";

import {
  IMPORT_DRAFT_PAYLOAD_VERSION,
  type ImportDraftPayloadV1,
} from "./draft-payload";
import { extractMimeText } from "./mime";
import { EMAIL_PARSE_RULES, type EmailParseRule } from "./rules";
import type { RuleDateFormat } from "./rules/types";

/**
 * 邮件解析规则引擎（#60，design §7.5 解析管线）：从 InboundEmail 的
 * 主题/正文/发件人抽取订阅名、金额、币种、账期、扣费日，产出 ImportDraft
 * 的版本化 payload 与可解释置信度。
 *
 * 底线（issue #60 验收）：
 * - fail closed：金额/币种/日期任一不可模糊抽取时不产草稿、不猜值，
 *   以可诊断原因失败（parseStatus=failed + 结构化日志）；
 * - 命中规则但抽不齐 = 模板漂移（template_drift），直接失败而非启发式猜值；
 * - 未命中任何规则才走通用启发式，且其置信度被封顶在预选阈值（0.9）之下；
 * - 解析结果一律只写 ImportDraft，绝不自动入账（§7.5）。
 */

/** confidence ≥ 0.9 的草稿在 UI 预选「接受」（仍需用户一次点击，§7.5）。 */
export const DRAFT_ACCEPT_PRESELECT_THRESHOLD = 0.9;

export interface EmailParseInput {
  /** 落库列 fromAddr（webhook 契约已是裸地址）。 */
  fromAddr: string;
  /** 落库列 subject。 */
  subject: string;
  receivedAt: Date;
  /** RFC 822 原文（用户关闭原文保留时缺省，此时只有主题可解析）。 */
  raw?: string;
}

export type ParseFailureReason =
  | "no_text" // 无任何可解析文本
  | "template_drift" // 规则命中但抽取失败（模板改版）
  | "amount_missing"
  | "amount_ambiguous"
  | "currency_ambiguous"
  | "date_missing"
  | "date_ambiguous"
  | "name_missing";

export type ParseOutcome =
  | {
      ok: true;
      payload: ImportDraftPayloadV1;
      confidence: number;
      matchedRule: string | null;
    }
  | { ok: false; reason: ParseFailureReason; matchedRule: string | null };

function fail(reason: ParseFailureReason, matchedRule: string | null = null): ParseOutcome {
  return { ok: false, reason, matchedRule };
}

/* ---------------- 规范化 ---------------- */

const SUBJECT_PREFIX = /^\s*(?:re|fw|fwd|回复|答复|转发)\s*[:：]\s*/i;

/** 剥离层层转发/回复前缀（"Re: Fwd: 转发: …"）。 */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  while (SUBJECT_PREFIX.test(s)) {
    s = s.replace(SUBJECT_PREFIX, "").trim();
  }
  return s;
}

/** 从 "Display Name <a@b.c>" 或裸地址取 addr-spec，小写。 */
export function addrSpec(from: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const addr = (angle ? angle[1] : from).trim();
  return addr.toLowerCase();
}

const FORWARD_MARKER =
  /^\s*(?:-{2,}\s*)?(?:forwarded message|begin forwarded message|转发的?邮件|原始邮件)\s*(?:-{2,})?\s*[:：]?\s*$/i;

const FORWARDED_HEADER =
  /^\s*(?:from|sent|to|cc|subject|date|发件人|收件人|抄送|主题|日期|发送时间)\s*[:：]/i;

export interface NormalizedBody {
  /** 去掉转发头块、引用前缀后的正文（每行折叠空白，空行剔除）。 */
  text: string;
  /** 转发块内层头（人工转发的真实来源）；自动转发时为空。 */
  forwarded: { from?: string; subject?: string; date?: string };
}

/**
 * 正文规范化：剥引用前缀（"> "）、识别并剔除转发分隔线与其后的头块
 * （头块值回收为 forwarded 供规则匹配真实发件人/主题）、行内空白折叠。
 */
export function normalizeBodyText(rawText: string): NormalizedBody {
  const forwarded: NormalizedBody["forwarded"] = {};
  const out: string[] = [];
  let headerLinesLeft = 0; // 转发分隔线后允许的头块行数

  for (const rawLine of rawText.split(/\r?\n/)) {
    let line = rawLine;
    // 经典转发的引用前缀，逐层剥掉
    for (let guard = 0; guard < 5 && /^\s*>/.test(line); guard += 1) {
      line = line.replace(/^\s*>\s?/, "");
    }
    line = line.replace(/[ \t]+/g, " ").trim();

    if (FORWARD_MARKER.test(line)) {
      headerLinesLeft = 6; // From/Sent/To/Cc/Subject/Date 至多这几行
      continue;
    }
    if (headerLinesLeft > 0) {
      if (line === "") continue;
      const header = /^([^:：]{1,12})[:：]\s*(.*)$/.exec(line);
      if (header && FORWARDED_HEADER.test(line)) {
        headerLinesLeft -= 1;
        const key = header[1].trim().toLowerCase();
        const value = header[2].trim();
        if (value) {
          if (key === "from" || key === "发件人") forwarded.from ??= value;
          else if (key === "subject" || key === "主题") forwarded.subject ??= value;
          else if (key === "date" || key === "sent" || key === "日期" || key === "发送时间") {
            forwarded.date ??= value;
          }
        }
        continue;
      }
      headerLinesLeft = 0; // 头块结束
    }
    if (line !== "") out.push(line);
  }
  return { text: out.join("\n"), forwarded };
}

/* ---------------- 金额 / 日期原语 ---------------- */

/**
 * 金额原文 → 十进制字符串（与 BillingRecord numeric(14,2) 对齐）。
 * - 英美点分："1,234.56"（千分位）/ "68.00" / "68"；
 * - decimalComma（规则按模板市场显式声明）："10,99" / "1.234,56"；
 * - 其余（裸逗号小数 "12,99" 未声明 locale 等）一律 null —— fail closed。
 */
export function normalizeAmountToken(
  raw: string,
  options: { decimalComma?: boolean } = {},
): string | null {
  const s = raw.trim();
  if (options.decimalComma) {
    const m = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{1,2})$/.exec(s);
    if (!m) return null;
    return `${m[1].replace(/\./g, "")}.${m[2]}`;
  }
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return s.replace(/,/g, "");
  if (/^\d+(\.\d{1,2})?$/.test(s)) return s;
  return null;
}

const EN_MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const DE_MONTHS: Record<string, number> = {
  januar: 1, februar: 2, "märz": 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

function validDateOnly(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month - 1)) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 规则声明格式的日期解析；非法日历日（如 2026-02-30）返回 null。 */
export function parseRuleDate(raw: string, format: RuleDateFormat): string | null {
  const s = raw.trim();
  if (format === "iso") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? validDateOnly(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  if (format === "zh") {
    const m = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/.exec(s);
    return m ? validDateOnly(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  if (format === "en-long") {
    const monthNames = `(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
    const monthDay =
      /^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(s)
        ? new RegExp(`^${monthNames}\\s+(\\d{1,2}),?\\s+(\\d{4})$`, "i").exec(s)
        : null;
    if (monthDay) {
      const month = EN_MONTHS[expandEnMonth(monthDay[1])];
      return month ? validDateOnly(Number(monthDay[3]), month, Number(monthDay[2])) : null;
    }
    const dayMonth = new RegExp(`^(\\d{1,2})\\s+${monthNames},?\\s+(\\d{4})$`, "i").exec(s);
    if (dayMonth) {
      const month = EN_MONTHS[expandEnMonth(dayMonth[2])];
      return month ? validDateOnly(Number(dayMonth[3]), month, Number(dayMonth[1])) : null;
    }
    return null;
  }
  // de-long："5. August 2026"
  const de = /^(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})$/.exec(s);
  if (!de) return null;
  const month = DE_MONTHS[de[2].toLowerCase()];
  return month ? validDateOnly(Number(de[3]), month, Number(de[1])) : null;
}

function expandEnMonth(token: string): string {
  const t = token.toLowerCase();
  for (const full of Object.keys(EN_MONTHS)) {
    if (full.startsWith(t)) return full;
  }
  return t;
}

/** 绝对时间 → UTC 日期串（与 cycle.ts 的 UTC 口径一致，避免时区漂移）。 */
export function toDateOnlyUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/* ---------------- 规则抽取 ---------------- */

interface RuleContext {
  fromAddr: string;
  subject: string;
  text: string;
  dateHeader: Date | null;
}

const RULE_BASE = 0.45; // 发件域 + 主题双命中
const RULE_AMOUNT = 0.2;
const RULE_CURRENCY_EXPLICIT = 0.15; // 正文 ISO 代码且与模板声明一致
const RULE_CURRENCY_FIXED = 0.1; // 模板固定币种（符号无歧义依据见规则注释）
const RULE_DATE_BODY = 0.15;
const RULE_DATE_HEADER = 0.1;
const RULE_EXTRA = 0.05; // 套餐或订单号
const RULE_CAP = 0.99;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function extractWithRule(rule: EmailParseRule, ctx: RuleContext): ParseOutcome | null {
  const haystack = `${ctx.subject}\n${ctx.text}`;

  const amountMatch = rule.amountPattern.exec(haystack);
  const amountRaw = amountMatch?.groups?.amount;
  if (!amountRaw) return null;
  const amount = normalizeAmountToken(amountRaw, {
    decimalComma: rule.amountDecimalComma,
  });
  if (!amount) return null;

  // 模板带 ISO 代码时必须与声明币种一致：不一致 = 市场/模板漂移，拒抽不猜
  const capturedCurrency = amountMatch.groups?.currency?.toUpperCase();
  if (capturedCurrency !== undefined && capturedCurrency !== rule.currency) return null;

  let billedAt: string | null = null;
  let dateFromBody = false;
  if (rule.datePattern) {
    const dateRaw = rule.datePattern.exec(haystack)?.groups?.date;
    if (dateRaw) {
      billedAt = parseRuleDate(dateRaw, rule.dateFormat ?? "iso");
      dateFromBody = billedAt !== null;
    }
  }
  if (!billedAt && ctx.dateHeader) {
    billedAt = toDateOnlyUtc(ctx.dateHeader); // Date 头回退，置信度略降
  }
  if (!billedAt) return null;

  const name = rule.name ?? rule.namePattern?.exec(haystack)?.groups?.name?.trim();
  if (!name) return null;

  const plan = rule.planPattern?.exec(haystack)?.groups?.plan?.trim() || undefined;
  const reference =
    rule.referencePattern?.exec(haystack)?.groups?.reference?.trim() || undefined;

  const confidence = round3(
    Math.min(
      RULE_CAP,
      RULE_BASE +
        RULE_AMOUNT +
        (capturedCurrency ? RULE_CURRENCY_EXPLICIT : RULE_CURRENCY_FIXED) +
        (dateFromBody ? RULE_DATE_BODY : RULE_DATE_HEADER) +
        (plan || reference ? RULE_EXTRA : 0),
    ),
  );

  const candidate: ImportDraftPayloadV1["candidate"] = {
    name,
    amount,
    currency: rule.currency,
    billedAt,
  };
  if (rule.vendorSlug) candidate.vendorSlug = rule.vendorSlug;
  if (plan) candidate.planName = plan;
  const cycle = (plan && rule.planCycleMap?.[plan]) || rule.billingCycle;
  if (cycle) candidate.billingCycle = cycle;
  if (reference) candidate.reference = reference;

  return {
    ok: true,
    payload: {
      version: IMPORT_DRAFT_PAYLOAD_VERSION,
      candidate,
      evidence: {
        fromAddr: ctx.fromAddr,
        subject: ctx.subject,
        matchedRule: rule.id,
      },
    },
    confidence,
    matchedRule: rule.id,
  };
}

/* ---------------- 通用启发式（未命中任何规则） ---------------- */

/** 常见 ISO-4217 代码白名单：过滤 "INV 2026" 之类的伪金额对。 */
const KNOWN_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "CNY", "JPY", "HKD", "TWD", "KRW", "SGD", "CAD",
  "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "INR", "BRL", "MXN", "THB",
  "MYR", "IDR", "PHP", "VND", "ZAR", "TRY", "PLN", "AED", "SAR", "ILS",
]);

const AMOUNT_NUMBER = "[0-9][0-9,]*(?:\\.[0-9]{1,2})?";
/** €/£ 是全球唯一币种符号；$/¥ 多币种共用，启发式一律不作依据。 */
const UNAMBIGUOUS_SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP" };

const STRONG_AMOUNT_LABEL =
  /(?:\btotal\b|amount due|charged|paid|\bpayment\b|合计|总额|实付|应付|扣款|付款)/i;
const DATE_LABEL = /(?:date|dated|paid|charged|billed|renewed|日期|扣款|缴费|续费)/i;

interface AmountCandidate {
  amount: string;
  currency: string;
  currencyFromCode: boolean;
  labeled: boolean;
}

interface DateCandidate {
  date: string;
  labeled: boolean;
}

const LABEL_WINDOW = 40;

function hasLabelNear(haystack: string, start: number, end: number, label: RegExp): boolean {
  const windowText = haystack.slice(Math.max(0, start - LABEL_WINDOW), end + LABEL_WINDOW);
  return label.test(windowText);
}

/** 扫描「ISO 代码/单义符号 + 金额」对；裸数字与 $/¥ 不进场（防猜币种）。 */
function scanAmounts(haystack: string): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  const push = (
    amountRaw: string,
    currency: string,
    currencyFromCode: boolean,
    start: number,
    end: number,
  ) => {
    const amount = normalizeAmountToken(amountRaw);
    if (!amount) return;
    out.push({
      amount,
      currency,
      currencyFromCode,
      labeled: hasLabelNear(haystack, start, end, STRONG_AMOUNT_LABEL),
    });
  };
  for (const m of haystack.matchAll(
    new RegExp(`\\b([A-Z]{3})\\s*(${AMOUNT_NUMBER})\\b`, "g"),
  )) {
    if (KNOWN_CURRENCIES.has(m[1])) push(m[2], m[1], true, m.index!, m.index! + m[0].length);
  }
  for (const m of haystack.matchAll(
    new RegExp(`\\b(${AMOUNT_NUMBER})\\s*([A-Z]{3})\\b`, "g"),
  )) {
    if (KNOWN_CURRENCIES.has(m[2])) push(m[1], m[2], true, m.index!, m.index! + m[0].length);
  }
  for (const symbol of Object.keys(UNAMBIGUOUS_SYMBOLS)) {
    const escaped = symbol === "€" ? "€" : "£";
    for (const m of haystack.matchAll(
      new RegExp(`${escaped}\\s*(${AMOUNT_NUMBER})|(${AMOUNT_NUMBER})\\s*${escaped}`, "g"),
    )) {
      push(m[1] ?? m[2], UNAMBIGUOUS_SYMBOLS[symbol], false, m.index!, m.index! + m[0].length);
    }
  }
  return out;
}

/** 扫描正文日期：ISO / en-long / zh；歧义数字序（08/05/2026）不进场。 */
function scanDates(haystack: string): DateCandidate[] {
  const out: DateCandidate[] = [];
  const push = (date: string | null, start: number, end: number) => {
    if (!date) return;
    out.push({ date, labeled: hasLabelNear(haystack, start, end, DATE_LABEL) });
  };
  for (const m of haystack.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(validDateOnly(Number(m[1]), Number(m[2]), Number(m[3])), m.index!, m.index! + m[0].length);
  }
  for (const m of haystack.matchAll(
    /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/g,
  )) {
    push(parseRuleDate(m[1], "zh"), m.index!, m.index! + m[0].length);
  }
  for (const m of haystack.matchAll(
    /([A-Z][a-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}\s+[A-Z][a-z]+,?\s*\d{4})/g,
  )) {
    push(parseRuleDate(m[1], "en-long"), m.index!, m.index! + m[0].length);
  }
  return out;
}

const GENERIC_SUBDOMAINS = new Set([
  "mail", "mailer", "billing", "receipt", "receipts", "no-reply", "noreply",
  "donotreply", "notify", "notification", "notifications", "notice", "info",
  "email", "news", "service", "support", "account", "accounts", "orders",
]);

/** 从发件域词干推导展示名（"mailer.acme-saas.com" → "Acme-saas"）。 */
export function nameFromFromAddr(fromAddr: string): string | null {
  const domain = addrSpec(fromAddr).split("@")[1];
  if (!domain) return null;
  const labels = domain
    .split(".")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !GENERIC_SUBDOMAINS.has(l));
  if (labels.length === 0) return null;
  let stem: string;
  if (
    labels.length >= 3 &&
    labels[labels.length - 1].length === 2 &&
    ["co", "com", "net", "org", "ac", "gov"].includes(labels[labels.length - 2])
  ) {
    stem = labels[labels.length - 3]; // example.co.uk → example
  } else {
    stem = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(stem)) return null;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

const CYCLE_HINTS: [RegExp, ImportDraftPayloadV1["candidate"]["billingCycle"]][] = [
  [/\bmonthly\b|per month|every month|每月|按月|月度/i, "monthly"],
  [/\bquarterly\b|每季|季度/i, "quarterly"],
  [/\bannual\b|\byearly\b|per year|every year|每年|按年|年度/i, "yearly"],
  [/\bweekly\b|per week|每周|按周/i, "weekly"],
];

const HEURISTIC_BASE = 0.1;
const HEURISTIC_NAME = 0.1;
const HEURISTIC_AMOUNT_LABELED = 0.25;
const HEURISTIC_AMOUNT_UNLABELED = 0.2;
const HEURISTIC_CURRENCY_CODE = 0.2;
const HEURISTIC_CURRENCY_SYMBOL = 0.15;
const HEURISTIC_DATE_LABELED = 0.15;
const HEURISTIC_DATE_UNLABELED = 0.1;
/** 启发式置信度硬顶：永远够不到 0.9 预选线，必须人工过目。 */
const HEURISTIC_CAP = 0.85;

function heuristicExtract(ctx: RuleContext & { receivedAt: Date }): ParseOutcome {
  const haystack = `${ctx.subject}\n${ctx.text}`;

  const amounts = scanAmounts(haystack);
  if (amounts.length === 0) return fail("amount_missing");
  const strong = amounts.filter((a) => a.labeled);
  const chosen = [...new Map(strong.map((a) => [a.amount, a])).values()];
  if (chosen.length > 1) return fail("amount_ambiguous");
  let amountPick: AmountCandidate | undefined;
  let amountLabeled = false;
  if (chosen.length === 1) {
    amountPick = chosen[0];
    amountLabeled = true;
  } else {
    const distinct = [...new Map(amounts.map((a) => [a.amount, a])).values()];
    if (distinct.length > 1) return fail("amount_ambiguous");
    amountPick = distinct[0];
  }
  const currencies = new Set(amounts.map((a) => a.currency));
  if (currencies.size > 1) return fail("currency_ambiguous");

  const dates = scanDates(haystack);
  if (dates.length === 0) return fail("date_missing");
  const labeledDates = [...new Map(dates.filter((d) => d.labeled).map((d) => [d.date, d])).values()];
  let datePick: DateCandidate;
  if (labeledDates.length === 1) {
    datePick = labeledDates[0];
  } else if (labeledDates.length > 1) {
    return fail("date_ambiguous");
  } else {
    const distinct = [...new Map(dates.map((d) => [d.date, d])).values()];
    if (distinct.length > 1) return fail("date_ambiguous");
    datePick = distinct[0];
  }

  const name = nameFromFromAddr(ctx.fromAddr);
  if (!name) return fail("name_missing");

  const cycles = CYCLE_HINTS.filter(([re]) => re.test(haystack)).map(([, c]) => c);
  const billingCycle = cycles.length === 1 ? cycles[0] : undefined;

  const confidence = round3(
    Math.min(
      HEURISTIC_CAP,
      HEURISTIC_BASE +
        HEURISTIC_NAME +
        (amountLabeled ? HEURISTIC_AMOUNT_LABELED : HEURISTIC_AMOUNT_UNLABELED) +
        (amountPick.currencyFromCode
          ? HEURISTIC_CURRENCY_CODE
          : HEURISTIC_CURRENCY_SYMBOL) +
        (datePick.labeled ? HEURISTIC_DATE_LABELED : HEURISTIC_DATE_UNLABELED),
    ),
  );

  const candidate: ImportDraftPayloadV1["candidate"] = {
    name,
    amount: amountPick.amount,
    currency: amountPick.currency,
    billedAt: datePick.date,
  };
  if (billingCycle) candidate.billingCycle = billingCycle;

  return {
    ok: true,
    payload: {
      version: IMPORT_DRAFT_PAYLOAD_VERSION,
      candidate,
      evidence: { fromAddr: ctx.fromAddr, subject: ctx.subject },
    },
    confidence,
    matchedRule: null,
  };
}

/* ---------------- 订阅匹配（vendor + 金额 + 周期） ---------------- */

export interface SubscriptionMatchRow {
  id: string;
  name: string;
  price: unknown; // Prisma Decimal —— 只按数值相等比较
  currency: string;
  billingCycle: string;
  vendor: { name: string; slug: string } | null;
}

/**
 * design §7.5 管线 G 步：vendor + 金额 + 周期匹配已有订阅。
 * 恰好一条命中才建议（suggestedSubscriptionId），多条/零条都留空 ——
 * 宁缺毋滥，建议错了比不建议更伤信任。
 */
export function suggestSubscription(
  candidate: ImportDraftPayloadV1["candidate"],
  subscriptions: SubscriptionMatchRow[],
): string | null {
  const candidateName = candidate.name.trim().toLowerCase();
  const hits = subscriptions.filter((s) => {
    const nameHit =
      s.name.trim().toLowerCase() === candidateName ||
      s.vendor?.name.trim().toLowerCase() === candidateName ||
      (candidate.vendorSlug !== undefined && s.vendor?.slug === candidate.vendorSlug);
    if (!nameHit) return false;
    if (s.currency !== candidate.currency) return false;
    if (Number(s.price) !== Number(candidate.amount)) return false;
    if (candidate.billingCycle && s.billingCycle !== candidate.billingCycle) return false;
    return true;
  });
  return hits.length === 1 ? hits[0].id : null;
}

/* ---------------- 引擎入口 ---------------- */

/**
 * 解析一封入站邮件。纯函数：不碰 DB、不写日志、无副作用。
 * 匹配顺序：规则注册表（确定性排序）→ 全部抽取失败 = template_drift →
 * 无规则命中才走启发式。
 */
export function parseEmail(input: EmailParseInput): ParseOutcome {
  const mime = input.raw !== undefined ? extractMimeText(input.raw) : null;
  const body = normalizeBodyText(mime?.text ?? "");

  // 人工转发时真实来源在转发头块里；自动转发保持原 From，两路都兼容
  const fromAddr = addrSpec(body.forwarded.from ?? mime?.from ?? input.fromAddr);
  const subject = normalizeSubject(
    body.forwarded.subject ?? mime?.subject ?? input.subject,
  );
  const dateHeader = mime?.dateHeader ?? null;

  if (!subject && !body.text) return fail("no_text");

  const ctx: RuleContext = { fromAddr, subject, text: body.text, dateHeader };

  const matched = EMAIL_PARSE_RULES.filter(
    (rule) => rule.matchFrom.test(fromAddr) && rule.matchSubject.test(subject),
  );
  for (const rule of matched) {
    const outcome = extractWithRule(rule, ctx);
    if (outcome) return outcome;
  }
  if (matched.length > 0) {
    // 模板改版：可诊断失败（指标按规则 id 定位），绝不启发式猜值
    return fail("template_drift", matched[0].id);
  }
  return heuristicExtract({ ...ctx, receivedAt: input.receivedAt });
}
