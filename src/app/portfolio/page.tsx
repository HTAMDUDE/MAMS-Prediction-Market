import Link from "next/link";
import { ago, money, pct, signedMoney } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { ensureFinalized } from "@/server/finalize";
import { getPortfolio, type PortfolioItem } from "@/server/services/portfolio";
import { ChangePasswordForm } from "@/components/change-password-form";
import { MobileRows } from "@/components/mobile-rows";
import { Status } from "@/components/state-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Portfolio · MAMS Prediction Market" };

const link = "text-primary hover:underline";

function StateChip({ state }: { state: PortfolioItem["bundle"]["state"] }) {
  if (state === "closed") return <Status tone="closed">awaiting result</Status>;
  if (state === "proposed") return <Status tone="pending">result proposed</Status>;
  if (state === "disputed") return <Status tone="rejected">disputed</Status>;
  return null;
}

function Outcome({ i }: { i: PortfolioItem }) {
  if (i.bundle.state === "cancelled") {
    return i.refund > 0 ? <span className="text-muted-foreground">Refunded Ⓜ{money(i.refund)}</span> : <span className="text-muted-foreground">Cancelled</span>;
  }
  return i.price > 0 ? <span className="text-up">Won Ⓜ{money(i.value)}</span> : <span className="text-down">Lost</span>;
}

export default async function Portfolio() {
  await ensureFinalized();
  const user = await requireUser("/portfolio");
  const p = await getPortfolio(user.id);
  const kpi = (label: string, value: number) => (
    <Card className="gap-0.5 p-3 sm:gap-1 sm:p-4">
      <span className="text-xs text-muted-foreground sm:text-sm">{label}</span>
      <strong className="text-base tabular-nums sm:text-2xl">Ⓜ{money(value)}</strong>
    </Card>
  );
  const gainOf = (i: PortfolioItem) => i.value - i.cost;
  const gainClass = (g: number) => (g >= 0 ? "text-up" : "text-down");
  return (
    <div className="space-y-4">
      <h1>{user.username}&apos;s portfolio</h1>
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {kpi("Net worth", p.worth)}
        {kpi("Cash", p.balance)}
        {kpi("In open bets", p.invested)}
      </div>

      <Card className="gap-2 p-4 sm:p-5">
        <h2>Open positions</h2>
        {p.active.length ? (
          <>
            <MobileRows rows={p.active.map((i, k) => ({
              key: k,
              title: <><Link href={`/market/${i.marketId}`} className={link}>{i.question}</Link> <StateChip state={i.bundle.state} /></>,
              sub: <>{i.label} · {pct(i.price)}</>,
              stats: [["Shares", money(i.shares)], ["Spent", `Ⓜ${money(i.cost)}`], ["Value now", `Ⓜ${money(i.value)}`], ["Gain", <span key="g" className={gainClass(gainOf(i))}>{signedMoney(gainOf(i))}</span>]],
            }))} />
            <Table className="hidden sm:table">
              <TableHeader><TableRow><TableHead>Market</TableHead><TableHead>Outcome</TableHead><TableHead className="text-right">Shares</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right" title="What these shares would sell for right now">Value now</TableHead><TableHead className="text-right">Gain</TableHead></TableRow></TableHeader>
              <TableBody>
                {p.active.map((i, k) => (
                  <TableRow key={k}>
                    <TableCell className="whitespace-normal">
                      <Link href={`/market/${i.marketId}`} className={link}>{i.question}</Link> <StateChip state={i.bundle.state} />
                    </TableCell>
                    <TableCell>{i.label} <span className="text-sm text-muted-foreground">{pct(i.price)}</span></TableCell>
                    <TableCell className="text-right">{money(i.shares)}</TableCell>
                    <TableCell className="text-right">Ⓜ{money(i.cost)}</TableCell>
                    <TableCell className="text-right">Ⓜ{money(i.value)}</TableCell>
                    <TableCell className={`text-right ${gainClass(gainOf(i))}`}>{signedMoney(gainOf(i))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {Math.abs(p.rowsTotal - p.invested) > 0.01 && (
              <p className="text-sm text-muted-foreground">Rows add up to Ⓜ{money(p.rowsTotal)}, but selling several outcomes of one market together is worth Ⓜ{money(p.invested)} in total.</p>
            )}
          </>
        ) : (
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="text-muted-foreground">You have no open bets yet.</p>
            <Link href="/" className={buttonVariants({ variant: "outline" })}>Browse markets</Link>
          </div>
        )}
      </Card>

      {p.settled.length > 0 && (
        <Card className="gap-2 p-4 sm:p-5">
          <h2>Settled</h2>
          <MobileRows rows={p.settled.map((i, k) => ({
            key: k,
            title: <Link href={`/market/${i.marketId}`} className={link}>{i.question}</Link>,
            sub: i.label,
            stats: [["Shares", money(i.shares)], ["Spent", `Ⓜ${money(i.cost)}`], ["Result", <Outcome key="r" i={i} />]],
          }))} />
          <Table className="hidden sm:table">
            <TableHeader><TableRow><TableHead>Market</TableHead><TableHead>Your pick</TableHead><TableHead className="text-right">Shares</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Result</TableHead></TableRow></TableHeader>
            <TableBody>
              {p.settled.map((i, k) => (
                <TableRow key={k}>
                  <TableCell className="whitespace-normal"><Link href={`/market/${i.marketId}`} className={link}>{i.question}</Link></TableCell>
                  <TableCell>{i.label}</TableCell>
                  <TableCell className="text-right">{money(i.shares)}</TableCell>
                  <TableCell className="text-right">Ⓜ{money(i.cost)}</TableCell>
                  <TableCell className="text-right"><Outcome i={i} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Card className="gap-2 p-4 sm:p-5">
        <h2>Trade history</h2>
        {p.trades.length ? (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Trade</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="hidden text-right sm:table-cell">When</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {p.trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-normal">
                    {t.shares > 0 ? <span className="font-semibold text-up">Bought</span> : <span className="font-semibold text-down">Sold</span>}{" "}
                    {money(Math.abs(t.shares))} × {t.outcome.label} · <Link href={`/market/${t.marketId}`} className={link}>{t.market.question}</Link>
                    <span className="block text-xs text-muted-foreground sm:hidden">{ago(t.createdAt)}</span>
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${t.amount > 0 ? "" : "text-up"}`}>{signedMoney(-t.amount)}</TableCell>
                  <TableCell className="hidden text-right text-sm text-muted-foreground sm:table-cell">{ago(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className="text-muted-foreground">No trades yet. Your bets will show up here.</p>}
        {p.trades.length >= 30 && <p className="text-sm text-muted-foreground">Showing your 30 most recent trades.</p>}
      </Card>

      <ChangePasswordForm />
    </div>
  );
}
