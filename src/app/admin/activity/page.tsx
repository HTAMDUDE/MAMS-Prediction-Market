import Link from "next/link";
import { auditLabel } from "@/lib/audit-actions";
import { when } from "@/lib/format";
import { getAdminOrNull, toActor } from "@/lib/session";
import { ensureFinalized } from "@/server/finalize";
import { listAudit } from "@/server/services/audit";
import { Forbidden } from "@/components/forbidden";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Activity log · MAMS Prediction Market" };

function href(page: number, q: string) {
  const s = new URLSearchParams();
  if (q) s.set("q", q);
  if (page > 1) s.set("page", String(page));
  const qs = s.toString();
  return `/admin/activity${qs ? `?${qs}` : ""}`;
}

export default async function Activity({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await ensureFinalized();
  const me = await getAdminOrNull();
  if (!me) return <Forbidden />;
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const { rows, total, page, pages } = await listAudit(toActor(me), { q, page: Number(sp.page) || 1 });

  return (
    <div className="space-y-4">
      <Link href="/admin" className="text-sm text-muted-foreground hover:text-foreground">← Back to admin</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>Activity log</h1>
        <span className="text-sm text-muted-foreground">{total} {total === 1 ? "entry" : "entries"}</span>
      </div>
      <p className="text-muted-foreground">Every admin action, newest first: who did it, to what, and when. Entries can&apos;t be edited or removed.</p>

      <form className="flex gap-2">
        <Input name="q" defaultValue={q} placeholder="Search admin, action, user, market or detail" aria-label="Search the activity log" />
        <Button variant="outline">Search</Button>
        {q && <Link href="/admin/activity" className={buttonVariants({ variant: "ghost" })}>Clear</Link>}
      </form>

      <Card className="p-2">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow><TableHead>When</TableHead><TableHead>Admin</TableHead><TableHead>Action</TableHead><TableHead>Target</TableHead><TableHead>Details</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{when(r.createdAt)}</TableCell>
                  <TableCell><strong>{r.actorName}</strong></TableCell>
                  <TableCell className="whitespace-normal">{auditLabel(r.action)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {r.targetType === "market" && r.targetId && r.action !== "market.delete"
                      ? <Link href={`/market/${r.targetId}`} className="text-primary hover:underline">{r.targetLabel}</Link>
                      : r.targetLabel ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-sm break-words text-muted-foreground">{r.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <p className="p-4 text-muted-foreground">{q ? "Nothing matches that search." : "No admin activity yet."}</p>}
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Page {page} of {pages}</span>
          <div className="flex gap-2">
            {page > 1 && <Link href={href(page - 1, q)} className={buttonVariants({ variant: "outline", size: "sm" })}>← Newer</Link>}
            {page < pages && <Link href={href(page + 1, q)} className={buttonVariants({ variant: "outline", size: "sm" })}>Older →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
