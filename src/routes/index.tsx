import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ASSETS, VENUES, checkOrder, netSpreadPct, fillCost, maxDrawdownPct,
  type Asset, type RiskLimits, type Venue,
} from "@/lib/trading";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SwapDesk — Crypto Trading Console" },
      { name: "description", content: "Live crypto prices, swaps, arbitrage scanner and risk controls in one paper-trading console." },
      { property: "og:title", content: "SwapDesk — Crypto Trading Console" },
      { property: "og:description", content: "Live crypto prices, swaps, arbitrage scanner and risk controls." },
    ],
  }),
  component: Console,
});

type Prices = Record<Asset, { price: number; change: number }>;
type Log = { t: string; msg: string; kind: "ok" | "err" | "info" };
type Balances = Record<Asset | "USDT", number>;

const VENUE_SKEW: Record<Venue, number> = { Binance: 0, Coinbase: 0.0012, Kraken: -0.0009 };

function usePrices() {
  const [prices, setPrices] = useState<Prices | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const syms = JSON.stringify(ASSETS.map((a) => `${a}USDT`));
        const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(syms)}`);
        const d: { symbol: string; lastPrice: string; priceChangePercent: string }[] = await r.json();
        const p = {} as Prices;
        d.forEach((x) => (p[x.symbol.replace("USDT", "") as Asset] = { price: +x.lastPrice, change: +x.priceChangePercent }));
        if (!stop) { setPrices(p); setLive(true); }
      } catch { if (!stop) setLive(false); }
    };
    load();
    const id = setInterval(load, 4000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  return { prices, live };
}

function venuePrice(base: number, v: Venue, tick: number, a: string) {
  const jitter = Math.sin(tick * 1.7 + a.length * 3 + v.length) * 0.0015;
  return base * (1 + VENUE_SKEW[v] + jitter);
}

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function Console() {
  const { prices, live } = usePrices();
  const [tick, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 2000); return () => clearInterval(id); }, []);

  const [bal, setBal] = useState<Balances>({ USDT: 10000, BTC: 0, ETH: 0, SOL: 0, BNB: 0, XRP: 0, ADA: 0 });
  const [pnl, setPnl] = useState(0);
  const [logs, setLogs] = useState<Log[]>([]);
  const [limits, setLimits] = useState<RiskLimits>({ maxOrderUsd: 2000, maxDailyLossUsd: 300, minSpreadPct: 0.05, feePct: 0.1, slippagePct: 0.05, killSwitch: false });
  const [stats, setStats] = useState({ trades: 0, wins: 0, fees: 0, slip: 0, rejected: 0 });
  const record = (p: number, fee: number, slip: number) =>
    setStats((s) => ({ ...s, trades: s.trades + 1, wins: s.wins + (p > 0 ? 1 : 0), fees: s.fees + fee, slip: s.slip + slip }));
  const reject = () => setStats((s) => ({ ...s, rejected: s.rejected + 1 }));
  const log = (msg: string, kind: Log["kind"] = "info") =>
    setLogs((l) => [{ t: new Date().toLocaleTimeString(), msg, kind }, ...l].slice(0, 60));

  // Swap form
  const [from, setFrom] = useState<Asset | "USDT">("USDT");
  const [to, setTo] = useState<Asset | "USDT">("BTC");
  const [amt, setAmt] = useState("500");
  const px = (a: Asset | "USDT") => (a === "USDT" ? 1 : prices?.[a]?.price ?? 0);

  const swap = () => {
    const a = parseFloat(amt);
    if (from === to) return log("Pick two different assets", "err");
    if (!(a > 0) || a > bal[from]) return log(`Insufficient ${from} balance`, "err");
    const usd = a * px(from);
    const chk = checkOrder(usd, pnl, limits);
    if (!chk.ok) { reject(); return log(`REJECTED: ${chk.reason}`, "err"); }
    const { fee, slip, netUsd } = fillCost(usd, limits.feePct, limits.slippagePct);
    const out = netUsd / px(to);
    setBal((b) => ({ ...b, [from]: b[from] - a, [to]: b[to] + out }));
    setPnl((p) => p - fee - slip);
    record(-fee - slip, fee, slip);
    log(`SWAP ${fmt(a, 6)} ${from} → ${fmt(out, 6)} ${to} (fee $${fmt(fee)}, slippage $${fmt(slip)})`, "ok");
  };

  // Arbitrage
  const opps = useMemo(() => {
    if (!prices) return [];
    return ASSETS.map((a) => {
      const quotes = VENUES.map((v) => ({ v, p: venuePrice(prices[a].price, v, tick, a) }));
      const buy = quotes.reduce((m, q) => (q.p < m.p ? q : m));
      const sell = quotes.reduce((m, q) => (q.p > m.p ? q : m));
      return { a, buy, sell, net: netSpreadPct(buy.p, sell.p, limits.feePct) - 2 * limits.slippagePct };
    }).sort((x, y) => y.net - x.net);
  }, [prices, tick, limits.feePct, limits.slippagePct]);

  const [autoArb, setAutoArb] = useState(false);
  const [arbSize, setArbSize] = useState(500);
  const execArb = (o: (typeof opps)[number]) => {
    const chk = checkOrder(arbSize, pnl, limits);
    if (!chk.ok) { reject(); return log(`ARB REJECTED: ${chk.reason}`, "err"); }
    if (o.net < limits.minSpreadPct) return log(`ARB SKIPPED ${o.a}: net ${fmt(o.net, 3)}% below min`, "info");
    const profit = arbSize * (o.net / 100);
    const fee = 2 * arbSize * (limits.feePct / 100);
    const slip = 2 * arbSize * (limits.slippagePct / 100);
    setPnl((p) => p + profit);
    setBal((b) => ({ ...b, USDT: b.USDT + profit }));
    record(profit, fee, slip);
    log(`ARB ${o.a} buy ${o.buy.v} @${fmt(o.buy.p)} sell ${o.sell.v} @${fmt(o.sell.p)} → ${profit >= 0 ? "+" : ""}$${fmt(profit)}`, profit >= 0 ? "ok" : "err");
  };
  const lastTick = useRef(-1);
  useEffect(() => {
    if (autoArb && opps[0] && tick !== lastTick.current) { lastTick.current = tick; execArb(opps[0]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, autoArb]);

  // DCA / auto-swap strategy
  const [dca, setDca] = useState(false);
  const [dcaAsset, setDcaAsset] = useState<Asset>("ETH");
  useEffect(() => {
    if (!dca || !prices || tick % 5 !== 0) return;
    const usd = 100;
    const chk = checkOrder(usd, pnl, limits);
    if (!chk.ok || bal.USDT < usd) { reject(); return log(`DCA paused: ${chk.ok ? "low USDT" : chk.reason}`, "err"); }
    const { fee, slip, netUsd } = fillCost(usd, limits.feePct, limits.slippagePct);
    const out = netUsd / prices[dcaAsset].price;
    setBal((b) => ({ ...b, USDT: b.USDT - usd, [dcaAsset]: b[dcaAsset] + out }));
    setPnl((p) => p - fee - slip);
    record(-fee - slip, fee, slip);
    log(`DCA bought ${fmt(out, 6)} ${dcaAsset}`, "ok");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, dca]);

  const equity = (Object.keys(bal) as (Asset | "USDT")[]).reduce((s, k) => s + bal[k] * px(k), 0);
  const [curve, setCurve] = useState<number[]>([]);
  useEffect(() => { if (prices) setCurve((c) => [...c, equity].slice(-2000)); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, prices]);
  const dd = maxDrawdownPct(curve);
  const lossUsedPct = Math.min(100, (Math.max(0, -pnl) / (limits.maxDailyLossUsd || 1)) * 100);

  // API config
  const [venue, setVenue] = useState<Venue>("Binance");
  const [keys, setKeys] = useState<Record<Venue, { key: string; set: boolean }>>({
    Binance: { key: "", set: false }, Coinbase: { key: "", set: false }, Kraken: { key: "", set: false },
  });
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  const panel = "border border-border bg-card p-4";
  const h = "mb-3 font-mono text-xs uppercase tracking-widest text-muted-foreground";
  const input = "w-full border border-input bg-background px-2 py-1.5 font-mono text-sm outline-none focus:border-ring";
  const btn = "border border-primary bg-primary px-3 py-1.5 font-mono text-sm font-semibold text-primary-foreground hover:opacity-90";
  const btnGhost = "border border-border px-3 py-1.5 font-mono text-sm hover:border-primary";

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-tight">Swap<span className="text-primary">Desk</span></span>
          <span className="border border-accent px-2 py-0.5 font-mono text-[10px] uppercase text-accent">Paper trading</span>
        </div>
        <div className="flex gap-6 font-mono text-sm">
          <span>Equity <b className="text-primary">${fmt(equity)}</b></span>
          <span>P&L today <b className={pnl >= 0 ? "text-gain" : "text-loss"}>{pnl >= 0 ? "+" : ""}${fmt(pnl)}</b></span>
          <span className={live ? "text-gain" : "text-loss"}>● {live ? "LIVE" : "OFFLINE"}</span>
        </div>
      </header>

      {/* Ticker */}
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {ASSETS.map((a) => (
          <div key={a} className="bg-background px-4 py-3 font-mono">
            <div className="text-xs text-muted-foreground">{a}/USDT</div>
            <div className="text-lg">{prices ? fmt(prices[a].price, prices[a].price < 10 ? 4 : 2) : "—"}</div>
            <div className={`text-xs ${(prices?.[a].change ?? 0) >= 0 ? "text-gain" : "text-loss"}`}>
              {prices ? `${prices[a].change >= 0 ? "+" : ""}${fmt(prices[a].change)}%` : ""}
            </div>
          </div>
        ))}
      </div>

      <main className="grid gap-4 p-4 lg:grid-cols-3">
        {/* Swap */}
        <section className={panel}>
          <h2 className={h}>Execution · Swap</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <select className={input} value={from} onChange={(e) => setFrom(e.target.value as Asset)}>
                {["USDT", ...ASSETS].map((a) => <option key={a}>{a}</option>)}
              </select>
              <select className={input} value={to} onChange={(e) => setTo(e.target.value as Asset)}>
                {["USDT", ...ASSETS].map((a) => <option key={a}>{a}</option>)}
              </select>
            </div>
            <input className={input} value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="Amount" />
            <div className="font-mono text-xs text-muted-foreground">
              Available: {fmt(bal[from], 6)} {from} · ≈ ${fmt((parseFloat(amt) || 0) * px(from))}
            </div>
            <div className="font-mono text-xs">
              You receive ≈ {px(to) ? fmt(((parseFloat(amt) || 0) * px(from) * (1 - limits.feePct / 100)) / px(to), 6) : "—"} {to}
            </div>
            <button className={`${btn} w-full`} onClick={swap} disabled={!prices}>Execute swap</button>
          </div>
          <h2 className={`${h} mt-6`}>Balances</h2>
          <table className="w-full font-mono text-sm">
            <tbody>
              {(Object.keys(bal) as (Asset | "USDT")[]).map((k) => (
                <tr key={k} className="border-t border-border">
                  <td className="py-1">{k}</td>
                  <td className="text-right">{fmt(bal[k], k === "USDT" ? 2 : 6)}</td>
                  <td className="text-right text-muted-foreground">${fmt(bal[k] * px(k))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Arbitrage */}
        <section className={`${panel} lg:col-span-2`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={h}>Arbitrage scanner · {VENUES.join(" / ")}</h2>
            <div className="flex items-center gap-2 font-mono text-xs">
              Size $<input className={`${input} w-24`} type="number" value={arbSize} onChange={(e) => setArbSize(+e.target.value)} />
              <button className={autoArb ? btn : btnGhost} onClick={() => { setAutoArb(!autoArb); log(`Auto-arbitrage ${!autoArb ? "ON" : "OFF"}`); }}>
                Auto {autoArb ? "ON" : "OFF"}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr><th className="py-2 text-left">Asset</th><th className="text-left">Buy</th><th className="text-left">Sell</th><th className="text-right">Net edge</th><th /></tr>
              </thead>
              <tbody>
                {opps.map((o) => (
                  <tr key={o.a} className="border-t border-border">
                    <td className="py-2">{o.a}</td>
                    <td>{o.buy.v} <span className="text-muted-foreground">{fmt(o.buy.p)}</span></td>
                    <td>{o.sell.v} <span className="text-muted-foreground">{fmt(o.sell.p)}</span></td>
                    <td className={`text-right ${o.net >= limits.minSpreadPct ? "text-gain" : "text-loss"}`}>{fmt(o.net, 3)}%</td>
                    <td className="text-right"><button className={btnGhost} onClick={() => execArb(o)}>Execute</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Base prices are live from Binance; other venue quotes are simulated until exchange APIs are connected.
          </p>

          <h2 className={`${h} mt-6`}>Automated strategy · DCA swap</h2>
          <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
            Buy $100 of
            <select className={`${input} w-24`} value={dcaAsset} onChange={(e) => setDcaAsset(e.target.value as Asset)}>
              {ASSETS.map((a) => <option key={a}>{a}</option>)}
            </select>
            every 10s
            <button className={dca ? btn : btnGhost} onClick={() => { setDca(!dca); log(`DCA ${!dca ? "ON" : "OFF"}`); }}>{dca ? "Running" : "Start"}</button>
          </div>
        </section>

        {/* Risk */}
        <section className={panel}>
          <h2 className={h}>Risk controls</h2>
          <div className="space-y-3 font-mono text-sm">
            {([
              ["maxOrderUsd", "Max order ($)"],
              ["maxDailyLossUsd", "Max daily loss ($)"],
              ["minSpreadPct", "Min arb edge (%)"],
              ["feePct", "Fee per leg (%)"],
            ] as const).map(([k, label]) => (
              <label key={k} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{label}</span>
                <input className={`${input} w-28`} type="number" step="any" value={limits[k]}
                  onChange={(e) => setLimits({ ...limits, [k]: +e.target.value })} />
              </label>
            ))}
            <button
              className={`w-full border px-3 py-2 font-semibold ${limits.killSwitch ? "border-destructive bg-destructive text-destructive-foreground" : "border-destructive text-destructive"}`}
              onClick={() => { setLimits({ ...limits, killSwitch: !limits.killSwitch }); setAutoArb(false); setDca(false); log(limits.killSwitch ? "Kill switch released" : "KILL SWITCH ENGAGED", "err"); }}>
              {limits.killSwitch ? "Kill switch ON — release" : "Kill switch"}
            </button>
          </div>
        </section>

        {/* API config */}
        <section className={panel}>
          <h2 className={h}>Exchange API configuration</h2>
          <div className="space-y-3 font-mono text-sm">
            <div className="flex gap-1">
              {VENUES.map((v) => (
                <button key={v} className={venue === v ? btn : btnGhost} onClick={() => setVenue(v)}>{v}</button>
              ))}
            </div>
            <input className={input} placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <input className={input} type="password" placeholder="API secret" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
            <button className={`${btn} w-full`} onClick={() => {
              if (!apiKey || !apiSecret) return log("Enter key and secret", "err");
              setKeys({ ...keys, [venue]: { key: apiKey.slice(0, 4) + "••••", set: true } });
              setApiKey(""); setApiSecret("");
              log(`${venue} credentials staged (session only, not stored)`, "ok");
            }}>Save for session</button>
            <ul className="space-y-1 text-xs">
              {VENUES.map((v) => (
                <li key={v} className="flex justify-between">
                  <span>{v}</span>
                  <span className={keys[v].set ? "text-gain" : "text-muted-foreground"}>{keys[v].set ? `staged ${keys[v].key}` : "not configured"}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Use trade-only keys with withdrawals disabled. Live order routing is off — all fills are simulated.</p>
          </div>
        </section>

        {/* Log */}
        <section className={panel}>
          <h2 className={h}>Execution log</h2>
          <div className="h-72 overflow-y-auto font-mono text-xs">
            {logs.length === 0 && <div className="text-muted-foreground">Waiting for orders…</div>}
            {logs.map((l, i) => (
              <div key={i} className={l.kind === "ok" ? "text-gain" : l.kind === "err" ? "text-loss" : "text-muted-foreground"}>
                <span className="text-muted-foreground">{l.t}</span> {l.msg}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
