import { describe, it, expect } from "vitest";
import { checkOrder, netSpreadPct, fillCost, maxDrawdownPct, recordTrade, emptyStrategyStats, winRatePct, type RiskLimits } from "@/lib/trading";

const limits: RiskLimits = { maxOrderUsd: 1000, maxDailyLossUsd: 200, minSpreadPct: 0.1, feePct: 0.1, slippagePct: 0.05, killSwitch: false };

describe("risk controls", () => {
  it("blocks orders above max size", () => {
    expect(checkOrder(1500, 0, limits).ok).toBe(false);
  });
  it("blocks after daily loss limit", () => {
    expect(checkOrder(100, -200, limits).ok).toBe(false);
  });
  it("blocks when kill switch on", () => {
    expect(checkOrder(100, 0, { ...limits, killSwitch: true }).ok).toBe(false);
  });
  it("allows normal orders", () => {
    expect(checkOrder(500, -50, limits).ok).toBe(true);
  });
  it("subtracts fees on both legs", () => {
    expect(netSpreadPct(100, 101, 0.1)).toBeCloseTo(0.8);
  });
  it("deducts fee and slippage from a fill", () => {
    const c = fillCost(1000, 0.1, 0.05);
    expect(c.fee).toBeCloseTo(1);
    expect(c.slip).toBeCloseTo(0.5);
    expect(c.netUsd).toBeCloseTo(998.5);
  });
  it("measures max drawdown", () => {
    expect(maxDrawdownPct([100, 120, 90, 130])).toBeCloseTo(25);
  });
});

describe("strategy stats", () => {
  it("accumulates pnl, fees, slippage and wins per strategy", () => {
    let s = emptyStrategyStats();
    s = recordTrade(s, 10, 1, 0.5, 10010);
    s = recordTrade(s, -4, 1, 0.5, 10006);
    expect(s.pnl).toBeCloseTo(6);
    expect(s.trades).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.fees).toBeCloseTo(2);
    expect(s.slip).toBeCloseTo(1);
    expect(winRatePct(s)).toBeCloseTo(50);
  });
  it("win rate is zero with no trades", () => {
    expect(winRatePct(emptyStrategyStats())).toBe(0);
  });
});
