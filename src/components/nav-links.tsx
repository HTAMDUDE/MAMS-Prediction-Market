"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type NavItem = { href: string; label: string; match: (path: string) => boolean; badge?: number };

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-wrap gap-1">
      {items.map((it) => {
        const active = it.match(pathname);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary",
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
