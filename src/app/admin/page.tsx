import Link from "next/link";
import { ago, money, until, when } from "@/lib/format";
import { prisma } from "@/lib/db";
import { getAdminOrNull, toActor } from "@/lib/session";
import { schoolLocalInDays } from "@/lib/time";
import { ensureFinalized } from "@/server/finalize";
import { listUsers } from "@/server/services/accounts";
import { bundles, type Bundle } from "@/server/services/markets";
import { ANNOUNCEMENT_MAX, getAnnouncement } from "@/server/services/settings";
import { announcementAction, createMarketAction, proposeResultAction } from "@/server/actions/admin";
import { ActionForm, ConfirmButton } from "@/components/action-form";
import { AdminUsersTable } from "@/components/admin-users-table";
import { DeleteMarketButton } from "@/components/delete-market-button";
import { Forbidden } from "@/components/forbidden";
import { MarketForm } from "@/components/market-form";
import { Status } from "@/components/state-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

export const metadata = { title: "Admin · MAMS Prediction Market" };

function MarketRow({ b, children }: { b: Bundle; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <Link href={`/market/${b.m.id}`} className="text-primary hover:underline">{b.m.question}</Link>
        <div className="text-sm text-muted-foreground">
          {b.state === "closed" ? <Status tone="closed">needs a result</Status>
            : b.state === "proposed" ? <><Status tone="pending">result proposed</Status> {b.outcomes.find((o) => o.id === b.m.proposedOutcomeId)?.label} · finalizes {until(b.m.finalizesAt!)}</>
            : b.state === "disputed" ? <Status tone="rejected">disputed — needs review</Status>
            : b.state === "open" ? until(b.m.closesAt)
            : <span className="capitalize">{b.state}</span>}
          {" "}· Ⓜ{money(b.volume)} traded
        </div>
      </div>
      <div className="flex items-center gap-2">
        {children}
        <Link href={`/admin/markets/${b.m.id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>Edit</Link>
        <DeleteMarketButton marketId={b.m.id} open={b.m.status === "open"} small />
      </div>
    </div>
  );
}

export default async function Admin({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string; upage?: string }> }) {
  await ensureFinalized();
  const me = await getAdminOrNull();
  if (!me) return <Forbidden />;
  const sp = await searchParams;
  const [openMarkets, settledMarkets, userData, proposals, announcement] = await Promise.all([
    prisma.market.findMany({ where: { status: "open" }, orderBy: { closesAt: "asc" } }),
    prisma.market.findMany({ where: { status: { not: "open" } }, orderBy: { resolvedAt: "desc" } }),
    listUsers(toActor(me), { q: sp.q, filter: sp.filter, page: Number(sp.upage) || 1 }),
    prisma.proposal.findMany({ where: { status: "pending" }, orderBy: { id: "asc" }, include: { user: true } }),
    getAnnouncement(),
  ]);
  const [markets, settled] = await Promise.all([bundles(prisma, openMarkets), bundles(prisma, settledMarkets)]);
  const defaultClose = schoolLocalInDays(7);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>Admin</h1>
        <Link href="/admin/activity" className={buttonVariants({ variant: "outline" })}>Activity log</Link>
      </div>

      <Card className="gap-2 p-5" id="announcement">
        <h2>Site announcement</h2>
        <p className="text-sm text-muted-foreground">Shown in a banner at the top of every page until you clear it (e.g. “Betting on the snow-day market closes at noon”).</p>
        <ActionForm action={announcementAction} className="space-y-2">
          <Textarea name="text" rows={2} maxLength={ANNOUNCEMENT_MAX} defaultValue={announcement ?? ""} placeholder="No announcement right now." />
          <div className="flex gap-2">
            <Button size="sm">Publish</Button>
            {announcement && <Button size="sm" variant="outline" name="clear" value="1">Clear</Button>}
          </div>
        </ActionForm>
      </Card>

      <Card className="gap-2 p-5" id="proposals">
        <h2>Proposals waiting for approval {proposals.length > 0 && <span className="ml-1 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{proposals.length}</span>}</h2>
        {proposals.length ? proposals.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-2 border-t py-2 first:border-t-0">
            <div>
              <strong>{p.question}</strong>
              <div className="text-sm text-muted-foreground">{p.category} · {p.outcomes.join(" · ")} · closes {when(p.closesAt)} · by <b>{p.user.displayUsername ?? p.user.username}</b> {ago(p.createdAt)}</div>
            </div>
            <Link href={`/admin/proposals/${p.id}`} className={buttonVariants({ size: "sm" })}>Review</Link>
          </div>
        )) : <p className="text-muted-foreground">No proposals right now. Users can suggest markets from the Propose page.</p>}
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2">Create a market</h2>
          <MarketForm action={createMarketAction} initial={{ closes_at: defaultClose }} showLiquidity submitLabel="Create market" />
        </div>
        <Card className="gap-1 p-5">
          <h2 className="mb-1">Unresolved markets</h2>
          {markets.length ? markets.map((b) => (
            <MarketRow key={b.m.id} b={b}>
              {b.state === "closed" ? (
                <ActionForm action={proposeResultAction} className="flex items-center gap-1.5">
                  <input type="hidden" name="market_id" value={b.m.id} />
                  <NativeSelect name="outcome_id" required defaultValue="" className="h-7 w-32">
                    <option value="">Winner…</option>
                    {b.outcomes.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </NativeSelect>
                  <ConfirmButton size="sm" title="Propose this result?" message="Traders get 24 hours to dispute it before winners are paid." confirmLabel="Propose">Propose</ConfirmButton>
                </ActionForm>
              ) : b.state === "proposed" || b.state === "disputed" ? (
                <Link href={`/market/${b.m.id}#admin`} className={buttonVariants({ size: "sm" })}>{b.state === "disputed" ? "Review" : "Open"}</Link>
              ) : null}
            </MarketRow>
          )) : <p className="text-muted-foreground">Nothing to resolve.</p>}

          {settled.length > 0 && (
            <>
              <h2 className="mt-4 mb-1">Resolved &amp; cancelled</h2>
              {settled.map((b) => <MarketRow key={b.m.id} b={b} />)}
            </>
          )}
        </Card>
      </div>

      <AdminUsersTable data={userData} meId={me.id} isOwner={me.isOwner} />
    </div>
  );
}
