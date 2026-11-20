import Link from "next/link";
import { ago, money, pct } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { ensureFinalized } from "@/server/finalize";
import { getPortfolio } from "@/server/services/portfolio";
import { ChangePasswordForm } from "@/components/change-password-form";
import { Status } from "@/components/state-badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Portfolio · MAMS Prediction Market" };

export default async function Portfolio() {
  await ensureFinalized();
  const user = await requireUser("/portfolio");
  const p = await getPortfolio(user.id);
  const kpi = (label: string, value: number) => (
    <Card className="gap-1 p-4"><span className="text-sm text-muted-foreground">{label}</span><strong className="text-2xl">Ⓜ{money(value)}</strong></Card>
  );
  return (
    <div className="space-y-4">
      <h1>{user.username}&apos;s portfolio</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        {kpi("Net worth", p.worth)}
        {kpi("Cash", p.balance)}
        {kpi("In open bets (if sold now)", p.invested)}
      </div>

      <Card className="gap-2 p-5">
        <h2>Open positions</h2>
        {p.active.length ? (
          <>
            <Table>
              <TableHeader><TableRow><TableHead>Market</TableHead><TableHead>Outcome</TableHead><TableHead className="text-right">Shares</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right" title="What these shares would sell for right now">Sell value</TableHead><TableHead className="text-right">Gain</TableHead></TableRow></TableHeader>
              <TableBody>
                {p.active.map((i, k) => {
                  const gain = i.value - i.cost;
                  return (
                    <TableRow key={k}>
                      <TableCell className="whitespace-normal">
                        <Link href={`/market/${i.marketId}`} className="text-primary hover:underline">{i.question}</Link>{" "}
                        {i.bundle.state === "closed" ? <Status tone="closed">awaiting result</Status> : i.bundle.state === "proposed" ? <Status tone="pending">result proposed</Status> : i.bundle.state === "disputed" ? <Status tone="rejected">disputed</Status> : null}
                      </TableCell>
                      <TableCell>{i.label} <span className="text-sm text-muted-foreground">{pct(i.price)}</span></TableCell>
                      <TableCell className="text-right">{money(i.shares)}</TableCell>
                      <TableCell className="text-right">Ⓜ{money(i.cost)}</TableCell>
                      <TableCell className="text-right">Ⓜ{money(i.value)}</TableCell>
                      <TableCell className={`text-right ${gain >= 0 ? "text-up" : "text-down"}`}>{gain >= 0 ? "+" : ""}{money(gain)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {Math.abs(p.rowsTotal - p.invested) > 0.01 && (
              <p className="text-sm text-muted-foreground">Rows add up to Ⓜ{money(p.rowsTotal)}, but selling several outcomes of one market together is worth Ⓜ{money(p.invested)} in total.</p>
            )}
          </>
        ) : <p className="text-muted-foreground">No open bets. <Link href="/" className="text-primary hover:underline">Browse markets →</Link></p>}
      </Card>

      {p.settled.length > 0 && (
        <Card className="gap-2 p-5">
          <h2>Settled</h2>
          <Table>
            <TableHeader><TableRow><TableHead>Market</TableHead><TableHead>Your pick</TableHead><TableHead className="text-right">Shares</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Result</TableHead></TableRow></TableHeader>
            <TableBody>
              {p.settled.map((i, k) => (
                <TableRow key={k}>
                  <TableCell className="whitespace-normal"><Link href={`/market/${i.marketId}`} className="text-primary hover:underline">{i.question}</Link></TableCell>
                  <TableCell>{i.label}</TableCell>
                  <TableCell className="text-right">{money(i.shares)}</TableCell>
                  <TableCell className="text-right">Ⓜ{money(i.cost)}</TableCell>
                  <TableCell className="text-right">
                    {i.bundle.state === "cancelled" ? <span className="text-muted-foreground">Refunded</span>
                      : i.price > 0 ? <span className="text-up">Won Ⓜ{money(i.value)}</span> : <span className="text-down">Lost</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Card className="gap-2 p-5">
        <h2>Trade history</h2>
        {p.trades.length ? (
          <Table>
            <TableBody>
              {p.trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-normal">
                    {t.shares > 0 ? <span className="font-semibold text-up">Bought</span> : <span className="font-semibold text-down">Sold</span>}{" "}
                    {money(Math.abs(t.shares))} × {t.outcome.label} — <Link href={`/market/${t.marketId}`} className="text-primary hover:underline">{t.market.question}</Link>
                  </TableCell>
                  <TableCell className="text-right">{t.amount > 0 ? "−" : "+"}Ⓜ{money(Math.abs(t.amount))}</TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">{ago(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className="text-muted-foreground">No trades yet.</p>}
      </Card>

      <ChangePasswordForm />
    </div>
  );
}
