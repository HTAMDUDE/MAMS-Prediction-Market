import Link from "next/link";
import { notFound } from "next/navigation";
import { presetFor } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getAdminOrNull } from "@/lib/session";
import { toSchoolLocal } from "@/lib/time";
import { ensureFinalized } from "@/server/finalize";
import { Forbidden } from "@/components/forbidden";
import { EditMarketForm } from "@/components/edit-market-form";

export const metadata = { title: "Edit market · MAMS Prediction Market" };

export default async function EditMarket({ params }: { params: Promise<{ id: string }> }) {
  await ensureFinalized();
  if (!(await getAdminOrNull())) return <Forbidden />;
  const id = Number((await params).id);
  const m = Number.isInteger(id) ? await prisma.market.findUnique({ where: { id }, include: { outcomes: { orderBy: { position: "asc" } } } }) : null;
  if (!m) notFound();
  const hasTrades = (await prisma.trade.count({ where: { marketId: id } })) > 0;
  return (
    <div className="space-y-3">
      <Link href={`/market/${id}`} className="text-sm text-muted-foreground hover:text-foreground">← Back to market</Link>
      <EditMarketForm
        // a fresh form (and fresh field state) whenever the saved market changes
        key={`${m.id}-${m.outcomes.map((o) => o.label).join("|")}-${m.closesAt.getTime()}`}
        m={{
          id: m.id, status: m.status, question: m.question, description: m.description, rulesSource: m.rulesSource, rulesOtherwise: m.rulesOtherwise,
          category: m.category, closesAt: toSchoolLocal(m.closesAt), liquidity: presetFor(m.b, m.outcomes.length), hasTrades, open: m.status === "open",
          outcomes: m.outcomes.map((o) => ({ id: o.id, label: o.label })),
        }}
      />
    </div>
  );
}
