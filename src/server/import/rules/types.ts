import type { BillingCycleKind } from "@/server/billing/cycle";

/**
 * 邮件解析规则的类型定义（#60，design §7.5「规则库」）。
 *
 * 规则是数据不是代码分支：每条规则声明 matchFrom/matchSubject/抽取正则，
 * 由引擎（../parse.ts）统一解释执行。模板改版时新增 version 并保留旧版
 * （规则演进只增不改），既有 Draft payload 不受影响。
 */

/** 正文日期格式，由引擎的共享日期解析器解释。 */
export type RuleDateFormat = "iso" | "en-long" | "de-long" | "zh";

export interface EmailParseRule {
  /** 规则 id：`provider/template/vN`，写入 evidence.matchedRule（≤100 字符）。 */
  id: string;
  provider: string;
  template: string;
  version: number;
  /** 发件地址匹配（addr-spec 小写形态，需锚定域尾防 evilnetflix.com 之类傍名）。 */
  matchFrom: RegExp;
  /** 主题匹配（规范化后：转发/回复前缀已剥离）。 */
  matchSubject: RegExp;
  /** 系统 Vendor slug（可选，供订阅匹配用）。 */
  vendorSlug?: string;
  /** 固定候选名（模板只服务单一产品时）。 */
  name?: string;
  /** 候选名捕获（模板覆盖多产品时，命名组 name）。与 name 二选一。 */
  namePattern?: RegExp;
  /** 套餐捕获（命名组 plan）。 */
  planPattern?: RegExp;
  /** 套餐词 → 账期映射（如 包年→yearly）；命中时优先于固定 billingCycle。 */
  planCycleMap?: Record<string, BillingCycleKind>;
  /** 模板固定币种：该模板只会在单一币种市场发出（注释必须给出依据）。 */
  currency: string;
  /**
   * 金额捕获：命名组 amount；若模板中金额带 ISO 代码，用命名组 currency
   * 捕获 —— 引擎会校验它与固定币种一致（不一致 = 模板/市场漂移，拒抽）。
   */
  amountPattern: RegExp;
  /** 金额按欧洲逗号小数解读（"10,99" → 10.99）；缺省按英美点分。 */
  amountDecimalComma?: boolean;
  /** 日期捕获（命名组 date）；缺省时回退用邮件 Date 头（置信度略降）。 */
  datePattern?: RegExp;
  dateFormat?: RuleDateFormat;
  /** 订单/发票号捕获（命名组 reference）。 */
  referencePattern?: RegExp;
  /** 模板固化的账期（收据类邮件通常能确定）。 */
  billingCycle?: BillingCycleKind;
}
