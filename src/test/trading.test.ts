import { describe, it, expect } from "vitest";
import { checkOrder, netSpreadPct, type RiskLimits } from "@/lib/trading";

const limits: RiskLimits = { maxOrderUsd: 1000, maxDailyLossUsd: 200, minSpreadPct: 0.1, feePct: 0.1, killSwitch: false };

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
});
