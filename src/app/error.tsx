"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="py-16 text-center">
      <h1>Something went wrong</h1>
      <p className="mt-2 text-muted-foreground">Please try again. If it keeps happening, tell an admin.</p>
      <Button className="mt-5" onClick={reset}>Try again</Button>
    </div>
  );
}
