import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export function Forbidden({ signedIn = true }: { signedIn?: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1>403 — Not allowed</h1>
      <p className="mt-2 text-muted-foreground">
        {signedIn ? "You don't have permission to view this page." : "Log in with an admin account to view this page."}
      </p>
      <Link href={signedIn ? "/" : "/login"} className={buttonVariants({ className: "mt-5" })}>
        {signedIn ? "Back to markets" : "Log in"}
      </Link>
    </div>
  );
}
