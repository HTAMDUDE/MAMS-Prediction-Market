import { money } from "@/lib/format";
import { grantAction, resetPasswordAction, toggleAdminAction, tradingAction } from "@/server/actions/admin";
import { ActionForm, ConfirmButton } from "@/components/action-form";
import { Status, Tag } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type AdminUserRow = { id: string; username: string; balance: number; isAdmin: boolean; banned: boolean };

export function AdminUsersTable({ users, meId, ownerId, isOwner }: { users: AdminUserRow[]; meId: string; ownerId: string | null; isOwner: boolean }) {
  return (
    <Card className="gap-2 p-5" id="users">
      <h2>Users</h2>
      <p className="text-sm text-muted-foreground">
        {isOwner ? "You're the owner: you can manage everyone, and only you can add or remove admins."
          : "Only the site owner can add or remove admins, or change an admin's balance or trading access."}
      </p>
      <Table>
        <TableHeader>
          <TableRow><TableHead>User</TableHead><TableHead className="text-right">Balance</TableHead><TableHead>Adjust balance</TableHead><TableHead>Trading</TableHead><TableHead>Password</TableHead><TableHead>Role</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => {
            const manageable = isOwner || (u.id !== ownerId && !u.isAdmin);
            const hidden = <input type="hidden" name="user_id" value={u.id} />;
            return (
              <TableRow key={u.id}>
                <TableCell><strong>{u.username}</strong>{u.id === meId && <span className="ml-1 text-sm text-muted-foreground">(you)</span>}</TableCell>
                <TableCell className="text-right">Ⓜ{money(u.balance)}</TableCell>
                <TableCell>
                  {manageable ? (
                    <ActionForm action={grantAction} className="flex gap-1.5" resetOnSuccess>
                      {hidden}
                      <Input type="number" name="amount" step="0.01" placeholder="±Ⓜ" className="w-24" required />
                      <Button variant="outline" size="sm">Apply</Button>
                    </ActionForm>
                  ) : <span className="text-sm text-muted-foreground">Owner only</span>}
                </TableCell>
                <TableCell>
                  {u.id === ownerId ? <span className="text-sm text-muted-foreground">—</span>
                    : manageable ? (
                      <ActionForm action={tradingAction} className="flex items-center gap-1.5">
                        {hidden}
                        {u.banned ? (
                          <><Status tone="rejected">Banned</Status><Button variant="outline" size="sm">Allow</Button></>
                        ) : (
                          <ConfirmButton variant="outline" size="sm" title={`Turn off trading for ${u.username}?`} message="Their bets in all unresolved markets will be refunded and removed." confirmLabel="Ban from trading">Ban from trading</ConfirmButton>
                        )}
                      </ActionForm>
                    ) : u.banned ? <Status tone="rejected">Banned</Status> : <span className="text-sm text-muted-foreground">Owner only</span>}
                </TableCell>
                <TableCell>
                  {manageable ? (
                    <ActionForm action={resetPasswordAction}>
                      {hidden}
                      <ConfirmButton variant="outline" size="sm" title={`Reset ${u.username}'s password?`} message="They'll be signed out and you'll get a temporary password to give them." confirmLabel="Reset password">Reset</ConfirmButton>
                    </ActionForm>
                  ) : <span className="text-sm text-muted-foreground">Owner only</span>}
                </TableCell>
                <TableCell>
                  {u.id === ownerId ? <Tag>Owner</Tag>
                    : isOwner ? (
                      <ActionForm action={toggleAdminAction} className="flex items-center gap-1.5">
                        {hidden}
                        {u.isAdmin && <Tag>Admin</Tag>}
                        <Button variant="outline" size="sm">{u.isAdmin ? "Remove admin" : "Make admin"}</Button>
                      </ActionForm>
                    ) : u.isAdmin ? <Tag>Admin</Tag> : <span className="text-sm text-muted-foreground">User</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
