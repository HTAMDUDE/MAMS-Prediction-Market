"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Plain data (not functions) so the server header can hand it to this client component. */
export type NavItem = { href: string; label: string; exact?: string[]; prefixes?: string[]; badge?: number };

export function isActive(it: NavItem, pathname: string) {
  return (it.exact ?? [it.href]).includes(pathname) || (it.prefixes ?? []).some((p) => pathname.startsWith(p));
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="hidden flex-1 gap-1 md:flex">
      {items.map((it) => {
        const active = isActive(it, pathname);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50",
              active && "bg-secondary text-foreground",
            )}
          >
            {it.label}
            {it.badge ? (
              <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[0.7rem] font-semibold text-primary-foreground" title={`${it.badge} ${it.badge === 1 ? "proposal" : "proposals"} waiting`}>
                {it.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
