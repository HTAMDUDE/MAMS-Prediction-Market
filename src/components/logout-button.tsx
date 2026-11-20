"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function LogoutButton({ username }: { username: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost" size="sm" disabled={pending} title={`Log out ${username}`}
      onClick={() => start(async () => { await authClient.signOut(); router.push("/"); router.refresh(); })}
    >
      Log out
    </Button>
  );
}
