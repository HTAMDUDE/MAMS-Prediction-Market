import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1>404 — Not Found</h1>
      <p className="mt-2 text-muted-foreground">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link href="/" className={buttonVariants({ className: "mt-5" })}>Back to markets</Link>
    </div>
  );
}
