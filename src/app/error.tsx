"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  return (
    <div className="px-4 py-16 text-center">
      <h1>Something went wrong</h1>
      <p className="mt-2 text-muted-foreground">Please try again. If it keeps happening, tell an admin.</p>
      {digest && <p className="mt-1 text-xs text-muted-foreground">Error code: {digest}</p>}
      <div className="mt-5 flex justify-center gap-2">
        <Button type="button" className="h-10 px-5" onClick={() => retry()}>Try again</Button>
        <Link href="/" className={buttonVariants({ variant: "outline", className: "h-10 px-5" })}>Back to markets</Link>
      </div>
    </div>
  );
}
