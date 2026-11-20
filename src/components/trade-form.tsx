"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cents, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { placeTrade } from "@/server/actions/market";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type TradeOutcome = { id: number; label: string; price: number; held: number };
type Quote = { ok: true; shares: number; coins: number; avg_price: number; new_price: number } | { ok: false; error?: string };

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Buy/sell panel with a live quote from /api/quote. */
export function TradeForm({ marketId, outcomes, binary, balance }: { marketId: number; outcomes: TradeOutcome[]; binary: boolean; balance: number }) {
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [outcomeId, setOutcomeId] = useState(outcomes[0].id);
  const [value, setValue] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const seq = useRef(0);
  const selected = outcomes.find((o) => o.id === outcomeId)!;
  const isBuy = action === "buy";
  const maxBuy = Math.floor(balance * 100) / 100;
  const v = parseFloat(value);
  const idle = !isBuy && selected.held <= 0 ? "none" : !(v > 0) ? "empty" : "ready";

  useEffect(() => {
    const my = ++seq.current; // any quote still in flight becomes stale
    if (idle !== "ready") return;
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ market: String(marketId), outcome: String(outcomeId), action, value: String(v) });
      try {
        const res = (await (await fetch(`/api/quote?${params}`)).json()) as Quote;
        if (my === seq.current) setQuote(res);
      } catch {
        if (my === seq.current) setQuote({ ok: false, error: "Quote unavailable." });
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [idle, marketId, outcomeId, action, v]);

  const q = idle === "ready" ? quote : null;
  let preview: React.ReactNode;
  if (idle === "none") preview = <span className="text-muted-foreground">You don&apos;t own any “{selected.label}” shares to sell.</span>;
  else if (idle === "empty") preview = <span className="text-muted-foreground">{isBuy ? "Enter an amount to see your payout." : "Enter shares to see what you get back."}</span>;
  else if (!q) preview = <span className="text-muted-foreground">Getting a quote…</span>;
  else if (!q.ok) preview = <span className="text-down">{q.error || "Can't quote that trade."}</span>;
  else {
    const row = (k: string, val: React.ReactNode) => <div className="flex justify-between"><span className="text-muted-foreground">{k}</span><b>{val}</b></div>;
    preview = isBuy ? (
      <>
        {row("Shares", fmt(q.shares))}
        {row("Avg price", `Ⓜ${q.avg_price.toFixed(2)}`)}
        {row("Pays if right", <span className="text-up">Ⓜ{fmt(q.shares)} (+{fmt(q.shares - q.coins)})</span>)}
        {row("New price", `${(q.new_price * 100).toFixed(1)}%`)}
      </>
    ) : (
      <>
        {row("You receive", <span className="text-up">Ⓜ{fmt(q.coins)}</span>)}
        {row("Avg price", `Ⓜ${q.avg_price.toFixed(2)}`)}
        {row("New price", `${(q.new_price * 100).toFixed(1)}%`)}
      </>
    );
  }
  const canSubmit = idle === "ready" && q?.ok === true;

  const switchAction = (a: "buy" | "sell") => { setAction(a); setValue(""); setQuote(null); };

  return (
    <ActionForm action={placeTrade} className="space-y-3" onResult={(s) => { if (s.ok) { setValue(""); setQuote(null); } }}>
      {({ pending }) => (
        <>
          <input type="hidden" name="market_id" value={marketId} />
          <input type="hidden" name="action" value={action} />
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
            {(["buy", "sell"] as const).map((a) => (
              <button key={a} type="button" onClick={() => switchAction(a)} className={cn("rounded-md py-1.5 text-sm font-semibold capitalize text-muted-foreground", action === a && "bg-card text-foreground shadow-sm")}>{a}</button>
            ))}
          </div>
          <div className={cn("grid gap-2", binary ? "grid-cols-2" : "grid-cols-1")}>
            {outcomes.map((o, i) => (
              <label key={o.id} className="cursor-pointer">
                <input type="radio" name="outcome_id" value={o.id} checked={o.id === outcomeId} onChange={() => { setOutcomeId(o.id); setQuote(null); }} className="peer sr-only" />
                <span className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium peer-checked:border-primary peer-checked:bg-primary/10 peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">
                  <i className="size-2.5 shrink-0 rounded-full" style={{ background: `var(--c${i})` }} />
                  <span className="truncate">{o.label}</span>
                  <b className="ml-auto">{binary ? cents(o.price) : `Ⓜ${o.price.toFixed(2)}`}</b>
                </span>
              </label>
            ))}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="value" className="text-sm font-medium">{isBuy ? "Amount (Ⓜ)" : `Shares to sell (you own ${fmt(selected.held)})`}</label>
            <div className="flex gap-2">
              <Input id="value" name="value" type="number" min="0.01" step={isBuy ? "0.01" : "any"} required placeholder="0.00" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
              <Button type="button" variant="outline" onClick={() => setValue(String(isBuy ? maxBuy : selected.held))}>Max</Button>
            </div>
          </div>
          {isBuy && (
            <div className="flex gap-2">
              {[10, 50, 100].map((amt) => (
                <Button key={amt} type="button" variant="secondary" size="sm" className="flex-1" onClick={() => setValue(String(Math.min((parseFloat(value) || 0) + amt, maxBuy)))}>+{amt}</Button>
              ))}
            </div>
          )}
          <div className="space-y-1 rounded-lg bg-secondary p-3 text-sm">{preview}</div>
          <Button className="w-full" disabled={!canSubmit || pending}>{isBuy ? "Buy" : "Sell"} “{selected.label}”</Button>
          <p className="text-center text-sm text-muted-foreground">
            Balance Ⓜ{money(balance)} · <Link href="/how-it-works" className="text-primary hover:underline">How does this work?</Link>
          </p>
        </>
      )}
    </ActionForm>
  );
}
