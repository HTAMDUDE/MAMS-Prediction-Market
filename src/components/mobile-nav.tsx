"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { MenuIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BonusButton } from "@/components/bonus-button";
import { LogoutButton } from "@/components/logout-button";
import { buttonVariants } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { isActive, type NavItem } from "@/components/nav-links";

/** The menu below the `md` breakpoint: a slide-in sheet with the nav, the daily bonus and log out. */
export function MobileNav({ items, username, canBonus, bonusAmount }: { items: NavItem[]; username: string | null; canBonus: boolean; bonusAmount: number }) {
  const pathname = usePathname();
  // Open only for the page it was opened on, so navigating anywhere closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  return (
    <Sheet open={openAt === pathname} onOpenChange={(o) => setOpenAt(o ? pathname : null)}>
      <SheetTrigger aria-label="Open menu" className="grid size-9 place-items-center rounded-lg border bg-card outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:hidden">
        <MenuIcon className="size-5" />
      </SheetTrigger>
      <SheetContent>
        <SheetTitle>Menu</SheetTitle>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {items.map((it) => (
            <SheetClose
              key={it.href}
              nativeButton={false}
              render={<Link href={it.href} aria-current={isActive(it, pathname) ? "page" : undefined} />}
              className={cn(
                "flex min-h-11 items-center rounded-lg px-3 text-base font-medium text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50",
                isActive(it, pathname) && "bg-secondary text-foreground",
              )}
            >
              {it.label}
              {it.badge ? <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{it.badge}</span> : null}
            </SheetClose>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t pt-4">
          {username ? (
            <>
              {canBonus && <BonusButton amount={bonusAmount} />}
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">Signed in as <b className="text-foreground">{username}</b></span>
                <LogoutButton username={username} />
              </div>
            </>
          ) : (
            <>
              <Link href="/login" className={cn(buttonVariants({ variant: "outline" }), "h-10")}>Log in</Link>
              <Link href="/register" className={cn(buttonVariants(), "h-10")}>Sign up</Link>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
