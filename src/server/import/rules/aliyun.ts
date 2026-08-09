import type { EmailParseRule } from "./types";

/**
 * 阿里云 续费扣款通知（zh-CN 模板）。
 * - 币种依据：阿里云中国站 ¥ 恒为 CNY；
 * - 金额带千分位（"¥1,080.00"），引擎按英美点分解读并去千分位；
 * - 产品名从正文抽取（一条模板覆盖 ECS/OSS/域名等全部产品线），
 *   周期由套餐词（包年/包月）映射为 yearly/monthly，模板未出现则不猜。
 */
export const aliyunRules: EmailParseRule[] = [
  {
    id: "aliyun/renewal/v1",
    provider: "aliyun",
    template: "renewal",
    version: 1,
    matchFrom: /@([a-z0-9-]+\.)*aliyun\.com$/,
    matchSubject: /续费(成功|扣款)|扣款成功/,
    vendorSlug: "aliyun",
    currency: "CNY",
    namePattern: /购买的\s+(?<name>[^（(\n，。]+?)\s*[（(]/,
    planPattern: /(?<plan>包年|包月)/,
    planCycleMap: { 包年: "yearly", 包月: "monthly" },
    amountPattern: /扣款金额\s*[:：]?\s*¥\s*(?<amount>[0-9][0-9,]*(?:\.[0-9]{1,2})?)/,
    datePattern: /于\s*(?<date>\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)\s*自动续费/,
    dateFormat: "zh",
    referencePattern: /订单号\s*[:：]\s*(?<reference>[A-Za-z0-9-]+)/,
  },
];
