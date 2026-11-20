import type { MarketState } from "@/server/services/markets";
import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  closed: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  pending: "bg-gold/20 text-amber-800 dark:text-gold",
  rejected: "bg-down/15 text-down",
  resolved: "bg-up/15 text-up",
  cancelled: "bg-muted text-muted-foreground",
};

export function Status({ tone, children }: { tone: keyof typeof STYLES; children: React.ReactNode }) {
  return <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-semibold", STYLES[tone])}>{children}</span>;
}

export function Tag({ children, title }: { children: React.ReactNode; title?: string }) {
  return <span title={title} className="inline-block rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">{children}</span>;
}

/** Short label for a market's state, as shown on cards and in lists. */
export function StateBadge({ state, short = true }: { state: MarketState; short?: boolean }) {
  switch (state) {
    case "closed": return <Status tone="closed">{short ? "Awaiting result" : "Betting closed — awaiting result"}</Status>;
    case "proposed": return <Status tone="pending">Result proposed</Status>;
    case "disputed": return <Status tone="rejected">{short ? "Disputed" : "Result disputed"}</Status>;
    case "resolved": return <Status tone="resolved">Resolved</Status>;
    case "cancelled": return <Status tone="cancelled">Cancelled</Status>;
    default: return null;
  }
}
