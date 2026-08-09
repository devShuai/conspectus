import type { EmailParseRule } from "./types";

/**
 * Spotify 续费账单（de-DE 市场模板）。
 * - 德国模板金额是逗号小数（"10,99 €"），amountDecimalComma 声明后引擎
 *   按欧洲格式解读 —— 没有该声明时逗号金额一律 fail closed；
 * - 币种依据：€ 符号 + 德国站模板，恒为 EUR。
 */
export const spotifyRules: EmailParseRule[] = [
  {
    id: "spotify/receipt-de/v1",
    provider: "spotify",
    template: "receipt-de",
    version: 1,
    matchFrom: /@([a-z0-9-]+\.)*spotify\.com$/,
    matchSubject: /spotify.*(rechnung|quittung)/i,
    vendorSlug: "spotify",
    name: "Spotify",
    currency: "EUR",
    billingCycle: "monthly",
    amountDecimalComma: true,
    amountPattern: /betrag:\s*(?<amount>\d{1,3}(?:\.\d{3})*,\d{2})\s*€/i,
    datePattern: /datum:\s*(?<date>\d{1,2}\.\s*[A-ZÄÖÜ][a-zäöü]+\s+\d{4})/i,
    dateFormat: "de-long",
    planPattern: /^abo:\s*(?<plan>.+?)\s*$/im,
  },
];
