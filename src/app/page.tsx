import Link from "next/link";
import { CATEGORIES, CURRENCY } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ensureFinalized } from "@/server/finalize";
import { bundles } from "@/server/services/markets";
import { buttonVariants } from "@/components/ui/button";
import { MarketCard } from "@/components/market-card";

const TABS = [["open", "Open"], ["closed", "Awaiting result"], ["resolved", "Resolved"], ["all", "All"]] as const;

function href(status: string, cat?: string) {
  const q = new URLSearchParams();
  if (status !== "open") q.set("status", status);
  if (cat) q.set("cat", cat);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

export default async function Home({ searchParams }: { searchParams: Promise<{ status?: string; cat?: string }> }) {
  await ensureFinalized();
  const { status = "open", cat = "" } = await searchParams;
  const [user, all] = await Promise.all([getCurrentUser(), prisma.market.findMany({ orderBy: { closesAt: "asc" } })]);
  let markets = await bundles(prisma, all);
  if (status === "closed") markets = markets.filter((b) => ["closed", "proposed", "disputed"].includes(b.state)); // "Awaiting result" also covers proposed and disputed
  else if (["open", "resolved", "cancelled"].includes(status)) markets = markets.filter((b) => b.state === status);
  if (cat) markets = markets.filter((b) => b.m.category === cat);
  if (status === "open") markets.sort((a, b) => Number(b.m.featured) - Number(a.m.featured) || b.volume - a.volume); // featured first, then busiest
  else if (status === "resolved" || status === "cancelled") markets.sort((a, b) => (b.m.resolvedAt?.getTime() ?? 0) - (a.m.resolvedAt?.getTime() ?? 0));

  return (
    <>
      {!user && (
        <section className="mb-6 rounded-2xl border bg-card p-6 sm:p-8">
          <h1 className="text-3xl">Bet on what happens at Mass Academy.</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Sign up and get <strong>1,000 {CURRENCY}</strong> of play money. Buy shares in the outcomes you believe in — each winning
            share pays out Ⓜ1 when the market resolves. Prices move as people trade, so they show what the whole school thinks will happen.
          </p>
          <div className="mt-5 flex gap-2">
            <Link href="/register" className={buttonVariants()}>Get started</Link>
            <Link href="/how-it-works" className={buttonVariants({ variant: "outline" })}>How it works</Link>
          </div>
        </section>
      )}

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-1 rounded-lg bg-secondary p-1 sm:w-fit">
          {TABS.map(([key, label]) => (
            <Link key={key} href={href(key, cat)} className={cn("rounded-md px-3 py-1 text-sm font-medium text-muted-foreground", status === key && "bg-card text-foreground shadow-sm")}>{label}</Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {["", ...CATEGORIES].map((c) => (
            <Link key={c || "all"} href={href(status, c)} className={cn("rounded-full border px-3 py-1 text-sm text-muted-foreground hover:bg-secondary", cat === c && "border-primary bg-primary text-primary-foreground hover:bg-primary")}>
              {c || "All topics"}
            </Link>
          ))}
        </div>
      </div>

      {markets.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{markets.map((b) => <MarketCard key={b.m.id} b={b} />)}</div>
      ) : (
        <div className="rounded-xl border bg-card py-12 text-center">
          <p className="text-muted-foreground">No markets here yet.</p>
          {user?.isAdmin && <Link href="/admin" className={buttonVariants({ className: "mt-4" })}>Create a market</Link>}
        </div>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-lg">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Pick a market", "Each market is a question about a Mass Academy event with two or more possible outcomes."],
            ["Buy shares", "A share at 30% costs about Ⓜ0.30. If that outcome happens, every share pays Ⓜ1. Buying pushes the price up."],
            ["Sell any time", "Changed your mind? Sell shares back before the market closes at the current price."],
            ["Climb the board", "After a result is announced, an admin proposes it and everyone has 24 hours to dispute it. Then winners are paid."],
          ].map(([title, body], i) => (
            <div key={title} className="rounded-xl border bg-card p-4">
              <span className="mb-2 grid size-7 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span>
              <h4 className="font-semibold">{title}</h4>
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
