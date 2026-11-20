"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { markVerificationSent, secondsUntilResend } from "@/lib/verify";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** "We emailed you a link" step after sign-up, with a Resend button that waits 60 seconds between sends. */
export function CheckEmail({ email }: { email: string | null }) {
  const [wait, setWait] = useState(0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const tick = () => setWait(secondsUntilResend());
    const first = setTimeout(tick, 0); // read sessionStorage after mount (not during render)
    const t = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, []);

  async function resend() {
    if (!email) return;
    setSending(true);
    const { error } = await authClient.sendVerificationEmail({ email });
    setSending(false);
    if (error) return toast.error(error.status === 429 ? "Too many requests. Wait a minute and try again." : (error.message ?? "Couldn't send the email."));
    markVerificationSent();
    setWait(secondsUntilResend());
    toast.success("Sent! Check your inbox (and spam folder).");
  }

  return (
    <Card className="mx-auto max-w-md gap-4 p-6">
      <h1>Check your email</h1>
      <p>
        We sent a verification link to {email ? <b className="break-all">{email}</b> : "your email address"}. Click it to finish creating your
        account — it works for 24 hours.
      </p>
      <p className="text-sm text-muted-foreground">Nothing after a minute? Check your spam folder, or send it again.</p>
      {email && (
        <Button variant="outline" onClick={resend} disabled={sending || wait > 0}>
          {wait > 0 ? `Resend email (${wait}s)` : "Resend email"}
        </Button>
      )}
      <p className="text-sm text-muted-foreground">
        Wrong address? <Link href="/register" className="text-primary hover:underline">Sign up again</Link>. Already verified?{" "}
        <Link href="/login" className="text-primary hover:underline">Log in</Link>.
      </p>
    </Card>
  );
}
