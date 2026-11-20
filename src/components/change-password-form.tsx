"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { changePasswordSchema, firstError } from "@/lib/validation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangePasswordForm() {
  const [pending, setPending] = useState(false);
  const id = useId();
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
  const field = (name: string, label: string, auto: string, minLength?: number) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input id={`${id}-${name}`} type="password" name={name} required minLength={minLength} autoComplete={auto} />
    </div>
  );
  return (
    <Card className="p-0">
      <details className="group">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-base font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-5 [&::-webkit-details-marker]:hidden">
          Account: change password
          <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-180">▾</span>
        </summary>
        <form onSubmit={submit} className="grid gap-3 px-4 pb-4 sm:grid-cols-3 sm:px-5 sm:pb-5">
          {field("current", "Current password", "current-password")}
          {field("next", "New password", "new-password", 6)}
          {field("confirm", "Confirm new password", "new-password", 6)}
          <div className="sm:col-span-3"><Button variant="outline" disabled={pending}>{pending ? "Changing…" : "Change password"}</Button></div>
        </form>
      </details>
    </Card>
  );
}
