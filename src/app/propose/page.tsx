import Link from "next/link";
import { ago } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { ensureFinalized } from "@/server/finalize";
import { myProposals } from "@/server/services/proposals";
import { submitProposal, withdrawProposalAction } from "@/server/actions/propose";
import { ActionForm } from "@/components/action-form";
import { MarketForm } from "@/components/market-form";
import { Status, Tag } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Propose a market · MAMS Prediction Market" };

const STATUS = { pending: ["pending", "Waiting for review"], approved: ["resolved", "Approved"], rejected: ["rejected", "Not approved"] } as const;

export default async function Propose() {
  await ensureFinalized();
  const user = await requireUser("/propose");
  const mine = await myProposals(user.id);
  return (
    <MarketForm
      action={submitProposal}
      initial={{}}
      preview
      submitLabel="Send for approval"
      intro={
        <>
          <h1>Propose a market</h1>
          <p className="text-muted-foreground">
            Got a question about something happening at Mass Academy? Suggest it here. An admin will review it, may tweak the wording, and then put it
            live or explain why not. New to this? <Link href="/how-it-works" className="text-primary hover:underline">How markets work</Link>.
          </p>
          <div className="rounded-lg bg-secondary p-3 text-sm">
            <strong>A good market has…</strong>
            <ul className="mt-1 ml-5 list-disc space-y-0.5">
              <li>A <b>clear, checkable answer</b>. Anyone reading the rules should reach the same result.</li>
              <li>A <b>named source</b> for the answer, such as a results page or an announcement.</li>
              <li>A <b>date</b>, and a rule for what happens if the event is postponed.</li>
              <li><b>Nothing private</b>: no grades, health or questions about individual people.</li>
            </ul>
          </div>
        </>
      }
      aside={
        <Card className="gap-3 p-5">
          <h2>Your proposals</h2>
          {mine.length ? mine.map((p) => (
            <div key={p.id} className="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-2"><Tag>{p.category}</Tag><Status tone={STATUS[p.status as keyof typeof STATUS][0]}>{STATUS[p.status as keyof typeof STATUS][1]}</Status></div>
              <strong>{p.question}</strong>
              <div className="text-sm text-muted-foreground">{p.outcomes.join(" · ")} — sent {ago(p.createdAt)}</div>
              {p.reviewNote && <p className="rounded-md border-l-4 border-gold bg-secondary p-2 text-sm"><b>Admin note:</b> {p.reviewNote}</p>}
              {p.status === "approved" && p.marketId ? <Link href={`/market/${p.marketId}`} className="text-sm text-primary hover:underline">View market →</Link>
                : p.status === "pending" ? (
                  <ActionForm action={withdrawProposalAction}>
                    <input type="hidden" name="proposal_id" value={p.id} />
                    <Button variant="outline" size="sm">Withdraw</Button>
                  </ActionForm>
                ) : null}
            </div>
          )) : <p className="text-muted-foreground">You haven&apos;t proposed anything yet.</p>}
        </Card>
      }
    />
  );
}
