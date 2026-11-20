"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { CURRENCY, STARTING_BALANCE } from "@/lib/constants";
import { firstError, loginSchema, registerSchema, safeNext } from "@/lib/validation";
import { syntheticEmail } from "@/lib/username";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = loginSchema.safeParse(Object.fromEntries(new FormData(e.currentTarget)));
    if (!parsed.success) return toast.error(firstError(parsed.error));
    setPending(true);
    const { error } = await authClient.signIn.username({ username: parsed.data.username, password: parsed.data.password });
    if (error) {
      setPending(false);
      return toast.error(error.status === 429 || /too many/i.test(error.message ?? "") ? (error.message ?? "Too many attempts. Try again later.") : "Wrong username or password.");
    }
    router.push(safeNext(next));
    router.refresh();
  }
  return (
    <Card className="mx-auto max-w-sm p-6">
      <h1>Log in</h1>
      <form onSubmit={submit} className="mt-4 space-y-4">
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
    const { username, password } = parsed.data;
    const { data, error } = await authClient.signUp.email({ name: username, email: syntheticEmail(username), password, username } as Parameters<typeof authClient.signUp.email>[0]);
    if (error || !data) {
      setPending(false);
      const taken = /exist|taken|already/i.test(error?.message ?? "");
      return toast.error(taken ? "That username is taken." : error?.status === 429 ? "Too many new accounts from this network. Try again in a while." : (error?.message ?? "Couldn't create the account."));
    }
    const isAdmin = Boolean((data.user as { isAdmin?: boolean }).isAdmin);
    toast.success(`Welcome! You start with ${STARTING_BALANCE.toLocaleString("en-US")} ${CURRENCY}.` + (isAdmin ? " You're an admin, so you can create and resolve markets." : ""));
    router.push("/");
    router.refresh();
  }
  return (
    <Card className="mx-auto max-w-sm p-6">
      <h1>Create an account</h1>
      <p className="mt-1 text-sm text-muted-foreground">You&apos;ll start with Ⓜ1,000 {CURRENCY} — play money, no real value.</p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <Field label="Username"><Input name="username" required autoFocus minLength={3} maxLength={20} pattern="[A-Za-z0-9_.\-]+" autoComplete="username" /></Field>
        <Field label="Password"><Input type="password" name="password" required minLength={6} autoComplete="new-password" /></Field>
        <Field label="Confirm password"><Input type="password" name="confirm" required minLength={6} autoComplete="new-password" /></Field>
        <Button className="w-full" disabled={pending}>Sign up</Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">Already have an account? <Link href="/login" className="text-primary hover:underline">Log in</Link></p>
    </Card>
  );
}
