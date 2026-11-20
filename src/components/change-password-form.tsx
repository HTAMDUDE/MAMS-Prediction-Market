"use client";

import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { changePasswordSchema, firstError } from "@/lib/validation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangePasswordForm() {
  const [pending, setPending] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const parsed = changePasswordSchema.safeParse(Object.fromEntries(new FormData(form)));
    if (!parsed.success) return toast.error(firstError(parsed.error));
    setPending(true);
    const { error } = await authClient.changePassword({ currentPassword: parsed.data.current, newPassword: parsed.data.next, revokeOtherSessions: true });
    setPending(false);
    if (error) return toast.error(/invalid|incorrect|wrong/i.test(error.message ?? "") ? "Your current password is wrong." : (error.message ?? "Couldn't change your password."));
    form.reset();
    toast.success("Password changed.");
  }
  return (
    <Card className="gap-3 p-5">
      <h2>Change password</h2>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Current password</Label><Input type="password" name="current" required autoComplete="current-password" /></div>
        <div className="space-y-1.5"><Label>New password</Label><Input type="password" name="next" required minLength={6} autoComplete="new-password" /></div>
        <div className="space-y-1.5"><Label>Confirm new password</Label><Input type="password" name="confirm" required minLength={6} autoComplete="new-password" /></div>
        <div className="sm:col-span-3"><Button variant="outline" disabled={pending}>Change password</Button></div>
      </form>
    </Card>
  );
}
