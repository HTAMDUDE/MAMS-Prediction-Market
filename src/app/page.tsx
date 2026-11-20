import Link from "next/link";
import { CATEGORIES, CURRENCY } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ensureFinalized } from "@/server/finalize";
import { bundles } from "@/server/services/markets";
import { buttonVariants } from "@/components/ui/button";
import { MarketCard } from "@/components/market-card";

const TABS = [["open", "Open"], ["closed", "Awaiting result"], ["resolved", "Resolved"], ["cancelled", "Cancelled"], ["all", "All"]] as const;
const STATUSES: string[] = TABS.map(([k]) => k);
const OPEN_FIRST = ["open", "closed", "proposed", "disputed", "resolved", "cancelled"];

function href(status: string, cat?: string) {
  const q = new URLSearchParams();
  if (status !== "open") q.set("status", status);
  if (cat) q.set("cat", cat);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

export default async function Home({ searchParams }: { searchParams: Promise<{ status?: string; cat?: string }> }) {
  await ensureFinalized();
  const sp = await searchParams;
  const status = sp.status && STATUSES.includes(sp.status) ? sp.status : "open"; // unknown values fall back to Open
  const cat = sp.cat && (CATEGORIES as readonly string[]).includes(sp.cat) ? sp.cat : "";
  const [user, all] = await Promise.all([getCurrentUser(), prisma.market.findMany({ orderBy: { closesAt: "asc" } })]);
  let markets = await bundles(prisma, all);
  if (status === "closed") markets = markets.filter((b) => ["closed", "proposed", "disputed"].includes(b.state)); // "Awaiting result" also covers proposed and disputed
  else if (["open", "resolved", "cancelled"].includes(status)) markets = markets.filter((b) => b.state === status);
  if (cat) markets = markets.filter((b) => b.m.category === cat);
  if (status === "open") markets.sort((a, b) => Number(b.m.featured) - Number(a.m.featured) || b.volume - a.volume); // featured first, then busiest
  else if (status === "all") markets.sort((a, b) => OPEN_FIRST.indexOf(a.state) - OPEN_FIRST.indexOf(b.state) || (a.state === "open" ? a.m.closesAt.getTime() - b.m.closesAt.getTime() : (b.m.resolvedAt ?? b.m.closesAt).getTime() - (a.m.resolvedAt ?? a.m.closesAt).getTime())); // live markets first, then newest finished
  else if (status === "resolved" || status === "cancelled") markets.sort((a, b) => (b.m.resolvedAt?.getTime() ?? 0) - (a.m.resolvedAt?.getTime() ?? 0));

  return (
    <>
      {!user && (
        <section className="mb-6 rounded-2xl border bg-card p-6 sm:p-8">
          <h1 className="text-2xl sm:text-3xl">Bet on what happens at Mass Academy.</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Sign up and get <strong>1,000 {CURRENCY}</strong> of play money. Buy shares in the outcomes you believe in — each winning
            share pays out Ⓜ1 when the market resolves. Prices move as people trade, so they show what the whole school thinks will happen.
          </p>
          <div className="mt-5 flex gap-2">
            <Link href="/register" className={buttonVariants({ className: "h-10 px-5 text-base" })}>Get started</Link>
            <Link href="/how-it-works" className={buttonVariants({ variant: "outline", className: "h-10 px-5 text-base" })}>How it works</Link>
          </div>
        </section>
      )}

      {user && <h1 className="mb-3">Markets</h1>}
      <div className="mb-4 space-y-3">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <nav aria-label="Market status" className="flex w-max gap-1 rounded-lg bg-secondary p-1">
            {TABS.map(([key, label]) => (
              <Link
                key={key} href={href(key, cat)} aria-current={status === key ? "page" : undefined}
                className={cn("flex h-9 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50", status === key && "bg-card text-foreground shadow-sm")}
              >{label}</Link>
            ))}
          </nav>
        </div>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <nav aria-label="Topic" className="flex gap-1.5 sm:w-auto sm:flex-wrap max-sm:w-max">
            {["", ...CATEGORIES].map((c) => (
              <Link
                key={c || "all"} href={href(status, c)} aria-current={cat === c ? "page" : undefined}
                className={cn("flex h-9 items-center rounded-full border px-3.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50", cat === c && "border-primary bg-primary text-primary-foreground hover:bg-primary")}
              >{c || "All topics"}</Link>
            ))}
          </nav>
        </div>
      </div>

      {markets.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{markets.map((b) => <MarketCard key={b.m.id} b={b} />)}</div>
      ) : (
        <div className="rounded-xl border bg-card px-4 py-12 text-center">
          <p className="font-medium">{cat || status !== "open" ? "No markets match these filters." : "No open markets right now."}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {cat || status !== "open" ? "Try another topic or status." : "Check back soon, or propose one yourself."}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {(cat || status !== "open") && <Link href="/" className={buttonVariants({ variant: "outline" })}>Clear filters</Link>}
            {user && !user.isAdmin && <Link href="/propose" className={buttonVariants()}>Propose a market</Link>}
            {user?.isAdmin && <Link href="/admin" className={buttonVariants()}>Create a market</Link>}
          </div>
        </div>
      )}

      <section className="mt-10">
        <h2 className="mb-3">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Pick a market", "Each market is a question about a Mass Academy event with two or more possible outcomes."],
            ["Buy shares", "A share at 30% costs about Ⓜ0.30. If that outcome happens, every share pays Ⓜ1. Buying pushes the price up."],
            ["Sell any time", "Changed your mind? Sell shares back before the market closes at the current price."],
            ["Climb the board", "After a result is announced, an admin proposes it and everyone has 24 hours to dispute it. Then winners are paid."],
          ].map(([title, body], i) => (
            <div key={title} className="rounded-xl border bg-card p-4">
              <span className="mb-2 grid size-7 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span>
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {body} {i === 3 && <Link href="/how-it-works" className="text-primary hover:underline">Read the full guide</Link>}
              </p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
