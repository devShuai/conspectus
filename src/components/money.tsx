/**
 * Format an amount with its own currency (design.md §6.2 / §7.3).
 * Never hardcode a symbol: per-currency fraction digits differ (JPY has none)
 * and the user's base currency is configurable.
 */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    // Unknown/invalid ISO code: show the raw code so the number is never
    // silently attributed to the wrong currency.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export default function Money({
  amount,
  currency,
}: Readonly<{ amount: number; currency: string }>) {
  return <span className="money">{formatMoney(amount, currency)}</span>;
}
