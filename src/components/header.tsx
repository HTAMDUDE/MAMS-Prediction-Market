import Link from "next/link";
import { DAILY_BONUS, CURRENCY } from "@/lib/constants";
import { money } from "@/lib/format";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { todayInSchoolTz } from "@/lib/time";
import { buttonVariants } from "@/components/ui/button";
import { BonusButton } from "@/components/bonus-button";
import { LogoutButton } from "@/components/logout-button";
import { MobileNav } from "@/components/mobile-nav";
import { NavLinks, type NavItem } from "@/components/nav-links";

export async function Header() {
  const user = await getCurrentUser();
  const pending = user?.isAdmin ? await prisma.proposal.count({ where: { status: "pending" } }) : 0;
  const items: NavItem[] = [
    { href: "/", label: "Markets", prefixes: ["/market/"] },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/how-it-works", label: "How it works" },
  ];
  if (user) {
    items.push({ href: "/portfolio", label: "Portfolio" });
    items.push({ href: "/propose", label: "Propose" });
    if (user.isAdmin) items.push({ href: "/admin", label: "Admin", prefixes: ["/admin/"], badge: pending });
  }
  const canBonus = Boolean(user) && user!.lastBonus !== todayInSchoolTz();
  return (
    <header className="sticky top-0 z-20 border-b bg-card">
      <div className="mx-auto flex h-14 max-w-280 items-center gap-3 px-4 md:gap-5">
        <Link href="/" className="flex items-center gap-2.5 rounded-lg text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="grid size-8 place-items-center rounded-lg bg-primary font-bold text-primary-foreground">M</span>
          <span className="hidden sm:inline">MAMS <strong>Prediction Market</strong></span>
          <span className="font-bold sm:hidden">MAMS</span>
        </Link>
        <NavLinks items={items} />
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          {user ? (
            <>
              {canBonus && <span className="hidden md:block"><BonusButton amount={DAILY_BONUS} /></span>}
              <Link href="/portfolio" title={`Your ${CURRENCY}`} className="flex h-9 items-center gap-1 rounded-full border bg-secondary px-3 text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <span className="text-gold">Ⓜ</span>{money(user.balance)}
              </Link>
              <span className="hidden md:block"><LogoutButton username={user.username} /></span>
            </>
          ) : (
            <span className="hidden items-center gap-2 md:flex">
              <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>Log in</Link>
              <Link href="/register" className={buttonVariants({ size: "sm" })}>Sign up</Link>
            </span>
          )}
          <MobileNav items={items} username={user?.username ?? null} canBonus={canBonus} bonusAmount={DAILY_BONUS} />
        </div>
      </div>
    </header>
  );
}
