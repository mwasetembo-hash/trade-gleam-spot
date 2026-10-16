import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getApiRestrictions, getAccountBalances, placeMarketOrder } from "./binance.server";

/** Hard server-side cap on any single live order, in USDT. */
const MAX_LIVE_ORDER_USDT = 250;

/** Checks the stored Binance keys and reports their permissions. */
export const validateBinanceConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const r = await getApiRestrictions();
    return {
      ok: true as const,
      spotTrading: !!r.enableSpotAndMarginTrading,
      withdrawalsEnabled: !!r.enableWithdrawals,
      ipRestricted: !!r.ipRestrict,
      safeToTrade: !!r.enableSpotAndMarginTrading && !r.enableWithdrawals,
    };
  });

/** Live account balances (non-zero only). */
export const getLiveBalances = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const balances = await getAccountBalances();
    return balances.map((b) => ({ asset: b.asset, free: +b.free, locked: +b.locked }));
  });

/**
 * Places a real market order on Binance. Re-validates that withdrawals are
 * disabled on every call and enforces a hard per-order USDT cap server-side.
 */
export const placeLiveOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { asset: string; side: "BUY" | "SELL"; usdt: number }) => data)
  .handler(async ({ data }) => {
    const usdt = Number(data.usdt);
    if (!Number.isFinite(usdt) || usdt <= 0) throw new Error("Amount must be positive");
    if (usdt > MAX_LIVE_ORDER_USDT)
      throw new Error(`Order exceeds the server-side cap of $${MAX_LIVE_ORDER_USDT}`);

    const restrictions = await getApiRestrictions();
    if (restrictions.enableWithdrawals)
      throw new Error("Refusing to trade: this API key has withdrawal permissions enabled");
    if (!restrictions.enableSpotAndMarginTrading)
      throw new Error("This API key does not have spot trading enabled");

    const symbol = `${data.asset.toUpperCase()}USDT`;
    const result = await placeMarketOrder(symbol, data.side, usdt);
    return {
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      executedQty: +result.executedQty,
      spentQuote: +result.cummulativeQuoteQty,
      status: result.status,
    };
  });
