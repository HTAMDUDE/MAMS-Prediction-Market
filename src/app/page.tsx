import Link from "next/link";
import { CURRENCY } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { ensureFinalized } from "@/server/finalize";
import { bundles } from "@/server/services/markets";
import { buttonVariants } from "@/components/ui/button";
import { toCard } from "@/components/market-card";
import { MarketBrowser } from "@/components/market-browser";

export default async function Home({ searchParams }: { searchParams: Promise<{ status?: string; cat?: string }> }) {
  await ensureFinalized();
  const sp = await searchParams;
  const [user, all] = await Promise.all([getCurrentUser(), prisma.market.findMany({ orderBy: { closesAt: "asc" } })]);
  const cards = (await bundles(prisma, all)).map(toCard); // every market, once: the tabs and topic filters switch on the client

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
      <MarketBrowser cards={cards} initialStatus={sp.status} initialCat={sp.cat} role={!user ? "guest" : user.isAdmin ? "admin" : "user"} />

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
