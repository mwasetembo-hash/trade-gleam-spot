export const ASSETS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA"] as const;
export type Asset = (typeof ASSETS)[number];
export type Venue = "Binance" | "Coinbase" | "Kraken";
export const VENUES: Venue[] = ["Binance", "Coinbase", "Kraken"];

export type RiskLimits = {
  maxOrderUsd: number;
  maxDailyLossUsd: number;
  minSpreadPct: number;
  feePct: number;
  slippagePct: number;
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

/** Cost of filling one leg of `usd` notional: exchange fee plus slippage. */
export function fillCost(usd: number, feePct: number, slippagePct: number) {
  const fee = usd * (feePct / 100);
  const slip = usd * (slippagePct / 100);
  return { fee, slip, netUsd: usd - fee - slip };
}

/** Largest peak-to-trough fall in an equity curve, in percent. */
export function maxDrawdownPct(curve: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, ((peak - v) / peak) * 100);
  }
  return dd;
}
