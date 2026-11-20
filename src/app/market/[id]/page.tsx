import Link from "next/link";
import { notFound } from "next/navigation";
import { ago, money, pct, until, when } from "@/lib/format";
import { prisma } from "@/lib/db";
import * as lmsr from "@/lib/lmsr";
import { getCurrentUser } from "@/lib/session";
import { ensureFinalized } from "@/server/finalize";
import { bundle } from "@/server/services/markets";
import { tradeBlockReason } from "@/server/services/trading";
import { disputeResult, postComment } from "@/server/actions/market";
import { ActionForm } from "@/components/action-form";
import { DeleteMarketButton } from "@/components/delete-market-button";
import { MarketAdminLinks, MarketAdminPanel } from "@/components/market-admin-panel";
import { PriceChart } from "@/components/price-chart";
import { StateBadge, Status, Tag } from "@/components/state-badge";
import { TradeForm } from "@/components/trade-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const m = await prisma.market.findUnique({ where: { id: Number((await params).id) || 0 }, select: { question: true } });
  return { title: `${m?.question ?? "Market"} · MAMS Prediction Market` };
}

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureFinalized();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const m = await prisma.market.findUnique({ where: { id } });
  if (!m) notFound();
  const [user, b] = await Promise.all([getCurrentUser(), bundle(prisma, m)]);

  const proposed = m.proposedOutcomeId !== null && m.status === "open";
  const [history, trades, clarifications, comments, disputes, proposer] = await Promise.all([
    prisma.priceHistory.findMany({ where: { marketId: id }, orderBy: { id: "asc" } }),
    prisma.trade.findMany({ where: { marketId: id }, orderBy: { id: "desc" }, take: 25, include: { user: true, outcome: true } }),
    prisma.clarification.findMany({ where: { marketId: id }, orderBy: { id: "asc" } }),
    prisma.comment.findMany({ where: { marketId: id }, orderBy: { id: "desc" }, include: { user: true } }),
    proposed ? prisma.dispute.findMany({ where: { marketId: id, handledAt: null }, orderBy: { id: "asc" }, include: { user: true } }) : [],
    proposed && m.proposedById ? prisma.user.findUnique({ where: { id: m.proposedById } }) : null,
  ]);
  const name = (u: { displayUsername: string | null; username: string | null }) => u.displayUsername ?? u.username ?? "?";

  let canDispute = false;
  if (proposed && user) {
    const traded = (await prisma.trade.count({ where: { userId: user.id, marketId: id } })) > 0;
    canDispute = traded && !disputes.some((d) => d.userId === user.id);
  }

  const q = b.outcomes.map((o) => o.shares);
  const myPositions = user
    ? (await prisma.position.findMany({ where: { userId: user.id, outcome: { marketId: id } }, include: { outcome: true }, orderBy: { outcome: { position: "asc" } } })).map((p) => {
        const i = b.outcomes.findIndex((o) => o.id === p.outcomeId);
        // Resolved markets pay 1 per winning share; otherwise show what the shares would sell for now.
        const value = m.status === "resolved" ? p.shares * b.outcomes[i].price : m.status === "cancelled" ? 0 : lmsr.sellValue(q, m.b, i, p.shares);
        return { label: p.outcome.label, outcomeId: p.outcomeId, shares: p.shares, cost: p.cost, value };
      })
    : [];
  const blockReason = user ? await tradeBlockReason(prisma, user.id, id) : null;
  let blocked: { id: string; username: string }[] = [];
  let allUsers: string[] = [];
  if (user?.isAdmin) {
    const [bl, us] = await Promise.all([
      prisma.marketBlock.findMany({ where: { marketId: id }, include: { user: true } }),
      prisma.user.findMany({ select: { displayUsername: true, username: true }, orderBy: { username: "asc" } }),
    ]);
    blocked = bl.map((x) => ({ id: x.userId, username: name(x.user) })).sort((a, c) => a.username.localeCompare(c.username));
    allUsers = us.map(name);
  }

  const closedLike = b.state === "resolved" || b.state === "cancelled";
  const labelOf = (oid: number | null) => b.outcomes.find((o) => o.id === oid)?.label;
  const winner = labelOf(m.resolvedOutcomeId);
  const historyData = history.map((h) => ({ t: h.createdAt.getTime(), p: h.prices }));

  return (
    <>
      <Link href="/" className="mb-3 inline-block text-sm text-muted-foreground hover:text-foreground">← All markets</Link>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="space-y-4">
          <Card className="gap-3 p-5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Tag>{m.category}</Tag>
              {b.state === "open" ? <span className="text-muted-foreground">Closes {when(m.closesAt)} ({until(m.closesAt)})</span>
                : b.state === "resolved" ? <Status tone="resolved">Resolved {when(m.resolvedAt!)}</Status>
                : b.state === "cancelled" ? <Status tone="cancelled">Cancelled — all bets refunded</Status>
                : <StateBadge state={b.state} short={false} />}
            </div>
            <h1 className="text-2xl">{m.question}</h1>
            {b.binary && !closedLike && (
              <div><span className="text-4xl font-bold tracking-tight">{pct(b.outcomes[0].price)}</span> <span className="text-muted-foreground">chance of Yes</span></div>
            )}

            {(m.description || m.rulesSource || m.rulesOtherwise || clarifications.length > 0) && (
              <div className="space-y-1 rounded-lg bg-secondary p-4 text-sm" id="rules">
                <h2>Rules</h2>
                {m.description && <><h4 className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{b.binary ? "Resolves YES if" : "How the winner is decided"}</h4><p>{m.description}</p></>}
                {m.rulesSource && <><h4 className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Source</h4><p>{m.rulesSource}</p></>}
                {m.rulesOtherwise && <><h4 className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Otherwise</h4><p>{m.rulesOtherwise}</p></>}
                <h4 className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Betting closes</h4><p>{when(m.closesAt)}</p>
                {clarifications.map((c) => (
                  <p key={c.id} className="mt-2 rounded-md border-l-4 border-gold bg-card p-2"><b>Clarification · {when(c.createdAt)}</b><br />{c.body}</p>
                ))}
                <p className="pt-1 text-muted-foreground">Bet on what the rules say, not just the title. <Link href="/how-it-works" className="text-primary hover:underline">How markets work</Link></p>
              </div>
            )}

            <PriceChart history={historyData} labels={b.outcomes.map((o) => o.label)} endTime={closedLike ? m.resolvedAt?.getTime() ?? null : null} lines={b.binary && !closedLike ? 1 : b.outcomes.length} />
            {!(b.binary && !closedLike) && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {b.outcomes.map((o, i) => (
                  <span key={o.id} className={b.state === "resolved" && o.id === m.resolvedOutcomeId ? "font-bold" : ""}>
                    <i className="mr-1.5 inline-block size-2.5 rounded-full" style={{ background: `var(--c${i})` }} />{o.label} <strong>{pct(o.price)}</strong>
                  </span>
                ))}
              </div>
            )}
            <div className="text-sm text-muted-foreground">Ⓜ{money(b.volume)} traded · {b.traders} trader{b.traders === 1 ? "" : "s"}</div>
          </Card>

          {myPositions.length > 0 && (
            <Card className="gap-2 p-5">
              <h2>Your position</h2>
              <Table>
                <TableHeader><TableRow><TableHead>Outcome</TableHead><TableHead className="text-right">Shares</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right" title="What these shares would sell for right now">Sell value</TableHead><TableHead className="text-right">Pays if right</TableHead></TableRow></TableHeader>
                <TableBody>
                  {myPositions.map((p) => (
                    <TableRow key={p.outcomeId}>
                      <TableCell>{p.label}</TableCell><TableCell className="text-right">{money(p.shares)}</TableCell>
                      <TableCell className="text-right">Ⓜ{money(p.cost)}</TableCell><TableCell className="text-right">Ⓜ{money(p.value)}</TableCell>
                      <TableCell className="text-right">Ⓜ{money(p.shares)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}

          <Card className="gap-2 p-5">
            <h2>Recent trades</h2>
            {trades.length ? (
              <Table>
                <TableBody>
                  {trades.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="whitespace-normal">
                        <strong>{name(t.user)}</strong>{" "}
                        {t.user.isAdmin && <span title="Admins can see who is trading and resolve markets"><Tag>admin</Tag></span>}{" "}
                        {t.userId === m.createdById && <span title="Wrote this market"><Tag>creator</Tag></span>}{" "}
                        {t.shares > 0 ? <span className="font-semibold text-up">bought</span> : <span className="font-semibold text-down">sold</span>}{" "}
                        {money(Math.abs(t.shares))} × {t.outcome.label}
                      </TableCell>
                      <TableCell className="text-right">Ⓜ{money(Math.abs(t.amount))}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{ago(t.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p className="text-muted-foreground">No trades yet. Be the first!</p>}
          </Card>

          <Card className="gap-3 p-5" id="discussion">
            <h2>Discussion</h2>
            {user && (
              <ActionForm action={postComment} className="flex items-start gap-2" resetOnSuccess>
                <input type="hidden" name="market_id" value={id} />
                <Textarea name="body" maxLength={500} rows={2} placeholder="Share your reasoning…" required />
                <Button size="sm">Post</Button>
              </ActionForm>
            )}
            {comments.length ? comments.map((c) => (
              <div key={c.id} className="border-t pt-2"><strong>{name(c.user)}</strong> <span className="text-sm text-muted-foreground">{ago(c.createdAt)}</span><p className="mt-0.5 whitespace-pre-wrap">{c.body}</p></div>
            )) : <p className="text-muted-foreground">No comments yet.</p>}
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20">
          {b.state === "open" && (
            <Card className="gap-3 p-4" id="trade">
              <h2>Place a bet</h2>
              {user && blockReason ? <p className="text-muted-foreground">{blockReason}</p>
                : user ? <TradeForm marketId={id} binary={b.binary} balance={user.balance} outcomes={b.outcomes.map((o) => ({ id: o.id, label: o.label, price: o.price, held: myPositions.find((p) => p.outcomeId === o.id)?.shares ?? 0 }))} />
                : <p><Link href={`/login?next=/market/${id}`} className="text-primary hover:underline">Log in</Link> or <Link href="/register" className="text-primary hover:underline">sign up</Link> to bet.</p>}
            </Card>
          )}
          {b.state === "resolved" && (
            <Card className="gap-2 p-4">
              <h2>Result</h2>
              <p className="text-xl font-bold text-up">{winner}</p>
              <p className="text-sm text-muted-foreground">
                Every “{winner}” share paid Ⓜ1. {m.proposedAt && `Proposed ${when(m.proposedAt)} · finalized ${when(m.resolvedAt!)}.`}
              </p>
            </Card>
          )}
          {b.state === "closed" && (
            <Card className="gap-2 p-4"><h2>Betting closed</h2><p className="text-muted-foreground">An admin will propose a result once it&apos;s known. You&apos;ll then have 24 hours to dispute it before winners are paid.</p></Card>
          )}
          {(b.state === "proposed" || b.state === "disputed") && (
            <Card className="gap-2 p-4" id="proposed-result">
              <h2>Proposed result</h2>
              <p className="text-xl font-bold">{labelOf(m.proposedOutcomeId)}</p>
              <p className="text-sm text-muted-foreground">
                Proposed by {proposer ? name(proposer) : "an admin"} {ago(m.proposedAt!)}.{" "}
                {b.state === "disputed" ? <>It&apos;s <b>paused</b> because someone disputed it. An admin will review.</>
                  : <>Winners are paid {when(m.finalizesAt!)} ({until(m.finalizesAt!)}) unless someone disputes it.</>}
              </p>
              {disputes.map((d) => <div key={d.id} className="rounded-md border-l-4 border-gold bg-secondary p-2 text-sm"><b>{name(d.user)}</b> disputed: {d.reason}</div>)}
              {canDispute ? (
                <ActionForm action={disputeResult} className="space-y-2" resetOnSuccess>
                  <input type="hidden" name="market_id" value={id} />
                  <label className="text-sm font-medium">Think this result is wrong? Tell the admins why.
                    <Textarea name="reason" rows={2} minLength={10} maxLength={500} required className="mt-1.5 font-normal" placeholder="e.g. The official results page lists a different winner." />
                  </label>
                  <Button variant="outline" className="w-full">Dispute this result</Button>
                </ActionForm>
              ) : user && !disputes.some((d) => d.userId === user.id) ? (
                <p className="text-sm text-muted-foreground">Only people who traded in this market can dispute its result.</p>
              ) : null}
            </Card>
          )}

          {user?.isAdmin && m.status === "open" && <MarketAdminPanel b={b} blocked={blocked} allUsers={allUsers} />}
          {user?.isAdmin && (
            <>
              <MarketAdminLinks marketId={id} />
              <DeleteMarketButton marketId={id} open={m.status === "open"} block />
            </>
          )}
        </aside>
      </div>
    </>
  );
}
