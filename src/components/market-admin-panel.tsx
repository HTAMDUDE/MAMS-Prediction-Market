import Link from "next/link";
import type { Bundle } from "@/server/services/markets";
import { schoolLocalInDays } from "@/lib/time";
import {
  blockAction, cancelAction, clarifyAction, closeEarlyAction, featureAction, proposeResultAction, reopenAction, resultAction, unblockAction,
} from "@/server/actions/admin";
import { ActionForm, ConfirmButton } from "@/components/action-form";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

export function MarketAdminPanel({ b, blocked, allUsers }: { b: Bundle; blocked: { id: string; username: string }[]; allUsers: string[] }) {
  const proposedLike = b.state === "proposed" || b.state === "disputed";
  return (
    <Card className="scroll-mt-20 gap-3 border-primary/40 p-4" id="admin">
      <h2>Admin</h2>

      <div className="space-y-2">
        {b.state === "open" && (
          <ActionForm action={closeEarlyAction}>
            <input type="hidden" name="market_id" value={b.m.id} />
            <ConfirmButton variant="outline" className="w-full" title="Close betting now?" message="Nobody can bet or sell after this, and you can propose a result right away. You can reopen betting later." confirmLabel="Close betting">
              Close betting now
            </ConfirmButton>
          </ActionForm>
        )}
        {b.state === "closed" && (
          <ActionForm action={reopenAction} className="space-y-2">
            <input type="hidden" name="market_id" value={b.m.id} />
            <label className="text-sm font-medium">Reopen betting until
              <Input type="datetime-local" name="closes_at" required defaultValue={schoolLocalInDays(1)} className="mt-1.5 font-normal" />
            </label>
            <Button variant="outline" className="w-full">Reopen betting</Button>
          </ActionForm>
        )}
        <ActionForm action={featureAction}>
          <input type="hidden" name="market_id" value={b.m.id} />
          <input type="hidden" name="featured" value={b.m.featured ? "0" : "1"} />
          <Button variant="outline" className="w-full">{b.m.featured ? "★ Remove from featured" : "☆ Feature on the home page"}</Button>
        </ActionForm>
      </div>
      {b.state === "open" ? (
        <p className="text-sm text-muted-foreground">You can propose a result once betting closes.</p>
      ) : (
        <ActionForm action={proposeResultAction} className="space-y-2">
          <input type="hidden" name="market_id" value={b.m.id} />
          <label className="text-sm font-medium">{proposedLike ? "Change the proposed result" : "Winning outcome"}
            <NativeSelect name="outcome_id" required className="mt-1.5 font-normal" defaultValue="">
              <option value="">Choose…</option>
              {b.outcomes.filter((o) => o.id !== b.m.proposedOutcomeId).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </NativeSelect>
          </label>
          <ConfirmButton className="w-full" title="Propose this result?" message="Traders get 24 hours to dispute it before winners are paid." confirmLabel="Propose result">
            {proposedLike ? "Propose this instead" : "Propose result"}
          </ConfirmButton>
        </ActionForm>
      )}

      {proposedLike && (
        <ActionForm action={resultAction} className="space-y-2">
          <input type="hidden" name="market_id" value={b.m.id} />
          {b.state === "disputed" && (
            <ConfirmButton className="w-full" name="decision" value="confirm" title="Confirm the proposed result?" message="Winners are paid immediately and this cannot be undone." confirmLabel="Confirm & pay out">
              Confirm result &amp; pay out
            </ConfirmButton>
          )}
          <Button variant="outline" className="w-full" name="decision" value="retract">Withdraw proposed result</Button>
        </ActionForm>
      )}

      <ActionForm action={cancelAction}>
        <input type="hidden" name="market_id" value={b.m.id} />
        <ConfirmButton variant="destructive" className="w-full" title="Cancel this market?" message="Everyone gets back what they spent on it." confirmLabel="Cancel & refund">
          Cancel &amp; refund
        </ConfirmButton>
      </ActionForm>

      <h3 className="mt-2 text-base font-semibold">Clarify the rules</h3>
      <p className="text-sm text-muted-foreground">The written rules are locked once betting starts. Add a dated note instead.</p>
      <ActionForm action={clarifyAction} className="space-y-2" resetOnSuccess>
        <input type="hidden" name="market_id" value={b.m.id} />
        <Textarea name="body" aria-label="Clarification text" rows={2} minLength={5} maxLength={500} required placeholder="e.g. A half day counts as a snow day." />
        <Button variant="outline" size="sm">Add clarification</Button>
      </ActionForm>

      <h3 className="mt-2 text-base font-semibold">Blocked from this market</h3>
      <p className="text-sm text-muted-foreground">For people who know the answer ahead of time. Blocking someone refunds and removes any bets they already placed here.</p>
      {blocked.length ? blocked.map((u) => (
        <ActionForm key={u.id} action={unblockAction} className="flex items-center justify-between gap-2">
          <input type="hidden" name="market_id" value={b.m.id} />
          <input type="hidden" name="user_id" value={u.id} />
          <span>{u.username}</span>
          <Button variant="outline" size="sm">Unblock</Button>
        </ActionForm>
      )) : <p className="text-sm text-muted-foreground">Nobody is blocked.</p>}
      <ActionForm action={blockAction} className="flex gap-2" resetOnSuccess>
        <input type="hidden" name="market_id" value={b.m.id} />
        <Input name="username" aria-label="Username to block" list="all-users" placeholder="Username" required autoComplete="off" />
        <datalist id="all-users">{allUsers.map((n) => <option key={n} value={n} />)}</datalist>
        <ConfirmButton variant="destructive" size="sm" title="Block this user?" message="Their bets on this market will be refunded and removed." confirmLabel="Block">Block</ConfirmButton>
      </ActionForm>
    </Card>
  );
}

export function MarketAdminLinks({ marketId }: { marketId: number }) {
  return (
    <Link href={`/admin/markets/${marketId}/edit`} className={buttonVariants({ variant: "outline", className: "w-full" })}>Edit market</Link>
  );
}
