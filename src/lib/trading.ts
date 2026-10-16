export const ASSETS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA"] as const;
export type Asset = (typeof ASSETS)[number];
export type Venue = "Binance" | "Coinbase" | "Kraken";
export const VENUES: Venue[] = ["Binance", "Coinbase", "Kraken"];

export type RiskLimits = {
  maxOrderUsd: number;
  maxDailyLossUsd: number;
  minSpreadPct: number;
  feePct: number;
  killSwitch: boolean;
};

export type RiskCheck = { ok: true } | { ok: false; reason: string };

/** Pre-trade risk gate: every order passes through here before it is filled. */
export function checkOrder(
  notionalUsd: number,
  realizedPnlToday: number,
  limits: RiskLimits,
): RiskCheck {
  if (limits.killSwitch) return { ok: false, reason: "Kill switch is on" };
  if (notionalUsd <= 0) return { ok: false, reason: "Amount must be positive" };
  if (notionalUsd > limits.maxOrderUsd)
    return { ok: false, reason: `Order exceeds max size $${limits.maxOrderUsd}` };
  if (-realizedPnlToday >= limits.maxDailyLossUsd)
    return { ok: false, reason: "Daily loss limit reached" };
  return { ok: true };
}

/** Net arbitrage edge after paying fees on both legs, in percent. */
export function netSpreadPct(buy: number, sell: number, feePct: number): number {
  if (buy <= 0) return 0;
  return ((sell - buy) / buy) * 100 - 2 * feePct;
}
