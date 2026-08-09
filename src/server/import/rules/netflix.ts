import type { EmailParseRule } from "./types";

/**
 * Netflix 扣款收据（en-US 市场模板）。
 * 币种依据：该模板正文只出现 "$"，美国站收据恒为 USD —— 模板固定币种。
 */
export const netflixRules: EmailParseRule[] = [
  {
    id: "netflix/receipt/v1",
    provider: "netflix",
    template: "receipt",
    version: 1,
    matchFrom: /@([a-z0-9-]+\.)*netflix\.com$/,
    matchSubject: /your (netflix )?receipt|receipt from netflix/i,
    vendorSlug: "netflix",
    name: "Netflix",
    currency: "USD",
    billingCycle: "monthly",
    amountPattern: /payment of \$(?<amount>[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    datePattern: /received on (?<date>[A-Z][a-z]+ \d{1,2}, \d{4})/i,
    dateFormat: "en-long",
    planPattern: /^plan:\s*(?<plan>[A-Za-z0-9][A-Za-z0-9 +]*?)\s*$/im,
    referencePattern: /^invoice:\s*(?<reference>[A-Z0-9-]+)\s*$/im,
  },
];
