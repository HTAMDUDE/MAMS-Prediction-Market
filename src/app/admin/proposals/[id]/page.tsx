import Link from "next/link";
import { notFound } from "next/navigation";
import { ago } from "@/lib/format";
import { prisma } from "@/lib/db";
import { getAdminOrNull } from "@/lib/session";
import { toSchoolLocal } from "@/lib/time";
import { ensureFinalized } from "@/server/finalize";
import { reviewProposalAction } from "@/server/actions/admin";
import { Forbidden } from "@/components/forbidden";
import { MarketForm } from "@/components/market-form";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Review proposal · MAMS Prediction Market" };

export default async function ReviewProposal({ params }: { params: Promise<{ id: string }> }) {
  await ensureFinalized();
  if (!(await getAdminOrNull())) return <Forbidden />;
  const id = Number((await params).id);
  const p = Number.isInteger(id) ? await prisma.proposal.findUnique({ where: { id }, include: { user: true } }) : null;
  if (!p) notFound();
  const proposer = p.user.displayUsername ?? p.user.username ?? "the proposer";
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <Link href="/admin#proposals" className="text-sm text-muted-foreground hover:text-foreground">← Back to admin</Link>
      {p.status !== "pending" ? (
        <Card className="gap-2 p-5">
          <h1>Review proposal</h1>
          <p className="text-muted-foreground">Proposed by <strong>{proposer}</strong> {ago(p.createdAt)}.</p>
          <p className="rounded-lg bg-down/10 p-3 text-down">This proposal was already {p.status}.</p>
        </Card>
      ) : (
        <MarketForm
          action={reviewProposalAction}
          hidden={{ proposal_id: p.id }}
          showLiquidity
          review={{ proposer }}
          initial={{
            question: p.question, description: p.description, category: p.category, rules_source: p.rulesSource, rules_otherwise: p.rulesOtherwise,
            outcomes: p.outcomes.join("\n"), closes_at: toSchoolLocal(p.closesAt), liquidity: "medium",
          }}
          intro={
            <>
              <h1>Review proposal</h1>
              <p className="text-muted-foreground">Proposed by <strong>{proposer}</strong> {ago(p.createdAt)}. You can fix the wording or details before approving.</p>
            </>
          }
        />
      )}
    </div>
  );
}
