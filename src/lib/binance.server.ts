// Server-only Binance client. API keys are read from env inside handlers and
// are never logged, returned, or included in error messages.

const BASE_URL = "https://api.binance.com";

async function hmacSha256(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function binanceCreds() {
  const apiKey = process.env["BINANCE_API_KEY"];
  const apiSecret = process.env["BINANCE_API_SECRET"];
  if (!apiKey || !apiSecret) throw new Error("Binance API keys are not configured on the server");
  return { apiKey, apiSecret };
}

async function signedRequest<T>(
  path: string,
  method: "GET" | "POST",
  params: Record<string, string>,
): Promise<T> {
  const { apiKey, apiSecret } = binanceCreds();
  const query = new URLSearchParams({
    ...params,
    timestamp: String(Date.now()),
    recvWindow: "5000",
  }).toString();
  const signature = await hmacSha256(query, apiSecret);
  const res = await fetch(`${BASE_URL}${path}?${query}&signature=${signature}`, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (!res.ok) {
    // Binance error bodies never contain credentials; safe to surface msg only.
    throw new Error(`Binance error ${body.code ?? res.status}: ${body.msg ?? "request failed"}`);
  }
  return body as T;
}

export type ApiRestrictions = {
  enableReading?: boolean;
  enableSpotAndMarginTrading?: boolean;
  enableWithdrawals?: boolean;
  enableInternalTransfer?: boolean;
  ipRestrict?: boolean;
};

export function getApiRestrictions() {
  return signedRequest<ApiRestrictions>("/sapi/v1/account/apiRestrictions", "GET", {});
}

export type AccountBalance = { asset: string; free: string; locked: string };

export async function getAccountBalances(): Promise<AccountBalance[]> {
  const acc = await signedRequest<{ balances: AccountBalance[] }>("/api/v3/account", "GET", {});
  return acc.balances.filter((b) => +b.free > 0 || +b.locked > 0);
}

export type OrderResult = {
  orderId: number;
  symbol: string;
  side: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
};

export function placeMarketOrder(symbol: string, side: "BUY" | "SELL", quoteOrderQty: number) {
  return signedRequest<OrderResult>("/api/v3/order", "POST", {
    symbol,
    side,
    type: "MARKET",
    quoteOrderQty: quoteOrderQty.toFixed(2),
  });
}
