"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { money, pctPrecise, price } from "@/lib/format";
import { cn } from "@/lib/utils";
import { placeTrade } from "@/server/actions/market";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type TradeOutcome = { id: number; label: string; price: number; held: number };
type QuoteBody = { ok: true; shares: number; coins: number; avg_price: number; new_price: number } | { ok: false; error?: string };
/** A quote remembers what it was fetched for, so it can never be shown or submitted for a different input. */
type Quote = { key: string; body: QuoteBody };

/** How much worse than the quote the final fill may be before the server refuses it. */
const SLIPPAGE = 0.98;
const round2 = (n: number) => Math.round(n * 100) / 100;
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;

/** Buy/sell panel with a live quote from /api/quote. */
export function TradeForm({ marketId, outcomes, binary, balance }: { marketId: number; outcomes: TradeOutcome[]; binary: boolean; balance: number }) {
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [outcomeId, setOutcomeId] = useState(outcomes[0].id);
  const [value, setValue] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [refresh, setRefresh] = useState(0); // bumped after a failed trade so the quote is re-fetched
  const selected = outcomes.find((o) => o.id === outcomeId)!;
  const isBuy = action === "buy";
  const maxBuy = floor2(balance);
  const v = parseFloat(value);
  const idle = !isBuy && selected.held <= 0 ? "none" : !(v > 0) ? "empty" : "ready";
  const key = `${outcomeId}|${action}|${value}`;

  useEffect(() => {
    if (idle !== "ready") return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ market: String(marketId), outcome: String(outcomeId), action, value: String(v) });
      try {
        const res = await fetch(`/api/quote?${params}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error("bad response");
        setQuote({ key, body: (await res.json()) as QuoteBody });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setQuote({ key, body: { ok: false, error: "Quote unavailable. Try again." } });
      }
    }, 150);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [idle, marketId, outcomeId, action, v, key, refresh]);

  const fresh = idle === "ready" && quote?.key === key; // the quote matches exactly what's typed
  const q = fresh ? quote!.body : null;
  const stale = idle === "ready" && !fresh && quote && quote.key.split("|")[0] === String(outcomeId) && quote.key.split("|")[1] === action ? quote.body : null;

  const row = (k: string, val: React.ReactNode) => <div className="flex justify-between gap-3"><span className="text-muted-foreground">{k}</span><b>{val}</b></div>;
  const renderBody = () => {
    const show = q ?? stale;
    if (show && show.ok) {
      return (
        <div className={cn("space-y-1", !q && "opacity-50 transition-opacity")}>
          {isBuy ? (
            <>
              {row("Shares", money(show.shares))}
              {row("Avg price", `Ⓜ${money(show.avg_price)}`)}
              {row("Pays if right", <span className="text-up">Ⓜ{money(show.shares)} (+{money(show.shares - show.coins)})</span>)}
              {row("New price", pctPrecise(show.new_price))}
            </>
          ) : (
            <>
              {row("You receive", <span className="text-up">Ⓜ{money(show.coins)}</span>)}
              {row("Avg price", `Ⓜ${money(show.avg_price)}`)}
              {row("New price", pctPrecise(show.new_price))}
            </>
          )}
        </div>
      );
    }
    const muted = (t: string) => <span className="text-muted-foreground">{t}</span>;
    if (idle === "none") return muted(`You don’t own any “${selected.label}” shares to sell.`);
    if (idle === "empty") return muted(isBuy ? "Enter an amount to see your payout." : "Enter shares to see what you get back.");
    if (q && !q.ok) return <span className="text-down">{q.error || "Can’t quote that trade."}</span>;
    return muted("Getting a quote…");
  };

  const canSubmit = fresh && q?.ok === true;
  const minOut = q && q.ok ? (isBuy ? q.shares : q.coins) * SLIPPAGE : 0;

  const switchAction = (a: "buy" | "sell") => { setAction(a); setValue(""); setQuote(null); };
  const setAmount = (n: number) => setValue(n > 0 ? String(round2(n)) : "");

  return (
    <ActionForm
      action={placeTrade}
      className="space-y-3"
      onResult={(s) => { if (s.ok) { setValue(""); setQuote(null); } else setRefresh((n) => n + 1); }}
    >
      {({ pending }) => (
        <>
          <input type="hidden" name="market_id" value={marketId} />
          <input type="hidden" name="action" value={action} />
          {canSubmit && <input type="hidden" name="min_out" value={String(Math.floor(minOut * 1e6) / 1e6)} />}
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
            {(["buy", "sell"] as const).map((a) => (
              <button
                key={a} type="button" aria-pressed={action === a} onClick={() => switchAction(a)}
                className={cn(
                  "h-9 rounded-md text-sm font-semibold capitalize text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  action === a && "bg-card text-foreground shadow-sm",
                )}
              >{a}</button>
            ))}
          </div>
          <div className={cn("grid gap-2", binary ? "grid-cols-2" : "grid-cols-1")} role="radiogroup" aria-label="Outcome">
            {outcomes.map((o, i) => (
              <label key={o.id} className="cursor-pointer">
                <input type="radio" name="outcome_id" value={o.id} checked={o.id === outcomeId} onChange={() => { setOutcomeId(o.id); setQuote(null); }} className="peer sr-only" />
                <span className="flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors hover:bg-secondary/60 peer-checked:border-primary peer-checked:bg-primary/10 peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">
                  <i className="size-2.5 shrink-0 rounded-full" style={{ background: `var(--c${i})` }} />
                  <span className="truncate">{o.label}</span>
                  <b className="ml-auto shrink-0">{price(o.price, binary)}</b>
                </span>
              </label>
            ))}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="trade-value" className="text-sm font-medium">
              {isBuy ? "Amount (Ⓜ)" : `Shares to sell (you own ${money(selected.held)})`}
            </label>
            <div className="flex gap-2">
              <Input
                id="trade-value" name="value" type="number" inputMode="decimal" min="0.01" step={isBuy ? "0.01" : "any"} required
                placeholder="0.00" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className="h-10 text-base"
              />
              <Button
                type="button" variant="outline" className="h-10 px-4"
                disabled={isBuy ? maxBuy < 1 : selected.held <= 0}
                // 6 decimals stays within the server's snap-to-everything tolerance, so Max sells the whole position
                onClick={() => setValue(isBuy ? String(maxBuy) : String(Number(selected.held.toFixed(6))))}
              >Max</Button>
            </div>
          </div>
          {isBuy && (
            <div className="flex gap-2">
              {[10, 50, 100].map((amt) => (
                <Button
                  key={amt} type="button" variant="secondary" className="h-9 flex-1" disabled={maxBuy < 1 || (parseFloat(value) || 0) >= maxBuy}
                  onClick={() => setAmount(Math.min((parseFloat(value) || 0) + amt, maxBuy))}
                >+{amt}</Button>
              ))}
            </div>
          )}
          <div className="min-h-[6.75rem] space-y-1 rounded-lg bg-secondary p-3 text-sm" aria-live="polite">{renderBody()}</div>
          <Button
            className={cn("h-10 w-full text-base whitespace-normal", isBuy ? "bg-up text-white hover:bg-up/90" : "bg-down text-white hover:bg-down/90")}
            disabled={!canSubmit || pending}
          >
            <span className="truncate">{pending ? (isBuy ? "Buying…" : "Selling…") : `${isBuy ? "Buy" : "Sell"} “${selected.label}”`}</span>
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Balance Ⓜ{money(balance)} · <Link href="/how-it-works" className="text-primary hover:underline">How does this work?</Link>
          </p>
        </>
      )}
    </ActionForm>
  );
}
