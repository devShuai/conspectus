import type { EmailParseRule } from "./types";

/**
 * Apple 收据：同一发件域下按主题语种分模板（zh / en 两条规则并存，
 * 演示规则按 provider/template/version 组织、可插拔）。
 * - zh：Apple 中国商店模板，¥ 恒为 CNY（人民币定价收据），正文为 HTML；
 * - en：Apple 美国商店模板，$ 恒为 USD。
 * 候选名从正文购买项目抽取（Apple 收据覆盖 iCloud+/Music/TV+ 等多产品，
 * 不能固化单一名称）。
 */
export const appleRules: EmailParseRule[] = [
  {
    id: "apple/receipt-zh/v1",
    provider: "apple",
    template: "receipt-zh",
    version: 1,
    matchFrom: /@([a-z0-9-]+\.)*apple\.com$/,
    matchSubject: /收据/,
    vendorSlug: "apple",
    currency: "CNY",
    namePattern: /购买\s+(?<name>[^\n。，]+?)\s*[。，\n]/,
    amountPattern: /金额\s*[:：]?\s*¥\s*(?<amount>[0-9][0-9,]*(?:\.[0-9]{1,2})?)/,
    datePattern: /日期\s*[:：]?\s*(?<date>\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/,
    dateFormat: "zh",
    referencePattern: /订单号\s*[:：]?\s*(?<reference>[A-Z0-9]+)/,
  },
  {
    id: "apple/receipt-en/v1",
    provider: "apple",
    template: "receipt-en",
    version: 1,
    matchFrom: /@([a-z0-9-]+\.)*apple\.com$/,
    matchSubject: /receipt from apple/i,
    vendorSlug: "apple",
    currency: "USD",
    namePattern: /purchase of (?<name>[^\n.]+)/i,
    amountPattern: /^amount:\s*\$(?<amount>[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/im,
    datePattern: /^date:\s*(?<date>[A-Z][a-z]+ \d{1,2}, \d{4})\s*$/im,
    dateFormat: "en-long",
    referencePattern: /^order id:\s*(?<reference>[A-Z0-9]+)\s*$/im,
  },
];
