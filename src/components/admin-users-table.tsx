import Link from "next/link";
import { money, when } from "@/lib/format";
import { USER_FILTERS, type listUsers } from "@/server/services/accounts";
import {
  commentMuteAction, deleteUserAction, grantAction, markVerifiedAction, resendVerificationAction, resetPasswordAction,
  toggleAdminAction, tradingAction, updateEmailAction,
} from "@/server/actions/admin";
import { ActionForm, ConfirmButton } from "@/components/action-form";
import { ManageDialog } from "@/components/manage-dialog";
import { Status, Tag } from "@/components/state-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Users = Awaited<ReturnType<typeof listUsers>>;
const FILTER_LABELS: Record<string, string> = { all: "Everyone", admins: "Admins", banned: "Banned from trading", muted: "Muted from commenting", unverified: "Email not verified" };

function pageHref(p: number, q: string, filter: string) {
  const s = new URLSearchParams();
  if (q) s.set("q", q);
  if (filter !== "all") s.set("filter", filter);
  if (p > 1) s.set("upage", String(p));
  const qs = s.toString();
  return `/admin${qs ? `?${qs}` : ""}#users`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

export function AdminUsersTable({ data, meId, isOwner }: { data: Users; meId: string; isOwner: boolean }) {
  const { rows, total, page, pages, filter, q } = data;
  return (
    <Card className="gap-3 p-5" id="users">
      <h2>Users <span className="ml-1 text-sm font-normal text-muted-foreground">{total}</span></h2>
      <p className="text-sm text-muted-foreground">
        {isOwner ? "You're the owner: you can manage everyone, and only you can add or remove admins."
          : "Only the site owner can add or remove admins, or change an admin's balance, email or access."}
        {" "}Emails are visible to admins only.
      </p>

      <form action="/admin#users" className="flex flex-wrap gap-2">
        <Input name="q" defaultValue={q} placeholder="Search username or email" className="min-w-48 flex-1" aria-label="Search users" />
        <NativeSelect name="filter" defaultValue={filter} className="w-auto" aria-label="Filter users">
          {USER_FILTERS.map((f) => <option key={f} value={f}>{FILTER_LABELS[f]}</option>)}
        </NativeSelect>
        <Button variant="outline">Search</Button>
        {(q || filter !== "all") && <Link href="/admin#users" className={buttonVariants({ variant: "ghost" })}>Clear</Link>}
      </form>

      <Table>
        <TableHeader>
          <TableRow><TableHead>User</TableHead><TableHead>Email</TableHead><TableHead className="text-right">Balance</TableHead><TableHead className="w-24" /></TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((u) => {
            const manageable = isOwner || (!u.isOwner && !u.isAdmin);
            const canDelete = manageable && !u.isAdmin && u.id !== meId;
            const hidden = <input type="hidden" name="user_id" value={u.id} />;
            return (
              <TableRow key={u.id}>
                <TableCell className="whitespace-normal">
                  <strong>{u.username}</strong>{u.id === meId && <span className="ml-1 text-sm text-muted-foreground">(you)</span>}
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {u.isOwner ? <Tag>Owner</Tag> : u.isAdmin ? <Tag>Admin</Tag> : null}
                    {u.banned && <Status tone="rejected">Trading off</Status>}
                    {u.muted && <Status tone="pending">Muted</Status>}
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal break-all">
                  {u.legacyEmail ? <span className="text-sm text-muted-foreground">none (imported)</span> : u.email}
                  {!u.legacyEmail && (u.emailVerified ? <Status tone="resolved">verified</Status> : <> <Status tone="closed">not verified</Status></>)}
                </TableCell>
                <TableCell className="text-right">Ⓜ{money(u.balance)}</TableCell>
                <TableCell className="text-right">
                  <ManageDialog title={u.username} description={`Joined ${when(u.createdAt)}.`}>
                    {!manageable ? (
                      <p className="text-sm text-muted-foreground">Only the site owner can manage this account.</p>
                    ) : (
                      <div className="space-y-3">
                        <Section title="Balance">
                          <ActionForm action={grantAction} className="flex gap-2" resetOnSuccess>
                            {hidden}
                            <Input type="number" name="amount" step="0.01" placeholder="±Ⓜ" required />
                            <Button variant="outline">Apply</Button>
                          </ActionForm>
                          <p className="text-xs text-muted-foreground">Now Ⓜ{money(u.balance)}. Use a negative number to take coins away.</p>
                        </Section>

                        <Section title="Trading and commenting" hint="Banning trading refunds and removes their open bets. Muting only stops comments.">
                          {!u.isOwner && (
                            <ActionForm action={tradingAction} className="flex items-center gap-2">
                              {hidden}
                              {u.banned ? <Button variant="outline">Allow trading</Button>
                                : <ConfirmButton variant="outline" title={`Turn off trading for ${u.username}?`} message="Their bets in all unresolved markets will be refunded and removed." confirmLabel="Ban from trading">Ban from trading</ConfirmButton>}
                            </ActionForm>
                          )}
                          {!u.isOwner && (
                            <ActionForm action={commentMuteAction}>
                              {hidden}
                              <Button variant="outline">{u.muted ? "Allow commenting" : "Mute from commenting"}</Button>
                            </ActionForm>
                          )}
                        </Section>

                        <Section title="Email" hint={u.legacyEmail ? "This account was imported and has no email. Add one so they can verify and use it." : undefined}>
                          <ActionForm action={updateEmailAction} className="space-y-2">
                            {hidden}
                            <Input type="email" name="email" defaultValue={u.legacyEmail ? "" : u.email} placeholder="name@example.com" required />
                            <ConfirmButton variant="outline" title={`Change ${u.username}'s email?`} message="We'll send a verification link to the new address, and they can't log in until they use it." confirmLabel="Change email">Change email</ConfirmButton>
                          </ActionForm>
                          {!u.emailVerified && !u.legacyEmail && (
                            <div className="flex flex-wrap gap-2">
                              <ActionForm action={resendVerificationAction}>{hidden}<Button variant="outline">Resend verification</Button></ActionForm>
                              <ActionForm action={markVerifiedAction}>
                                {hidden}
                                <ConfirmButton variant="outline" title="Mark this email as verified?" message="Only do this if you're sure the address is theirs. They'll be able to log in immediately." confirmLabel="Mark verified">Mark as verified</ConfirmButton>
                              </ActionForm>
                            </div>
                          )}
                        </Section>

                        <Section title="Password" hint="Gives them a temporary password (shown once) and signs them out everywhere.">
                          <ActionForm action={resetPasswordAction}>
                            {hidden}
                            <ConfirmButton variant="outline" title={`Reset ${u.username}'s password?`} message="They'll be signed out and you'll get a temporary password to give them." confirmLabel="Reset password">Reset password</ConfirmButton>
                          </ActionForm>
                        </Section>

                        {isOwner && !u.isOwner && (
                          <Section title="Role">
                            <ActionForm action={toggleAdminAction} className="flex items-center gap-2">
                              {hidden}
                              {u.isAdmin && <Tag>Admin</Tag>}
                              <Button variant="outline">{u.isAdmin ? "Remove admin" : "Make admin"}</Button>
                            </ActionForm>
                          </Section>
                        )}

                        {canDelete && (
                          <Section title="Danger zone" hint="Deleting removes the account, their comments and proposals. Their bets in unresolved markets are reversed and prices restored. Payouts already made are kept.">
                            <ActionForm action={deleteUserAction}>
                              {hidden}
                              <ConfirmButton variant="destructive" title={`Delete ${u.username}?`} message="This permanently deletes the account and can't be undone." confirmLabel="Delete account">Delete account</ConfirmButton>
                            </ActionForm>
                          </Section>
                        )}
                      </div>
                    )}
                  </ManageDialog>
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground">No users match.</TableCell></TableRow>}
        </TableBody>
      </Table>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Page {page} of {pages}</span>
          <div className="flex gap-2">
            {page > 1 && <Link href={pageHref(page - 1, q, filter)} className={buttonVariants({ variant: "outline", size: "sm" })}>← Previous</Link>}
            {page < pages && <Link href={pageHref(page + 1, q, filter)} className={buttonVariants({ variant: "outline", size: "sm" })}>Next →</Link>}
          </div>
        </div>
      )}
    </Card>
  );
}
