"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CATEGORIES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { MarketCard, type CardData } from "@/components/market-card";

const TABS = [["open", "Open"], ["closed", "Awaiting result"], ["resolved", "Resolved"], ["cancelled", "Cancelled"], ["all", "All"]] as const;
const STATUSES: string[] = TABS.map(([k]) => k);
const OPEN_FIRST = ["open", "closed", "proposed", "disputed", "resolved", "cancelled"];

/** Keep the address bar shareable without a navigation: no server request, no history entry. */
function syncUrl(status: string, cat: string) {
  const q = new URLSearchParams();
  if (status !== "open") q.set("status", status);
  if (cat) q.set("cat", cat);
  const s = q.toString();
  window.history.replaceState(null, "", s ? `/?${s}` : "/");
}

function filterCards(cards: CardData[], status: string, cat: string): CardData[] {
  let m = cards;
  if (status === "closed") m = m.filter((b) => ["closed", "proposed", "disputed"].includes(b.state)); // "Awaiting result" also covers proposed and disputed
  else if (["open", "resolved", "cancelled"].includes(status)) m = m.filter((b) => b.state === status);
  if (cat) m = m.filter((b) => b.category === cat);
  m = [...m];
  if (status === "open") m.sort((a, b) => Number(b.featured) - Number(a.featured) || b.volume - a.volume); // featured first, then busiest
  else if (status === "all") m.sort((a, b) => OPEN_FIRST.indexOf(a.state) - OPEN_FIRST.indexOf(b.state) || (a.state === "open" ? a.closesAt - b.closesAt : (b.resolvedAt ?? b.closesAt) - (a.resolvedAt ?? a.closesAt))); // live markets first, then newest finished
  else if (status === "resolved" || status === "cancelled") m.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  return m;
}

export function MarketBrowser({ cards, initialStatus, initialCat, role }: {
  cards: CardData[]; initialStatus?: string; initialCat?: string; role: "guest" | "user" | "admin";
}) {
  const [status, setStatus] = useState(initialStatus && STATUSES.includes(initialStatus) ? initialStatus : "open"); // unknown values fall back to Open
  const [cat, setCat] = useState(initialCat && (CATEGORIES as readonly string[]).includes(initialCat) ? initialCat : "");
  const markets = useMemo(() => filterCards(cards, status, cat), [cards, status, cat]);
  const pick = (s: string, c: string) => { setStatus(s); setCat(c); syncUrl(s, c); };

  return (
    <>
      <div className="mb-4 space-y-3">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <nav aria-label="Market status" className="flex w-max gap-1 rounded-lg bg-secondary p-1">
            {TABS.map(([key, label]) => (
              <button
                key={key} type="button" onClick={() => pick(key, cat)} aria-pressed={status === key}
                className={cn("flex h-9 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50", status === key && "bg-card text-foreground shadow-sm")}
              >{label}</button>
            ))}
          </nav>
        </div>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <nav aria-label="Topic" className="flex gap-1.5 sm:w-auto sm:flex-wrap max-sm:w-max">
            {["", ...CATEGORIES].map((c) => (
              <button
                key={c || "all"} type="button" onClick={() => pick(status, c)} aria-pressed={cat === c}
                className={cn("flex h-9 items-center rounded-full border px-3.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50", cat === c && "border-primary bg-primary text-primary-foreground hover:bg-primary")}
              >{c || "All topics"}</button>
            ))}
          </nav>
        </div>
      </div>

      {markets.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{markets.map((b) => <MarketCard key={b.id} b={b} />)}</div>
      ) : (
        <div className="rounded-xl border bg-card px-4 py-12 text-center">
          <p className="font-medium">{cat || status !== "open" ? "No markets match these filters." : "No open markets right now."}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {cat || status !== "open" ? "Try another topic or status." : "Check back soon, or propose one yourself."}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {(cat || status !== "open") && <button type="button" onClick={() => pick("open", "")} className={buttonVariants({ variant: "outline" })}>Clear filters</button>}
            {role === "user" && <Link href="/propose" className={buttonVariants()}>Propose a market</Link>}
            {role === "admin" && <Link href="/admin" className={buttonVariants()}>Create a market</Link>}
          </div>
        </div>
      )}
    </>
  );
}
