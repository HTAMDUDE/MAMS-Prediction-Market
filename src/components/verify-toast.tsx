"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

/**
 * The verification link lands on "/?verified=1" (success, and the user is signed in) or "/?error=…" (bad or expired
 * link). Show the outcome once, then tidy the URL so a refresh doesn't repeat it.
 */
export function VerifyToast() {
  const params = useSearchParams();
  const verified = params.get("verified");
  const error = params.get("error");
  useEffect(() => {
    if (!verified && !error) return;
    if (verified) toast.success("Email verified. Welcome to MAMS Prediction Market!");
    else toast.error("That verification link is invalid or has expired. Log in and we'll send you a new one.");
    const url = new URL(window.location.href);
    url.searchParams.delete("verified");
    url.searchParams.delete("error");
    window.history.replaceState(null, "", url.pathname + url.search);
  }, [verified, error]);
  return null;
}
