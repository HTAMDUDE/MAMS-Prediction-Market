"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Plain data (not functions) so the server header can hand it to this client component. */
export type NavItem = { href: string; label: string; exact?: string[]; prefixes?: string[]; badge?: number };

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto sm:flex-1">
      {items.map((it) => {
        const active = (it.exact ?? [it.href]).includes(pathname) || (it.prefixes ?? []).some((p) => pathname.startsWith(p));
        return (
          <Link
            key={it.href}
            href={it.href}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:bg-secondary",
              active && "bg-secondary text-foreground",
            )}
          >
            {it.label}
            {it.badge ? (
              <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[0.7rem] font-semibold text-primary-foreground" title={`${it.badge} proposal(s) waiting`}>
                {it.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
