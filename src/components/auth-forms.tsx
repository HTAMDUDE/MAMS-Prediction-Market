"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { CURRENCY } from "@/lib/constants";
import { markVerificationSent } from "@/lib/verify";
import { firstError, loginSchema, registerSchema, safeNext } from "@/lib/validation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [unverified, setUnverified] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = loginSchema.safeParse(Object.fromEntries(new FormData(e.currentTarget)));
    if (!parsed.success) return toast.error(firstError(parsed.error));
    setPending(true);
    setUnverified(false);
    const { error } = await authClient.signIn.username({ username: parsed.data.username, password: parsed.data.password });
    if (error) {
      setPending(false);
      if (error.code === "EMAIL_NOT_VERIFIED") {
        markVerificationSent();
        setUnverified(true); // the server has just emailed a fresh link
        return;
      }
      return toast.error(error.status === 429 || /too many/i.test(error.message ?? "") ? (error.message ?? "Too many attempts. Try again later.") : "Wrong username or password.");
    }
    router.push(safeNext(next));
    router.refresh();
  }
  return (
    <Card className="mx-auto max-w-sm p-6">
      <h1>Log in</h1>
      <form onSubmit={submit} className="mt-4 space-y-4">
        {unverified && (
          <div role="alert" className="rounded-lg border-l-4 border-gold bg-secondary p-3 text-sm">
            <b>Verify your email to log in.</b> We just sent a new link to the address on your account. Check your inbox (and spam
            folder), click the link, then log in again.
          </div>
        )}
        <Field label="Username"><Input name="username" required autoFocus autoComplete="username" /></Field>
        <Field label="Password"><Input type="password" name="password" required autoComplete="current-password" /></Field>
        <Button className="w-full" disabled={pending}>Log in</Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">New here? <Link href="/register" className="text-primary hover:underline">Create an account</Link></p>
    </Card>
  );
}

export function RegisterForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = registerSchema.safeParse(Object.fromEntries(new FormData(e.currentTarget)));
    if (!parsed.success) return toast.error(firstError(parsed.error));
    setPending(true);
    const { username, email, password } = parsed.data;
    const { error } = await authClient.signUp.email({ name: username, email, password, username } as Parameters<typeof authClient.signUp.email>[0]);
    if (error) {
      setPending(false);
      const msg = error.message ?? "";
      return toast.error(
        error.status === 429 ? "Too many new accounts from this network. Try again in a while."
          : /username/i.test(msg) && /taken|exist/i.test(msg) ? "That username is taken."
          : /exist|already/i.test(msg) ? "An account with that email already exists. Try logging in."
          : msg || "Couldn't create the account.",
      );
    }
    markVerificationSent();
    router.push(`/check-email?email=${encodeURIComponent(email)}`);
  }
  return (
    <Card className="mx-auto max-w-sm p-6">
      <h1>Create an account</h1>
      <p className="mt-1 text-sm text-muted-foreground">You&apos;ll start with Ⓜ1,000 {CURRENCY} — play money, no real value.</p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <Field label="Username" hint="3–20 letters, numbers, _ . - — this is what other players see.">
          <Input name="username" required autoFocus minLength={3} maxLength={20} pattern="[A-Za-z0-9_.\-]+" autoComplete="username" />
        </Field>
        <Field label="Email" hint="We'll send a link to verify it. It's never shown to other players.">
          <Input type="email" name="email" required autoComplete="email" />
        </Field>
        <Field label="Password"><Input type="password" name="password" required minLength={6} autoComplete="new-password" /></Field>
        <Field label="Confirm password"><Input type="password" name="confirm" required minLength={6} autoComplete="new-password" /></Field>
        <Button className="w-full" disabled={pending}>Sign up</Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">Already have an account? <Link href="/login" className="text-primary hover:underline">Log in</Link></p>
    </Card>
  );
}
