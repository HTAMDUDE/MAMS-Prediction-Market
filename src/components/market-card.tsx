import Link from "next/link";
import { centsLabel, money, pct, until } from "@/lib/format";
import type { Bundle, MarketState } from "@/server/services/markets";
import { Card } from "@/components/ui/card";
import { StateBadge, Tag } from "@/components/state-badge";

/** The few fields a card needs, as plain data (timestamps in ms) so the whole list can be sent to the client once. */
export type CardData = {
  id: number; question: string; category: string; featured: boolean;
  closesAt: number; resolvedAt: number | null; resolvedOutcomeId: number | null;
  state: MarketState; binary: boolean; outcomes: Bundle["outcomes"]; volume: number; traders: number;
};

export function toCard(b: Bundle): CardData {
  const m = b.m;
  return {
    id: m.id, question: m.question, category: m.category, featured: m.featured, closesAt: m.closesAt.getTime(),
    resolvedAt: m.resolvedAt?.getTime() ?? null, resolvedOutcomeId: m.resolvedOutcomeId,
    state: b.state, binary: b.binary, outcomes: b.outcomes, volume: b.volume, traders: b.traders,
  };
}

export function MarketCard({ b }: { b: CardData }) {
  const live = ["open", "closed", "proposed", "disputed"].includes(b.state);
  return (
    <Link href={`/market/${b.id}`} className="group block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <Card className="h-full gap-3 p-4 transition-all group-hover:-translate-y-0.5 group-hover:shadow-md">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-1.5">
            <Tag>{b.category}</Tag>
            {b.featured && <span title="Featured by the admins" className="text-gold">★ Featured</span>}
          </span>
          {b.state === "open" ? <span suppressHydrationWarning className="text-muted-foreground">{until(new Date(b.closesAt))}</span> : <StateBadge state={b.state} />}
        </div>
        <h3 className="text-base leading-snug font-semibold">{b.question}</h3>
        {b.binary && live ? (
          <div className="flex items-end justify-between gap-2">
            <div>
              <span className="text-3xl font-bold tracking-tight">{pct(b.outcomes[0].price)}</span>{" "}
              <span className="text-sm text-muted-foreground">chance</span>
            </div>
            <div className="flex gap-1.5 text-sm font-semibold">
              <span className="rounded-md bg-c0/15 px-2 py-1 text-c0">Yes {centsLabel(b.outcomes[0].price)}</span>
              <span className="rounded-md bg-c1/15 px-2 py-1 text-c1">No {centsLabel(b.outcomes[1].price)}</span>
            </div>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {b.outcomes.slice(0, 4).map((o, i) => (
              <li key={o.id} className={`grid grid-cols-[minmax(0,8rem)_1fr_3rem] items-center gap-2 text-sm ${b.state === "resolved" && o.id === b.resolvedOutcomeId ? "font-bold" : ""}`}>
                <span className="truncate">{o.label}</span>
                <span className="h-2 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full" style={{ width: `${(o.price * 100).toFixed(1)}%`, background: `var(--c${i})` }} />
                </span>
                <span className="text-right font-semibold">{pct(o.price)}</span>
              </li>
            ))}
            {b.outcomes.length > 4 && <li className="text-sm text-muted-foreground">+{b.outcomes.length - 4} more</li>}
          </ul>
        )}
        <div className="mt-auto text-sm text-muted-foreground">
          Ⓜ{money(b.volume)} traded · {b.traders} trader{b.traders === 1 ? "" : "s"}
        </div>
      </Card>
    </Link>
  );
}
